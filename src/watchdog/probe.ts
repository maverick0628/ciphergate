/**
 * Probe a single watchdog target and classify it `ok | degraded | down`.
 *
 *   down     — unreachable (connection refused, DNS failure, timeout) or a wrong
 *              HTTP status. The real homelab failure modes: a dead container, a
 *              wrong IP, a broken tunnel returning 502.
 *   degraded — reachable with the expected status, but a health assertion failed
 *              (e.g. LM Studio answers 200 with zero models, or a /health body
 *              isn't `{"status":"healthy"}`). It's up but not serving.
 *   ok       — reachable, expected status, all assertions pass.
 *
 * Probes are a single attempt with no internal retry — flap dampening lives in
 * state.ts so a transient blip never fires an alert on its own.
 */
import { connect } from 'node:net';
import type { WatchdogTarget } from './manifest.js';
import type { WatchdogConfig } from './config.js';

export type ProbeStatus = 'ok' | 'degraded' | 'down';

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  /** Short human reason, used verbatim in the alert message (e.g. `health 502`). */
  detail: string;
  latencyMs: number;
}

/** Parse a tcp target address (`tcp://host:port` or `host:port`) into host/port. */
export function parseTcpAddress(url: string): { host: string; port: number } {
  const cleaned = url.replace(/^tcp:\/\//, '');
  const idx = cleaned.lastIndexOf(':');
  if (idx <= 0) throw new Error(`tcp target needs host:port, got "${url}"`);
  const host = cleaned.slice(0, idx);
  const port = Number(cleaned.slice(idx + 1));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`tcp target has a bad port: "${url}"`);
  return { host, port };
}

/** Evaluate the health assertions for an http/access response. Returns null if all pass. */
async function evaluateExpect(target: WatchdogTarget, res: Response): Promise<string | null> {
  const expect = target.expect ?? {};
  const wantStatus = expect.status ?? 200;
  if (res.status !== wantStatus) {
    return `health ${res.status}`;
  }
  const needsBody = expect.jsonStatus !== undefined || expect.minModels !== undefined || expect.bodyIncludes !== undefined;
  if (!needsBody) return null;

  const text = await res.text();
  if (expect.bodyIncludes !== undefined && !text.includes(expect.bodyIncludes)) {
    return `body missing "${expect.bodyIncludes}"`;
  }
  if (expect.jsonStatus !== undefined || expect.minModels !== undefined) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return 'non-JSON body';
    }
    const obj = (body ?? {}) as Record<string, unknown>;
    if (expect.jsonStatus !== undefined && obj.status !== expect.jsonStatus) {
      return `status=${JSON.stringify(obj.status)} (want "${expect.jsonStatus}")`;
    }
    if (expect.minModels !== undefined) {
      const data = obj.data;
      const n = Array.isArray(data) ? data.length : 0;
      if (n < expect.minModels) return `${n} models (want ≥${expect.minModels})`;
    }
  }
  return null;
}

async function probeHttp(
  target: WatchdogTarget,
  cfg: WatchdogConfig,
  fetchFn: typeof fetch,
): Promise<{ status: ProbeStatus; detail: string }> {
  const headers: Record<string, string> = {};
  const isEdge = target.kind === 'access';
  if (isEdge) {
    if (cfg.cfAccessClientId) headers['CF-Access-Client-Id'] = cfg.cfAccessClientId;
    if (cfg.cfAccessClientSecret) headers['CF-Access-Client-Secret'] = cfg.cfAccessClientSecret;
  }
  const suffix = isEdge ? ' (edge→origin)' : '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), target.timeoutMs ?? cfg.timeoutMs);
  try {
    const res = await fetchFn(target.url, { headers, signal: controller.signal });
    const fail = await evaluateExpect(target, res);
    if (fail === null) {
      return { status: 'ok', detail: `${res.status}` };
    }
    // A wrong status is a hard `down`; a soft assertion failure is `degraded`.
    if (fail.startsWith('health ')) {
      return { status: 'down', detail: `${fail}${suffix}` };
    }
    return { status: 'degraded', detail: `${fail}${suffix}` };
  } catch (err) {
    const e = err as Error;
    const reason = e.name === 'AbortError' ? 'timeout' : (e.cause as Error | undefined)?.message || e.message;
    return { status: 'down', detail: `unreachable: ${reason}${suffix}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeTcp(
  target: WatchdogTarget,
  cfg: WatchdogConfig,
): Promise<{ status: ProbeStatus; detail: string }> {
  const { host, port } = parseTcpAddress(target.url);
  const timeoutMs = target.timeoutMs ?? cfg.timeoutMs;
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (status: ProbeStatus, detail: string) => {
      socket.destroy();
      resolve({ status, detail });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done('ok', `tcp ${host}:${port}`));
    socket.once('timeout', () => done('down', 'unreachable: timeout'));
    socket.once('error', (err) => done('down', `unreachable: ${(err as Error).message}`));
  });
}

/** Probe one target. Never throws — a failure is a `down` result. */
export async function probeTarget(
  target: WatchdogTarget,
  cfg: WatchdogConfig,
  fetchFn: typeof fetch = fetch,
): Promise<ProbeResult> {
  const t0 = Date.now();
  const { status, detail } =
    target.kind === 'tcp' ? await probeTcp(target, cfg) : await probeHttp(target, cfg, fetchFn);
  return { name: target.name, status, detail, latencyMs: Date.now() - t0 };
}
