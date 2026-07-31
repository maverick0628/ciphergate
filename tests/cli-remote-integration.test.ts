import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Test helpers ──────────────────────────────────────────────────────────────

interface MockResponse {
  status: number;
  body?: unknown;
  contentType?: string;
}

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

function installFetchMock(responses: MockResponse[]): { calls: RecordedCall[]; restore: () => void } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const headers: Record<string, string> = {};
    const initHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(initHeaders)) headers[k] = v;
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined, headers });
    const res = responses[i++];
    if (!res) throw new Error(`No mock response for call ${i} to ${url}`);
    const ct = res.contentType ?? (typeof res.body === 'string' ? 'text/plain' : 'application/json');
    const bodyText = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? {});
    return new Response(res.status === 204 ? null : bodyText, {
      status: res.status,
      headers: { 'content-type': ct },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function runCLI(args: string[]) {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(' '));

  const { program } = await import('../src/cli.js');

  let exitCode = 0;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  }) as (code?: number) => never);

  try {
    await program.parseAsync(['node', 'gateway', ...args]);
  } catch (e: unknown) {
    const err = e as Error & { code?: string };
    if (err?.code === 'commander.helpDisplayed' || err?.message?.startsWith('process.exit(')) {
      // expected
    } else {
      throw e;
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
    exitSpy.mockRestore();
  }

  return { stdout: logs.join('\n'), stderr: errs.join('\n'), exitCode };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CLI in remote mode (GATEWAY_URL set)', () => {
  beforeEach(() => {
    process.env.GATEWAY_URL = 'http://gw:8400';
    process.env.GATEWAY_CONSUMER_KEY = 'test-key';
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.GATEWAY_URL;
    delete process.env.GATEWAY_CONSUMER_KEY;
    vi.resetModules();
  });

  describe('secret set', () => {
    it('POSTs to /v1/secret when secret does not exist (404 from probe)', async () => {
      const mock = installFetchMock([
        { status: 404, body: { error: 'not_found', message: 'not found' } }, // existence probe
        { status: 201, body: { name: 'NEW_KEY', version: 1 } },              // create
      ]);
      try {
        const { stdout, exitCode } = await runCLI(['secret', 'set', 'NEW_KEY', '--value', 'v1', '--consumers', 'n8n', '--tags', 'prod']);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Secret 'NEW_KEY' created");
        expect(mock.calls[1].method).toBe('POST');
        expect(mock.calls[1].url).toBe('http://gw:8400/v1/secret');
        expect(JSON.parse(mock.calls[1].body!)).toMatchObject({ name: 'NEW_KEY', value: 'v1', consumers: ['n8n'], tags: ['prod'] });
      } finally { mock.restore(); }
    });

    it('PUTs to /v1/secret/:name when secret already exists', async () => {
      const mock = installFetchMock([
        { status: 200, body: { name: 'EXISTING', value: 'old', version: 1 } }, // existence probe
        { status: 200, body: { version: 2 } },                                  // update
      ]);
      try {
        const { stdout, exitCode } = await runCLI(['secret', 'set', 'EXISTING', '--value', 'newv']);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Secret 'EXISTING' updated");
        expect(mock.calls[1].method).toBe('PUT');
        expect(mock.calls[1].url).toBe('http://gw:8400/v1/secret/EXISTING');
      } finally { mock.restore(); }
    });

    it('forwards Bearer token on every call', async () => {
      const mock = installFetchMock([
        { status: 404, body: {} },
        { status: 201, body: {} },
      ]);
      try {
        await runCLI(['secret', 'set', 'KEY', '--value', 'v']);
        for (const c of mock.calls) expect(c.headers.Authorization).toBe('Bearer test-key');
      } finally { mock.restore(); }
    });
  });

  describe('secret get', () => {
    it('GETs /v1/secret/:name and prints value', async () => {
      const mock = installFetchMock([{ status: 200, body: { name: 'API_KEY', value: 'sk-abc', version: 1 } }]);
      try {
        const { stdout, exitCode } = await runCLI(['secret', 'get', 'API_KEY']);
        expect(exitCode).toBe(0);
        expect(stdout).toBe('sk-abc');
        expect(mock.calls[0].url).toBe('http://gw:8400/v1/secret/API_KEY');
      } finally { mock.restore(); }
    });

    it('exits 1 with server error message on 404', async () => {
      const mock = installFetchMock([{ status: 404, body: { error: 'not_found', message: 'Secret not found' } }]);
      try {
        const { stderr, exitCode } = await runCLI(['secret', 'get', 'MISSING']);
        expect(exitCode).toBe(1);
        expect(stderr).toContain('Secret not found');
      } finally { mock.restore(); }
    });
  });

  describe('secret list', () => {
    it('GETs /v1/secrets and renders rows', async () => {
      const mock = installFetchMock([{
        status: 200,
        body: { secrets: [
          { name: 'A', version: 1, updated_at: '2026-01-01', tags: ['p'], consumers: ['n8n'] },
          { name: 'B', version: 3, updated_at: '2026-02-01', tags: [], consumers: [] },
        ] },
      }]);
      try {
        const { stdout, exitCode } = await runCLI(['secret', 'list']);
        expect(exitCode).toBe(0);
        expect(stdout).toContain('A  v1');
        expect(stdout).toContain('B  v3');
      } finally { mock.restore(); }
    });
  });

  describe('secret delete', () => {
    it('DELETEs /v1/secret/:name and prints confirmation', async () => {
      const mock = installFetchMock([{ status: 204 }]);
      try {
        const { stdout, exitCode } = await runCLI(['secret', 'delete', 'GOODBYE']);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Secret 'GOODBYE' deleted");
        expect(mock.calls[0].method).toBe('DELETE');
      } finally { mock.restore(); }
    });
  });

  describe('env', () => {
    it('GETs /v1/env and writes lines to stdout', async () => {
      const mock = installFetchMock([{ status: 200, body: 'A=1\nB=2\n', contentType: 'text/plain' }]);
      try {
        const { stdout, exitCode } = await runCLI(['env']);
        expect(exitCode).toBe(0);
        expect(stdout).toContain('A=1');
        expect(stdout).toContain('B=2');
      } finally { mock.restore(); }
    });
  });

  describe('local-only commands are rejected in remote mode', () => {
    it.each([
      ['init'],
      ['consumer', 'add', 'foo'],
      ['consumer', 'list'],
      ['backup', '--output', '/tmp/x.db'],
      ['restore', '/tmp/x.db'],
    ])('rejects: gateway %s', async (...args) => {
      const mock = installFetchMock([]);
      try {
        const { stderr, exitCode } = await runCLI(args);
        expect(exitCode).toBe(1);
        expect(stderr).toMatch(/local|not available in remote mode/i);
        expect(mock.calls).toHaveLength(0);
      } finally { mock.restore(); }
    });
  });

  describe('config validation', () => {
    it('errors when GATEWAY_URL is set but GATEWAY_CONSUMER_KEY is missing', async () => {
      delete process.env.GATEWAY_CONSUMER_KEY;
      const { stderr, exitCode } = await runCLI(['secret', 'get', 'FOO']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('GATEWAY_CONSUMER_KEY');
    });
  });
});
