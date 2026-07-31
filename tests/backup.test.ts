import { describe, it, expect } from 'vitest';
import { planRetention, isoWeek } from '../src/backup/retention.js';

// ---------------------------------------------------------------------------
// retention planner — pure logic: which dated backup keys to keep vs prune.
// ---------------------------------------------------------------------------

describe('planRetention', () => {
  const keysFor = (dates: string[]): string[] =>
    dates.flatMap((d) => [`qdrant/${d}/claude-memory.snapshot.enc`, `gateway/${d}/gateway.db.enc`]);

  it('keeps everything when fewer dated runs than the daily window', () => {
    const keys = keysFor(['2026-06-29', '2026-06-28', '2026-06-27']);
    const { keep, prune } = planRetention(keys, { retainDaily: 7, retainWeekly: 4 });
    expect(prune).toEqual([]);
    expect(keep.sort()).toEqual(keys.sort());
  });

  it('keeps the newest N dates within the daily window', () => {
    const dates = ['2026-06-29', '2026-06-28', '2026-06-27', '2026-06-26'];
    const keys = keysFor(dates);
    const { prune } = planRetention(keys, { retainDaily: 2, retainWeekly: 0 });
    // newest two dates kept; the two older dates fully pruned
    expect(prune.sort()).toEqual(keysFor(['2026-06-27', '2026-06-26']).sort());
  });

  it('prunes ALL keys belonging to a pruned date, not just some', () => {
    const keys = keysFor(['2026-06-29', '2026-06-01']);
    const { prune } = planRetention(keys, { retainDaily: 1, retainWeekly: 0 });
    expect(prune.sort()).toEqual([
      'gateway/2026-06-01/gateway.db.enc',
      'qdrant/2026-06-01/claude-memory.snapshot.enc',
    ]);
  });

  it('retains one run per ISO week beyond the daily window, up to retainWeekly', () => {
    // 06-15 (Mon) and 06-21 (Sun) are the SAME ISO week; the rest are distinct weeks.
    const dates = [
      '2026-06-29', // newest — daily window
      '2026-06-21', // ISO week of 06-15..06-21 (week X)
      '2026-06-15', // same ISO week X — should collapse to one kept
      '2026-06-08', // week Y
      '2026-06-01', // week Z — beyond retainWeekly, pruned
    ];
    const keys = keysFor(dates);
    const { keep, prune } = planRetention(keys, { retainDaily: 1, retainWeekly: 2 });
    const keptDates = new Set(keep.map((k) => k.split('/')[1]));
    expect(keptDates.has('2026-06-29')).toBe(true); // daily
    expect(keptDates.has('2026-06-08')).toBe(true); // week Y
    expect(keptDates.has('2026-06-01')).toBe(false); // week Z pruned
    // only one of the two same-week days (06-21 / 06-15) is kept
    const weekXKept = ['2026-06-21', '2026-06-15'].filter((d) => keptDates.has(d));
    expect(weekXKept.length).toBe(1);
    // pruned + kept partition the input
    expect([...prune, ...keep].sort()).toEqual(keys.sort());
  });

  it('ignores keys without a parseable date', () => {
    const keys = ['manifest/latest.json', 'qdrant/2026-06-29/claude-memory.snapshot.enc'];
    const { keep, prune } = planRetention(keys, { retainDaily: 7, retainWeekly: 4 });
    expect(keep).toContain('manifest/latest.json'); // undated keys always kept
    expect(prune).toEqual([]);
  });
});

describe('isoWeek', () => {
  it('assigns the same week to days in one ISO week and differs across weeks', () => {
    expect(isoWeek('2026-06-15')).toBe(isoWeek('2026-06-21')); // Mon & Sun of same ISO week
    expect(isoWeek('2026-06-22')).not.toBe(isoWeek('2026-06-15'));
  });
});

// ---------------------------------------------------------------------------
// offsite store — AWS SigV4 signing + R2/S3 PUT/LIST/DELETE against a stub.
// ---------------------------------------------------------------------------
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { deriveSigningKey, putObject, getObject, listObjects, pruneRetention, type S3Config } from '../src/backup/store.js';

describe('deriveSigningKey (SigV4)', () => {
  it('matches the AWS-documented test vector', () => {
    // From AWS "Examples of how to derive a signing key" (SigV4 docs).
    const key = deriveSigningKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam');
    expect(key.toString('hex')).toBe('c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
  });
});

interface S3Call { method: string; url: string; auth?: string; sha?: string; body: Buffer }
async function startS3Stub(): Promise<{ server: Server; cfg: (bucket: string) => S3Config; store: Map<string, Buffer>; calls: S3Call[]; close: () => void }> {
  const store = new Map<string, Buffer>();
  const calls: S3Call[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url ?? '/', 'http://localhost');
      calls.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers['authorization'] as string, sha: req.headers['x-amz-content-sha256'] as string, body });
      const path = decodeURIComponent(u.pathname); // /bucket/key...
      if (req.method === 'PUT') { store.set(path, body); res.statusCode = 200; return res.end(); }
      if (req.method === 'DELETE') { store.delete(path); res.statusCode = 204; return res.end(); }
      if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix') ?? '';
        const bucketPrefix = path; // /bucket
        const keys = [...store.keys()].filter((k) => k.startsWith(`${bucketPrefix}/${prefix}`)).map((k) => k.slice(bucketPrefix.length + 1));
        const xml = `<?xml version="1.0"?><ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key><Size>${store.get(`${bucketPrefix}/${k}`)!.length}</Size></Contents>`).join('')}</ListBucketResult>`;
        res.setHeader('Content-Type', 'application/xml'); return res.end(xml);
      }
      if (req.method === 'GET') {
        const v = store.get(path);
        if (!v) { res.statusCode = 404; return res.end(); }
        return res.end(v);
      }
      res.statusCode = 400; res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return {
    server, store, calls,
    cfg: (bucket) => ({ endpoint: `http://127.0.0.1:${port}`, bucket, accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', region: 'auto' }),
    close: () => server.close(),
  };
}

describe('putObject / getObject', () => {
  it('PUTs a signed object and reads it back byte-identical', async () => {
    const stub = await startS3Stub();
    try {
      const cfg = stub.cfg('homelab-backups');
      const payload = Buffer.from('binary\x00\x01snapshot');
      await putObject(cfg, 'qdrant/2026-06-29/claude-memory.snapshot.enc', payload);
      const put = stub.calls.find((c) => c.method === 'PUT')!;
      expect(put.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/);
      expect(put.sha).toBe(createHash('sha256').update(payload).digest('hex'));
      const got = await getObject(cfg, 'qdrant/2026-06-29/claude-memory.snapshot.enc');
      expect(got.equals(payload)).toBe(true);
    } finally { stub.close(); }
  });
});

describe('listObjects', () => {
  it('lists keys under a prefix', async () => {
    const stub = await startS3Stub();
    try {
      const cfg = stub.cfg('homelab-backups');
      await putObject(cfg, 'qdrant/2026-06-29/a.enc', Buffer.from('a'));
      await putObject(cfg, 'qdrant/2026-06-28/b.enc', Buffer.from('b'));
      await putObject(cfg, 'gateway/2026-06-29/c.enc', Buffer.from('c'));
      const keys = await listObjects(cfg, 'qdrant/');
      expect(keys.sort()).toEqual(['qdrant/2026-06-28/b.enc', 'qdrant/2026-06-29/a.enc']);
    } finally { stub.close(); }
  });
});

describe('pruneRetention', () => {
  it('deletes only keys outside the retention window', async () => {
    const stub = await startS3Stub();
    try {
      const cfg = stub.cfg('homelab-backups');
      for (const d of ['2026-06-29', '2026-06-28', '2026-06-01']) await putObject(cfg, `qdrant/${d}/x.enc`, Buffer.from(d));
      const { pruned } = await pruneRetention(cfg, 'qdrant/', { retainDaily: 2, retainWeekly: 0 });
      expect(pruned).toEqual(['qdrant/2026-06-01/x.enc']);
      const left = await listObjects(cfg, 'qdrant/');
      expect(left.sort()).toEqual(['qdrant/2026-06-28/x.enc', 'qdrant/2026-06-29/x.enc']);
    } finally { stub.close(); }
  });
});

// ---------------------------------------------------------------------------
// archive — encrypt-at-rest for the Qdrant/Letta dumps (AES-256-GCM, argon2id).
// ---------------------------------------------------------------------------
import { sealBuffer, openBuffer } from '../src/backup/archive.js';

describe('archive seal/open', () => {
  it('round-trips arbitrary binary byte-for-byte', async () => {
    const plain = Buffer.from([0, 1, 2, 255, 128, 64, 0, 0, 7]);
    const sealed = await sealBuffer(plain, 'correct horse battery staple');
    expect(sealed.equals(plain)).toBe(false); // actually encrypted
    const opened = await openBuffer(sealed, 'correct horse battery staple');
    expect(opened.equals(plain)).toBe(true);
  });

  it('fails to open with the wrong passphrase', async () => {
    const sealed = await sealBuffer(Buffer.from('secret snapshot'), 'right-key');
    await expect(openBuffer(sealed, 'wrong-key')).rejects.toThrow();
  });

  it('fails to open tampered ciphertext (GCM auth)', async () => {
    const sealed = await sealBuffer(Buffer.from('secret snapshot'), 'k');
    sealed[sealed.length - 1] ^= 0xff; // flip a ciphertext byte
    await expect(openBuffer(sealed, 'k')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// qdrant — snapshot, download, count, recover against a fake Qdrant.
// ---------------------------------------------------------------------------
import { snapshotCollection, collectionCount, recoverSnapshot, type QdrantConfig } from '../src/backup/qdrant.js';

interface QCall { method: string; url: string; body: Buffer; apiKey?: string }
async function startQdrantStub(): Promise<{ cfg: QdrantConfig; calls: QCall[]; snapshots: Map<string, Buffer>; close: () => void }> {
  const calls: QCall[] = [];
  const snapshots = new Map<string, Buffer>();
  const counts: Record<string, number> = { 'claude-memory': 1500 };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = req.url ?? '';
      calls.push({ method: req.method ?? '', url: u, body, apiKey: req.headers['api-key'] as string });
      res.setHeader('Content-Type', 'application/json');
      let m;
      if ((m = u.match(/^\/collections\/([^/]+)\/snapshots$/)) && req.method === 'POST') {
        if (!(m[1] in counts)) { res.statusCode = 404; return res.end(JSON.stringify({ status: { error: `Collection ${m[1]} not found` } })); }
        const name = `${m[1]}-snap-1.snapshot`;
        snapshots.set(`${m[1]}/${name}`, Buffer.from(`SNAPSHOT:${m[1]}`));
        return res.end(JSON.stringify({ result: { name, size: 12 }, status: 'ok' }));
      }
      if ((m = u.match(/^\/collections\/([^/]+)\/snapshots\/([^/]+)$/)) && req.method === 'GET') {
        const data = snapshots.get(`${m[1]}/${decodeURIComponent(m[2])}`);
        res.setHeader('Content-Type', 'application/octet-stream');
        return res.end(data ?? Buffer.alloc(0));
      }
      if ((m = u.match(/^\/collections\/([^/]+)\/points\/count$/)) && req.method === 'POST') {
        return res.end(JSON.stringify({ result: { count: counts[m[1]] ?? 0 }, status: 'ok' }));
      }
      if ((m = u.match(/^\/collections\/([^/]+)\/snapshots\/upload/)) && req.method === 'POST') {
        snapshots.set(`recovered/${m[1]}`, body);
        counts[m[1]] = 1500; // a recovered scratch collection reports the reloaded count
        return res.end(JSON.stringify({ result: true, status: 'ok' }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return {
    cfg: { qdrantUrl: `http://127.0.0.1:${port}`, qdrantApiKey: 'qkey' },
    calls, snapshots, close: () => server.close(),
  };
}

describe('snapshotCollection', () => {
  it('creates a snapshot, downloads it, and sends the api-key', async () => {
    const stub = await startQdrantStub();
    try {
      const out = await snapshotCollection(stub.cfg, 'claude-memory');
      expect(out.name).toBe('claude-memory-snap-1.snapshot');
      expect(out.data.toString()).toBe('SNAPSHOT:claude-memory');
      expect(stub.calls.every((c) => c.apiKey === 'qkey')).toBe(true);
      expect(stub.calls.some((c) => c.method === 'POST' && c.url.endsWith('/snapshots'))).toBe(true);
    } finally { stub.close(); }
  });
});

describe('collectionCount', () => {
  it('returns the exact point count', async () => {
    const stub = await startQdrantStub();
    try {
      expect(await collectionCount(stub.cfg, 'claude-memory')).toBe(1500);
      const counted = stub.calls.find((c) => c.url.endsWith('/points/count'))!;
      expect(JSON.parse(counted.body.toString()).exact).toBe(true);
    } finally { stub.close(); }
  });
});

describe('recoverSnapshot', () => {
  it('uploads the snapshot bytes to the recover endpoint', async () => {
    const stub = await startQdrantStub();
    try {
      await recoverSnapshot(stub.cfg, 'scratch-restore', Buffer.from('SNAPSHOT:claude-memory'));
      const up = stub.calls.find((c) => c.url.includes('/snapshots/upload'))!;
      expect(up).toBeTruthy();
      expect(up.body.includes(Buffer.from('SNAPSHOT:claude-memory'))).toBe(true);
    } finally { stub.close(); }
  });
});

// ---------------------------------------------------------------------------
// letta — list agents + export each against a fake Letta.
// ---------------------------------------------------------------------------
import { listAgents, exportAgent, exportAllAgents, type LettaConfig } from '../src/backup/letta.js';

async function startLettaStub(): Promise<{ cfg: LettaConfig; auth: string[]; close: () => void }> {
  const auth: string[] = [];
  const agents = [{ id: 'agent-1', name: 'overseer' }, { id: 'agent-2', name: 'researcher' }];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on('data', () => {});
    req.on('end', () => {
      auth.push((req.headers['authorization'] as string) ?? '');
      const u = req.url ?? '';
      res.setHeader('Content-Type', 'application/json');
      let m;
      if (u.startsWith('/v1/agents/') && (m = u.match(/^\/v1\/agents\/([^/]+)\/export/))) {
        return res.end(JSON.stringify({ agent_id: m[1], serialized: true, memory: [`mem-of-${m[1]}`] }));
      }
      if (u.startsWith('/v1/agents')) return res.end(JSON.stringify(agents));
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return { cfg: { lettaUrl: `http://127.0.0.1:${port}`, lettaKey: 'letta-key' }, auth, close: () => server.close() };
}

describe('listAgents', () => {
  it('returns id+name and sends the bearer token', async () => {
    const stub = await startLettaStub();
    try {
      const agents = await listAgents(stub.cfg);
      expect(agents).toEqual([{ id: 'agent-1', name: 'overseer' }, { id: 'agent-2', name: 'researcher' }]);
      expect(stub.auth.every((a) => a === 'Bearer letta-key')).toBe(true);
    } finally { stub.close(); }
  });
});

describe('exportAgent / exportAllAgents', () => {
  it('exports one agent to bytes', async () => {
    const stub = await startLettaStub();
    try {
      const data = await exportAgent(stub.cfg, 'agent-1');
      expect(JSON.parse(data.toString()).agent_id).toBe('agent-1');
    } finally { stub.close(); }
  });

  it('exports every agent with its name', async () => {
    const stub = await startLettaStub();
    try {
      const all = await exportAllAgents(stub.cfg);
      expect(all.map((a) => a.name).sort()).toEqual(['overseer', 'researcher']);
      expect(all.every((a) => a.data.length > 0)).toBe(true);
    } finally { stub.close(); }
  });
});

// ---------------------------------------------------------------------------
// gateway — capture the encrypted DB artifact from a backup command.
// ---------------------------------------------------------------------------
import { backupGateway, type GatewayConfig } from '../src/backup/gateway.js';

describe('backupGateway', () => {
  it('runs the configured command and returns the captured artifact bytes', async () => {
    const cfg: GatewayConfig = { backupCommand: ['docker', 'exec', 'ciphergate', 'sh', '-c', 'dump'] };
    let ran: string[] | undefined;
    const out = await backupGateway(cfg, {
      capture: async (argv) => { ran = argv; return Buffer.from('ENCRYPTED-DB-BYTES'); },
    });
    expect(ran).toEqual(['docker', 'exec', 'ciphergate', 'sh', '-c', 'dump']);
    expect(out.data.toString()).toBe('ENCRYPTED-DB-BYTES');
    expect(out.command).toEqual(cfg.backupCommand);
  });

  it('fails loudly when the command yields no bytes', async () => {
    const cfg: GatewayConfig = { backupCommand: ['true'] };
    await expect(backupGateway(cfg, { capture: async () => Buffer.alloc(0) })).rejects.toThrow(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// config — env-driven with homelab defaults.
// ---------------------------------------------------------------------------
import { backupConfigFromEnv } from '../src/backup/config.js';

describe('backupConfigFromEnv', () => {
  const baseEnv = {
    BACKUP_ENCRYPTION_KEY: 'pp',
    R2_ACCESS_KEY_ID: 'ak', R2_SECRET_ACCESS_KEY: 'sk',
    R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', R2_BUCKET: 'example-backups',
  };

  it('applies defaults', () => {
    const cfg = backupConfigFromEnv(baseEnv);
    expect(cfg.qdrant.qdrantUrl).toBe('http://llm-host:6333');
    expect(cfg.retention).toEqual({ retainDaily: 7, retainWeekly: 4 });
    expect(cfg.store.region).toBe('auto');
  });

  it('snapshots no Qdrant collections unless asked to', () => {
    // Backing up someone else's vector store is opt-in. An empty default means
    // a fresh install backs up its own database and nothing more.
    expect(backupConfigFromEnv(baseEnv).collections).toEqual([]);
  });

  it('parses BACKUP_COLLECTIONS as a comma list and trims', () => {
    const cfg = backupConfigFromEnv({ ...baseEnv, BACKUP_COLLECTIONS: ' a , b ,c ' });
    expect(cfg.collections).toEqual(['a', 'b', 'c']);
  });

  it('overrides retention from env', () => {
    const cfg = backupConfigFromEnv({ ...baseEnv, BACKUP_RETAIN_DAILY: '3', BACKUP_RETAIN_WEEKLY: '2' });
    expect(cfg.retention).toEqual({ retainDaily: 3, retainWeekly: 2 });
  });

  it('throws when a required offsite credential is missing', () => {
    expect(() => backupConfigFromEnv({ BACKUP_ENCRYPTION_KEY: 'pp' })).toThrow(/R2_/);
  });

  it('throws when the encryption passphrase is missing', () => {
    expect(() => backupConfigFromEnv({ ...baseEnv, BACKUP_ENCRYPTION_KEY: '' })).toThrow(/BACKUP_ENCRYPTION_KEY/);
  });
});

// ---------------------------------------------------------------------------
// runner — orchestrate qdrant + gateway + letta -> encrypt -> upload -> manifest.
// ---------------------------------------------------------------------------
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBackup } from '../src/backup/runner.js';
import type { BackupConfig } from '../src/backup/config.js';

async function fullStubConfig(): Promise<{ cfg: BackupConfig; s3: Awaited<ReturnType<typeof startS3Stub>>; closeAll: () => void; stateDir: string }> {
  const q = await startQdrantStub();
  const l = await startLettaStub();
  const s3 = await startS3Stub();
  const stateDir = mkdtempSync(join(tmpdir(), 'backup-state-'));
  const cfg: BackupConfig = {
    qdrant: q.cfg,
    collections: ['claude-memory'],
    letta: l.cfg,
    gateway: { backupCommand: ['emit-db'] },
    store: s3.cfg('homelab-backups'),
    retention: { retainDaily: 7, retainWeekly: 4 },
    encryptionKey: 'backup-passphrase',
    statePath: join(stateDir, 'backup-manifest.json'),
  };
  return { cfg, s3, stateDir, closeAll: () => { q.close(); l.close(); s3.close(); rmSync(stateDir, { recursive: true, force: true }); } };
}

describe('runBackup', () => {
  it('snapshots, encrypts, uploads each asset and writes a manifest', async () => {
    const { cfg, s3, closeAll } = await fullStubConfig();
    try {
      const now = new Date('2026-06-29T12:00:00Z');
      const manifest = await runBackup(cfg, { capture: async () => Buffer.from('ENCRYPTED-DB'), now });

      // manifest covers all three asset types
      const types = manifest.assets.map((a) => a.type).sort();
      expect(types).toEqual(['gateway', 'letta', 'letta', 'qdrant']);
      expect(manifest.date).toBe('2026-06-29');
      expect(manifest.assets.every((a) => a.size > 0 && /^[0-9a-f]{64}$/.test(a.sha256))).toBe(true);
      // the qdrant asset records the source point count
      expect(manifest.assets.find((a) => a.type === 'qdrant')!.count).toBe(1500);

      // objects landed under dated prefixes + the manifest pointers exist
      const keys = [...s3.store.keys()].map((k) => k.replace('/homelab-backups/', ''));
      expect(keys).toContain('qdrant/2026-06-29/claude-memory.snapshot.enc');
      expect(keys).toContain('gateway/2026-06-29/gateway.db');
      expect(keys.some((k) => k.startsWith('letta/2026-06-29/'))).toBe(true);
      expect(keys).toContain('manifest/2026-06-29.json');
      expect(keys).toContain('manifest/latest.json');
    } finally { closeAll(); }
  });

  it('encrypts the qdrant dump at rest (recoverable with the passphrase)', async () => {
    const { cfg, s3, closeAll } = await fullStubConfig();
    try {
      const now = new Date('2026-06-29T12:00:00Z');
      await runBackup(cfg, { capture: async () => Buffer.from('ENCRYPTED-DB'), now });
      const sealed = s3.store.get('/homelab-backups/qdrant/2026-06-29/claude-memory.snapshot.enc')!;
      const opened = await openBuffer(sealed, 'backup-passphrase');
      expect(opened.toString()).toBe('SNAPSHOT:claude-memory'); // original snapshot bytes
    } finally { closeAll(); }
  });

  it('records a per-asset error and still backs up the rest', async () => {
    const { cfg, s3, closeAll } = await fullStubConfig();
    try {
      const now = new Date('2026-06-29T12:00:00Z');
      cfg.collections = ['claude-memory', 'does-not-exist'];
      const manifest = await runBackup(cfg, { capture: async () => Buffer.from('ENCRYPTED-DB'), now });
      expect(manifest.errors.some((e) => e.includes('does-not-exist'))).toBe(true);
      // the good collection still made it
      expect([...s3.store.keys()].some((k) => k.includes('claude-memory.snapshot.enc'))).toBe(true);
    } finally { closeAll(); }
  });
});

// ---------------------------------------------------------------------------
// restore — dry-run listing + recover a snapshot into a SCRATCH collection.
// ---------------------------------------------------------------------------
import { listRestorable, restoreQdrantCollection } from '../src/backup/restore.js';

describe('listRestorable', () => {
  it('lists the keys that a restore would touch (dry-run)', async () => {
    const s3 = await startS3Stub();
    try {
      const cfg = s3.cfg('homelab-backups');
      await putObject(cfg, 'qdrant/2026-06-29/claude-memory.snapshot.enc', Buffer.from('x'));
      await putObject(cfg, 'qdrant/2026-06-28/other.snapshot.enc', Buffer.from('y'));
      const keys = await listRestorable(cfg, 'qdrant', '2026-06-29');
      expect(keys).toEqual(['qdrant/2026-06-29/claude-memory.snapshot.enc']);
    } finally { s3.close(); }
  });
});

describe('restoreQdrantCollection', () => {
  it('downloads, decrypts, and recovers into a scratch collection (not the live one)', async () => {
    const q = await startQdrantStub();
    const s3 = await startS3Stub();
    try {
      const store = s3.cfg('homelab-backups');
      // seed an offsite sealed snapshot the way runBackup would have
      const sealed = await sealBuffer(Buffer.from('SNAPSHOT:claude-memory'), 'pp');
      await putObject(store, 'qdrant/2026-06-29/claude-memory.snapshot.enc', sealed);

      const out = await restoreQdrantCollection({ store, qdrant: q.cfg, encryptionKey: 'pp' }, '2026-06-29', 'claude-memory');
      expect(out.scratch).toBe('claude-memory__restore_2026_06_29');
      expect(out.scratch).not.toBe('claude-memory'); // never the live collection
      expect(out.count).toBe(1500); // recovered count visible
      // the decrypted snapshot bytes reached qdrant's recover endpoint
      expect(q.snapshots.get(`recovered/${out.scratch}`)!.includes(Buffer.from('SNAPSHOT:claude-memory'))).toBe(true);
    } finally { q.close(); s3.close(); }
  });
});
