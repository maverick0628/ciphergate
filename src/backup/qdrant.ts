/**
 * Qdrant backup primitives — snapshot a collection, download the file, count
 * points (for restore verification), and recover a snapshot into a collection.
 *
 * Uses Qdrant's snapshot REST API directly with the optional `api-key` header
 * (standard Qdrant api-key auth). Snapshot
 * files are opaque binary; this module never inspects them, only moves them.
 */

export interface QdrantConfig {
  /** Qdrant base, e.g. http://llm-host:6333 */
  qdrantUrl: string;
  /** Optional api-key header. */
  qdrantApiKey?: string;
}

type FetchFn = typeof fetch;

function headers(cfg: QdrantConfig, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (cfg.qdrantApiKey) h['api-key'] = cfg.qdrantApiKey;
  return h;
}

const base = (cfg: QdrantConfig): string => cfg.qdrantUrl.replace(/\/$/, '');
const enc = encodeURIComponent;

/** Create a snapshot of a collection and return its server-assigned name. */
export async function createSnapshot(cfg: QdrantConfig, collection: string, fetchFn: FetchFn = fetch): Promise<string> {
  const res = await fetchFn(`${base(cfg)}/collections/${enc(collection)}/snapshots`, {
    method: 'POST',
    headers: headers(cfg, { 'Content-Type': 'application/json' }),
  });
  if (!res.ok) throw new Error(`snapshot ${collection} failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
  const json = (await res.json()) as { result?: { name?: string } };
  const name = json.result?.name;
  if (!name) throw new Error(`snapshot ${collection}: no name in response`);
  return name;
}

/** Download a named snapshot's bytes. */
export async function downloadSnapshot(cfg: QdrantConfig, collection: string, name: string, fetchFn: FetchFn = fetch): Promise<Buffer> {
  const res = await fetchFn(`${base(cfg)}/collections/${enc(collection)}/snapshots/${enc(name)}`, {
    headers: headers(cfg),
  });
  if (!res.ok) throw new Error(`download snapshot ${collection}/${name} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Snapshot a collection and download it in one step. */
export async function snapshotCollection(
  cfg: QdrantConfig,
  collection: string,
  fetchFn: FetchFn = fetch,
): Promise<{ name: string; data: Buffer }> {
  const name = await createSnapshot(cfg, collection, fetchFn);
  const data = await downloadSnapshot(cfg, collection, name, fetchFn);
  return { name, data };
}

/** Exact point count for a collection — used to prove a restore reloaded the data. */
export async function collectionCount(cfg: QdrantConfig, collection: string, fetchFn: FetchFn = fetch): Promise<number> {
  const res = await fetchFn(`${base(cfg)}/collections/${enc(collection)}/points/count`, {
    method: 'POST',
    headers: headers(cfg, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ exact: true }),
  });
  if (!res.ok) throw new Error(`count ${collection} failed: ${res.status}`);
  const json = (await res.json()) as { result?: { count?: number } };
  return json.result?.count ?? 0;
}

/**
 * Recover a snapshot's bytes into `collection` via the upload endpoint. For the
 * restore test, point this at a *scratch* collection, never the live one.
 */
export async function recoverSnapshot(
  cfg: QdrantConfig,
  collection: string,
  data: Buffer,
  fetchFn: FetchFn = fetch,
): Promise<void> {
  const form = new FormData();
  form.append('snapshot', new Blob([Uint8Array.from(data)]), `${collection}.snapshot`);
  const res = await fetchFn(`${base(cfg)}/collections/${enc(collection)}/snapshots/upload?priority=snapshot`, {
    method: 'POST',
    headers: headers(cfg),
    body: form,
  });
  if (!res.ok) throw new Error(`recover ${collection} failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
}
