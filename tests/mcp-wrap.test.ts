import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';

const run = promisify(execFile);
const WRAP = join(process.cwd(), 'scripts', 'mcp-wrap');

/** Stub gateway batch endpoint: returns canned secrets, records the auth header. */
async function startStub(): Promise<{ server: Server; url: string; lastAuth: () => string | undefined }> {
  let lastAuth: string | undefined;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastAuth = req.headers['authorization'] as string | undefined;
      res.setHeader('Content-Type', 'application/json');
      const { names } = JSON.parse(body || '{}') as { names: string[] };
      const known: Record<string, string> = {
        LETTA_SERVER_PASSWORD: "p@ss'with-quote",
        N8N_API_KEY: 'n8n-key-123',
      };
      const secrets = names.filter((n) => known[n] !== undefined).map((n) => ({ name: n, value: known[n], version: 1 }));
      const missing = names.filter((n) => known[n] === undefined);
      res.end(JSON.stringify({ secrets, missing, denied: [] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}`, lastAuth: () => lastAuth };
}

describe('mcp-wrap', () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  beforeAll(async () => { stub = await startStub(); });
  afterAll(async () => { await new Promise<void>((r) => stub.server.close(() => r())); });

  const env = (extra: Record<string, string>) => ({
    ...process.env,
    GATEWAY_URL: stub.url,
    GATEWAY_CONSUMER_KEY: 'consumer-key',
    ...extra,
  });

  it('injects a fetched secret into the exec\'d command\'s env', async () => {
    // The wrapped command prints the injected env var back out.
    const { stdout } = await run(WRAP, ['N8N_API_KEY', 'node', '-e', 'process.stdout.write(process.env.N8N_API_KEY||"")'], { env: env({}) });
    expect(stdout).toBe('n8n-key-123');
  });

  it('forwards the consumer key as a Bearer token', async () => {
    await run(WRAP, ['N8N_API_KEY', 'node', '-e', '0'], { env: env({}) });
    expect(stub.lastAuth()).toBe('Bearer consumer-key');
  });

  it('handles values containing shell metacharacters safely', async () => {
    const { stdout } = await run(WRAP, ['LETTA_SERVER_PASSWORD', 'node', '-e', 'process.stdout.write(process.env.LETTA_SERVER_PASSWORD||"")'], { env: env({}) });
    expect(stdout).toBe("p@ss'with-quote");
  });

  it('injects multiple comma-separated secrets', async () => {
    const { stdout } = await run(WRAP, ['LETTA_SERVER_PASSWORD,N8N_API_KEY', 'node', '-e', 'process.stdout.write([process.env.LETTA_SERVER_PASSWORD,process.env.N8N_API_KEY].join("|"))'], { env: env({}) });
    expect(stdout).toBe("p@ss'with-quote|n8n-key-123");
  });

  it('fails closed (non-zero) when a requested secret is missing', async () => {
    await expect(
      run(WRAP, ['DOES_NOT_EXIST', 'node', '-e', '0'], { env: env({}) }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('missing: DOES_NOT_EXIST') });
  });

  it('errors when GATEWAY_URL is unset', async () => {
    const e = { ...process.env, GATEWAY_CONSUMER_KEY: 'k' };
    delete (e as Record<string, string | undefined>).GATEWAY_URL;
    await expect(run(WRAP, ['N8N_API_KEY', 'node', '-e', '0'], { env: e })).rejects.toMatchObject({
      stderr: expect.stringContaining('GATEWAY_URL is not set'),
    });
  });
});
