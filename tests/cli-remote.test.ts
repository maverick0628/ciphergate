import { describe, it, expect, beforeEach } from 'vitest';
import { RemoteClient, getRemoteConfigFromEnv } from '../src/cli-remote.js';

// ── Test helper: a minimal fetch mock ─────────────────────────────────────────

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface MockResponse {
  status: number;
  body?: unknown;
  contentType?: string;
}

function makeFetchMock(responses: MockResponse[]): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const headers: Record<string, string> = {};
    const initHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(initHeaders)) headers[k] = v;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body as string | undefined,
    });
    const res = responses[i++];
    if (!res) throw new Error(`No mock response queued for call ${i} to ${url}`);
    const ct = res.contentType ?? (typeof res.body === 'string' ? 'text/plain' : 'application/json');
    const bodyText = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? {});
    return new Response(res.status === 204 ? null : bodyText, {
      status: res.status,
      headers: { 'content-type': ct },
    }) as unknown as Response;
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

// ── getRemoteConfigFromEnv ────────────────────────────────────────────────────

describe('getRemoteConfigFromEnv', () => {
  beforeEach(() => {
    delete process.env.GATEWAY_URL;
    delete process.env.GATEWAY_CONSUMER_KEY;
  });

  it('returns null when GATEWAY_URL is unset', () => {
    expect(getRemoteConfigFromEnv()).toBeNull();
  });

  it('returns config when both env vars are set', () => {
    process.env.GATEWAY_URL = 'http://example.com:8400';
    process.env.GATEWAY_CONSUMER_KEY = 'abc123';
    expect(getRemoteConfigFromEnv()).toEqual({ url: 'http://example.com:8400', apiKey: 'abc123' });
  });

  it('strips trailing slashes from URL', () => {
    process.env.GATEWAY_URL = 'http://example.com:8400///';
    process.env.GATEWAY_CONSUMER_KEY = 'abc';
    expect(getRemoteConfigFromEnv()?.url).toBe('http://example.com:8400');
  });

  it('throws when GATEWAY_URL is set but GATEWAY_CONSUMER_KEY is missing', () => {
    process.env.GATEWAY_URL = 'http://example.com:8400';
    expect(() => getRemoteConfigFromEnv()).toThrow(/GATEWAY_CONSUMER_KEY/);
  });
});

// ── RemoteClient ──────────────────────────────────────────────────────────────

describe('RemoteClient', () => {
  const cfg = { url: 'http://gw:8400', apiKey: 'test-key' };

  it('sends Bearer token auth header on every request', async () => {
    const { fetch, calls } = makeFetchMock([{ status: 200, body: { value: 'v', version: 1 } }]);
    const client = new RemoteClient(cfg, fetch);
    await client.getSecret('FOO');
    expect(calls[0].headers.Authorization).toBe('Bearer test-key');
  });

  it('getSecret hits GET /v1/secret/:name and returns parsed body', async () => {
    const { fetch, calls } = makeFetchMock([{ status: 200, body: { name: 'FOO', value: 'bar', version: 3 } }]);
    const client = new RemoteClient(cfg, fetch);
    const result = await client.getSecret('FOO');
    expect(calls[0].url).toBe('http://gw:8400/v1/secret/FOO');
    expect(calls[0].method).toBe('GET');
    expect(result).toEqual({ name: 'FOO', value: 'bar', version: 3 });
  });

  it('createSecret POSTs to /v1/secret with JSON body', async () => {
    const { fetch, calls } = makeFetchMock([{ status: 201, body: { name: 'FOO', version: 1 } }]);
    const client = new RemoteClient(cfg, fetch);
    await client.createSecret({ name: 'FOO', value: 'bar', consumers: ['n8n'], tags: ['prod'] });
    expect(calls[0].url).toBe('http://gw:8400/v1/secret');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].body!)).toEqual({ name: 'FOO', value: 'bar', consumers: ['n8n'], tags: ['prod'] });
  });

  it('updateSecret PUTs to /v1/secret/:name', async () => {
    const { fetch, calls } = makeFetchMock([{ status: 200, body: { version: 2 } }]);
    const client = new RemoteClient(cfg, fetch);
    await client.updateSecret('FOO', { value: 'newval' });
    expect(calls[0].url).toBe('http://gw:8400/v1/secret/FOO');
    expect(calls[0].method).toBe('PUT');
    expect(JSON.parse(calls[0].body!)).toEqual({ value: 'newval' });
  });

  it('listSecrets GETs /v1/secrets and forwards tag filter', async () => {
    const { fetch, calls } = makeFetchMock([{ status: 200, body: { secrets: [{ name: 'A', version: 1, updated_at: 't', tags: ['p'], consumers: [] }] } }]);
    const client = new RemoteClient(cfg, fetch);
    const result = await client.listSecrets('prod');
    expect(calls[0].url).toBe('http://gw:8400/v1/secrets?tag=prod');
    expect(result.secrets).toHaveLength(1);
  });

  it('deleteSecret DELETEs /v1/secret/:name and resolves on 204', async () => {
    const { fetch, calls } = makeFetchMock([{ status: 204 }]);
    const client = new RemoteClient(cfg, fetch);
    await client.deleteSecret('FOO');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe('http://gw:8400/v1/secret/FOO');
  });

  it('getEnv GETs /v1/env and returns text body', async () => {
    const { fetch, calls } = makeFetchMock([{ status: 200, body: 'A=1\nB=2\n', contentType: 'text/plain' }]);
    const client = new RemoteClient(cfg, fetch);
    const result = await client.getEnv({ tag: 'infra', names: ['A', 'B'] });
    expect(calls[0].url).toBe('http://gw:8400/v1/env?tag=infra&names=A%2CB');
    expect(result).toBe('A=1\nB=2\n');
  });

  it('getHistory hits /v1/secret/:name/history', async () => {
    const { fetch, calls } = makeFetchMock([{ status: 200, body: { name: 'FOO', current_version: 2, history: [] } }]);
    const client = new RemoteClient(cfg, fetch);
    await client.getHistory('FOO');
    expect(calls[0].url).toBe('http://gw:8400/v1/secret/FOO/history');
  });

  it('rotationReport hits /v1/rotation-report', async () => {
    const { fetch, calls } = makeFetchMock([{ status: 200, body: { overdue: [], due: [], ok: [] } }]);
    const client = new RemoteClient(cfg, fetch);
    await client.rotationReport();
    expect(calls[0].url).toBe('http://gw:8400/v1/rotation-report');
  });

  it('getAudit forwards limit/consumer/since query params', async () => {
    const { fetch, calls } = makeFetchMock([{ status: 200, body: { entries: [] } }]);
    const client = new RemoteClient(cfg, fetch);
    await client.getAudit({ limit: 25, consumer: 'n8n', since: '2026-01-01' });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe('/v1/audit');
    expect(u.searchParams.get('limit')).toBe('25');
    expect(u.searchParams.get('consumer')).toBe('n8n');
    expect(u.searchParams.get('since')).toBe('2026-01-01');
  });

  it('throws with HTTP status and server message on non-2xx JSON error', async () => {
    const { fetch } = makeFetchMock([{ status: 401, body: { error: 'unauthorized', message: 'Invalid or missing API key' } }]);
    const client = new RemoteClient(cfg, fetch);
    await expect(client.getSecret('FOO')).rejects.toThrow(/HTTP 401.*Invalid or missing API key/);
  });

  it('secretExists returns true on 200', async () => {
    const { fetch } = makeFetchMock([{ status: 200, body: { value: 'v', version: 1 } }]);
    const client = new RemoteClient(cfg, fetch);
    expect(await client.secretExists('FOO')).toBe(true);
  });

  it('secretExists returns false on 404', async () => {
    const { fetch } = makeFetchMock([{ status: 404, body: { error: 'not_found', message: 'not found' } }]);
    const client = new RemoteClient(cfg, fetch);
    expect(await client.secretExists('FOO')).toBe(false);
  });

  it('secretExists rethrows on non-404 errors', async () => {
    const { fetch } = makeFetchMock([{ status: 500, body: { message: 'oops' } }]);
    const client = new RemoteClient(cfg, fetch);
    await expect(client.secretExists('FOO')).rejects.toThrow(/HTTP 500/);
  });
});
