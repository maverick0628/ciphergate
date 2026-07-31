# Homelab health watchdog

`gateway-watchdog` proactively probes the homelab MCP servers, tunnels, and core
dependencies, and alerts on **state transition** — not every tick — via Pushover
(ntfy optional/dormant), recording each incident/recovery in the overseer Qdrant
collections.

It catches the failure modes the homelab actually hits: a dead container, a wrong
IP, an expired secret, a hung session, a broken tunnel returning 502. HTTP/TCP
probes are host-agnostic, so a single watchdog covers services on several hosts
without needing a remote Docker socket.

## What it probes

The inventory lives in `deploy-config/watchdog.targets.json` — an array of
`{ name, kind, url, expect?, timeoutMs? }`, editable without a rebuild (same
loader shape as the scoped-injector manifest).

That file names live hosts, so it is gitignored rather than shipped. Copy
[`watchdog.targets.example.json`](../watchdog.targets.example.json) and fill in
your own services, or point `WATCHDOG_TARGETS` at a file elsewhere:

```bash
mkdir -p deploy-config && cp watchdog.targets.example.json deploy-config/watchdog.targets.json
```

A target set might look like this:

| Name | Kind | Probe | Healthy |
|---|---|---|---|
| `gateway-rest` | http | `:8400/health` | 200 + `{"status":"healthy"}` |
| `vector-db` | http | `:6333/healthz` | 200 |
| `model-server` | http | `:1234/v1/models` | 200, ≥1 model |
| `internal-service` | tcp | `service-host:8402` | TCP connect succeeds |
| `public-edge` | access | `https://service.example.com/health` | 200 through the access proxy |

Three probe kinds:

- **http** — GET the URL, assert the status code plus optional body checks
  (`jsonStatus`, `minModels`, `bodyIncludes`).
- **access** — like http, but sends the `CF-Access-Client-Id` /
  `CF-Access-Client-Secret` service-token headers, so the probe exercises the
  full **edge → tunnel → origin** path, not just the LAN. (Without the token,
  Cloudflare Access answers 403 — proof the edge is gating the request.)
- **tcp** — opens a TCP connection; a successful connect is healthy. For services
  with no HTTP health endpoint (e.g. `mcp-server-qdrant`).

Docker-container introspection is deferred to a later version — cross-host
`docker ps` needs remote socket access, and HTTP/TCP probes already cover the
real failure modes.

## Status classification

Each probe yields `ok | degraded | down`:

- **down** — unreachable (refused / DNS failure / timeout) or a wrong HTTP status.
- **degraded** — reachable with the right status, but a health assertion failed
  (LM Studio answers 200 with zero models, or a `/health` body isn't
  `{"status":"healthy"}`). It's up but not serving.
- **ok** — reachable, expected status, all assertions pass.

## Alert on transition, not on tick

The watchdog persists the last committed state of each target to
`${WATCHDOG_STATE}` and only acts on a **change**:

- `ok → down` (or `degraded`) fires an **incident**.
- `down → ok` fires a **recovery**.
- No change → silence.

**Flap dampening:** a target only flips to `down` after `WATCHDOG_FAIL_THRESHOLD`
consecutive unhealthy probes (default **2**), so a single transient blip never
pages. Recovery is immediate — one healthy probe clears it. Because the state
file is persisted, a watchdog restart never re-alerts for an already-known-down
target.

> In `watch` mode the dampener clears in ~2 intervals (≈2 minutes at the default
> 60s). A one-off `gateway-watchdog run` counts as a single failure, so the
> incident fires on the second `run` — see [Proving it live](#proving-it-live).

## Alert channels

On a transition the watchdog fans out to its sinks, each best-effort (one
failing sink never blocks the others):

- **Pushover** — POST to `https://api.pushover.net/1/messages.json`. Priority `1`
  (high) for down/degraded, `0` (normal) for recovery. Skipped if no credentials.
  The live homelab push channel.
- **ntfy** — optional. POST to a topic (`NTFY_URL`), priority `high` for
  down/degraded, `default` for recovery. Skipped when `NTFY_URL` is empty — the
  homelab ntfy was retired 2026-06-22 (Pushover replaced it), so this is dormant.
- **Qdrant** — embeds a one-line summary with the same nomic model + **un-named
  vector** layout (via `embedQuery` in
  [`src/watchdog/embed.ts`](../src/watchdog/embed.ts)) and upserts a point into
  `overseer_incidents` (incident) or `overseer_outcomes` (recovery), so the
  overseer's history stays semantically queryable.

Message format:

```
⛔ vector-db DOWN — health 502 (edge→origin)
⚠️ lm-studio DEGRADED — 0 models (want ≥1)
✅ vector-db recovered
```

## Configuration (env)

All env-driven, with the homelab defaults baked in (see
[`src/watchdog/config.ts`](../src/watchdog/config.ts)).

| Env | Default | Notes |
|---|---|---|
| `WATCHDOG_TARGETS` | `./deploy-config/watchdog.targets.json` | inventory manifest path |
| `WATCHDOG_INTERVAL` | `60` | seconds between sweeps (`watch` mode) |
| `WATCHDOG_STATE` | `/data/watchdog-state.json` | transition memory |
| `WATCHDOG_FAIL_THRESHOLD` | `2` | consecutive failures before `down` |
| `WATCHDOG_TIMEOUT_MS` | `5000` | default per-probe timeout |
| `QDRANT_URL` | `http://llm-host:6333` | incident store |
| `EMBED_URL` | `http://llm-host:1234/v1` | nomic embeddings (OpenAI-compatible) |
| `EMBED_MODEL` | `text-embedding-nomic-embed-text-v2` | match your index |
| `PUSHOVER_TOKEN` / `PUSHOVER_USER` | — | from the gateway; falls back to `PUSHOVER_APP_TOKEN` / `PUSHOVER_USER_KEY` |
| `NTFY_URL` | — | optional ntfy topic; empty = sink dormant (homelab ntfy retired 2026-06-22) |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | — | for `access` probes; from the gateway |

Secrets are never hardcoded — they arrive as env at deploy time, injected from
the gateway (`gateway secret get …`, `gateway env`, or the REST
`/v1/secret/:name` endpoint with a consumer key).

## CLI

```bash
gateway-watchdog run                 # one sweep, print a table, alert on change
gateway-watchdog run --no-alert      # probe + print only (no Pushover/ntfy/Qdrant writes)
gateway-watchdog watch               # loop forever, one sweep per interval
gateway-watchdog watch -i 30         # override the interval (seconds)
```

`run` exits non-zero if any target is currently `down`, so a cron/n8n job can
react to the exit code as well as the alerts.

```
NAME             STATUS    LATENCY  DETAIL
vector-db        ✅ ok           25ms  200
qdrant           ✅ ok           28ms  200
lm-studio        ✅ ok           14ms  200
letta            ✅ ok           14ms  200
gateway-rest     ✅ ok           13ms  200
qdrant-memory    ✅ ok            9ms  tcp gateway-host:8402
public-edge   ✅ ok          210ms  200
qdrant-mcp-edge  ✅ ok          198ms  200

8 ok, 0 degraded, 0 down
```

## Deploy

Ships inside the `ciphergate` image (the `gateway-watchdog` bin). Run the
`watch` loop on a host that can reach the model server + Qdrant locally and
the gateway host over the LAN:

```bash
# Cloudflare Access service token is a managed gateway secret; Pushover
# token/user are deploy env (same as the main gateway). Never commit them.
export CF_ACCESS_CLIENT_ID=$(gateway secret get CF_ACCESS_CLIENT_ID)
export CF_ACCESS_CLIENT_SECRET=$(gateway secret get CF_ACCESS_CLIENT_SECRET)
export PUSHOVER_TOKEN=$PUSHOVER_APP_TOKEN   # the gateway's Pushover app token
export PUSHOVER_USER=$PUSHOVER_USER_KEY     # the gateway's Pushover user key

docker compose -f docker-compose.watchdog.yml up -d --build
docker logs -f gateway-watchdog
```

> **Alert-channel prerequisites.** Pushover and ntfy each no-op gracefully when
> unconfigured (the incident is still recorded in Qdrant). For live delivery set
> `PUSHOVER_TOKEN`/`PUSHOVER_USER` — Pushover is the homelab push channel. ntfy
> is dormant: the homelab ntfy was retired 2026-06-22, so `NTFY_URL` is empty and
> the ntfy sink is skipped. Point `NTFY_URL` at a topic only if ntfy returns.
>
> **`qdrant-mcp-edge` healthy = 406.** `mcp-server-qdrant` exposes no `/health`,
> so the edge target probes `/mcp`; a plain GET (no SSE `Accept` header) returns
> **406** once the 307 redirect is followed — a stable signal that Access, the
> tunnel, and the origin are all alive.

The compose file mounts a named volume for the state file, bind-mounts the
`deploy-config/` **directory** at `/opt/gateway-config` (so the inventory is
editable without a rebuild), and joins the `homelab` network. Its healthcheck
passes while the state file keeps getting written (i.e. the loop is still
sweeping).

> Mount the directory, never the single file. Docker binds a file by inode, and
> `watchdog.targets.json` is gitignored — so a checkout that deletes and
> recreates it detaches the mount, and the watchdog goes blind with `ENOENT`
> while the host path and `docker inspect` both still look correct. This
> happened on 2026-07-30 after the PR #40 checkout; only a restart re-binds it.

An n8n cron hitting `docker exec gateway-watchdog gateway-watchdog run` is an
optional second trigger, but the built-in `watch` loop is enough.

## Proving it live

```bash
# 1. Baseline — everything ok.
gateway-watchdog run

# 2. Take vector-db down. The first run dampens (1 failure); the second crosses
#    the threshold → marks it down, sends Pushover + ntfy, writes one
#    overseer_incidents point.
docker stop vector-db
gateway-watchdog run          # vector-db down, dampened (no alert yet)
gateway-watchdog run          # incident fires

# 3. Bring it back → recovery alert + one overseer_outcomes point.
docker start vector-db
gateway-watchdog run          # ✅ vector-db recovered

# 4. Run the loop.
docker compose -f docker-compose.watchdog.yml up -d --build
```

## Architecture

```
src/watchdog/
  manifest.ts   # load + validate watchdog.targets.json
  config.ts     # env → WatchdogConfig (homelab defaults)
  probe.ts      # probe one target → { name, status, detail, latencyMs }
  state.ts      # transition memory (JSON file) + flap dampening
  alert.ts      # Pushover + ntfy + Qdrant incident/outcome (reuses embedQuery)
  runner.ts     # sweep all → diff vs state → alert on change → table
src/watchdog-cli.ts   # bin `gateway-watchdog`: run | watch
```
