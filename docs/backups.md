# Automated backups

Automated, encrypted, offsite, restore-tested copies of everything expensive to
recreate: any configured Qdrant collections, the gateway's
encrypted secret DB, and the Letta agents. Scheduled, retained, and proven by an
actual restore — an untested backup is not a backup.

Built on the `gateway-backup` bin shipped inside the ciphergate image. See
the source in `src/backup/`.

## What it backs up

| Asset | Source | Method | At rest |
|---|---|---|---|
| Qdrant collections | `llm-host:6333` | snapshot API per collection | encrypted (this tool) |
| Gateway secret DB | the `ciphergate` container | `gateway backup` (streamed out) | already encrypted |
| Letta agents | `localhost:8283` | export each agent | encrypted (this tool) |

The Qdrant set is empty unless `BACKUP_COLLECTIONS` names collections,
`agent-insights`, and `overseer_incidents`/`overseer_outcomes`. The throwaway
`*-queue` collections are skipped. Override with `BACKUP_COLLECTIONS`.

## How it works

```
gateway-backup run
  ├─ Qdrant   snapshot → download → AES-256-GCM seal → PUT qdrant/<date>/<col>.snapshot.enc
  ├─ Gateway  docker exec gateway backup → (already encrypted) → PUT gateway/<date>/gateway.db
  ├─ Letta    export each agent → seal → PUT letta/<date>/<name>-<id>.json.enc
  ├─ Manifest sizes + sha256 + counts → PUT manifest/<date>.json + manifest/latest.json
  └─ Prune    keep N daily + M weekly per asset prefix; log every deletion
```

Each asset is independent: one failing collection is recorded in the manifest's
`errors` and the run continues. A backup that skips one collection beats a backup
that aborts. Nothing is skipped silently — prunes and per-asset failures both log.

**Encryption.** The Qdrant snapshots and Letta exports are sealed with the same
primitives as the gateway's secret store — argon2id KDF + AES-256-GCM (see
[`src/storage/crypto.ts`](../src/storage/crypto.ts)). Each blob is self-describing
(`salt | iv | authTag | ciphertext`), so a restore needs only the passphrase. The
gateway DB arrives encrypted already and ships as-is.

**Offsite.** Cloudflare R2 over the S3 REST API with Signature V4 — no SDK, ~40
lines of signer. Path-style addressing (`<endpoint>/<bucket>/<key>`). Credentials
(`R2_*`) come from the gateway, never code.

## Config (env)

| Env | Default | Notes |
|---|---|---|
| `BACKUP_ENCRYPTION_KEY` | — | **required** — refuses to back up in the clear |
| `R2_ENDPOINT` / `R2_BUCKET` | — / `homelab-backups` | **required** |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | — | **required**, from the gateway |
| `R2_REGION` | `auto` | R2 ignores it; real S3 needs the region |
| `BACKUP_QDRANT_URL` | `http://llm-host:6333` | |
| `BACKUP_COLLECTIONS` | _(empty)_ | comma list of Qdrant collections |
| `BACKUP_LETTA_URL` / `BACKUP_LETTA_KEY` | — | omit both to skip Letta |
| `BACKUP_RETAIN_DAILY` / `BACKUP_RETAIN_WEEKLY` | `7` / `4` | |
| `BACKUP_GATEWAY_CMD` | `docker exec ciphergate …` | JSON array; stdout is the artifact |
| `BACKUP_STATE` | `/data/backup-manifest.json` | local last-run record |

## Run it

```bash
# one full backup
gateway-backup run

# what a restore WOULD touch (dry-run, the default)
gateway-backup restore qdrant 2026-06-29

# actually recover a collection into a SCRATCH collection (never the live one)
gateway-backup restore qdrant 2026-06-29 --collection claude-memory --execute
#   → Recovered claude-memory → scratch collection claude-memory__restore_2026_06_29: 1500 points.
```

Deploy on a host that reaches both the gateway and the vector store:

```bash
docker compose -f docker-compose.backup.yml up -d --build
```

The container runs one backup per `BACKUP_EVERY` seconds (default daily). Prefer
an n8n or host cron calling `docker exec ciphergate-backup gateway-backup run`
if you'd rather schedule externally.

## Restore is the point

`restore` defaults to a dry-run that lists the offsite keys it would touch. With
`--execute` it downloads, decrypts, and recovers a Qdrant snapshot into a
*scratch* collection (`<collection>__restore_<date>`) and reports the reloaded
point count — so you verify the count matches the source without ever touching
live data. Gateway and Letta restores are a manual reload from the downloaded
artifact (decrypt the `gateway.db` / agent export and import it).

## Acceptance (prove on hardware)

1. `gateway-backup run` snapshots each collection, dumps the gateway DB, exports
   the agents, uploads to R2, writes a manifest.
2. R2 shows today's keys with non-zero sizes (`manifest/latest.json` lists them).
3. `gateway-backup restore qdrant <date> --collection <c> --execute` reloads into
   a scratch collection and the count matches the source.
4. After old runs accumulate, retention keeps exactly the configured window and
   logs each pruned key.
5. A second run appends a new dated prefix — it never clobbers an earlier one.
