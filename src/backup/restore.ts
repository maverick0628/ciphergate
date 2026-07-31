/**
 * Restore — read an offsite backup back. The CLI defaults to a dry-run; an
 * actual Qdrant restore always lands in a *scratch* collection
 * (`<collection>__restore_<date>`), never the live one, so proving a backup
 * never risks the data it's protecting. The point count of the scratch
 * collection is returned so a caller can assert the reload was complete.
 */
import type { S3Config } from './store.js';
import type { QdrantConfig } from './qdrant.js';
import { listObjects, getObject } from './store.js';
import { recoverSnapshot, collectionCount } from './qdrant.js';
import { openBuffer } from './archive.js';

export interface RestoreConfig {
  store: S3Config;
  qdrant: QdrantConfig;
  encryptionKey: string;
}

/** List the offsite keys a restore of `<asset>/<date>/` would touch (dry-run). */
export async function listRestorable(
  store: S3Config,
  asset: string,
  date: string,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<string[]> {
  const keys = await listObjects(store, `${asset}/${date}/`, opts);
  return keys.sort();
}

/** Scratch collection name for a restore — deterministic and clearly not live. */
export function scratchName(collection: string, date: string): string {
  return `${collection}__restore_${date.replace(/-/g, '_')}`;
}

/**
 * Restore one Qdrant collection's snapshot from `<date>` into a scratch
 * collection. Downloads the sealed snapshot, decrypts it, recovers it, and reads
 * back the scratch point count.
 */
export async function restoreQdrantCollection(
  cfg: RestoreConfig,
  date: string,
  collection: string,
  opts: { fetchFn?: typeof fetch; now?: Date; scratch?: string } = {},
): Promise<{ source: string; scratch: string; count: number }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const key = `qdrant/${date}/${collection}.snapshot.enc`;
  const sealed = await getObject(cfg.store, key, { fetchFn, now: opts.now });
  const snapshot = await openBuffer(sealed, cfg.encryptionKey);
  const scratch = opts.scratch ?? scratchName(collection, date);
  await recoverSnapshot(cfg.qdrant, scratch, snapshot, fetchFn);
  const count = await collectionCount(cfg.qdrant, scratch, fetchFn);
  return { source: collection, scratch, count };
}
