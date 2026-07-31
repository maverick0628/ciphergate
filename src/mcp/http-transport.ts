import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildGatewayMcpServer } from './server-factory.js';

export interface HttpMcpOptions {
  /** Base URL of the gateway REST API the tools proxy to. */
  gatewayUrl: string;
  host: string;
  port: number;
  /** Path the MCP endpoint is mounted at (default `/mcp`). */
  path?: string;
  /** Optional logger; defaults to console. */
  log?: (msg: string) => void;
}

/**
 * Extract the consumer API key from an incoming request.
 *
 * Mirrors HashiCorp's Vault MCP server transport-specific token model: stdio
 * reads the key from an env var, HTTP reads it from a per-session request
 * header — never from the URL. We accept either `Authorization: Bearer <key>`
 * (same scheme the REST API uses) or `X-API-Key: <key>` (same header the n8n
 * integration uses), so a single consumer key works across all surfaces.
 */
export function extractConsumerKey(headers: IncomingMessage['headers']): string | null {
  const auth = headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    if (token) return token;
  }
  const apiKey = headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  return null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/** JSON-RPC shaped error so MCP clients surface the message cleanly. */
function rpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    jsonrpc: '2.0',
    error: { code: -32001, message },
    id: null,
  });
}

/**
 * Start a streamable-http MCP server that proxies to the gateway REST API.
 *
 * Runs in stateless mode: each request gets a fresh {@link buildGatewayMcpServer}
 * bound to the consumer key carried on that request's headers, so the same
 * endpoint can serve many differently-scoped consumers without shared state.
 */
export function startHttpMcpServer(opts: HttpMcpOptions): HttpServer {
  const path = opts.path ?? '/mcp';
  const log = opts.log ?? ((m: string) => console.log(m));

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health') {
      return sendJson(res, 200, { status: 'healthy', transport: 'streamable-http', timestamp: new Date().toISOString() });
    }

    if (url.pathname !== path) {
      return rpcError(res, 404, `Not found. MCP endpoint is mounted at ${path}`);
    }

    const consumerKey = extractConsumerKey(req.headers);
    if (!consumerKey) {
      return rpcError(res, 401, 'Missing consumer key. Provide it via "Authorization: Bearer <key>" or "X-API-Key: <key>".');
    }

    // Stateless: a fresh server + transport per request, bound to this key.
    const server = buildGatewayMcpServer(opts.gatewayUrl, consumerKey);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      log(`MCP request error: ${(err as Error).message}`);
      if (!res.headersSent) rpcError(res, 500, 'Internal MCP transport error');
    }
  });

  httpServer.listen(opts.port, opts.host, () => {
    log(`CipherGate MCP (streamable-http) listening on ${opts.host}:${opts.port}${path}`);
  });

  return httpServer;
}
