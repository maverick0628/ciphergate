import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTargets, loadTargets } from '../src/watchdog/manifest.js';
import { watchdogConfigFromEnv, type WatchdogConfig } from '../src/watchdog/config.js';
import { probeTarget, parseTcpAddress, type ProbeResult } from '../src/watchdog/probe.js';
import { applyProbe, loadState, saveState, type TargetState } from '../src/watchdog/state.js';
import {
  formatAlert,
  eventFor,
  sendPushover,
  sendNtfy,
  recordEvent,
  dispatchAlert,
  type AlertEvent,
} from '../src/watchdog/alert.js';
import { runOnce, renderTable } from '../src/watchdog/runner.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
}

/** Stub that plays health endpoints + the Qdrant/embeddings path the watchdog hits. */
async function startStub(): Promise<{ server: Server; url: string; calls: Recorded[] }> {
  const calls: Recorded[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = req.url ?? '';
      calls.push({
        method: req.method ?? '',
        url: u,
        headers: {
          'cf-access-client-id': req.headers['cf-access-client-id'] as string | undefined,
          'cf-access-client-secret': req.headers['cf-access-client-secret'] as string | undefined,
          'content-type': req.headers['content-type'] as string | undefined,
          title: req.headers['title'] as string | undefined,
          priority: req.headers['priority'] as string | undefined,
          'api-key': req.headers['api-key'] as string | undefined,
        },
        body,
      });
      res.setHeader('Content-Type', 'application/json');
      if (u === '/healthy') return res.end(JSON.stringify({ status: 'healthy' }));
      if (u === '/unhealthy') return res.end(JSON.stringify({ status: 'starting' }));
      if (u === '/models-empty') return res.end(JSON.stringify({ data: [] }));
      if (u === '/models-one') return res.end(JSON.stringify({ data: [{ id: 'm' }] }));
      if (u === '/ok') return res.end(JSON.stringify({ ok: true }));
      if (u === '/boom') {
        res.statusCode = 502;
        return res.end('bad gateway');
      }
      if (u === '/slow') return setTimeout(() => res.end('{}'), 300);
      if (u === '/v1/embeddings') return res.end(JSON.stringify({ data: [{ embedding: Array(768).fill(0.01) }] }));
      if (u.endsWith('/points')) return res.end(JSON.stringify({ result: { status: 'acknowledged' } }));
      return res.end(JSON.stringify({}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}`, calls };
}

function cfgFor(base: string, overrides: Partial<WatchdogConfig> = {}): WatchdogConfig {
  return {
    ...watchdogConfigFromEnv({} as NodeJS.ProcessEnv),
    qdrantUrl: base,
    embedUrl: `${base}/v1`,
    ntfyUrl: `${base}/homelab-watchdog`,
    timeoutMs: 1000,
    ...overrides,
  };
}

const result = (name: string, status: ProbeResult['status'], detail = ''): ProbeResult => ({
  name,
  status,
  detail,
  latencyMs: 1,
});

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

describe('watchdog manifest', () => {
  it('parses a valid targets array', () => {
    const targets = parseTargets([
      { name: 'a', kind: 'http', url: 'http://x/health', expect: { status: 200, jsonStatus: 'healthy' } },
      { name: 'b', kind: 'tcp', url: 'tcp://host:8402' },
      { name: 'c', kind: 'access', url: 'https://x/health' },
    ]);
    expect(targets).toHaveLength(3);
    expect(targets[0].expect?.jsonStatus).toBe('healthy');
  });

  it('rejects a bad entry', () => {
    expect(() => parseTargets([{ name: 'a', kind: 'ftp', url: 'x' }])).toThrow(/kind must be one of/);
    expect(() => parseTargets([{ name: '', kind: 'http', url: 'x' }])).toThrow(/name must be/);
    expect(() => parseTargets([{ name: 'a', kind: 'http' }])).toThrow(/url must be/);
    expect(() => parseTargets([])).toThrow(/at least one target/);
    expect(() => parseTargets('nope')).toThrow(/array/);
  });

  it('rejects duplicate names', () => {
    expect(() =>
      parseTargets([
        { name: 'dup', kind: 'http', url: 'http://a' },
        { name: 'dup', kind: 'http', url: 'http://b' },
      ]),
    ).toThrow(/duplicate/);
  });

  // The real watchdog.targets.json is gitignored — it names live hosts. The
  // example is what ships, so that is what has to stay parseable.
  it('loads + validates the shipped watchdog.targets.example.json', () => {
    const targets = loadTargets(
      new URL('../watchdog.targets.example.json', import.meta.url).pathname,
    );
    expect(targets.map((t) => t.name)).toContain('gateway-rest');
    expect(targets.find((t) => t.name === 'some-tcp-service')?.kind).toBe('tcp');
    expect(targets.find((t) => t.name === 'qdrant')?.kind).toBe('http');
    expect(targets.filter((t) => t.kind === 'access')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

describe('watchdogConfigFromEnv', () => {
  it('applies homelab defaults', () => {
    const c = watchdogConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(c.qdrantUrl).toBe('http://llm-host:6333');
    expect(c.embedUrl).toBe('http://llm-host:1234/v1');
    expect(c.embedModel).toBe('text-embedding-nomic-embed-text-v2');
    expect(c.incidentsCollection).toBe('overseer_incidents');
    expect(c.outcomesCollection).toBe('overseer_outcomes');
    expect(c.failThreshold).toBe(2);
    expect(c.ntfyUrl).toBe(''); // ntfy retired 2026-06-22 — empty unless NTFY_URL is set
  });

  it('reads Pushover from spec vars or the gateway fallbacks', () => {
    expect(watchdogConfigFromEnv({ PUSHOVER_TOKEN: 't', PUSHOVER_USER: 'u' } as never).pushoverToken).toBe('t');
    const fallback = watchdogConfigFromEnv({ PUSHOVER_APP_TOKEN: 'at', PUSHOVER_USER_KEY: 'uk' } as never);
    expect(fallback.pushoverToken).toBe('at');
    expect(fallback.pushoverUser).toBe('uk');
  });
});

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

describe('parseTcpAddress', () => {
  it('parses tcp:// and bare host:port', () => {
    expect(parseTcpAddress('tcp://gateway-host:8402')).toEqual({ host: 'gateway-host', port: 8402 });
    expect(parseTcpAddress('host:1234')).toEqual({ host: 'host', port: 1234 });
  });
  it('rejects a missing port', () => {
    expect(() => parseTcpAddress('justhost')).toThrow();
  });
});

describe('probeTarget', () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  beforeAll(async () => { stub = await startStub(); });
  afterAll(async () => { await new Promise<void>((r) => stub.server.close(() => r())); });

  it('classifies 200 as ok', async () => {
    const r = await probeTarget({ name: 'h', kind: 'http', url: `${stub.url}/ok` }, cfgFor(stub.url));
    expect(r.status).toBe('ok');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('classifies a 502 as down with a `health 502` detail', async () => {
    const r = await probeTarget({ name: 'h', kind: 'http', url: `${stub.url}/boom`, expect: { status: 200 } }, cfgFor(stub.url));
    expect(r.status).toBe('down');
    expect(r.detail).toContain('health 502');
  });

  it('classifies an unreachable host as down', async () => {
    const r = await probeTarget({ name: 'h', kind: 'http', url: 'http://127.0.0.1:1/x' }, cfgFor(stub.url));
    expect(r.status).toBe('down');
    expect(r.detail).toMatch(/unreachable/);
  });

  it('classifies a timeout as down', async () => {
    const r = await probeTarget({ name: 'h', kind: 'http', url: `${stub.url}/slow`, timeoutMs: 50 }, cfgFor(stub.url));
    expect(r.status).toBe('down');
    expect(r.detail).toContain('timeout');
  });

  it('degrades a 200 whose JSON status is wrong', async () => {
    const r = await probeTarget({ name: 'h', kind: 'http', url: `${stub.url}/unhealthy`, expect: { jsonStatus: 'healthy' } }, cfgFor(stub.url));
    expect(r.status).toBe('degraded');
  });

  it('passes a 200 whose JSON status matches', async () => {
    const r = await probeTarget({ name: 'h', kind: 'http', url: `${stub.url}/healthy`, expect: { jsonStatus: 'healthy' } }, cfgFor(stub.url));
    expect(r.status).toBe('ok');
  });

  it('degrades an empty model list but passes a non-empty one', async () => {
    const empty = await probeTarget({ name: 'm', kind: 'http', url: `${stub.url}/models-empty`, expect: { minModels: 1 } }, cfgFor(stub.url));
    expect(empty.status).toBe('degraded');
    const one = await probeTarget({ name: 'm', kind: 'http', url: `${stub.url}/models-one`, expect: { minModels: 1 } }, cfgFor(stub.url));
    expect(one.status).toBe('ok');
  });

  it('sends Cloudflare Access headers for an access probe and tags edge→origin', async () => {
    const r = await probeTarget(
      { name: 'edge', kind: 'access', url: `${stub.url}/boom`, expect: { status: 200 } },
      cfgFor(stub.url, { cfAccessClientId: 'cid', cfAccessClientSecret: 'csec' }),
    );
    expect(r.status).toBe('down');
    expect(r.detail).toContain('(edge→origin)');
    const last = stub.calls.at(-1)!;
    expect(last.headers['cf-access-client-id']).toBe('cid');
    expect(last.headers['cf-access-client-secret']).toBe('csec');
  });

  it('connects over TCP for a tcp target', async () => {
    const port = new URL(stub.url).port;
    const r = await probeTarget({ name: 'tcp', kind: 'tcp', url: `tcp://127.0.0.1:${port}` }, cfgFor(stub.url));
    expect(r.status).toBe('ok');
  });

  it('marks a refused TCP port down', async () => {
    const r = await probeTarget({ name: 'tcp', kind: 'tcp', url: 'tcp://127.0.0.1:1' }, cfgFor(stub.url));
    expect(r.status).toBe('down');
  });
});

// ---------------------------------------------------------------------------
// state transitions
// ---------------------------------------------------------------------------

describe('applyProbe transitions', () => {
  const T = 2;
  const ok = (name = 'svc') => result(name, 'ok', '200');
  const down = (name = 'svc') => result(name, 'down', 'health 502');

  it('emits nothing when an ok target stays ok', () => {
    const prev: TargetState = { status: 'ok', failures: 0, lastStatus: 'ok', detail: '200', since: 'x' };
    expect(applyProbe(prev, ok(), T, 'now').kind).toBe('none');
  });

  it('flap-dampens: one failure is not yet down', () => {
    const t = applyProbe({ status: 'ok', failures: 0, lastStatus: 'ok', detail: '', since: 'x' }, down(), T, 'now');
    expect(t.kind).toBe('none');
    expect(t.next.status).toBe('ok');
    expect(t.next.failures).toBe(1);
  });

  it('fires an incident on the second consecutive failure', () => {
    const afterOne: TargetState = { status: 'ok', failures: 1, lastStatus: 'down', detail: '', since: 'x' };
    const t = applyProbe(afterOne, down(), T, 'now');
    expect(t.kind).toBe('incident');
    expect(t.next.status).toBe('down');
  });

  it('does not re-alert while already down', () => {
    const downState: TargetState = { status: 'down', failures: 2, lastStatus: 'down', detail: '', since: 'x' };
    expect(applyProbe(downState, down(), T, 'now').kind).toBe('none');
  });

  it('fires a recovery on down→ok', () => {
    const downState: TargetState = { status: 'down', failures: 3, lastStatus: 'down', detail: '', since: 'x' };
    const t = applyProbe(downState, ok(), T, 'now');
    expect(t.kind).toBe('recovery');
    expect(t.next.status).toBe('ok');
    expect(t.next.failures).toBe(0);
  });

  it('treats an unseen target as previously ok (down still dampened)', () => {
    const first = applyProbe(undefined, down(), T, 'now');
    expect(first.kind).toBe('none');
    const second = applyProbe(first.next, down(), T, 'now');
    expect(second.kind).toBe('incident');
  });

  it('a single failure with threshold 1 fires immediately', () => {
    const t = applyProbe(undefined, down(), 1, 'now');
    expect(t.kind).toBe('incident');
  });
});

describe('state file persistence', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'wd-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns empty state for a missing file', () => {
    expect(loadState(join(dir, 'nope.json')).targets).toEqual({});
  });

  it('round-trips and creates the parent directory', () => {
    const path = join(dir, 'nested', 'state.json');
    saveState(path, { version: 1, targets: { svc: { status: 'down', failures: 2, lastStatus: 'down', detail: 'x', since: 'now' } } });
    expect(existsSync(path)).toBe(true);
    expect(loadState(path).targets.svc.status).toBe('down');
  });
});

// ---------------------------------------------------------------------------
// alert dispatch
// ---------------------------------------------------------------------------

describe('formatAlert', () => {
  it('formats a down incident', () => {
    const a = formatAlert({ name: 'vector-db', kind: 'incident', status: 'down', detail: 'health 502 (edge→origin)', at: 'now' });
    expect(a.message).toBe('⛔ vector-db DOWN — health 502 (edge→origin)');
    expect(a.pushoverPriority).toBe(1);
    expect(a.ntfyPriority).toBe('high');
  });
  it('formats a degraded incident', () => {
    const a = formatAlert({ name: 'lm-studio', kind: 'incident', status: 'degraded', detail: '0 models', at: 'now' });
    expect(a.message).toContain('DEGRADED');
  });
  it('formats a recovery', () => {
    const a = formatAlert({ name: 'vector-db', kind: 'recovery', status: 'ok', detail: '', at: 'now' });
    expect(a.message).toBe('✅ vector-db recovered');
    expect(a.pushoverPriority).toBe(0);
    expect(a.ntfyPriority).toBe('default');
  });
});

describe('eventFor', () => {
  it('drops non-transitions and keeps incidents/recoveries', () => {
    const base = { name: 'x', status: 'down' as const, detail: 'd', next: {} as TargetState };
    expect(eventFor({ ...base, kind: 'none' }, 'now')).toBeNull();
    expect(eventFor({ ...base, kind: 'incident' }, 'now')?.kind).toBe('incident');
  });
});

describe('alert sinks against a stub', () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  beforeAll(async () => { stub = await startStub(); });
  afterAll(async () => { await new Promise<void>((r) => stub.server.close(() => r())); });

  const incident: AlertEvent = { name: 'vector-db', kind: 'incident', status: 'down', detail: 'health 502', at: '2026-06-29T00:00:00Z' };

  it('skips Pushover with no credentials', async () => {
    expect(await sendPushover(cfgFor(stub.url), formatAlert(incident))).toBe(false);
  });

  it('POSTs the Pushover form when credentialed', async () => {
    const cfg = cfgFor('https://api.pushover.net', { pushoverToken: 'tok', pushoverUser: 'usr' });
    const seen: { url: string; body: string } = { url: '', body: '' };
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.url = String(url);
      seen.body = String(init?.body ?? '');
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await sendPushover(cfg, formatAlert(incident), fakeFetch)).toBe(true);
    expect(seen.url).toBe('https://api.pushover.net/1/messages.json');
    const form = new URLSearchParams(seen.body);
    expect(form.get('token')).toBe('tok');
    expect(form.get('user')).toBe('usr');
    expect(form.get('priority')).toBe('1');
    expect(form.get('message')).toContain('vector-db DOWN');
  });

  it('POSTs ntfy with title + priority headers', async () => {
    await sendNtfy(cfgFor(stub.url), formatAlert(incident));
    const last = stub.calls.at(-1)!;
    expect(last.url).toBe('/homelab-watchdog');
    expect(last.headers.priority).toBe('high');
    expect(last.headers.title).toContain('vector-db');
    expect(last.body).toContain('DOWN');
  });

  it('skips ntfy with no topic configured', async () => {
    const before = stub.calls.length;
    expect(await sendNtfy(cfgFor(stub.url, { ntfyUrl: '' }), formatAlert(incident))).toBe(false);
    expect(stub.calls.length).toBe(before); // never POSTed
  });

  it('records an incident as an un-named-vector Qdrant point with a summary payload', async () => {
    const { collection } = await recordEvent(cfgFor(stub.url), incident);
    expect(collection).toBe('overseer_incidents');
    const upsert = stub.calls.find((c) => c.method === 'PUT' && c.url.includes('overseer_incidents'))!;
    const sent = JSON.parse(upsert.body);
    expect(Array.isArray(sent.points[0].vector)).toBe(true); // top-level (un-named) vector
    expect(sent.points[0].vector).toHaveLength(768);
    expect(sent.points[0].payload.summary).toContain('vector-db');
    expect(sent.points[0].payload.source).toBe('watchdog');
  });

  it('records a recovery into the outcomes collection', async () => {
    const recovery: AlertEvent = { name: 'vector-db', kind: 'recovery', status: 'ok', detail: '', at: 'now' };
    const { collection } = await recordEvent(cfgFor(stub.url), recovery);
    expect(collection).toBe('overseer_outcomes');
  });

  it('dispatchAlert fans out best-effort and collects sink errors', async () => {
    // ntfy URL points nowhere; pushover has no creds; qdrant works via the stub.
    const cfg = cfgFor(stub.url, { ntfyUrl: 'http://127.0.0.1:1/topic' });
    const res = await dispatchAlert(cfg, incident);
    expect(res.recorded).toBe(true);
    expect(res.pushover).toBe(false);
    expect(res.ntfy).toBe(false);
    expect(res.errors.some((e) => e.startsWith('ntfy:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runner integration
// ---------------------------------------------------------------------------

describe('runOnce integration', () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  let dir: string;
  beforeAll(async () => { stub = await startStub(); dir = mkdtempSync(join(tmpdir(), 'wd-run-')); });
  afterAll(async () => { await new Promise<void>((r) => stub.server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });

  it('probes all targets, persists state, and dampens then fires an incident', async () => {
    const statePath = join(dir, 'state.json');
    const cfg = cfgFor(stub.url, { statePath });
    const targets = [
      { name: 'good', kind: 'http' as const, url: `${stub.url}/ok` },
      { name: 'bad', kind: 'http' as const, url: `${stub.url}/boom`, expect: { status: 200 } },
    ];

    // Sweep 1: bad is down once → dampened, no incident yet.
    const s1 = await runOnce(cfg, { targets, dispatch: false });
    expect(s1.results.find((r) => r.name === 'good')?.status).toBe('ok');
    expect(s1.results.find((r) => r.name === 'bad')?.status).toBe('down');
    expect(s1.events).toHaveLength(0);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).targets.bad.failures).toBe(1);

    // Sweep 2: second consecutive failure → incident.
    const s2 = await runOnce(cfg, { targets, dispatch: false });
    expect(s2.events).toHaveLength(1);
    expect(s2.events[0].event.kind).toBe('incident');
    expect(s2.events[0].event.name).toBe('bad');
  });

  it('renders an aligned table', () => {
    const table = renderTable([result('vector-db', 'ok', '200'), result('letta', 'down', 'unreachable')]);
    expect(table).toMatch(/NAME/);
    expect(table).toMatch(/vector-db/);
    expect(table).toMatch(/letta/);
  });
});
