import { describe, it, expect } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildGuardServer } from '../src/proxy/guard.js';
import { compilePolicy } from '../src/proxy/policy.js';

/** A stub downstream MCP server exposing `read` and `delete` tools. */
function makeDownstream(): Server {
  const s = new Server({ name: 'stub', version: '1.0.0' }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'delete', description: 'delete a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
    ],
  }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === 'read') {
      return { content: [{ type: 'text', text: `contents of ${(args as { path: string }).path}: token=sk-LEAK123` }] };
    }
    return { content: [{ type: 'text', text: `deleted ${(args as { path: string }).path}` }] };
  });
  return s;
}

/** Wire stub-downstream ⇄ guard ⇄ test-client, returning a connected test client. */
async function wireGuard(policy: Parameters<typeof compilePolicy>[0]) {
  // downstream server ⇄ downstream client
  const [dsServerT, dsClientT] = InMemoryTransport.createLinkedPair();
  const downstreamServer = makeDownstream();
  await downstreamServer.connect(dsServerT);
  const downstreamClient = new Client({ name: 'dc', version: '1.0.0' }, { capabilities: {} });
  await downstreamClient.connect(dsClientT);

  // guard server ⇄ test client
  const guard = buildGuardServer(downstreamClient, compilePolicy(policy), () => {});
  const [guardT, testT] = InMemoryTransport.createLinkedPair();
  await guard.connect(guardT);
  const testClient = new Client({ name: 'tc', version: '1.0.0' }, { capabilities: {} });
  await testClient.connect(testT);
  return testClient;
}

describe('MCP guard bridge', () => {
  it('forwards and filters tools/list to the allowlist', async () => {
    const client = await wireGuard({ allowTools: ['read'] });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['read']);
  });

  it('forwards an allowed tool call and redacts secrets in the result', async () => {
    const client = await wireGuard({ allowTools: ['read'], redactPatterns: ['sk-[A-Z0-9]+'] });
    const res = await client.callTool({ name: 'read', arguments: { path: 'notes.md' } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('contents of notes.md');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('sk-LEAK123');
  });

  it('blocks a tool not on the allowlist without reaching downstream', async () => {
    const client = await wireGuard({ allowTools: ['read'] });
    const res = await client.callTool({ name: 'delete', arguments: { path: 'x' } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/Blocked by gateway-proxy guard/);
  });

  it('blocks a call whose arguments match a deny pattern (path traversal)', async () => {
    const client = await wireGuard({}); // defaults include path-traversal deny
    const res = await client.callTool({ name: 'read', arguments: { path: '../../etc/passwd' } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/deny pattern/);
  });

  it('passes a benign call through untouched when no redaction configured', async () => {
    const client = await wireGuard({});
    const res = await client.callTool({ name: 'read', arguments: { path: 'safe.md' } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('sk-LEAK123'); // no redact patterns → unchanged
  });
});
