import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startMcpHttpServer } from '../src/mcp/stateful-http-server.js';
import { buildGuardServer, startGuard } from '../src/proxy/guard.js';
import { compilePolicy, parseServerPolicy, type ServerPolicy } from '../src/proxy/policy.js';
import { parseManifest, type ProxyManifest } from '../src/proxy/manifest.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const loadPolicy = (rel: string): ServerPolicy =>
  parseServerPolicy(JSON.parse(readFileSync(resolve(repoRoot, rel), 'utf8')), rel);

const robinhood = loadPolicy('policies/robinhood-trading.policy.json');

// ---------------------------------------------------------------------------
// A fake hosted Robinhood MCP, served over real streamable-http. Records which
// tools the guard actually forwarded so we can prove a denied trade never
// reaches the downstream server.
// ---------------------------------------------------------------------------

const reached: string[] = [];

function makeFakeRobinhood(): Server {
  const s = new Server({ name: 'robinhood-fake', version: '1.0.0' }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'get_equity_quotes', description: 'quote', inputSchema: { type: 'object' } },
      { name: 'get_accounts', description: 'accounts', inputSchema: { type: 'object' } },
      { name: 'place_equity_order', description: 'place an order', inputSchema: { type: 'object' } },
      { name: 'cancel_equity_order', description: 'cancel an order', inputSchema: { type: 'object' } },
      { name: 'robinhood_brand_new_tool', description: 'added in a server update', inputSchema: { type: 'object' } },
    ],
  }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    reached.push(req.params.name);
    if (req.params.name === 'get_equity_quotes') {
      return { content: [{ type: 'text', text: '{"symbol":"AAPL","last_trade_price":"212.34"}' }] };
    }
    if (req.params.name === 'get_accounts') {
      return {
        content: [
          { type: 'text', text: '{"account_number":"5QR12345","buying_power":"1000.00","account_url":"https://api.robinhood.com/accounts/5QR12345/"}' },
        ],
      };
    }
    // A trade tool — must never be reached for a denied call.
    return { content: [{ type: 'text', text: '{"state":"filled","id":"ORDER_PLACED"}' }] };
  });
  return s;
}

let http: HttpServer;
let mcpUrl: string;
/** Every downstream client opened by a test, closed in teardown so sockets drain. */
const opened: Client[] = [];

beforeAll(async () => {
  http = startMcpHttpServer(() => makeFakeRobinhood(), { host: '127.0.0.1', port: 0, log: () => {} });
  await new Promise<void>((r) => http.on('listening', () => r()));
  const port = (http.address() as AddressInfo).port;
  mcpUrl = `http://127.0.0.1:${port}/mcp`;
});

afterAll(async () => {
  await Promise.allSettled(opened.map((c) => c.close()));
  http.closeAllConnections();
  await new Promise<void>((r) => http.close(() => r()));
});

/** Wire fake-http-downstream ⇄ guard ⇄ test-client over a REAL streamable-http transport. */
async function wireHttpGuard(policy: ServerPolicy, onDeny?: (ev: { tool: string; reason: string }) => void) {
  const downstream = new Client({ name: 'dc', version: '1.0.0' }, { capabilities: {} });
  await downstream.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  opened.push(downstream);

  const guard = buildGuardServer(downstream, compilePolicy(policy), () => {}, onDeny);
  const [guardT, testT] = InMemoryTransport.createLinkedPair();
  await guard.connect(guardT);
  const client = new Client({ name: 'tc', version: '1.0.0' }, { capabilities: {} });
  await client.connect(testT);
  return { client, downstream };
}

// ---------------------------------------------------------------------------
// manifest: http transport parsing (url + transport instead of command/args)
// ---------------------------------------------------------------------------

describe('manifest http transport', () => {
  it('parses an http server with url + transport and no command', () => {
    const m = parseManifest(
      {
        version: 1,
        gatewayUrl: 'http://x:8400',
        servers: {
          'robinhood-trading': {
            transport: 'http',
            url: 'https://agent.robinhood.com/mcp/trading',
            policyFile: 'policies/robinhood-trading.policy.json',
          },
        },
      },
      repoRoot,
    );
    const s = m.servers['robinhood-trading'];
    expect(s.transport).toBe('http');
    expect(s.url).toBe('https://agent.robinhood.com/mcp/trading');
    expect(s.command).toBeUndefined();
    expect(s.args).toEqual([]);
    expect(s.policy?.allowTools).toContain('get_equity_quotes');
  });

  it('defaults transport to stdio and still requires a command', () => {
    const m = parseManifest(
      { version: 1, gatewayUrl: 'http://x:8400', servers: { c: { command: 'coinbase', args: ['mcp'] } } },
      repoRoot,
    );
    expect(m.servers.c.transport).toBe('stdio');
  });

  it('rejects an http server with no url', () => {
    expect(() =>
      parseManifest(
        { version: 1, gatewayUrl: 'http://x:8400', servers: { r: { transport: 'http' } } },
        repoRoot,
      ),
    ).toThrow(/url/);
  });

  it('rejects an http server that also sets a command', () => {
    expect(() =>
      parseManifest(
        { version: 1, gatewayUrl: 'http://x:8400', servers: { r: { transport: 'http', url: 'http://h/mcp', command: 'x', args: [] } } },
        repoRoot,
      ),
    ).toThrow(/command/);
  });

  it('rejects an unknown transport value', () => {
    expect(() =>
      parseManifest(
        { version: 1, gatewayUrl: 'http://x:8400', servers: { r: { transport: 'grpc', url: 'http://h/mcp' } } },
        repoRoot,
      ),
    ).toThrow(/transport/);
  });

  it('rejects a stdio server with no command (unchanged)', () => {
    expect(() =>
      parseManifest({ version: 1, gatewayUrl: 'http://x:8400', servers: { s: { args: [] } } }, repoRoot),
    ).toThrow(/command/);
  });
});

// ---------------------------------------------------------------------------
// robinhood policy enforced through the guard over a real http downstream
// ---------------------------------------------------------------------------

describe('robinhood policy through the guard (http downstream)', () => {
  it('hides trade + unknown tools from tools/list (allowlist filter)', async () => {
    const { client } = await wireHttpGuard(robinhood);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('get_equity_quotes');
    expect(names).toContain('get_accounts');
    expect(names).not.toContain('place_equity_order');
    expect(names).not.toContain('cancel_equity_order');
    expect(names).not.toContain('robinhood_brand_new_tool');
  });

  it('allows a read and fires NO deny alert', async () => {
    let denied = false;
    const { client } = await wireHttpGuard(robinhood, () => { denied = true; });
    const res = await client.callTool({ name: 'get_equity_quotes', arguments: { symbol: 'AAPL' } });
    expect((res.content as Array<{ text: string }>)[0].text).toContain('212.34');
    expect(res.isError).toBeFalsy();
    expect(denied).toBe(false);
  });

  it('redacts account numbers from an allowed read', async () => {
    const { client } = await wireHttpGuard(robinhood);
    const text = (await client.callTool({ name: 'get_accounts', arguments: {} }) as { content: Array<{ text: string }> }).content[0].text;
    expect(text).not.toContain('5QR12345');
    expect(text).toContain('[REDACTED]');
  });

  it('denies a trade without reaching downstream and fires a deny alert', async () => {
    reached.length = 0;
    const events: Array<{ tool: string; reason: string }> = [];
    const { client } = await wireHttpGuard(robinhood, (ev) => events.push(ev));
    const res = await client.callTool({ name: 'place_equity_order', arguments: { symbol: 'AAPL', side: 'buy', quantity: 1 } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/Blocked by gateway-proxy guard/);
    expect(reached).not.toContain('place_equity_order');
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('place_equity_order');
    expect(events[0].reason).toMatch(/allowlist/);
  });

  it('denies a brand-new server tool until it is allowlisted', async () => {
    const { client } = await wireHttpGuard(robinhood);
    const res = await client.callTool({ name: 'robinhood_brand_new_tool', arguments: {} });
    expect(res.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// startGuard end-to-end over http: the real production path (manifest → http
// downstream transport → guard), no command, no secret injection.
// ---------------------------------------------------------------------------

describe('startGuard over an http downstream', () => {
  async function startHttpGuard(): Promise<Client> {
    const manifest: ProxyManifest = parseManifest(
      {
        version: 1,
        gatewayUrl: 'http://unused:8400',
        servers: {
          'robinhood-trading': { transport: 'http', url: mcpUrl, policyFile: 'policies/robinhood-trading.policy.json' },
        },
      },
      repoRoot,
    );
    const [guardT, testT] = InMemoryTransport.createLinkedPair();
    await startGuard(manifest, 'robinhood-trading', { upstreamTransport: guardT, log: () => {} });
    const client = new Client({ name: 'tc', version: '1.0.0' }, { capabilities: {} });
    await client.connect(testT);
    return client;
  }

  it('forwards an allowed read and blocks a trade through the built http transport', async () => {
    const client = await startHttpGuard();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('get_equity_quotes');
    expect(names).not.toContain('place_equity_order');

    const ok = await client.callTool({ name: 'get_equity_quotes', arguments: { symbol: 'AAPL' } });
    expect((ok.content as Array<{ text: string }>)[0].text).toContain('212.34');

    const blocked = await client.callTool({ name: 'place_equity_order', arguments: { symbol: 'AAPL', side: 'buy', quantity: 1 } });
    expect(blocked.isError).toBe(true);
  });
});
