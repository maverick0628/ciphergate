/**
 * Backup configuration — env-driven, with this homelab's defaults baked in
 * (mirrors `watchdogConfigFromEnv`). Runs on a host that reaches both the
 * Studio (llm-host: Qdrant + LM Studio) and Letta over the LAN, and the
 * Cloudflare R2 edge for offsite upload.
 *
 * Secrets (R2 keys, Letta key, the encryption passphrase) are NEVER hardcoded —
 * they arrive as env at deploy time, injected from the gateway. The code only
 * reads them. Two are hard-required (we refuse to "back up" to nowhere or in the
 * clear): the R2 credentials and `BACKUP_ENCRYPTION_KEY`.
 */
import type { QdrantConfig } from './qdrant.js';
import type { LettaConfig } from './letta.js';
import type { GatewayConfig } from './gateway.js';
import type { S3Config } from './store.js';
import type { RetentionPolicy } from './retention.js';

export interface BackupConfig {
  qdrant: QdrantConfig;
  collections: string[];
  letta?: LettaConfig;
  gateway: GatewayConfig;
  store: S3Config;
  retention: RetentionPolicy;
  /** Passphrase used to encrypt Qdrant/Letta dumps at rest. */
  encryptionKey: string;
  /** Local last-run manifest record. */
  statePath: string;
}

/** Qdrant collections to snapshot. Empty unless BACKUP_COLLECTIONS names some. */
const DEFAULT_COLLECTIONS: string[] = [];

const DEFAULT_GATEWAY_CMD = [
  'docker',
  'exec',
  'ciphergate',
  'sh',
  '-c',
  'f=$(mktemp); gateway backup --output "$f" >/dev/null 2>&1; cat "$f"; rm -f "$f"',
];

function envInt(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const strip = (s: string): string => s.replace(/\/$/, '');

export function backupConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  const encryptionKey = env.BACKUP_ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error('BACKUP_ENCRYPTION_KEY is required (refusing to back up in the clear)');

  const missing = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_BUCKET'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing offsite credentials: ${missing.join(', ')}`);

  const collections = (env.BACKUP_COLLECTIONS ?? DEFAULT_COLLECTIONS.join(','))
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  let gatewayCommand = DEFAULT_GATEWAY_CMD;
  if (env.BACKUP_GATEWAY_CMD) {
    try {
      const parsed = JSON.parse(env.BACKUP_GATEWAY_CMD);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) gatewayCommand = parsed;
      else throw new Error('not a string array');
    } catch (err) {
      throw new Error(`BACKUP_GATEWAY_CMD must be a JSON string array: ${(err as Error).message}`);
    }
  }

  const letta =
    env.BACKUP_LETTA_URL && env.BACKUP_LETTA_KEY
      ? { lettaUrl: strip(env.BACKUP_LETTA_URL), lettaKey: env.BACKUP_LETTA_KEY }
      : undefined;

  return {
    qdrant: {
      qdrantUrl: strip(env.BACKUP_QDRANT_URL ?? 'http://llm-host:6333'),
      qdrantApiKey: env.BACKUP_QDRANT_API_KEY || env.QDRANT_API_KEY || undefined,
    },
    collections,
    letta,
    gateway: { backupCommand: gatewayCommand },
    store: {
      endpoint: strip(env.R2_ENDPOINT as string),
      bucket: env.R2_BUCKET as string,
      accessKeyId: env.R2_ACCESS_KEY_ID as string,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
      region: env.R2_REGION || 'auto',
    },
    retention: {
      retainDaily: envInt(env, 'BACKUP_RETAIN_DAILY', 7),
      retainWeekly: envInt(env, 'BACKUP_RETAIN_WEEKLY', 4),
    },
    encryptionKey,
    statePath: env.BACKUP_STATE ?? '/data/backup-manifest.json',
  };
}
