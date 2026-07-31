import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startGuard } from '../src/proxy/guard.js';
import { parseServerPolicy, type ServerPolicy } from '../src/proxy/policy.js';
import { parseManifest, type ProxyManifest } from '../src/proxy/manifest.js';
import { startFakeOAuthMcp, type FakeOAuthServer } from './helpers/fake-oauth-mcp.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const loadPolicy = (rel: string): ServerPolicy =>
  parseServerPolicy(JSON.parse(readFileSync(resolve(repoRoot, rel), 'utf8')), rel);
const robinhoodPolicy = loadPolicy('policies/robinhood-trading.policy.json');

const reached: string[] = [];

function makeFakeRobinhood(): Server {
  const s = new Server({ name: 'robinhood-fake', version: '1.0.0' }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'get_equity_quotes', description: 'quote', inputSchema: { type: 'object' } },
      { name: 'get_accounts', description: 'accounts', inputSchema: { type: 'object' } },
      { name: 'place_equity_order', description: 'place an order', inputSchema: { type: 'object' } },
      { name: 'cancel_equity_order', description: 'cancel an order', inputSchema: { type: 'object' } },
    ],
  }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    reached.push(req.params.name);
    if (req.params.name === 'get_equity_quotes') {
      return { content: [{ type: 'text', text: '{"symbol":"AAPL","last_trade_price":"212.34"}' }] };
    }
    return { content: [{ type: 'text', text: '{"state":"filled","id":"ORDER_PLACED"}' }] };
  });
  return s;
}

/** Simulate the user-agent consent leg: hit /authorize, follow the 302, return the code. */
let authorizeCalls = 0;
async function driveAuthorize(authorizationUrl: URL): Promise<string> {
  authorizeCalls += 1;
  const res = await fetch(authorizationUrl, { redirect: 'manual' });
  const loc = res.headers.get('location');
  if (!loc) throw new Error(`authorize did not redirect (status ${res.status})`);
  const code = new URL(loc).searchParams.get('code');
  if (!code) throw new Error('no code in redirect');
  return code;
}

let fake: FakeOAuthServer;
let storeDir: string;

beforeEach(async () => {
  reached.length = 0;
  authorizeCalls = 0;
  fake = await startFakeOAuthMcp(makeFakeRobinhood);
  storeDir = mkdtempSync(join(tmpdir(), 'sg-oauth-'));
});

afterEach(async () => {
  await fake.close();
  rmSync(storeDir, { recursive: true, force: true });
});

function oauthManifest(): ProxyManifest {
  return parseManifest(
    {
      version: 1,
      gatewayUrl: 'http://unused:8400',
      servers: {
        'robinhood-trading': { transport: 'http', url: fake.mcpUrl, auth: 'oauth', policyFile: 'policies/robinhood-trading.policy.json' },
      },
    },
    repoRoot,
  );
}

async function startOauthGuard(): Promise<Client> {
  const [guardT, testT] = InMemoryTransport.createLinkedPair();
  await startGuard(oauthManifest(), 'robinhood-trading', {
    upstreamTransport: guardT,
    log: () => {},
    oauthAuthorize: driveAuthorize,
    oauthRedirectUrl: 'http://127.0.0.1:8765/callback',
    oauthStoreDir: storeDir,
  });
  const client = new Client({ name: 'tc', version: '1.0.0' }, { capabilities: {} });
  await client.connect(testT);
  return client;
}

describe('robinhood guard over an OAuth-protected http downstream', () => {
  it('runs the PKCE flow, then lists reads and hides trade tools', async () => {
    const client = await startOauthGuard();
    expect(authorizeCalls).toBe(1);
    expect(fake.state.registrations).toBe(1);
    expect(fake.state.tokenGrants).toEqual(['authorization_code']);

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('get_equity_quotes');
    expect(names).toContain('get_accounts');
    expect(names).not.toContain('place_equity_order');
    expect(names).not.toContain('cancel_equity_order');
  });

  it('forwards an allowed read against the authenticated endpoint', async () => {
    const client = await startOauthGuard();
    const res = await client.callTool({ name: 'get_equity_quotes', arguments: { symbol: 'AAPL' } });
    expect((res.content as Array<{ text: string }>)[0].text).toContain('212.34');
    expect(res.isError).toBeFalsy();
  });

  it('denies a trade without reaching the downstream server', async () => {
    const client = await startOauthGuard();
    const res = await client.callTool({ name: 'place_equity_order', arguments: { symbol: 'AAPL', side: 'buy', quantity: 1 } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/Blocked by gateway-proxy guard/);
    expect(reached).not.toContain('place_equity_order');
  });

  it('persists tokens so a second run skips the interactive flow', async () => {
    const first = await startOauthGuard();
    await first.close();
    expect(authorizeCalls).toBe(1);
    expect(existsSync(join(storeDir, 'robinhood-trading.json'))).toBe(true);

    authorizeCalls = 0;
    const second = await startOauthGuard();
    expect(authorizeCalls).toBe(0); // no re-consent: cached token reused
    const names = (await second.listTools()).tools.map((t) => t.name);
    expect(names).toContain('get_equity_quotes');
  });

  it('refreshes silently when the cached access token has expired', async () => {
    const first = await startOauthGuard();
    await first.close();
    fake.state.tokenGrants.length = 0;

    // Server-side: invalidate the access token but keep the refresh token valid.
    fake.state.expireAccessTokens();
    authorizeCalls = 0;

    const second = await startOauthGuard();
    const names = (await second.listTools()).tools.map((t) => t.name);
    expect(names).toContain('get_equity_quotes');
    expect(authorizeCalls).toBe(0); // refresh, not re-consent
    expect(fake.state.tokenGrants).toContain('refresh_token');
  });
});
