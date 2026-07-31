import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpTools, handleToolCall } from './tools.js';

/**
 * Build a fully-wired MCP {@link Server} that proxies tool calls to the gateway
 * REST API using the supplied consumer key.
 *
 * Both transports use this factory so the tool surface stays identical:
 * - stdio binds one server for the process, with the key taken from an env var.
 * - streamable-http binds one server per request, with the key taken from a
 *   per-session request header (the Vault MCP model — see docs/mcp-http-transport.md).
 */
export function buildGatewayMcpServer(gatewayUrl: string, consumerKey: string): Server {
  const server = new Server(
    { name: 'ciphergate', version: '1.1.0' },
    { capabilities: { tools: {} } },
  );

  const tools = createMcpTools();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await handleToolCall(name, args ?? {}, gatewayUrl, consumerKey);
    return { content: [{ type: 'text', text: result }] };
  });

  return server;
}
