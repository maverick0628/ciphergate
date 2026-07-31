/**
 * Backup orchestrator — snapshot Qdrant, dump the gateway DB, export Letta
 * agents, encrypt what isn't already encrypted, upload everything offsite under
 * `<asset>/<date>/…`, write a manifest (sizes + checksums), and prune retention.
 *
 * Resilient by design: a single asset's failure is recorded in `manifest.errors`
 * and the run continues — a backup that skips one collection beats a backup that
 * aborts. Nothing is ever skipped silently.
 */
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BackupConfig } from './config.js';
import { snapshotCollection, collectionCount } from './qdrant.js';
import { backupGateway } from './gateway.js';
import { exportAllAgents } from './letta.js';
import { sealBuffer } from './archive.js';
import { putObject, pruneRetention } from './store.js';

export type AssetType = 'qdrant' | 'gateway' | 'letta';

export interface BackupAsset {
  type: AssetType;
  name: string;
  key: string;
  size: number;
  sha256: string;
  encrypted: boolean;
  /** Qdrant only: source point count, so a restore can assert it reloaded fully. */
  count?: number;
}

export interface BackupManifest {
  timestamp: string;
  date: string;
  assets: BackupAsset[];
  errors: string[];
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

type CaptureFn = (argv: string[]) => Promise<Buffer>;

export async function runBackup(
  cfg: BackupConfig,
  deps: { capture?: CaptureFn; now?: Date; fetchFn?: typeof fetch } = {},
): Promise<BackupManifest> {
  const now = deps.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const fetchFn = deps.fetchFn ?? fetch;
  const assets: BackupAsset[] = [];
  const errors: string[] = [];

  const upload = async (type: AssetType, name: string, key: string, bytes: Buffer, encrypted: boolean, count?: number) => {
    await putObject(cfg.store, key, bytes, { fetchFn, now });
    assets.push({ type, name, key, size: bytes.length, sha256: sha256(bytes), encrypted, count });
  };

  // 1. Qdrant collections — snapshot, count, encrypt, upload.
  for (const collection of cfg.collections) {
    try {
      const { data } = await snapshotCollection(cfg.qdrant, collection, fetchFn);
      let count: number | undefined;
      try {
        count = await collectionCount(cfg.qdrant, collection, fetchFn);
      } catch {
        count = undefined; // count is best-effort; the snapshot is what matters
      }
      const sealed = await sealBuffer(data, cfg.encryptionKey);
      await upload('qdrant', collection, `qdrant/${date}/${collection}.snapshot.enc`, sealed, true, count);
    } catch (err) {
      errors.push(`qdrant:${collection}: ${(err as Error).message}`);
    }
  }

  // 2. Gateway DB — already encrypted by the gateway; ship as-is.
  try {
    const { data } = await backupGateway(cfg.gateway, { capture: deps.capture });
    await upload('gateway', 'gateway-db', `gateway/${date}/gateway.db`, data, true);
  } catch (err) {
    errors.push(`gateway: ${(err as Error).message}`);
  }

  // 3. Letta agents — export each, encrypt, upload.
  if (cfg.letta) {
    try {
      const exports = await exportAllAgents(cfg.letta, fetchFn);
      for (const agent of exports) {
        try {
          const sealed = await sealBuffer(agent.data, cfg.encryptionKey);
          const safe = agent.name.replace(/[^A-Za-z0-9_-]/g, '_');
          await upload('letta', agent.name, `letta/${date}/${safe}-${agent.id}.json.enc`, sealed, true);
        } catch (err) {
          errors.push(`letta:${agent.name}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      errors.push(`letta: ${(err as Error).message}`);
    }
  }

  const manifest: BackupManifest = { timestamp: now.toISOString(), date, assets, errors };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));

  // 4. Manifest — dated copy + a `latest` pointer.
  try {
    await putObject(cfg.store, `manifest/${date}.json`, manifestBytes, { fetchFn, now, contentType: 'application/json' });
    await putObject(cfg.store, 'manifest/latest.json', manifestBytes, { fetchFn, now, contentType: 'application/json' });
  } catch (err) {
    errors.push(`manifest: ${(err as Error).message}`);
  }

  // Local last-run record.
  try {
    mkdirSync(dirname(cfg.statePath), { recursive: true });
    writeFileSync(cfg.statePath, manifestBytes);
  } catch {
    // a missing local state dir shouldn't fail the offsite backup
  }

  // 5. Retention — prune each asset prefix; never silent (returns what was pruned).
  for (const prefix of ['qdrant/', 'gateway/', 'letta/']) {
    try {
      const { pruned } = await pruneRetention(cfg.store, prefix, cfg.retention, { fetchFn, now });
      for (const key of pruned) process.stderr.write(`[backup] pruned ${key}\n`);
    } catch (err) {
      errors.push(`prune:${prefix}: ${(err as Error).message}`);
    }
  }

  return manifest;
}

/** One-line human summary of a run. */
export function summarizeBackup(m: BackupManifest): string {
  const byType = m.assets.reduce<Record<string, number>>((acc, a) => ((acc[a.type] = (acc[a.type] ?? 0) + 1), acc), {});
  const parts = Object.entries(byType).map(([t, n]) => `${n} ${t}`);
  const bytes = m.assets.reduce((s, a) => s + a.size, 0);
  const base = `${parts.join(', ') || 'no assets'} — ${(bytes / 1024).toFixed(1)} KiB`;
  return m.errors.length ? `${base}; ${m.errors.length} error(s)` : base;
}
