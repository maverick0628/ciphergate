# Working on CipherGate

Orientation for an AI agent — or a human — picking this repo up cold. Read this
before changing anything.

## What this is

A single-node encrypted secret store with three surfaces over one core: a REST
API, a CLI, and an MCP server. Plus a proxy that launches downstream MCP servers
with credentials injected at runtime and enforces a per-server policy on the
JSON-RPC stream, and a browser UI for adding and editing secrets.

Secrets are AES-256-GCM in SQLite. The data encryption key is derived from a
keyfile with Argon2id. The keyfile is the root of trust and lives outside the
database.

## Getting it running

```bash
npm install
npm run build
head -c 32 /dev/urandom | base64 > gateway.key
GATEWAY_DB_PATH=./gateway.db GATEWAY_KEYFILE=./gateway.key ./dist/cli.js init
```

`init` prints an admin API key **once**. Then:

```bash
GATEWAY_DB_PATH=./gateway.db GATEWAY_KEYFILE=./gateway.key npm start
```

REST on `:8400`, browser UI on `:8405`. The UI serves only a setup page until you
run `gateway ui set-password`.

```bash
npm test          # 469 tests, ~7s
npm run build     # tsc, then copies the UI assets into dist
```

## The shape of the code

| Path | What lives there |
|---|---|
| `src/core/` | The service layer. `secrets-service.ts` is the centre of gravity. |
| `src/storage/` | SQLite plus `crypto.ts` — encrypt, decrypt, mask, derive. |
| `src/api/` | Fastify routes and middleware for the REST surface. |
| `src/mcp/` | MCP server factory, tools, stdio and streamable-http transports. |
| `src/proxy/` | The scoped injector and the policy guard. |
| `src/ui/` | The browser UI: its own listener, session auth, static assets. |
| `src/watchdog/` | Health prober with transition-based alerting. |
| `src/backup/` | Encrypted backup and restore. |

## Rules that are not negotiable

These are load-bearing. Several exist because something went wrong once — see
`DECISIONS.md` for the incidents.

**Never let a plaintext value reach a log, an error message, an audit entry, or a
UI response body.** There is a test asserting a known plaintext appears in no UI
GET response. Keep it passing.

**Never gate authorization on a raw URL string.** `request.url` is undecoded
while the router matches the decoded path. Gate with routing — an encapsulated
Fastify scope — not with `startsWith`. This was a real bypass.

**Validate types at the write boundary.** `consumers` is stored as JSON and
authorization does `.includes()` on it. An array gives membership testing; a
string gives substring matching. That is an authorization bug wearing a type
coercion costume.

**`PUT /v1/secret/:name` is a partial update and must stay one.** Omitting
`value` must leave ciphertext, version and history untouched. The browser UI's
entire safety model rests on it.

**The UI must make no external request.** No webfonts, no CDNs. It is served by
the process holding every credential, possibly with no route to the internet.
Asserted in tests.

**No new runtime dependencies without a real reason.** There are five. Adding a
sixth to a credential store is a supply-chain decision, not a convenience.

## Conventions

TypeScript, ESM, strict. `node:` prefix on built-ins. Vitest, with tests beside
the behaviour they describe rather than mirroring the source tree.

Comments explain *why*, not *what*. If a line looks odd and isn't, say why it
isn't — most of the comments in here are load-bearing context, not narration.

## Before you claim it works

Run `npm test`. Then build the Docker image, because the image has a restricted
build context and a green test job says nothing about it — that gap shipped a
broken build once already.

If you touch the UI, open it in a browser. If you touch the CLI's prompts, drive
them through a real PTY: the suite pipes stdin, and readline behaves differently
in terminal mode. That gap shipped an invisible prompt once already.
