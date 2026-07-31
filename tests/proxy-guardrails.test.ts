import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildGuardServer } from '../src/proxy/guard.js';
import { compilePolicy, parseServerPolicy, type ServerPolicy } from '../src/proxy/policy.js';
import { parseManifest } from '../src/proxy/manifest.js';
import { formatDenyMessage, sendGuardDenyAlert, guardAlertConfigFromEnv } from '../src/proxy/alert.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const loadPolicy = (rel: string): ServerPolicy =>
  parseServerPolicy(JSON.parse(readFileSync(resolve(repoRoot, rel), 'utf8')), rel);

const coinbase = loadPolicy('policies/coinbase.policy.json');
const robinhood = loadPolicy('policies/robinhood-trading.policy.json');

// ---------------------------------------------------------------------------
// the shipped policy files: default-deny shape
// ---------------------------------------------------------------------------

describe('coinbase.policy.json', () => {
  it('allows reads/quotes/lists but never money-moving tools', () => {
    const allow = new Set(coinbase.allowTools);
    for (const t of ['coinbase_products_ticker', 'coinbase_orders_list', 'coinbase_balance', 'coinbase_orders_preview']) {
      expect(allow.has(t)).toBe(true);
    }
    for (const t of [
      'coinbase_orders_create', 'coinbase_orders_edit', 'coinbase_orders_cancel',
      'coinbase_orders_close_position', 'coinbase_convert_execute', 'coinbase_transfer',
      'coinbase_portfolios_create', 'coinbase_portfolios_delete', 'coinbase_set_env',
    ]) {
      expect(allow.has(t)).toBe(false); // denied by omission (default-deny)
    }
  });
});

describe('robinhood-trading.policy.json', () => {
  it('allows reads/reviews/scans but never order placement or cancellation', () => {
    const allow = new Set(robinhood.allowTools);
    for (const t of ['get_equity_quotes', 'get_equity_positions', 'review_equity_order', 'run_scan']) {
      expect(allow.has(t)).toBe(true);
    }
    for (const t of ['place_equity_order', 'place_option_order', 'cancel_equity_order', 'cancel_option_order']) {
      expect(allow.has(t)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// the policies enforced through the real guard bridge (acceptance 1-3)
// ---------------------------------------------------------------------------

/** A fake coinbase MCP server: one read (ticker), one balance, one trade. */
function makeFakeCoinbase(): Server {
  const s = new Server({ name: 'coinbase-fake', version: '1.0.0' }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'coinbase_products_ticker', description: 'price', inputSchema: { type: 'object' } },
      { name: 'coinbase_balance', description: 'balances', inputSchema: { type: 'object' } },
      { name: 'coinbase_orders_create', description: 'place an order', inputSchema: { type: 'object' } },
      { name: 'coinbase_brand_new_tool', description: 'a tool added in a server update', inputSchema: { type: 'object' } },
    ],
  }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'coinbase_products_ticker') {
      return { content: [{ type: 'text', text: '{"product_id":"BTC-USD","price":"64000.00"}' }] };
    }
    if (req.params.name === 'coinbase_balance') {
      return {
        content: [
          { type: 'text', text: '{"account":"main","available_balance":{"value":"12345.67","currency":"USD"},"api_key":"organizations/abc/apiKeys/xyz"}' },
        ],
      };
    }
    // Should never be reached for a denied tool.
    return { content: [{ type: 'text', text: '{"filled":true}' }] };
  });
  return s;
}

async function wireGuard(policy: ServerPolicy, onDeny?: (ev: { tool: string; reason: string }) => void) {
  const [dsServerT, dsClientT] = InMemoryTransport.createLinkedPair();
  const downstream = makeFakeCoinbase();
  await downstream.connect(dsServerT);
  const dsClient = new Client({ name: 'dc', version: '1.0.0' }, { capabilities: {} });
  await dsClient.connect(dsClientT);

  const guard = buildGuardServer(dsClient, compilePolicy(policy), () => {}, onDeny);
  const [guardT, testT] = InMemoryTransport.createLinkedPair();
  await guard.connect(guardT);
  const client = new Client({ name: 'tc', version: '1.0.0' }, { capabilities: {} });
  await client.connect(testT);
  return client;
}

describe('coinbase policy through the guard', () => {
  it('hides denied tools from tools/list (allowlist filter)', async () => {
    const client = await wireGuard(coinbase);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('coinbase_products_ticker');
    expect(names).toContain('coinbase_balance');
    expect(names).not.toContain('coinbase_orders_create');
    expect(names).not.toContain('coinbase_brand_new_tool'); // acceptance 3: new tool denied until allowlisted
  });

  it('allows a read and fires NO deny alert', async () => {
    let denied = false;
    const client = await wireGuard(coinbase, () => { denied = true; });
    const res = await client.callTool({ name: 'coinbase_products_ticker', arguments: {} });
    expect((res.content as Array<{ text: string }>)[0].text).toContain('64000');
    expect(res.isError).toBeFalsy();
    expect(denied).toBe(false);
  });

  it('redacts balances and api keys from an allowed read (acceptance 2)', async () => {
    const client = await wireGuard(coinbase);
    const text = (await client.callTool({ name: 'coinbase_balance', arguments: {} }) as { content: Array<{ text: string }> }).content[0].text;
    expect(text).not.toContain('12345.67');
    expect(text).not.toContain('organizations/abc');
    expect(text).toContain('[REDACTED]');
  });

  it('denies a trade without reaching downstream and fires a deny alert (acceptance 1)', async () => {
    const events: Array<{ tool: string; reason: string }> = [];
    const client = await wireGuard(coinbase, (ev) => events.push(ev));
    const res = await client.callTool({ name: 'coinbase_orders_create', arguments: { side: 'BUY', size: '1' } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/Blocked by gateway-proxy guard/);
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('coinbase_orders_create');
    expect(events[0].reason).toMatch(/allowlist/);
  });

  it('denies a brand-new server tool until it is allowlisted (acceptance 3)', async () => {
    const client = await wireGuard(coinbase);
    const res = await client.callTool({ name: 'coinbase_brand_new_tool', arguments: {} });
    expect(res.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// policyFile loading through the manifest (the deliverable wiring)
// ---------------------------------------------------------------------------

describe('manifest policyFile loading', () => {
  it('loads policies/*.json relative to the manifest baseDir', () => {
    const manifest = parseManifest(
      {
        version: 1,
        gatewayUrl: 'http://x:8400',
        servers: { coinbase: { command: 'c', args: [], policyFile: 'policies/coinbase.policy.json' } },
      },
      repoRoot,
    );
    expect(manifest.servers.coinbase.policy?.allowTools).toContain('coinbase_balance');
    expect(manifest.servers.coinbase.policyFile).toBe('policies/coinbase.policy.json');
  });

  it('rejects setting both policy and policyFile', () => {
    expect(() =>
      parseManifest({
        version: 1,
        gatewayUrl: 'http://x:8400',
        servers: { s: { command: 'c', args: [], policy: { allowTools: ['a'] }, policyFile: 'p.json' } },
      }, repoRoot),
    ).toThrow(/either policy or policyFile/);
  });

  it('errors clearly when the policyFile is missing', () => {
    expect(() =>
      parseManifest({
        version: 1,
        gatewayUrl: 'http://x:8400',
        servers: { s: { command: 'c', args: [], policyFile: 'policies/nope.json' } },
      }, repoRoot),
    ).toThrow(/cannot be read/);
  });

  it('the shipped example manifest parses and wires both trading policies', () => {
    const text = readFileSync(resolve(repoRoot, 'proxy-manifest.example.json'), 'utf8');
    const manifest = parseManifest(JSON.parse(text), repoRoot);
    expect(manifest.servers['coinbase'].policy?.allowTools).toBeTruthy();
    expect(manifest.servers['robinhood-trading'].policy?.allowTools).toContain('get_equity_quotes');
  });
});

// ---------------------------------------------------------------------------
// deny alert dispatch
// ---------------------------------------------------------------------------

describe('guard deny alert', () => {
  it('formats a high-signal deny message', () => {
    const { title, message } = formatDenyMessage({ server: 'coinbase', tool: 'coinbase_transfer', reason: 'not in the allowlist', at: 't' });
    expect(title).toContain('coinbase');
    expect(message).toContain('coinbase_transfer');
    expect(message).toContain('DENY');
  });

  it('POSTs Pushover with high priority when creds are present', async () => {
    let seen: { url: string; body: string } | null = null;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen = { url: String(url), body: String(init?.body) };
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await sendGuardDenyAlert(
      { pushoverToken: 'tok', pushoverUser: 'usr' },
      { server: 'coinbase', tool: 'coinbase_orders_create', reason: 'denied', at: 't' },
      fetchFn,
    );
    expect(r.pushover).toBe(true);
    expect(seen!.url).toContain('pushover.net');
    expect(seen!.body).toContain('priority=1');
    expect(decodeURIComponent(seen!.body)).toContain('coinbase_orders_create');
  });

  it('no-ops without creds and never throws', async () => {
    const r = await sendGuardDenyAlert(guardAlertConfigFromEnv({} as NodeJS.ProcessEnv), { server: 's', tool: 't', reason: 'r', at: 'a' });
    expect(r).toEqual({ pushover: false, ntfy: false, errors: [] });
  });
});
