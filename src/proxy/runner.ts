import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { ProxyManifest } from './manifest.js';
import { fetchInjectedEnv, resolveConsumerKey, type InjectionResult } from './injector.js';

export interface RunOptions {
  /** Override the manifest's gatewayUrl (e.g. from GATEWAY_URL). */
  gatewayUrl?: string;
  environ?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  /** Injectable spawn for tests. */
  spawnFn?: typeof spawn;
  /** Log sink (defaults to stderr so it never pollutes the stdio MCP stream). */
  log?: (msg: string) => void;
}

/**
 * Build the env the downstream child should run with.
 *
 * Order of precedence (later wins): inherited process env → static server.env
 * → injected secrets. The gateway consumer key env vars are stripped so the
 * downstream server can never read the gateway credential itself.
 */
export function buildChildEnv(
  manifest: ProxyManifest,
  serverName: string,
  injected: InjectionResult,
  environ: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const server = manifest.servers[serverName];
  const stripped = new Set<string>([manifest.consumerKeyEnv]);
  if (server.consumerKeyEnv) stripped.add(server.consumerKeyEnv);

  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(environ)) {
    if (!stripped.has(k)) base[k] = v;
  }
  return { ...base, ...(server.env ?? {}), ...injected.env };
}

/**
 * Fetch a server's secrets from the gateway and spawn it as a transparent
 * stdio MCP child with those secrets injected. Returns the child process.
 *
 * The child inherits stdio, so an MCP client (e.g. Claude Code) that launches
 * `gateway-proxy run <name>` talks to the downstream server directly while the
 * proxy only ever brokers credentials.
 */
export async function runServer(
  manifest: ProxyManifest,
  serverName: string,
  opts: RunOptions = {},
): Promise<ChildProcess> {
  const environ = opts.environ ?? process.env;
  const log = opts.log ?? ((m: string) => process.stderr.write(m + '\n'));
  const server = manifest.servers[serverName];
  if (!server) {
    throw new Error(`No server "${serverName}" in manifest. Available: ${Object.keys(manifest.servers).join(', ')}`);
  }
  if (server.transport === 'http' || !server.command) {
    throw new Error(`Server "${serverName}" uses the http transport; "run" only supports stdio servers. Use "gateway-proxy guard ${serverName}" instead.`);
  }
  const command = server.command;

  const gatewayUrl = opts.gatewayUrl ?? environ.GATEWAY_URL ?? manifest.gatewayUrl;
  const consumerKey = resolveConsumerKey(manifest, server, environ);

  const injected = await fetchInjectedEnv(server, { gatewayUrl, consumerKey, fetchFn: opts.fetchFn });
  log(`[gateway-proxy] ${serverName}: injected ${injected.fetched.length} secret(s) → ${Object.keys(injected.env).join(', ') || '(none)'}`);

  const childEnv = buildChildEnv(manifest, serverName, injected, environ);
  const spawnFn = opts.spawnFn ?? spawn;
  const spawnOpts: SpawnOptions = { stdio: 'inherit', env: childEnv };
  const child = spawnFn(command, server.args, spawnOpts);

  child.on('error', (err) => log(`[gateway-proxy] ${serverName} failed to start: ${err.message}`));
  return child;
}
