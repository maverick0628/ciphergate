import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createTestEnv } from './helpers.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { SecretCache } from '../src/core/cache.js';
import { AuditLogger } from '../src/core/audit.js';
import { SecretsService } from '../src/core/secrets-service.js';
import { deriveKey } from '../src/storage/crypto.js';
import { resetLockoutState } from '../src/core/lockout.js';
import { buildUiApp } from '../src/ui/server.js';
import { setUiPassword } from '../src/ui/credentials.js';
import { SESSION_COOKIE } from '../src/ui/session.js';

const PASSWORD = 'a-sufficiently-long-password';

async function createUiTestApp(opts: { configured?: boolean; secure?: boolean } = {}) {
  const env = createTestEnv();
  const storage = new SqliteStorage(env.dbPath);
  const salt = randomBytes(16);
  storage.setSalt(salt);
  const key = await deriveKey(readFileSync(env.keyfilePath), salt);
  const cache = new SecretCache(300);
  const audit = new AuditLogger(storage, { enabled: false, appToken: '', userKey: '' });
  const service = new SecretsService(storage, key, cache, audit);

  if (opts.configured !== false) {
    await setUiPassword(storage, 'admin', PASSWORD);
  }

  const app = buildUiApp({ storage, service, secure: opts.secure ?? false });
  return { app, storage, service, env };
}

/** Log in and return the raw session cookie value. */
async function login(app: Awaited<ReturnType<typeof createUiTestApp>>['app']): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/login',
    payload: { user: 'admin', password: PASSWORD },
  });
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie!;
  return raw.split(';')[0].split('=').slice(1).join('=');
}

describe('UI auth', () => {
  let ctx: Awaited<ReturnType<typeof createUiTestApp>>;

  afterEach(async () => {
    if (ctx) {
      await ctx.app.close();
      ctx.env.cleanup();
    }
    resetLockoutState();
  });

  beforeEach(() => resetLockoutState());

  describe('unconfigured install', () => {
    beforeEach(async () => {
      ctx = await createUiTestApp({ configured: false });
    });

    it('refuses login with 503 rather than exposing an admin surface', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/login',
        payload: { user: 'admin', password: PASSWORD },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('ui_not_configured');
    });

    it('still refuses API access', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/session' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('configured install', () => {
    beforeEach(async () => {
      ctx = await createUiTestApp();
    });

    it('sets a session cookie on a correct password', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/login',
        payload: { user: 'admin', password: PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      const setCookie = res.headers['set-cookie'];
      const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie!;
      expect(raw).toContain(SESSION_COOKIE);
      expect(raw).toContain('HttpOnly');
      expect(raw).toContain('SameSite=Strict');
    });

    it('rejects a wrong password with 401', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/login',
        payload: { user: 'admin', password: 'wrong-but-long-enough' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('gives the same answer for an unknown user as a wrong password', async () => {
      const unknown = await ctx.app.inject({
        method: 'POST',
        url: '/login',
        payload: { user: 'nobody', password: PASSWORD },
      });
      expect(unknown.statusCode).toBe(401);
      expect(unknown.json().error).toBe('unauthorized');
    });

    it('never echoes the password back', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/login',
        payload: { user: 'admin', password: 'wrong-but-long-enough' },
      });
      expect(res.body).not.toContain('wrong-but-long-enough');
    });

    it('locks out after too many failures', async () => {
      for (let i = 0; i < 6; i++) {
        await ctx.app.inject({
          method: 'POST',
          url: '/login',
          payload: { user: 'admin', password: 'wrong-but-long-enough' },
        });
      }
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/login',
        payload: { user: 'admin', password: PASSWORD },
      });
      expect(res.statusCode).toBe(429);
    });

    it('records a failed login in the audit trail', async () => {
      await ctx.app.inject({
        method: 'POST',
        url: '/login',
        payload: { user: 'admin', password: 'wrong-but-long-enough' },
      });
      const entries = ctx.storage.getAuditLog({ limit: 10 });
      const failure = entries.find(e => e.action === 'auth_failure');
      expect(failure).toBeDefined();
      expect(failure!.consumer).toBe('ui:admin');
      expect(failure!.success).toBe(0);
    });

    it('rejects /api without a session', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/session' });
      expect(res.statusCode).toBe(401);
    });

    it('accepts /api with a valid session', async () => {
      const token = await login(ctx.app);
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/session',
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toBe('admin');
    });

    it('rejects a forged session cookie', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/session',
        headers: { cookie: `${SESSION_COOKIE}=not-a-real-token` },
      });
      expect(res.statusCode).toBe(401);
    });

    it('logout invalidates the session', async () => {
      const token = await login(ctx.app);
      const out = await ctx.app.inject({
        method: 'POST',
        url: '/logout',
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      });
      expect(out.statusCode).toBe(200);

      const after = await ctx.app.inject({
        method: 'GET',
        url: '/api/session',
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      });
      expect(after.statusCode).toBe(401);
    });
  });

  describe('CSRF origin checks', () => {
    beforeEach(async () => {
      ctx = await createUiTestApp();
    });

    it('rejects a cross-origin mutating request', async () => {
      const token = await login(ctx.app);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/secrets',
        headers: {
          cookie: `${SESSION_COOKIE}=${token}`,
          origin: 'https://evil.example',
          host: 'localhost:8405',
        },
        payload: { name: 'EVIL', value: 'x'.repeat(20), consumers: [], tags: [] },
      });
      expect(res.statusCode).toBe(403);
      expect(ctx.storage.getSecret('EVIL')).toBeUndefined();
    });

    it('allows a same-origin mutating request', async () => {
      const token = await login(ctx.app);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/secrets',
        headers: {
          cookie: `${SESSION_COOKIE}=${token}`,
          origin: 'http://localhost:8405',
          host: 'localhost:8405',
        },
        payload: { name: 'GOOD_ONE', value: 'x'.repeat(20), consumers: [], tags: [] },
      });
      expect(res.statusCode).toBe(201);
    });

    it('allows a mutating request with no Origin header', async () => {
      // Non-browser clients (curl, tests) send no Origin. SameSite=Strict is
      // what stops the browser case, so absence is not itself suspicious.
      const token = await login(ctx.app);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/secrets',
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
        payload: { name: 'NO_ORIGIN', value: 'x'.repeat(20), consumers: [], tags: [] },
      });
      expect(res.statusCode).toBe(201);
    });

    it('rejects percent-encoded and otherwise mangled paths to the API', async () => {
      // Regression: the gate used to test `request.url.startsWith('/api/')`.
      // `request.url` is the RAW url while Fastify's router matches the DECODED
      // path, so `GET /%61pi/secrets` reached the handler with the gate skipped
      // and returned every secret's metadata unauthenticated.
      const variants = [
        '/api/secrets',
        '/%61pi/secrets',
        '/%61%70i/secrets',
        '/api/%73ecrets',
        '//api/secrets',
        '/API/secrets',
        '/api/secrets?tag=x',
        '/api/consumers',
        '/%61pi/consumers',
        '/api/session',
        '/%61pi/session',
      ];

      const reached: string[] = [];
      for (const url of variants) {
        const res = await ctx.app.inject({ method: 'GET', url });
        // 401 gated, 404 no such route. Anything else means a handler ran.
        if (![401, 404].includes(res.statusCode)) {
          reached.push(`${url} -> ${res.statusCode} ${res.body.slice(0, 60)}`);
        }
      }
      expect(reached).toEqual([]);
    });

    it('does not apply the origin check to reads', async () => {
      const token = await login(ctx.app);
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/session',
        headers: {
          cookie: `${SESSION_COOKIE}=${token}`,
          origin: 'https://evil.example',
          host: 'localhost:8405',
        },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('secure cookie flag', () => {
    it('omits Secure on a plain-HTTP listener', async () => {
      ctx = await createUiTestApp({ secure: false });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/login',
        payload: { user: 'admin', password: PASSWORD },
      });
      const raw = String(res.headers['set-cookie']);
      expect(raw).not.toContain('Secure');
    });

    it('sets Secure on an HTTPS listener', async () => {
      ctx = await createUiTestApp({ secure: true });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/login',
        payload: { user: 'admin', password: PASSWORD },
      });
      const raw = String(res.headers['set-cookie']);
      expect(raw).toContain('Secure');
    });
  });
});
