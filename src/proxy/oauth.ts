import { createServer, type Server as HttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/** Default directory for cached OAuth client registrations + tokens. */
export const DEFAULT_OAUTH_STORE_DIR = join(homedir(), '.ciphergate', 'oauth');

/**
 * Fixed loopback port for the OAuth callback. It MUST be stable across runs:
 * the dynamic client registration records this exact redirect_uri, and the
 * authorization server only redirects to the registered value — a fresh random
 * port each run would never receive the callback. Override with
 * GATEWAY_OAUTH_CALLBACK_PORT if it clashes with another service.
 */
export const DEFAULT_CALLBACK_PORT = 33418;

/** What a {@link GuardOAuthProvider} persists between runs. */
interface OAuthSession {
  client?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

/**
 * File-backed persistence for one server's OAuth session. The whole session
 * (dynamic client registration, tokens, PKCE verifier) lives in a single JSON
 * file (mode 0600) so the interactive flow runs once and later runs reuse the
 * cached/refreshed credentials.
 */
export class FileOAuthStore {
  constructor(private readonly path: string) {}

  private read(): OAuthSession {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as OAuthSession;
    } catch {
      return {};
    }
  }

  private write(session: OAuthSession): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(session, null, 2), { mode: 0o600 });
  }

  loadClient(): OAuthClientInformationFull | undefined {
    return this.read().client;
  }
  saveClient(client: OAuthClientInformationFull): void {
    this.write({ ...this.read(), client });
  }
  loadTokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }
  saveTokens(tokens: OAuthTokens): void {
    this.write({ ...this.read(), tokens });
  }
  loadCodeVerifier(): string | undefined {
    return this.read().codeVerifier;
  }
  saveCodeVerifier(codeVerifier: string): void {
    this.write({ ...this.read(), codeVerifier });
  }
  clear(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') {
      rmSync(this.path, { force: true });
      return;
    }
    const session = this.read();
    if (scope === 'client') delete session.client;
    if (scope === 'tokens') delete session.tokens;
    if (scope === 'verifier') delete session.codeVerifier;
    this.write(session);
  }
}

/** Performs the interactive consent leg and returns the authorization code. */
export type AuthorizeFn = (authorizationUrl: URL, redirectUrl: string) => Promise<string>;

export interface GuardOAuthProviderOptions {
  redirectUrl: string;
  clientName: string;
  scope?: string;
  store: FileOAuthStore;
  authorize: AuthorizeFn;
}

/**
 * {@link OAuthClientProvider} for a guarded http downstream. Drives the SDK's
 * PKCE authorization-code flow: dynamic client registration + tokens persist via
 * {@link FileOAuthStore}, and the user-consent leg runs through {@link AuthorizeFn}
 * (a loopback browser flow in production; injected in tests).
 *
 * The captured authorization code is stashed during {@link redirectToAuthorization}
 * and handed to the transport's `finishAuth` by {@link connectHttpWithOAuth}.
 */
export class GuardOAuthProvider implements OAuthClientProvider {
  private pendingAuth: Promise<string> | undefined;

  constructor(private readonly opts: GuardOAuthProviderOptions) {}

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName,
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    };
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.opts.store.loadClient();
  }
  saveClientInformation(info: OAuthClientInformationFull): void {
    this.opts.store.saveClient(info);
  }

  tokens(): OAuthTokens | undefined {
    return this.opts.store.loadTokens();
  }
  saveTokens(tokens: OAuthTokens): void {
    this.opts.store.saveTokens(tokens);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.opts.store.saveCodeVerifier(codeVerifier);
  }
  codeVerifier(): string {
    const v = this.opts.store.loadCodeVerifier();
    if (!v) throw new Error('No PKCE code verifier saved for this OAuth session');
    return v;
  }

  /**
   * Kick off the consent leg WITHOUT awaiting it. The SDK calls this inside the
   * (timeout-bound) initialize request, so it must return promptly — blocking
   * here until the user authorizes would trip the request timeout. The consent
   * promise is parked and awaited later by {@link connectHttpWithOAuth}, outside
   * any request lifecycle.
   */
  redirectToAuthorization(authorizationUrl: URL): void {
    this.pendingAuth = this.opts.authorize(authorizationUrl, this.opts.redirectUrl);
    // Avoid an unhandled-rejection warning during the brief window before the
    // driver awaits this; the real rejection still surfaces there.
    this.pendingAuth.catch(() => {});
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    this.opts.store.clear(scope);
  }

  /** Returns and clears the parked consent promise started during the redirect. */
  takeAuthorizationCode(): Promise<string> | undefined {
    const p = this.pendingAuth;
    this.pendingAuth = undefined;
    return p;
  }
}

/**
 * Connect a downstream {@link Client} to an OAuth-protected streamable-http MCP,
 * running the interactive PKCE flow on first use and reusing cached/refreshed
 * tokens thereafter.
 *
 * The first connect attempt carries any cached token. If the server demands
 * authorization, the SDK runs discovery + dynamic registration and invokes the
 * provider's consent leg; the resulting `UnauthorizedError` is caught here, the
 * captured code is exchanged via `finishAuth`, and a fresh transport reconnects
 * with the new token. A cached-but-expired token refreshes transparently inside
 * the SDK, so that path never throws.
 */
export async function connectHttpWithOAuth(
  makeTransport: () => StreamableHTTPClientTransport,
  provider: GuardOAuthProvider,
  clientInfo: { name: string; version: string },
  log: (msg: string) => void,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const first = makeTransport();
  const firstClient = new Client(clientInfo, { capabilities: {} });
  try {
    await firstClient.connect(first);
    return { client: firstClient, transport: first };
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
  }

  const pending = provider.takeAuthorizationCode();
  if (!pending) {
    throw new Error('OAuth authorization did not start (no redirect captured)');
  }
  // Wait for the user to finish authorizing — untimed, outside any MCP request.
  const code = await pending;
  // `first` carries the resource-metadata URL discovered from the 401, so the
  // code exchange resolves the right authorization server.
  await first.finishAuth(code);
  await first.close().catch(() => {});
  log('[guard] oauth: authorization complete; tokens cached');

  const transport = makeTransport();
  const client = new Client(clientInfo, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

/** Opens a URL in the user's default browser (best-effort, platform-aware). */
function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* best-effort: the URL is also logged for manual use */
  }
}

export interface LoopbackAuthorizer {
  /** redirect_uri the OAuth client must register and the auth server redirects to. */
  redirectUrl: string;
  authorize: AuthorizeFn;
  close(): void;
}

/**
 * Build a loopback {@link AuthorizeFn}: bind a one-shot http server on
 * 127.0.0.1, open the authorization URL in a browser, and resolve with the code
 * the authorization server redirects back with. The redirect path is fixed at
 * `/callback`. `open` is injectable for tests.
 */
export async function createLoopbackAuthorizer(opts: {
  log: (msg: string) => void;
  open?: (url: string) => void;
  /** Loopback port; defaults to the stable {@link DEFAULT_CALLBACK_PORT}. Tests pass 0. */
  port?: number;
} = { log: () => {} }): Promise<LoopbackAuthorizer> {
  const open = opts.open ?? openBrowser;
  const wantPort = opts.port ?? (Number(process.env.GATEWAY_OAUTH_CALLBACK_PORT) || DEFAULT_CALLBACK_PORT);
  const server: HttpServer = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(wantPort, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUrl = `http://127.0.0.1:${port}/callback`;

  const authorize: AuthorizeFn = (authorizationUrl) =>
    new Promise<string>((resolve, reject) => {
      server.on('request', (req, res) => {
        const reqUrl = new URL(req.url ?? '/', redirectUrl);
        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404);
          res.end();
          return;
        }
        opts.log(`[guard] oauth: callback received on ${reqUrl.pathname}`);
        const code = reqUrl.searchParams.get('code');
        const error = reqUrl.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>Authorization complete. You can close this tab and return to the terminal.</body></html>');
        if (error) reject(new Error(`OAuth authorization failed: ${error}`));
        else if (code) resolve(code);
        else reject(new Error('OAuth callback carried no authorization code'));
      });
      opts.log(`[guard] oauth: opening browser to authorize. If it does not open, visit:\n${authorizationUrl}`);
      open(authorizationUrl.toString());
    });

  return { redirectUrl, authorize, close: () => server.close() };
}
