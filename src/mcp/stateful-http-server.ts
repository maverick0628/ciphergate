import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export interface StatefulMcpHttpOptions {
  host?: string;
  port?: number;
  /** Mount path for the MCP endpoint (default `/mcp`; trailing slashes tolerated). */
  path?: string;
  log?: (msg: string) => void;
  /** Human name used in the startup log line (default `MCP`). */
  serverName?: string;
  /** Short tag prefixed to request-error logs (default `mcp`). */
  logTag?: string;
  /** Extra detail appended after `→` on the startup log line (e.g. upstreams). */
  startupDetail?: string;
}

const stripSlash = (p: string) => p.replace(/\/+$/, '') || '/';

/** Read and JSON-parse a request body (raw node http). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Start a **stateful** streamable-http MCP server for any MCP `Server`.
 *
 * Stateless (a fresh server per request) is enough for Claude, but Letta's
 * Python MCP client requires a real session — same as the FastMCP-based
 * qdrant-memory it already talks to — or it fails with "Session terminated".
 * So we key one transport (+server) per `mcp-session-id`, minted on initialize.
 *
 * `buildServer` is a thunk so each new session gets its own MCP `Server`
 * instance. This is the shared streamable-http transport.
 */
export function startMcpHttpServer(buildServer: () => Server, opts: StatefulMcpHttpOptions = {}): HttpServer {
  const host = opts.host ?? '0.0.0.0';
  const port = opts.port ?? 8403;
  const wantPath = stripSlash(opts.path ?? '/mcp');
  const log = opts.log ?? ((m: string) => console.log(m));
  const serverName = opts.serverName ?? 'MCP';
  const logTag = opts.logTag ?? 'mcp';
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (stripSlash(url.pathname) === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'healthy', transport: 'streamable-http', sessions: transports.size }));
    }
    if (stripSlash(url.pathname) !== wantPath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: `MCP endpoint is at ${wantPath}` }, id: null }));
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    try {
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        let transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          if (!isInitializeRequest(body)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session ID; send an initialize request first' }, id: null }));
          }
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, transport!);
            },
          });
          transport.onclose = () => {
            const sid = transport!.sessionId;
            if (sid) transports.delete(sid);
          };
          const server = buildServer();
          await server.connect(transport);
        }
        return await transport.handleRequest(req, res, body);
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Invalid or missing session ID' }, id: null }));
        }
        return await transport.handleRequest(req, res);
      }

      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, POST, DELETE' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Internal MCP transport error' }, id: null }));
      }
      log(`${logTag} request error: ${(err as Error).message}`);
    }
  });

  httpServer.listen(port, host, () => {
    const detail = opts.startupDetail ? ` → ${opts.startupDetail}` : '';
    log(`${serverName} (streamable-http, stateful) on ${host}:${port}${wantPath}${detail}`);
  });
  return httpServer;
}
