import { readFileSync } from 'node:fs';

/**
 * Watchdog target manifest.
 *
 * Describes the homelab endpoints the watchdog probes each sweep — MCP servers,
 * the gateway REST API, Qdrant/LM-Studio/Letta, and the Cloudflare edge→tunnel
 * paths. Kept in an editable JSON file (`watchdog.targets.json`) so the inventory
 * changes without a rebuild — same loader shape as `src/proxy/manifest.ts`.
 *
 * Probe kinds:
 *   http   — GET the url; assert status (+ optional body checks in `expect`).
 *   access — like http, but send the Cloudflare Access service-token headers so
 *            the probe exercises the full edge→tunnel→origin path, not the LAN.
 *   tcp    — open a TCP connection to host:port; a successful connect = ok.
 *            For services with no /health endpoint (e.g. mcp-server-qdrant).
 */
export type ProbeKind = 'http' | 'access' | 'tcp';

/**
 * Health assertions layered on top of the status-code check. All optional; an
 * empty `expect` means "200 (or `status`) is healthy". Each failed assertion
 * downgrades a reachable target to `degraded` rather than `down`.
 */
export interface TargetExpect {
  /** Required HTTP status (default 200). */
  status?: number;
  /** Require the JSON body's `.status` field to equal this (e.g. "healthy"). */
  jsonStatus?: string;
  /** Require the JSON body's `.data` array (OpenAI /v1/models) to have ≥ this length. */
  minModels?: number;
  /** Require the raw response body to contain this substring. */
  bodyIncludes?: string;
}

export interface WatchdogTarget {
  /** Stable identifier, used as the state key and in alerts. */
  name: string;
  kind: ProbeKind;
  /** http/access: the URL to GET. tcp: a `tcp://host:port` or `host:port` address. */
  url: string;
  /** Optional health assertions beyond reachability. */
  expect?: TargetExpect;
  /** Per-target probe timeout in ms (default from config). */
  timeoutMs?: number;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Invalid watchdog manifest: ${msg}`);
}

const KINDS: ProbeKind[] = ['http', 'access', 'tcp'];

function parseExpect(raw: unknown, where: string): TargetExpect | undefined {
  if (raw === undefined) return undefined;
  assert(typeof raw === 'object' && raw !== null && !Array.isArray(raw), `${where}.expect must be an object`);
  const e = raw as Record<string, unknown>;
  assert(e.status === undefined || (typeof e.status === 'number' && Number.isInteger(e.status)), `${where}.expect.status must be an integer`);
  assert(e.jsonStatus === undefined || typeof e.jsonStatus === 'string', `${where}.expect.jsonStatus must be a string`);
  assert(e.minModels === undefined || (typeof e.minModels === 'number' && e.minModels >= 0), `${where}.expect.minModels must be a non-negative number`);
  assert(e.bodyIncludes === undefined || typeof e.bodyIncludes === 'string', `${where}.expect.bodyIncludes must be a string`);
  return {
    status: e.status as number | undefined,
    jsonStatus: e.jsonStatus as string | undefined,
    minModels: e.minModels as number | undefined,
    bodyIncludes: e.bodyIncludes as string | undefined,
  };
}

/** Parse + validate a raw manifest (array of targets). Throws on any problem. */
export function parseTargets(raw: unknown): WatchdogTarget[] {
  assert(Array.isArray(raw), 'must be a JSON array of targets');
  assert(raw.length > 0, 'must define at least one target');

  const seen = new Set<string>();
  return raw.map((tRaw, i) => {
    const where = `target[${i}]`;
    assert(typeof tRaw === 'object' && tRaw !== null && !Array.isArray(tRaw), `${where} must be an object`);
    const t = tRaw as Record<string, unknown>;
    assert(typeof t.name === 'string' && t.name.length > 0, `${where}.name must be a non-empty string`);
    assert(!seen.has(t.name), `duplicate target name "${t.name}"`);
    seen.add(t.name as string);
    assert(typeof t.kind === 'string' && KINDS.includes(t.kind as ProbeKind), `${where}.kind must be one of ${KINDS.join(' | ')}`);
    assert(typeof t.url === 'string' && t.url.length > 0, `${where}.url must be a non-empty string`);
    assert(t.timeoutMs === undefined || (typeof t.timeoutMs === 'number' && t.timeoutMs > 0), `${where}.timeoutMs must be a positive number`);
    return {
      name: t.name as string,
      kind: t.kind as ProbeKind,
      url: t.url as string,
      expect: parseExpect(t.expect, where),
      timeoutMs: t.timeoutMs as number | undefined,
    };
  });
}

/** Load + parse the targets manifest from a JSON file. */
export function loadTargets(path: string): WatchdogTarget[] {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read watchdog manifest at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Watchdog manifest at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseTargets(parsed);
}
