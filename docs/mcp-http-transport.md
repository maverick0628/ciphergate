# Streamable-HTTP MCP transport

The MCP server (`mcp-server.js`) can run over **stdio** (local, default) or
**streamable-http** (remote/networked). Both expose the same 4 tools
(`get_secret`, `list_secrets`, `get_env`, `rotation_report`) via the same
`buildGatewayMcpServer` factory — only the transport and where the consumer key
comes from differ.

This mirrors HashiCorp's Vault MCP server token model:

| Transport | Consumer key source | When to use |
|---|---|---|
| `stdio` (default) | `GATEWAY_CONSUMER_KEY` / `GATEWAY_API_KEY` env, set before start | Local Claude Code on the same host |
| `http` (streamable-http) | per-request header: `Authorization: Bearer <key>` or `X-API-Key: <key>` | Networked / remote clients, the Cloudflare connector |

The key is **never** read from the URL — only from the environment (stdio) or a
request header (http).

## Running

```bash
# stdio (unchanged default)
GATEWAY_URL=http://gateway-host:8400 \
GATEWAY_CONSUMER_KEY=sg_live_... \
node dist/mcp-server.js

# streamable-http
MCP_TRANSPORT=http \
GATEWAY_URL=http://gateway-host:8400 \
node dist/mcp-server.js          # listens on 0.0.0.0:8401/mcp
# or: npm run mcp:http
```

The http transport runs **statelessly**: each request gets a fresh MCP server
bound to the consumer key on that request, so one endpoint serves many
differently-scoped consumers with no shared session state. Every tool call is
forwarded to the REST API as `Authorization: Bearer <key>`, so consumer scoping,
rate limiting, and audit logging all apply unchanged.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` (alias `streamable-http`) |
| `MCP_HTTP_PORT` | `8401` | Port for the http transport |
| `MCP_HTTP_HOST` | `0.0.0.0` | Bind host for the http transport |
| `MCP_HTTP_PATH` | `/mcp` | Path the MCP endpoint is mounted at |
| `GATEWAY_URL` | `http://localhost:8400` | REST API the tools proxy to |
| `GATEWAY_CONSUMER_KEY` | _(empty)_ | stdio only: consumer key |

`GET /health` on the http transport returns liveness without auth.

## Connecting clients

- **Local Claude Code** → keep stdio (see the main README MCP section).
- **Remote / Claude Desktop / claude.ai** → run the http transport behind
  an authenticating reverse proxy in front of it.

## Security notes

- Terminate TLS at the edge (Cloudflare/tunnel) or via a reverse proxy; the
  http transport itself speaks plain HTTP inside the trusted network.
- The transport carries the consumer key but enforces nothing beyond presence —
  all authn/authz happens at the REST API (consumer lookup, scope, audit) and,
  for remote exposure, at Cloudflare Access. Don't expose `:8401` directly to
  the internet without Access (or equivalent) in front.
