import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CallToolResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ProxyManifest } from './manifest.js';
import { compilePolicy, filterTools, evaluateToolCall, redactResult, type CompiledPolicy } from './policy.js';
import { fetchInjectedEnv, resolveConsumerKey } from './injector.js';
import { buildChildEnv } from './runner.js';
import { guardAlertConfigFromEnv, sendGuardDenyAlert } from './alert.js';
import {
  FileOAuthStore,
  GuardOAuthProvider,
  connectHttpWithOAuth,
  createLoopbackAuthorizer,
  DEFAULT_OAUTH_STORE_DIR,
  type AuthorizeFn,
} from './oauth.js';
import { join } from 'node:path';

export interface GuardOptions {
  gatewayUrl?: string;
  environ?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  log?: (msg: string) => void;
  /**
   * Pre-built transport to the downstream server (tests inject an in-memory
   * transport here). When omitted, the downstream server is spawned as a stdio
   * child with credentials injected (stdio transport) or connected over
   * streamable-http (http transport).
   */
  downstreamTransport?: Transport;
  /**
   * Pre-built transport for the client-facing (upstream) side of the guard.
   * Defaults to a {@link StdioServerTransport}; tests inject an in-memory
   * transport to drive the full guard end-to-end.
   */
  upstreamTransport?: Transport;
  /**
   * Consent leg for an `auth: "oauth"` http server. Defaults to a loopback
   * browser flow; tests inject a function that drives a fake authorization
   * server directly.
   */
  oauthAuthorize?: AuthorizeFn;
  /** redirect_uri to register for OAuth; defaults to a loopback callback. */
  oauthRedirectUrl?: string;
  /** Directory for cached OAuth registrations + tokens (default {@link DEFAULT_OAUTH_STORE_DIR}). */
  oauthStoreDir?: string;
}

/**
 * Wire a guard {@link Server} (facing the MCP client) that forwards to a
 * downstream {@link Client}, applying the compiled policy:
 *  - tools/list is filtered to the allowlist,
 *  - tools/call is allow/deny-checked and arg-warned before forwarding,
 *  - results are redacted on the way back.
 *
 * Pure with respect to transports — returns the configured server + the
 * downstream client so callers (or tests) control connection lifecycle.
 */
export function buildGuardServer(
  downstream: Client,
  policy: CompiledPolicy,
  log: (msg: string) => void,
  onDeny?: (ev: { tool: string; reason: string }) => void,
): Server {
  const server = new Server({ name: 'gateway-proxy-guard', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const upstream = await downstream.listTools();
    const tools = filterTools(upstream.tools, policy);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const decision = evaluateToolCall(name, args ?? {}, policy);
    for (const w of decision.warnings) log(`[guard] WARN ${name}: ${w}`);
    if (!decision.allowed) {
      log(`[guard] DENY ${name}: ${decision.reason}`);
      // Surface the block as a security event (Pushover/ntfy) — an attempted
      // trade is exactly what we want to hear about. Best-effort, never blocks.
      onDeny?.({ tool: name, reason: decision.reason ?? 'denied' });
      return {
        isError: true,
        content: [{ type: 'text', text: `Blocked by gateway-proxy guard: ${decision.reason}` }],
      };
    }
    const result = await downstream.callTool({ name, arguments: args ?? {} }, CallToolResultSchema);
    return redactResult(result as { content?: Array<Record<string, unknown>> }, policy);
  });

  return server;
}

/**
 * Run the guard for a manifest server over stdio: inject credentials, spawn the
 * downstream server as a stdio child, and bridge the two with policy enforced.
 */
export async function startGuard(manifest: ProxyManifest, serverName: string, opts: GuardOptions = {}): Promise<void> {
  const environ = opts.environ ?? process.env;
  const log = opts.log ?? ((m: string) => process.stderr.write(m + '\n'));
  const server = manifest.servers[serverName];
  if (!server) {
    throw new Error(`No server "${serverName}" in manifest. Available: ${Object.keys(manifest.servers).join(', ')}`);
  }

  const policy = compilePolicy(server.policy ?? {});

  const clientInfo = { name: 'gateway-proxy-guard-client', version: '1.0.0' };

  // Connect the downstream MCP server. Three paths:
  //  - oauth http: run the PKCE flow (first-run interactive, then cached) and
  //    attach the token to every request via an OAuthClientProvider.
  //  - plain http: connect to a hosted streamable-http MCP at server.url. The
  //    hosted server owns its own auth; only optional static headers are sent.
  //  - stdio: fetch secrets from the gateway and spawn the child with them
  //    injected into its env.
  // A pre-built transport (tests) short-circuits all of this.
  let downstream: Client;
  let oauthCleanup: (() => void) | undefined;
  if (!opts.downstreamTransport && server.transport === 'http' && server.auth === 'oauth') {
    if (!server.url) throw new Error(`server "${serverName}" uses transport "http" but has no url`);
    const storeDir = opts.oauthStoreDir ?? DEFAULT_OAUTH_STORE_DIR;
    const store = new FileOAuthStore(join(storeDir, `${serverName}.json`));

    let redirectUrl = opts.oauthRedirectUrl;
    let authorize = opts.oauthAuthorize;
    if (!authorize) {
      const loopback = await createLoopbackAuthorizer({ log });
      redirectUrl = loopback.redirectUrl;
      authorize = loopback.authorize;
      oauthCleanup = loopback.close;
    }
    if (!redirectUrl) throw new Error('oauthRedirectUrl is required when oauthAuthorize is supplied');

    const provider = new GuardOAuthProvider({ redirectUrl, clientName: `gateway-proxy-guard/${serverName}`, store, authorize });
    log(`[guard] ${serverName}: oauth http downstream → ${server.url}; policy ${server.policy ? 'active' : 'defaults-only'}`);
    const makeTransport = () =>
      new StreamableHTTPClientTransport(new URL(server.url as string), {
        authProvider: provider,
        ...(server.headers ? { requestInit: { headers: server.headers } } : {}),
      });
    try {
      ({ client: downstream } = await connectHttpWithOAuth(makeTransport, provider, clientInfo, log));
    } finally {
      oauthCleanup?.();
    }
  } else {
    let downstreamTransport = opts.downstreamTransport;
    if (!downstreamTransport) {
      if (server.transport === 'http') {
        if (!server.url) throw new Error(`server "${serverName}" uses transport "http" but has no url`);
        log(`[guard] ${serverName}: http downstream → ${server.url}; policy ${server.policy ? 'active' : 'defaults-only'}`);
        downstreamTransport = new StreamableHTTPClientTransport(
          new URL(server.url),
          server.headers ? { requestInit: { headers: server.headers } } : undefined,
        );
      } else {
        const gatewayUrl = opts.gatewayUrl ?? environ.GATEWAY_URL ?? manifest.gatewayUrl;
        const consumerKey = resolveConsumerKey(manifest, server, environ);
        const injected = await fetchInjectedEnv(server, { gatewayUrl, consumerKey, fetchFn: opts.fetchFn });
        log(`[guard] ${serverName}: injected ${injected.fetched.length} secret(s); policy ${server.policy ? 'active' : 'defaults-only'}`);
        const childEnv = buildChildEnv(manifest, serverName, injected, environ);
        downstreamTransport = new StdioClientTransport({
          command: server.command as string,
          args: server.args,
          env: childEnv as Record<string, string>,
          stderr: 'inherit',
        });
      }
    }
    downstream = new Client(clientInfo, { capabilities: {} });
    await downstream.connect(downstreamTransport);
  }

  // On a hard deny, fire a best-effort Pushover/ntfy alert from env creds.
  const alertCfg = guardAlertConfigFromEnv(environ);
  const onDeny = (ev: { tool: string; reason: string }) => {
    void sendGuardDenyAlert(alertCfg, { server: serverName, tool: ev.tool, reason: ev.reason, at: new Date().toISOString() }, opts.fetchFn)
      .then((r) => {
        if (r.errors.length) log(`[guard] alert errors: ${r.errors.join('; ')}`);
        else if (r.pushover || r.ntfy) log(`[guard] alerted deny of ${ev.tool} (pushover=${r.pushover} ntfy=${r.ntfy})`);
      })
      .catch(() => {});
  };

  const guard = buildGuardServer(downstream, policy, log, onDeny);
  await guard.connect(opts.upstreamTransport ?? new StdioServerTransport());
}
