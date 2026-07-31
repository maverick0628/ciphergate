import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpMcpServer, extractConsumerKey } from '../src/mcp/http-transport.js';

/** Records the Authorization header it last saw and returns canned secrets. */
async function startStubGateway(): Promise<{ server: Server; url: string; lastAuth: () => string | undefined }> {
  let lastAuth: string | undefined;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    lastAuth = req.headers['authorization'];
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/v1/secret/')) {
      const name = decodeURIComponent(req.url.replace('/v1/secret/', '').split('?')[0]);
      return res.end(JSON.stringify({ name, value: 's3cret-of-' + name, masked: '****', version: 3 }));
    }
    if (req.url?.startsWith('/v1/secrets')) {
      return res.end(JSON.stringify({ secrets: [{ name: 'FOO' }, { name: 'BAR' }] }));
    }
    if (req.url?.startsWith('/v1/rotation-report')) {
      return res.end(JSON.stringify({ entries: [] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}`, lastAuth: () => lastAuth };
}

describe('extractConsumerKey', () => {
  it('reads Authorization: Bearer', () => {
    expect(extractConsumerKey({ authorization: 'Bearer abc123' })).toBe('abc123');
  });
  it('reads X-API-Key', () => {
    expect(extractConsumerKey({ 'x-api-key': 'def456' })).toBe('def456');
  });
  it('prefers Bearer over X-API-Key when both present', () => {
    expect(extractConsumerKey({ authorization: 'Bearer abc', 'x-api-key': 'def' })).toBe('abc');
  });
  it('returns null when neither present or empty', () => {
    expect(extractConsumerKey({})).toBeNull();
    expect(extractConsumerKey({ authorization: 'Bearer ' })).toBeNull();
  });
});

describe('streamable-http MCP transport', () => {
  let stub: ReturnType<typeof startStubGateway>;
  let mcp: Server;
  let mcpUrl: string;

  beforeAll(async () => {
    stub = await startStubGateway();
    mcp = startHttpMcpServer({ gatewayUrl: stub.url, host: '127.0.0.1', port: 0, log: () => {} });
    await new Promise<void>((r) => mcp.on('listening', () => r()));
    const port = (mcp.address() as AddressInfo).port;
    mcpUrl = `http://127.0.0.1:${port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => mcp.close(() => r()));
    await new Promise<void>((r) => stub.server.close(() => r()));
  });

  async function connect(headers?: Record<string, string>): Promise<Client> {
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: headers ? { headers } : undefined,
    });
    await client.connect(transport);
    return client;
  }

  it('lists the 4 gateway tools over HTTP with a header-supplied key', async () => {
    const client = await connect({ 'X-API-Key': 'consumer-key-1' });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_env', 'get_secret', 'list_secrets', 'rotation_report']);
    await client.close();
  });

  it('proxies get_secret using the per-session key as the upstream Bearer token', async () => {
    const client = await connect({ Authorization: 'Bearer consumer-key-2' });
    const result = await client.callTool({ name: 'get_secret', arguments: { name: 'OPENAI_API_KEY' } });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('s3cret-of-OPENAI_API_KEY');
    // The header-supplied key must be forwarded to the REST API as a Bearer token.
    expect(stub.lastAuth()).toBe('Bearer consumer-key-2');
    await client.close();
  });

  it('rejects a request with no consumer key', async () => {
    await expect(connect()).rejects.toThrow();
  });
});
