# mcp-wrap — centralize MCP-server credentials on the gateway

`scripts/mcp-wrap` is a small wrapper that fetches named secrets from
ciphergate and execs a command with them injected as environment
variables. It's a gateway-backed drop-in for the common homelab pattern of
"wrap an MCP server so it never stores its own keys" — making ciphergate
the single source of truth (with audit + rotation) for every MCP server's
credentials, instead of a local dotenv or keychain.

## Interface

```
mcp-wrap NAME1[,NAME2,...] <command> [args...]
```

Each `NAME` is fetched from the gateway and exported under the **same name**,
then `<command>` is exec'd. This matches the usual `mcp-wrap <names> <cmd>`
calling convention, so existing MCP server definitions only need their
credential source swapped — not their shape.

## Setup

1. Store the secrets in the gateway (once):

   ```bash
   gateway secret set LETTA_SERVER_PASSWORD --value '...'
   gateway secret set N8N_API_KEY --value '...'
   ```

2. Create a consumer scoped to exactly the secrets your MCP servers need, and
   note its API key:

   ```bash
   gateway consumer add mcp-clients          # then scope it to those secrets
   ```

3. Put `scripts/mcp-wrap` on your PATH (e.g. `~/bin/mcp-wrap`) and set, in the
   environment Claude Code launches MCP servers from:

   ```bash
   export GATEWAY_URL=http://gateway-host:8400
   export GATEWAY_CONSUMER_KEY=sg_live_<mcp-clients-key>
   ```

## Use in Claude Code MCP definitions

```jsonc
{
  "mcpServers": {
    "example": { "command": "mcp-wrap", "args": ["EXAMPLE_API_TOKEN", "npx", "-y", "some-mcp-server"] },
    "n8n-mcp":{ "command": "mcp-wrap", "args": ["N8N_API_KEY", "n8n-mcp"] },
    "bookstack": { "command": "mcp-wrap", "args": ["BOOKSTACK_API_TOKEN,BOOKSTACK_BASE_URL", "bookstack-mcp-server"] }
  }
}
```

The MCP definitions hold only secret *names* + a single scoped gateway consumer
key (in the launching env) — never the secret values.

## Behaviour

- **Fail-closed:** if any requested secret is missing or out of the consumer's
  scope, `mcp-wrap` exits non-zero and never starts the downstream server.
- **Shell-safe:** values are injected via single-quote-escaped `export`, so
  secrets containing `$`, quotes, spaces, or backticks are passed through
  literally.
- **Audited:** each launch is a normal authenticated batch read, so it lands in
  the gateway audit log and can trigger Pushover alerts; rotation is one
  `gateway secret set` with no edits to any MCP definition.

Requires `curl` and `node` on PATH (node is used only for safe JSON handling).

## mcp-wrap vs. gateway-proxy

| | `mcp-wrap <names> <cmd>` | `gateway-proxy run\|guard <server>` |
|---|---|---|
| Config | ad-hoc names on the command line | a JSON manifest entry |
| Credentials | injected from the gateway | injected from the gateway |
| Tool policy | none (transparent) | `guard` adds allowlist / arg-filter / redaction |
| Best for | quickly centralizing existing wrapped servers | servers you also want behaviourally guarded |

Use `mcp-wrap` to centralize what you already run; reach for `gateway-proxy
guard` when you also want the tool-level policy layer
([scoped-injector.md](./scoped-injector.md)).
