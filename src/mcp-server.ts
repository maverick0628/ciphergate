import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildGatewayMcpServer } from './mcp/server-factory.js';
import { startHttpMcpServer } from './mcp/http-transport.js';

const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8400';
const transport = (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase();

if (transport === 'http' || transport === 'streamable-http') {
  // Remote/HTTP transport: the consumer key arrives per-request as a header
  // (Authorization: Bearer / X-API-Key), so no key is read from the env here.
  // See docs/mcp-http-transport.md and docs/cloudflare-connector.md.
  startHttpMcpServer({
    gatewayUrl,
    host: process.env.MCP_HTTP_HOST ?? '0.0.0.0',
    port: parseInt(process.env.MCP_HTTP_PORT ?? '8401', 10),
    path: process.env.MCP_HTTP_PATH ?? '/mcp',
  });
} else {
  // Local stdio transport: the consumer key is taken from the environment,
  // set before the process starts (the Vault MCP model for stdio).
  const consumerKey = process.env.GATEWAY_CONSUMER_KEY ?? process.env.GATEWAY_API_KEY ?? '';
  const server = buildGatewayMcpServer(gatewayUrl, consumerKey);
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}
