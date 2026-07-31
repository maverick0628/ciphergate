import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { createTestEnv } from './helpers.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { SecretCache } from '../src/core/cache.js';
import { AuthManager } from '../src/core/auth.js';
import { AuditLogger } from '../src/core/audit.js';
import { SecretsService } from '../src/core/secrets-service.js';
import { deriveKey } from '../src/storage/crypto.js';
import { registerAuth, resetRateLimitState } from '../src/api/middleware.js';
import { registerRoutes } from '../src/api/routes.js';
import { loadConfig } from '../src/config.js';

async function createTestApp() {
  const env = createTestEnv();
  const storage = new SqliteStorage(env.dbPath);
  const salt = randomBytes(16);
  storage.setSalt(salt);
  const keyContent = readFileSync(env.keyfilePath);
  const key = await deriveKey(keyContent, salt);
  const cache = new SecretCache(300);
  const auth = new AuthManager(storage);
  const audit = new AuditLogger(storage, { enabled: false, url: '', topic: '' });
  const service = new SecretsService(storage, key, cache, audit);

  const app = Fastify({ logger: false });
  registerAuth(app, auth);
  registerRoutes(app, service, auth, loadConfig(), Date.now());

  // Create admin and reader consumers for tests
  const { apiKey: adminKey } = auth.createConsumer('admin', 'admin');
  const { apiKey: readerKey } = auth.createConsumer('reader', 'reader');

  return { app, storage, service, auth, adminKey, readerKey, env };
}

describe('REST API', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    resetRateLimitState();
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.env.cleanup();
  });

  // ── Health ────────────────────────────────────────────────────────────────

  it('GET /health — 200 without auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('healthy');
    expect(body.timestamp).toBeDefined();
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('GET /v1/secret/:name — 401 without auth header', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/secret/NONEXISTENT' });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBe('unauthorized');
  });

  it('GET /v1/secret/:name — 401 with expired key', async () => {
    // Create a secret the reader can access
    const { apiKey: expiredKey } = ctx.auth.createConsumer('expired-user', 'reader', undefined, '2020-01-01T00:00:00Z');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/secret/TEST_KEY',
      headers: { authorization: `Bearer ${expiredKey}` },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBe('key_expired');
    expect(body.message).toContain('2020-01-01T00:00:00Z');
  });

  // ── Secret CRUD ───────────────────────────────────────────────────────────

  it('POST /v1/secret — admin creates a secret (201)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/secret',
      headers: { authorization: `Bearer ${ctx.adminKey}`, 'content-type': 'application/json' },
      payload: { name: 'TEST_KEY', value: 'super-secret-value', consumers: ['reader'], tags: ['test'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('TEST_KEY');
    expect(body.version).toBe(1);
  });

  it('POST /v1/secret — reader gets 403', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/secret',
      headers: { authorization: `Bearer ${ctx.readerKey}`, 'content-type': 'application/json' },
      payload: { name: 'TEST_KEY', value: 'value', consumers: ['reader'], tags: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /v1/secret/:name — 200 with valid key, correct response shape', async () => {
    // Create secret as admin
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/secret',
      headers: { authorization: `Bearer ${ctx.adminKey}`, 'content-type': 'application/json' },
      payload: { name: 'TEST_KEY', value: 'super-secret-value-long', consumers: ['reader'], tags: ['test'] },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/secret/TEST_KEY',
      headers: { authorization: `Bearer ${ctx.readerKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('TEST_KEY');
    expect(body.value).toBe('super-secret-value-long');
    expect(body.masked).toBeDefined();
    expect(body.version).toBe(1);
    expect(body.updated_at).toBeDefined();
  });

  it('GET /v1/secret/:name — 403 unauthorized consumer', async () => {
    // Create a secret that reader can NOT access
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/secret',
      headers: { authorization: `Bearer ${ctx.adminKey}`, 'content-type': 'application/json' },
      payload: { name: 'PRIVATE_KEY', value: 'secret-value', consumers: ['other-consumer'], tags: [] },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/secret/PRIVATE_KEY',
      headers: { authorization: `Bearer ${ctx.readerKey}` },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe('access_denied');
  });

  it('GET /v1/secret/:name — 404 for nonexistent', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/secret/NONEXISTENT',
      headers: { authorization: `Bearer ${ctx.adminKey}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /v1/secret/:name — admin updates secret', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/secret',
      headers: { authorization: `Bearer ${ctx.adminKey}`, 'content-type': 'application/json' },
      payload: { name: 'UPDATE_ME', value: 'original-value', consumers: ['reader'], tags: [] },
    });

    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/secret/UPDATE_ME',
      headers: { authorization: `Bearer ${ctx.adminKey}`, 'content-type': 'application/json' },
      payload: { value: 'updated-value' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('UPDATE_ME');
    expect(body.version).toBe(2);
  });

  it('DELETE /v1/secret/:name — admin deletes', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/secret',
      headers: { authorization: `Bearer ${ctx.adminKey}`, 'content-type': 'application/json' },
      payload: { name: 'DELETE_ME', value: 'to-be-deleted', consumers: [], tags: [] },
    });

    const deleteRes = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/secret/DELETE_ME',
      headers: { authorization: `Bearer ${ctx.adminKey}` },
    });
    expect(deleteRes.statusCode).toBe(204);

    // Confirm it's gone
    const getRes = await ctx.app.inject({
      method: 'GET',
      url: '/v1/secret/DELETE_ME',
      headers: { authorization: `Bearer ${ctx.adminKey}` },
    });
    expect(getRes.statusCode).toBe(404);
  });

  // ── List ──────────────────────────────────────────────────────────────────

  it('GET /v1/secrets — list with tag filter', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/secret',
      headers: { authorization: `Bearer ${ctx.adminKey}`, 'content-type': 'application/json' },
      payload: { name: 'SECRET_A', value: 'val-a', consumers: ['reader'], tags: ['test'] },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/secret',
      headers: { authorization: `Bearer ${ctx.adminKey}`, 'content-type': 'application/json' },
      payload: { name: 'SECRET_B', value: 'val-b', consumers: ['reader'], tags: ['prod'] },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/secrets?tag=test',
      headers: { authorization: `Bearer ${ctx.readerKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.secrets).toHaveLength(1);
    expect(body.secrets[0].name).toBe('SECRET_A');
  });

  // ── Batch ─────────────────────────────────────────────────────────────────

  it('POST /v1/secrets/batch — returns secrets + missing + denied', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/secret',
      headers: { authorization: `Bearer ${ctx.adminKey}`, 'content-type': 'application/json' },
      payload: { name: 'BATCH_A', value: 'batch-a-value', consumers: ['reader'], tags: [] },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/secret',
      headers: { authorization: `Bearer ${ctx.adminKey}`, 'content-type': 'application/json' },
      payload: { name: 'BATCH_B', value: 'batch-b-value', consumers: ['other'], tags: [] },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/secrets/batch',
      headers: { authorization: `Bearer ${ctx.readerKey}`, 'content-type': 'application/json' },
      payload: { names: ['BATCH_A', 'BATCH_B', 'BATCH_MISSING'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.secrets).toHaveLength(1);
    expect(body.secrets[0].name).toBe('BATCH_A');
    expect(body.missing).toContain('BATCH_MISSING');
    expect(body.denied).toContain('BATCH_B');
  });

  // ── Env ───────────────────────────────────────────────────────────────────

  it('GET /v1/env?tag=test — returns text/plain dotenv format', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/secret',
      headers: { authorization: `Bearer ${ctx.adminKey}`, 'content-type': 'application/json' },
      payload: { name: 'ENV_VAR', value: 'my-env-value', consumers: ['reader'], tags: ['test'] },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/env?tag=test',
      headers: { authorization: `Bearer ${ctx.readerKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.payload).toContain('ENV_VAR=my-env-value');
  });

  // ── Cache ─────────────────────────────────────────────────────────────────

  it('POST /v1/cache/refresh — admin only', async () => {
    const adminRes = await ctx.app.inject({
      method: 'POST',
      url: '/v1/cache/refresh',
      headers: { authorization: `Bearer ${ctx.adminKey}` },
    });
    expect(adminRes.statusCode).toBe(200);

    const readerRes = await ctx.app.inject({
      method: 'POST',
      url: '/v1/cache/refresh',
      headers: { authorization: `Bearer ${ctx.readerKey}` },
    });
    expect(readerRes.statusCode).toBe(403);
  });

  // ── Audit ─────────────────────────────────────────────────────────────────

  it('GET /v1/audit — admin only', async () => {
    const adminRes = await ctx.app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: `Bearer ${ctx.adminKey}` },
    });
    expect(adminRes.statusCode).toBe(200);
    const body = adminRes.json();
    expect(Array.isArray(body.entries)).toBe(true);

    const readerRes = await ctx.app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: `Bearer ${ctx.readerKey}` },
    });
    expect(readerRes.statusCode).toBe(403);
  });

  // ── Rotation Report ───────────────────────────────────────────────────────

  it('GET /v1/rotation-report — admin only', async () => {
    const adminRes = await ctx.app.inject({
      method: 'GET',
      url: '/v1/rotation-report',
      headers: { authorization: `Bearer ${ctx.adminKey}` },
    });
    expect(adminRes.statusCode).toBe(200);
    const body = adminRes.json();
    expect(body).toHaveProperty('due');
    expect(body).toHaveProperty('overdue');
    expect(body).toHaveProperty('ok');

    const readerRes = await ctx.app.inject({
      method: 'GET',
      url: '/v1/rotation-report',
      headers: { authorization: `Bearer ${ctx.readerKey}` },
    });
    expect(readerRes.statusCode).toBe(403);
  });

  // ── History ───────────────────────────────────────────────────────────────

  it('GET /v1/secret/:name/history — version history', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/secret',
      headers: { authorization: `Bearer ${ctx.adminKey}`, 'content-type': 'application/json' },
      payload: { name: 'HIST_KEY', value: 'v1-value', consumers: ['reader'], tags: [] },
    });
    await ctx.app.inject({
      method: 'PUT',
      url: '/v1/secret/HIST_KEY',
      headers: { authorization: `Bearer ${ctx.adminKey}`, 'content-type': 'application/json' },
      payload: { value: 'v2-value' },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/secret/HIST_KEY/history',
      headers: { authorization: `Bearer ${ctx.readerKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('HIST_KEY');
    expect(body.current_version).toBe(2);
    expect(body.history).toHaveLength(1);
    expect(body.history[0].version).toBe(1);
  });

  it('GET /v1/secret/:name?version=1 — specific version with is_current: false', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/secret',
      headers: { authorization: `Bearer ${ctx.adminKey}`, 'content-type': 'application/json' },
      payload: { name: 'VER_KEY', value: 'original-long-value', consumers: ['reader'], tags: [] },
    });
    await ctx.app.inject({
      method: 'PUT',
      url: '/v1/secret/VER_KEY',
      headers: { authorization: `Bearer ${ctx.adminKey}`, 'content-type': 'application/json' },
      payload: { value: 'updated-long-value' },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/secret/VER_KEY?version=1',
      headers: { authorization: `Bearer ${ctx.readerKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.value).toBe('original-long-value');
    expect(body.version).toBe(1);
    expect(body.is_current).toBe(false);
  });

  // ── Status ────────────────────────────────────────────────────────────────

  it('GET /v1/status — admin only, includes version field', async () => {
    const adminRes = await ctx.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: { authorization: `Bearer ${ctx.adminKey}` },
    });
    expect(adminRes.statusCode).toBe(200);
    const body = adminRes.json();
    expect(body.version).toBeDefined();
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(body.secrets).toBeDefined();
    expect(body.consumers).toBeDefined();
    expect(body.cache).toBeDefined();

    const readerRes = await ctx.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: { authorization: `Bearer ${ctx.readerKey}` },
    });
    expect(readerRes.statusCode).toBe(403);
  });
});
