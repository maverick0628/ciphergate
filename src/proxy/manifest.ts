import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { parseServerPolicy, type ServerPolicy } from './policy.js';

/**
 * Scoped-injector manifest.
 *
 * Describes downstream MCP servers and the gateway secrets each one needs. The
 * proxy fetches those secrets at launch and injects them as env vars into the
 * child process — so the downstream server (qdrant-mcp, n8n-mcp, letta, …)
 * never stores credentials, and every fetch flows through the gateway's audit
 * log + Pushover alerts. Modelled on the homelab-agent scoped-mcp pattern.
 */
export interface ProxyServer {
  /**
   * Downstream transport. `stdio` (default) spawns {@link command}/{@link args}
   * as a child with secrets injected; `http` connects to a hosted
   * streamable-http MCP at {@link url} (e.g. Robinhood's agent.robinhood.com).
   */
  transport: 'stdio' | 'http';
  /** Executable to spawn (stdio transport only), e.g. "uvx" or "npx". */
  command?: string;
  /** Arguments to the executable (stdio transport only); `[]` for http. */
  args: string[];
  /** Hosted streamable-http MCP endpoint (http transport only). */
  url?: string;
  /** Static headers sent on every http downstream request (http transport only). */
  headers?: Record<string, string>;
  /**
   * Opt an http server into OAuth (http transport only). `oauth` runs the PKCE
   * authorization-code flow against the resource_metadata-advertised
   * authorization server (RFC 9728 / MCP auth) and caches tokens locally — used
   * for hosted MCPs like Robinhood that 401 unauthenticated requests.
   */
  auth?: 'oauth';
  /**
   * Map of gateway secret name → target env var name injected into the child.
   * e.g. { "QDRANT_API_KEY": "QDRANT_API_KEY", "OPENAI_API_KEY": "EMBEDDING_API_KEY" }.
   */
  secrets: Record<string, string>;
  /** Static, non-secret env vars to set on the child (e.g. QDRANT_URL). */
  env?: Record<string, string>;
  /** Env var holding this server's gateway consumer key; overrides the top-level default. */
  consumerKeyEnv?: string;
  /** Optional guard policy (tool allowlist, arg filtering, response redaction) for `gateway-proxy guard`. */
  policy?: ServerPolicy;
  /**
   * Path to a standalone policy JSON file (a {@link ServerPolicy}), resolved
   * relative to the manifest. Lets the risky-server policies live as reviewable
   * `policies/*.policy.json` files instead of inline. Mutually exclusive with
   * `policy`.
   */
  policyFile?: string;
}

export interface ProxyManifest {
  version: 1;
  /** Gateway REST base URL. Overridable per-invocation by GATEWAY_URL. */
  gatewayUrl: string;
  /** Default env var holding the gateway consumer key (default: GATEWAY_PROXY_KEY). */
  consumerKeyEnv: string;
  servers: Record<string, ProxyServer>;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Invalid manifest: ${msg}`);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === 'string')
  );
}

/** Load + parse a standalone ServerPolicy file, resolved relative to `baseDir`. */
function loadPolicyFile(file: string, baseDir: string, label: string): ServerPolicy {
  const path = resolvePath(baseDir, file);
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Invalid manifest: ${label}.policyFile cannot be read at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid manifest: ${label}.policyFile at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseServerPolicy(parsed, `${label}.policyFile`);
}

/**
 * Parse + validate a raw manifest object. Throws on any structural problem.
 *
 * `baseDir` resolves any `policyFile` references (the directory of the manifest);
 * defaults to the cwd for callers that pass an already-inlined manifest.
 */
export function parseManifest(raw: unknown, baseDir: string = process.cwd()): ProxyManifest {
  assert(typeof raw === 'object' && raw !== null, 'must be a JSON object');
  const obj = raw as Record<string, unknown>;

  assert(obj.version === 1, 'version must be 1');
  assert(typeof obj.gatewayUrl === 'string' && obj.gatewayUrl.length > 0, 'gatewayUrl must be a non-empty string');

  const consumerKeyEnv = obj.consumerKeyEnv === undefined ? 'GATEWAY_PROXY_KEY' : obj.consumerKeyEnv;
  assert(typeof consumerKeyEnv === 'string' && consumerKeyEnv.length > 0, 'consumerKeyEnv must be a non-empty string');

  assert(typeof obj.servers === 'object' && obj.servers !== null && !Array.isArray(obj.servers), 'servers must be an object');
  const serversRaw = obj.servers as Record<string, unknown>;
  assert(Object.keys(serversRaw).length > 0, 'servers must define at least one server');

  const servers: Record<string, ProxyServer> = {};
  for (const [name, sRaw] of Object.entries(serversRaw)) {
    assert(typeof sRaw === 'object' && sRaw !== null, `server "${name}" must be an object`);
    const s = sRaw as Record<string, unknown>;

    const transport = s.transport === undefined ? 'stdio' : s.transport;
    assert(transport === 'stdio' || transport === 'http', `server "${name}".transport must be "stdio" or "http"`);

    if (transport === 'http') {
      assert(typeof s.url === 'string' && s.url.length > 0, `server "${name}".url must be a non-empty string for transport "http"`);
      assert(s.command === undefined && s.args === undefined, `server "${name}" uses transport "http" and must not set command/args`);
      assert(s.headers === undefined || isStringRecord(s.headers), `server "${name}".headers must be a map of string→string`);
      assert(s.auth === undefined || s.auth === 'oauth', `server "${name}".auth must be "oauth" if set`);
    } else {
      assert(typeof s.command === 'string' && s.command.length > 0, `server "${name}".command must be a non-empty string`);
      assert(Array.isArray(s.args) && s.args.every((a) => typeof a === 'string'), `server "${name}".args must be a string array`);
      assert(s.url === undefined, `server "${name}" uses transport "stdio" and must not set url`);
      assert(s.auth === undefined, `server "${name}" uses transport "stdio" and must not set auth`);
    }
    assert(s.secrets === undefined || isStringRecord(s.secrets), `server "${name}".secrets must be a map of string→string`);
    assert(s.env === undefined || isStringRecord(s.env), `server "${name}".env must be a map of string→string`);
    assert(s.consumerKeyEnv === undefined || (typeof s.consumerKeyEnv === 'string' && s.consumerKeyEnv.length > 0), `server "${name}".consumerKeyEnv must be a non-empty string`);

    assert(
      s.policyFile === undefined || (typeof s.policyFile === 'string' && s.policyFile.length > 0),
      `server "${name}".policyFile must be a non-empty string`,
    );
    assert(
      !(s.policy !== undefined && s.policyFile !== undefined),
      `server "${name}" must set either policy or policyFile, not both`,
    );

    // Validates structure + compiles any regexes; throws on a bad policy.
    const policy =
      s.policyFile !== undefined
        ? loadPolicyFile(s.policyFile as string, baseDir, `server "${name}"`)
        : parseServerPolicy(s.policy, `server "${name}"`);

    servers[name] = {
      transport: transport as 'stdio' | 'http',
      command: transport === 'stdio' ? (s.command as string) : undefined,
      args: transport === 'stdio' ? (s.args as string[]) : [],
      url: transport === 'http' ? (s.url as string) : undefined,
      headers: transport === 'http' ? (s.headers as Record<string, string> | undefined) : undefined,
      auth: transport === 'http' ? (s.auth as 'oauth' | undefined) : undefined,
      secrets: (s.secrets as Record<string, string>) ?? {},
      env: s.env as Record<string, string> | undefined,
      consumerKeyEnv: s.consumerKeyEnv as string | undefined,
      policy: Object.keys(policy).length > 0 ? policy : undefined,
      policyFile: s.policyFile as string | undefined,
    };
  }

  return { version: 1, gatewayUrl: obj.gatewayUrl, consumerKeyEnv, servers };
}

/** Load + parse a manifest from a JSON file. */
export function loadManifest(path: string): ProxyManifest {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read manifest at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Manifest at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  // Resolve any policyFile references relative to the manifest's own directory.
  return parseManifest(parsed, dirname(resolvePath(path)));
}
