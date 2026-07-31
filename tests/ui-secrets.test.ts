import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createTestEnv } from './helpers.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { SecretCache } from '../src/core/cache.js';
import { AuthManager } from '../src/core/auth.js';
import { AuditLogger } from '../src/core/audit.js';
import { SecretsService } from '../src/core/secrets-service.js';
import { deriveKey } from '../src/storage/crypto.js';
import { resetLockoutState } from '../src/core/lockout.js';
import { buildUiApp } from '../src/ui/server.js';
import { setUiPassword } from '../src/ui/credentials.js';
import { SESSION_COOKIE } from '../src/ui/session.js';

const PASSWORD = 'a-sufficiently-long-password';
const PLAINTEXT = 'sk-live-9f3c2a7e41b8d605c9ae';
const SHORT_PLAINTEXT = 'short1';

async function createCtx() {
  const env = createTestEnv();
  const storage = new SqliteStorage(env.dbPath);
  const salt = randomBytes(16);
  storage.setSalt(salt);
  const key = await deriveKey(readFileSync(env.keyfilePath), salt);
  const cache = new SecretCache(300);
  const auth = new AuthManager(storage);
  const audit = new AuditLogger(storage, { enabled: false, appToken: '', userKey: '' });
  const service = new SecretsService(storage, key, cache, audit);

  await setUiPassword(storage, 'admin', PASSWORD);
  auth.createConsumer('claude-code', 'reader');
  auth.createConsumer('some-service', 'reader');

  const app = buildUiApp({ storage, service, secure: false });

  const loginRes = await app.inject({
    method: 'POST',
    url: '/login',
    payload: { user: 'admin', password: PASSWORD },
  });
  const setCookie = loginRes.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie!;
  const token = raw.split(';')[0].split('=').slice(1).join('=');

  return { app, storage, service, env, cookie: `${SESSION_COOKIE}=${token}` };
}

describe('UI secrets API', () => {
  let ctx: Awaited<ReturnType<typeof createCtx>>;

  beforeEach(async () => {
    resetLockoutState();
    ctx = await createCtx();
    // A seed secret with a realistic-looking value.
    await ctx.app.inject({
      method: 'POST',
      url: '/api/secrets',
      headers: { cookie: ctx.cookie },
      payload: {
        name: 'SEEDED_TOKEN',
        value: PLAINTEXT,
        description: 'seed',
        consumers: ['claude-code'],
        tags: ['monitoring'],
      },
    });
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.env.cleanup();
    resetLockoutState();
  });

  const get = (url: string) =>
    ctx.app.inject({ method: 'GET', url, headers: { cookie: ctx.cookie } });

  const post = (url: string, payload: unknown) =>
    ctx.app.inject({ method: 'POST', url, headers: { cookie: ctx.cookie }, payload });

  const put = (url: string, payload: unknown) =>
    ctx.app.inject({ method: 'PUT', url, headers: { cookie: ctx.cookie }, payload });

  // ── The assertion that matters most ───────────────────────────────────────

  it('never returns the plaintext from any UI GET endpoint', async () => {
    const bodies = await Promise.all([
      get('/api/secrets').then(r => r.body),
      get('/api/secrets/SEEDED_TOKEN').then(r => r.body),
      get('/api/secrets/SEEDED_TOKEN/history').then(r => r.body),
      get('/api/consumers').then(r => r.body),
      get('/api/session').then(r => r.body),
    ]);
    for (const body of bodies) {
      expect(body).not.toContain(PLAINTEXT);
    }
  });

  // ── List ──────────────────────────────────────────────────────────────────

  it('lists metadata without values or masks', async () => {
    const res = await get('/api/secrets');
    expect(res.statusCode).toBe(200);
    const entry = res.json().secrets.find((s: { name: string }) => s.name === 'SEEDED_TOKEN');
    expect(entry).toBeDefined();
    expect(entry.tags).toEqual(['monitoring']);
    expect(entry.consumers).toEqual(['claude-code']);
    expect(entry.value).toBeUndefined();
    expect(entry.masked).toBeUndefined();
  });

  it('filters the list by tag', async () => {
    await post('/api/secrets', {
      name: 'OTHER_TOKEN',
      value: 'x'.repeat(24),
      consumers: [],
      tags: ['trading'],
    });
    const res = await get('/api/secrets?tag=trading');
    const names = res.json().secrets.map((s: { name: string }) => s.name);
    expect(names).toContain('OTHER_TOKEN');
    expect(names).not.toContain('SEEDED_TOKEN');
  });

  // ── Detail ────────────────────────────────────────────────────────────────

  it('returns a mask, not a value', async () => {
    const res = await get('/api/secrets/SEEDED_TOKEN');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.masked).toBe('sk-l...c9ae');
    expect(body.value).toBeUndefined();
    expect(body.version).toBe(1);
  });

  it('masks short values entirely', async () => {
    await post('/api/secrets', {
      name: 'SHORT_ONE',
      value: SHORT_PLAINTEXT,
      consumers: [],
      tags: [],
    });
    const res = await get('/api/secrets/SHORT_ONE');
    expect(res.json().masked).toBe('****');
    expect(res.body).not.toContain(SHORT_PLAINTEXT);
  });

  it('audit-logs the detail view as a read by the UI actor', async () => {
    await get('/api/secrets/SEEDED_TOKEN');
    const entries = ctx.storage.getAuditLog({ limit: 20 });
    const read = entries.find(e => e.action === 'read' && e.details === 'ui_detail');
    expect(read).toBeDefined();
    expect(read!.consumer).toBe('ui:admin');
    expect(read!.secret_name).toBe('SEEDED_TOKEN');
  });

  it('404s an unknown secret', async () => {
    const res = await get('/api/secrets/NOT_THERE');
    expect(res.statusCode).toBe(404);
  });

  it('400s an invalid secret name', async () => {
    const res = await get('/api/secrets/lowercase');
    expect(res.statusCode).toBe(400);
  });

  // ── Create ────────────────────────────────────────────────────────────────

  it('creates a secret and audit-logs it to the UI actor', async () => {
    const res = await post('/api/secrets', {
      name: 'NEW_TOKEN',
      value: 'y'.repeat(30),
      consumers: ['claude-code'],
      tags: ['homelab'],
    });
    expect(res.statusCode).toBe(201);

    const created = ctx.storage
      .getAuditLog({ limit: 20 })
      .find(e => e.action === 'create' && e.secret_name === 'NEW_TOKEN');
    expect(created!.consumer).toBe('ui:admin');
  });

  it('refuses an empty value on create', async () => {
    const res = await post('/api/secrets', { name: 'EMPTY_ONE', value: '', consumers: [], tags: [] });
    expect(res.statusCode).toBe(400);
    expect(ctx.storage.getSecret('EMPTY_ONE')).toBeUndefined();
  });

  it('refuses a missing value on create', async () => {
    const res = await post('/api/secrets', { name: 'NO_VALUE', consumers: [], tags: [] });
    expect(res.statusCode).toBe(400);
    expect(ctx.storage.getSecret('NO_VALUE')).toBeUndefined();
  });

  it('refuses a badly formed name', async () => {
    const res = await post('/api/secrets', { name: 'bad name', value: 'z'.repeat(20), consumers: [], tags: [] });
    expect(res.statusCode).toBe(400);
  });

  it('409s a duplicate name', async () => {
    const res = await post('/api/secrets', {
      name: 'SEEDED_TOKEN',
      value: 'z'.repeat(20),
      consumers: [],
      tags: [],
    });
    expect(res.statusCode).toBe(409);
  });

  // ── Update: the safety property ───────────────────────────────────────────

  it('leaves the value, version and history untouched when no value is sent', async () => {
    const before = ctx.storage.getSecret('SEEDED_TOKEN')!;

    const res = await put('/api/secrets/SEEDED_TOKEN', {
      tags: ['monitoring', 'homelab'],
      consumers: ['claude-code', 'some-service'],
      description: 'edited',
    });
    expect(res.statusCode).toBe(200);

    const after = ctx.storage.getSecret('SEEDED_TOKEN')!;
    expect(after.version).toBe(before.version);
    expect(after.value_enc.equals(before.value_enc)).toBe(true);
    expect(after.iv.equals(before.iv)).toBe(true);
    expect(after.tags).toEqual(['monitoring', 'homelab']);
    expect(after.consumers).toEqual(['claude-code', 'some-service']);
    expect(after.description).toBe('edited');
    expect(ctx.storage.getSecretHistory('SEEDED_TOKEN')).toHaveLength(0);
  });

  it('refuses an explicitly empty value on update, leaving the secret intact', async () => {
    const before = ctx.storage.getSecret('SEEDED_TOKEN')!;
    const res = await put('/api/secrets/SEEDED_TOKEN', { value: '' });
    expect(res.statusCode).toBe(400);

    const after = ctx.storage.getSecret('SEEDED_TOKEN')!;
    expect(after.value_enc.equals(before.value_enc)).toBe(true);
    expect(after.version).toBe(before.version);
  });

  it('rotates the value, bumping the version and writing history', async () => {
    const res = await put('/api/secrets/SEEDED_TOKEN', { value: 'rotated-value-0123456789' });
    expect(res.statusCode).toBe(200);

    const after = ctx.storage.getSecret('SEEDED_TOKEN')!;
    expect(after.version).toBe(2);
    expect(ctx.storage.getSecretHistory('SEEDED_TOKEN')).toHaveLength(1);

    const detail = await get('/api/secrets/SEEDED_TOKEN');
    expect(detail.json().masked).toBe('rota...6789');
  });

  it('404s an update to a missing secret', async () => {
    const res = await put('/api/secrets/NOT_THERE', { tags: ['x'] });
    expect(res.statusCode).toBe(404);
  });

  // ── Optimistic concurrency ────────────────────────────────────────────────

  it('accepts a matching expected_version', async () => {
    const res = await put('/api/secrets/SEEDED_TOKEN', { tags: ['fresh'], expected_version: 1 });
    expect(res.statusCode).toBe(200);
  });

  it('409s a stale expected_version without writing', async () => {
    await put('/api/secrets/SEEDED_TOKEN', { value: 'rotated-value-0123456789' });
    const res = await put('/api/secrets/SEEDED_TOKEN', { tags: ['stale'], expected_version: 1 });
    expect(res.statusCode).toBe(409);
    expect(ctx.storage.getSecret('SEEDED_TOKEN')!.tags).toEqual(['monitoring']);
  });

  // ── Rotation state ────────────────────────────────────────────────────────

  it('reports "none" for a secret with no rotation policy', async () => {
    // The seeded secret has no rotation_days. Green would claim the gateway is
    // watching something it isn't.
    const res = await get('/api/secrets');
    const entry = res.json().secrets.find((s: { name: string }) => s.name === 'SEEDED_TOKEN');
    expect(entry.rotation_days).toBeNull();
    expect(entry.rotation_state).toBe('none');
  });

  it('reports "ok" for a secret inside its rotation window', async () => {
    await post('/api/secrets', {
      name: 'WATCHED_TOKEN',
      value: 'v'.repeat(24),
      consumers: [],
      tags: [],
      rotation_days: 90,
    });
    const res = await get('/api/secrets');
    const entry = res.json().secrets.find((s: { name: string }) => s.name === 'WATCHED_TOKEN');
    expect(entry.rotation_state).toBe('ok');
  });

  it('carries the same state on the detail view', async () => {
    const res = await get('/api/secrets/SEEDED_TOKEN');
    expect(res.json().rotation_state).toBe('none');
    // rotation_status stays as the REST API reports it, for parity.
    expect(res.json().rotation_status).toBe('ok');
  });

  it('still returns no values or masks in the list', async () => {
    const res = await get('/api/secrets');
    const entry = res.json().secrets.find((s: { name: string }) => s.name === 'SEEDED_TOKEN');
    expect(entry.value).toBeUndefined();
    expect(entry.masked).toBeUndefined();
    expect(res.body).not.toContain(PLAINTEXT);
  });

  // ── Payload validation ────────────────────────────────────────────────────

  it('refuses a non-array consumers field', async () => {
    // Storage persists consumers with JSON.stringify and the REST API
    // authorizes with `consumers.includes(name)`. On a string that is substring
    // matching, so `consumers: "claude-code"` would grant a consumer named
    // `claude` access to the secret. Refuse before it reaches storage.
    const res = await post('/api/secrets', {
      name: 'STR_CONSUMERS',
      value: 'v'.repeat(20),
      consumers: 'claude-code-extra',
      tags: [],
    });
    expect(res.statusCode).toBe(400);
    expect(ctx.storage.getSecret('STR_CONSUMERS')).toBeUndefined();
  });

  it('refuses a non-array consumers field on update, leaving the stored array intact', async () => {
    const res = await put('/api/secrets/SEEDED_TOKEN', { consumers: 'claude-code-extra' });
    expect(res.statusCode).toBe(400);
    expect(ctx.storage.getSecret('SEEDED_TOKEN')!.consumers).toEqual(['claude-code']);
  });

  it('refuses non-string entries inside consumers or tags', async () => {
    for (const payload of [
      { name: 'BAD_C', value: 'v'.repeat(20), consumers: ['ok', 42], tags: [] },
      { name: 'BAD_T', value: 'v'.repeat(20), consumers: [], tags: [{ a: 1 }] },
      { name: 'BAD_E', value: 'v'.repeat(20), consumers: [''], tags: [] },
    ]) {
      const res = await post('/api/secrets', payload);
      expect(res.statusCode).toBe(400);
    }
  });

  it('refuses a negative or non-integer rotation_days', async () => {
    for (const rotation of [-5, 0, 1.5, 'ninety']) {
      const res = await post('/api/secrets', {
        name: 'BAD_ROTATION',
        value: 'v'.repeat(20),
        consumers: [],
        tags: [],
        rotation_days: rotation,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(ctx.storage.getSecret('BAD_ROTATION')).toBeUndefined();
  });

  it('returns 400 rather than 500 for an object rotation_days', async () => {
    const res = await post('/api/secrets', {
      name: 'OBJ_ROTATION',
      value: 'v'.repeat(20),
      consumers: [],
      tags: [],
      rotation_days: { a: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts null rotation_days as "no policy"', async () => {
    const res = await post('/api/secrets', {
      name: 'NULL_ROTATION',
      value: 'v'.repeat(20),
      consumers: [],
      tags: [],
      rotation_days: null,
    });
    expect(res.statusCode).toBe(201);
    expect(ctx.storage.getSecret('NULL_ROTATION')!.rotation_days).toBeNull();
  });

  it('refuses a non-string value', async () => {
    const res = await post('/api/secrets', {
      name: 'NUM_VALUE',
      value: 12345,
      consumers: [],
      tags: [],
    });
    expect(res.statusCode).toBe(400);
    expect(ctx.storage.getSecret('NUM_VALUE')).toBeUndefined();
  });

  it('refuses a non-integer expected_version', async () => {
    const res = await put('/api/secrets/SEEDED_TOKEN', { tags: ['x'], expected_version: 'one' });
    expect(res.statusCode).toBe(400);
  });

  // ── Consumers ─────────────────────────────────────────────────────────────

  it('lists consumers without key material', async () => {
    const res = await get('/api/consumers');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('api_key_hash');
    const names = res.json().consumers.map((c: { name: string }) => c.name);
    expect(names).toContain('claude-code');
    for (const consumer of res.json().consumers) {
      expect(Object.keys(consumer).sort()).toEqual(['name', 'role']);
    }
  });

  // ── Session gate covers every route ───────────────────────────────────────

  it('rejects every API route without a session', async () => {
    const unauthenticated = [
      ctx.app.inject({ method: 'GET', url: '/api/secrets' }),
      ctx.app.inject({ method: 'GET', url: '/api/secrets/SEEDED_TOKEN' }),
      ctx.app.inject({ method: 'GET', url: '/api/secrets/SEEDED_TOKEN/history' }),
      ctx.app.inject({ method: 'GET', url: '/api/consumers' }),
      ctx.app.inject({ method: 'POST', url: '/api/secrets', payload: { name: 'X_Y', value: 'v'.repeat(20) } }),
      ctx.app.inject({ method: 'PUT', url: '/api/secrets/SEEDED_TOKEN', payload: { tags: [] } }),
    ];
    for (const res of await Promise.all(unauthenticated)) {
      expect(res.statusCode).toBe(401);
    }
  });
});
