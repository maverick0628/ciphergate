import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

/**
 * A fake hosted, OAuth-protected streamable-http MCP server, modelled on the
 * live Robinhood endpoint: an unauthenticated MCP request 401s with an RFC 9728
 * `WWW-Authenticate: Bearer resource_metadata="…"` header, and the advertised
 * authorization server runs a real PKCE authorization-code flow (discovery →
 * dynamic client registration → /authorize → /token). Once a valid bearer token
 * is presented, requests are forwarded to the wrapped MCP `Server`.
 *
 * Everything runs over real HTTP on 127.0.0.1 so the MCP SDK's own auth code
 * path (discovery, DCR, PKCE, token exchange + refresh) is exercised end-to-end.
 */

const b64url = (b: Buffer): string => b.toString('base64url');
const pkceChallenge = (verifier: string): string => b64url(createHash('sha256').update(verifier).digest());
const stripSlash = (p: string): string => p.replace(/\/+$/, '') || '/';

interface PendingCode {
  codeChallenge: string;
  redirectUri: string;
}

export interface FakeOAuthState {
  /** grant_type seen on each /token call, in order ("authorization_code" | "refresh_token"). */
  tokenGrants: string[];
  /** Count of dynamic-client-registration calls. */
  registrations: number;
  /** Count of /authorize hits. */
  authorizations: number;
  /** Mark a currently-valid access token as stale, forcing a refresh on next use. */
  expireAccessTokens(): void;
}

export interface FakeOAuthServer {
  http: HttpServer;
  /** The protected MCP endpoint URL. */
  mcpUrl: string;
  /** Origin (used as the issuer / authorization-server base). */
  origin: string;
  state: FakeOAuthState;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Start the fake server. `buildServer` mints a fresh MCP `Server` per session
 * (same contract as the real stateful-http transport).
 */
export async function startFakeOAuthMcp(buildServer: () => Server): Promise<FakeOAuthServer> {
  const validAccessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  const pendingCodes = new Map<string, PendingCode>();
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const state: FakeOAuthState = {
    tokenGrants: [],
    registrations: 0,
    authorizations: 0,
    expireAccessTokens() {
      validAccessTokens.clear();
    },
  };

  let origin = '';
  const prmPath = '/.well-known/oauth-protected-resource/mcp';
  const asMetaPath = '/.well-known/oauth-authorization-server';
  const mcpPath = '/mcp';

  const bearerOf = (req: IncomingMessage): string | undefined => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return undefined;
    return h.slice('Bearer '.length);
  };

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = bearerOf(req);
    if (!token || !validAccessTokens.has(token)) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${origin}${prmPath}"`,
      });
      res.end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (req.method === 'POST') {
      const raw = await readBody(req);
      const body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        if (!isInitializeRequest(body)) {
          return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'No session; initialize first' }, id: null });
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => transports.set(id, transport!),
        });
        transport.onclose = () => {
          const sid = transport!.sessionId;
          if (sid) transports.delete(sid);
        };
        await buildServer().connect(transport);
      }
      return transport.handleRequest(req, res, body);
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Invalid session' }, id: null });
      return transport.handleRequest(req, res);
    }
    res.writeHead(405, { Allow: 'GET, POST, DELETE' });
    res.end();
  }

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', origin);
      const path = stripSlash(url.pathname);

      // RFC 9728 protected-resource metadata.
      if (path === stripSlash(prmPath)) {
        return sendJson(res, 200, { resource: `${origin}${mcpPath}`, authorization_servers: [origin] });
      }

      // RFC 8414 authorization-server metadata (+ OIDC fallback path).
      if (path === stripSlash(asMetaPath) || path === '/.well-known/openid-configuration') {
        return sendJson(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      }

      // RFC 7591 dynamic client registration.
      if (path === '/register' && req.method === 'POST') {
        const meta = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        state.registrations += 1;
        return sendJson(res, 201, {
          client_id: `client_${randomBytes(6).toString('hex')}`,
          client_id_issued_at: 1,
          redirect_uris: meta.redirect_uris ?? [],
          token_endpoint_auth_method: meta.token_endpoint_auth_method ?? 'none',
          grant_types: meta.grant_types ?? ['authorization_code', 'refresh_token'],
          response_types: meta.response_types ?? ['code'],
        });
      }

      // Authorization endpoint — issues a code bound to the PKCE challenge,
      // then 302-redirects back to the client's redirect_uri.
      if (path === '/authorize') {
        state.authorizations += 1;
        const codeChallenge = url.searchParams.get('code_challenge');
        const redirectUri = url.searchParams.get('redirect_uri');
        const reqState = url.searchParams.get('state');
        if (!codeChallenge || !redirectUri) {
          return sendJson(res, 400, { error: 'invalid_request' });
        }
        const code = `code_${randomBytes(8).toString('hex')}`;
        pendingCodes.set(code, { codeChallenge, redirectUri });
        const loc = new URL(redirectUri);
        loc.searchParams.set('code', code);
        if (reqState) loc.searchParams.set('state', reqState);
        res.writeHead(302, { Location: loc.toString() });
        return res.end();
      }

      // Token endpoint — authorization_code (with PKCE check) + refresh_token.
      if (path === '/token' && req.method === 'POST') {
        const params = new URLSearchParams((await readBody(req)).toString('utf8'));
        const grant = params.get('grant_type') ?? '';
        state.tokenGrants.push(grant);

        if (grant === 'authorization_code') {
          const code = params.get('code') ?? '';
          const verifier = params.get('code_verifier') ?? '';
          const pending = pendingCodes.get(code);
          if (!pending) return sendJson(res, 400, { error: 'invalid_grant' });
          if (pending.codeChallenge !== pkceChallenge(verifier)) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
          if (pending.redirectUri !== params.get('redirect_uri')) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
          pendingCodes.delete(code);
          const access = `at_${randomBytes(12).toString('hex')}`;
          const refresh = `rt_${randomBytes(12).toString('hex')}`;
          validAccessTokens.add(access);
          refreshTokens.add(refresh);
          return sendJson(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: params.get('scope') ?? undefined });
        }

        if (grant === 'refresh_token') {
          const refresh = params.get('refresh_token') ?? '';
          if (!refreshTokens.has(refresh)) return sendJson(res, 400, { error: 'invalid_grant' });
          const access = `at_${randomBytes(12).toString('hex')}`;
          validAccessTokens.add(access);
          // Preserve the existing refresh token (server may rotate; here we keep it).
          return sendJson(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh });
        }

        return sendJson(res, 400, { error: 'unsupported_grant_type' });
      }

      if (path === stripSlash(mcpPath)) {
        return await handleMcp(req, res);
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'server_error', message: (err as Error).message }));
      }
    }
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  const port = (http.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;

  return {
    http,
    origin,
    mcpUrl: `${origin}${mcpPath}`,
    state,
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
