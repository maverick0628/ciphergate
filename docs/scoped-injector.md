# Scoped-injector proxy (`gateway-proxy`)

A thin launcher that makes the gateway the **credential broker** for your other
MCP servers. Instead of each downstream server
storing its own API keys, `gateway-proxy`:

1. reads a per-agent **manifest** describing each server and the secrets it needs,
2. **fetches those secrets** from the gateway (one audited batch request), and
3. **spawns the server** with the secrets injected as env vars over stdio.

So the downstream server never stores credentials, the agent/MCP config never
contains them, and **every credential read flows through the gateway's audit log
+ Pushover alerts**. This is the homelab-agent "scoped-mcp" pattern realized as a
launcher.

```
 Claude Code ── launches ──► gateway-proxy run qdrant
                                   │  POST /v1/secrets/batch  (Bearer = scoped consumer key)
                                   ▼
                             ciphergate ── audit + Pushover
                                   │  { QDRANT_API_KEY: ... }
                                   ▼  injected as env
                             exec: uvx mcp-server-qdrant   (stdio → back to Claude Code)
```

## Manifest

Zero-dependency JSON (see [`proxy-manifest.example.json`](../proxy-manifest.example.json)):

```json
{
  "version": 1,
  "gatewayUrl": "http://gateway-host:8400",
  "consumerKeyEnv": "GATEWAY_PROXY_KEY",
  "servers": {
    "qdrant": {
      "command": "uvx",
      "args": ["mcp-server-qdrant"],
      "secrets": { "QDRANT_API_KEY": "QDRANT_API_KEY" },
      "env": { "QDRANT_URL": "http://gateway-host:6333", "COLLECTION_NAME": "claude-memory" }
    },
    "n8n": {
      "command": "npx",
      "args": ["-y", "n8n-mcp"],
      "secrets": { "N8N_API_KEY": "N8N_API_KEY" },
      "env": { "N8N_API_URL": "http://gateway-host:5678", "MCP_MODE": "stdio" }
    }
  }
}
```

- `secrets` maps **gateway secret name → target env var** the child expects.
- `env` sets static, non-secret env (URLs, collection names).
- `consumerKeyEnv` (per-server, optional) overrides the default key env var, so
  each downstream server can use a **separately-scoped** consumer.

## Commands

```bash
gateway-proxy --manifest ./proxy-manifest.json list        # list servers + their secrets
gateway-proxy resolve qdrant                               # dry-run: show injected env (values masked)
gateway-proxy run qdrant                                   # fetch secrets + exec the server (stdio)
gateway-proxy guard qdrant                                 # like run, but with the policy guard in the stream
```

The consumer key is read from the env var named by the manifest
(`GATEWAY_PROXY_KEY` by default), not stored in the manifest. Manifest path
defaults to `./proxy-manifest.json` or `$GATEWAY_PROXY_MANIFEST`.

## Wiring into Claude Code

```json
{
  "mcpServers": {
    "qdrant-memory": {
      "command": "gateway-proxy",
      "args": ["run", "qdrant"],
      "env": { "GATEWAY_PROXY_KEY": "sg_live_<scoped-consumer-key>" }
    },
    "n8n": {
      "command": "gateway-proxy",
      "args": ["run", "n8n"],
      "env": { "GATEWAY_PROXY_KEY": "sg_live_<scoped-consumer-key>" }
    }
  }
}
```

Claude's config holds only the **scoped gateway consumer key** — the actual
`QDRANT_API_KEY` / `N8N_API_KEY` live only in the gateway.

## Fail-closed behavior

If any required secret is **missing** or **denied** (out of the consumer's
scope), `gateway-proxy` aborts before spawning the child — it never launches a
downstream server with half its credentials. Create the consumer scoped to
exactly the secrets in the manifest:

```bash
gateway consumer add mcp-qdrant            # then scope it to QDRANT_API_KEY
```

## Two layers: `run` (credentials) and `guard` (behaviour)

`gateway-proxy run` brokers **credentials**: keys live in the gateway, get
injected per-launch, and every read is audited. It launches the child with
inherited stdio, so it is not in the message stream.

`gateway-proxy guard` adds **behavioural control**. It sits *in* the JSON-RPC
stream between the MCP client and the downstream server (acting as an MCP server
to the client and an MCP client to the child), applying a per-server **policy**
on top of credential injection — the rest of the homelab-agent scoped-mcp model.

### Policy

Add an optional `policy` block to any server in the manifest (fully backward
compatible — omit it and `guard` behaves like `run` plus the built-in defaults):

```json
{
  "qdrant": {
    "command": "uvx", "args": ["mcp-server-qdrant"],
    "secrets": { "QDRANT_API_KEY": "QDRANT_API_KEY" },
    "policy": {
      "allowTools": ["qdrant-store", "qdrant-find"],
      "denyArgPatterns": ["rm\\s+-rf"],
      "warnArgPatterns": ["(?i)\\binternal-only\\b"],
      "redactPatterns": ["sk-[A-Za-z0-9]{8,}", "sg_live_[A-Za-z0-9]+"],
      "disableDefaults": false
    }
  }
}
```

| Field | Effect |
|---|---|
| `allowTools` | If set, `tools/list` is filtered to these and any other `tools/call` is **blocked** before reaching the child. |
| `denyArgPatterns` | Regexes; if any matches the (key-sorted) stringified arguments, the call is **blocked**. |
| `warnArgPatterns` | Regexes; a match logs a **warning** to stderr but allows the call. |
| `redactPatterns` | Regexes; matches in text results are replaced with `[REDACTED]` on the way back. |
| `disableDefaults` | Opt out of the built-in patterns (default `false`). |

**Built-in defaults** (applied unless `disableDefaults: true`):
- Deny: path traversal (`../`), `/etc/passwd`/`/etc/shadow`, `id_rsa`.
- Warn: credential-shaped arguments (`api_key:`, `password=`, `bearer …`).

Patterns may start with an inline `(?i)` for case-insensitive matching. Invalid
regexes fail at **manifest load time**, not mid-session. Blocked calls return an
MCP `isError` result (`"Blocked by gateway-proxy guard: …"`) — the downstream
server is never invoked.

### Wiring `guard` into Claude Code

Identical to `run`, just swap the subcommand:

```json
{ "mcpServers": { "qdrant-memory": {
  "command": "gateway-proxy",
  "args": ["guard", "qdrant"],
  "env": { "GATEWAY_PROXY_KEY": "sg_live_<scoped-consumer-key>" }
} } }
```

### Scope note

The guard enforces tool/argument/response policy and credential injection. It
does not yet do schema-aware argument validation per tool (it matches on the
serialized argument blob), and rate limiting still lives at the gateway REST
layer rather than in the guard — both are reasonable future additions.
