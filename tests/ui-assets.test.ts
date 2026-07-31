import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createTestEnv } from './helpers.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { SecretCache } from '../src/core/cache.js';
import { AuditLogger } from '../src/core/audit.js';
import { SecretsService } from '../src/core/secrets-service.js';
import { deriveKey } from '../src/storage/crypto.js';
import { buildUiApp } from '../src/ui/server.js';
import { setUiPassword } from '../src/ui/credentials.js';
import { getAsset } from '../src/ui/assets.js';

const PASSWORD = 'a-sufficiently-long-password';
const PUBLIC_DIR = join(process.cwd(), 'src', 'ui', 'public');

async function createCtx(configured = true) {
  const env = createTestEnv();
  const storage = new SqliteStorage(env.dbPath);
  const salt = randomBytes(16);
  storage.setSalt(salt);
  const key = await deriveKey(readFileSync(env.keyfilePath), salt);
  const service = new SecretsService(
    storage,
    key,
    new SecretCache(300),
    new AuditLogger(storage, { enabled: false, appToken: '', userKey: '' }),
  );
  if (configured) await setUiPassword(storage, 'admin', PASSWORD);
  return { app: buildUiApp({ storage, service, secure: false }), storage, env };
}

describe('UI assets', () => {
  let ctx: Awaited<ReturnType<typeof createCtx>>;

  afterEach(async () => {
    await ctx.app.close();
    ctx.env.cleanup();
  });

  it('serves the three allowlisted assets with correct content types', async () => {
    ctx = await createCtx();
    const expected: Array<[string, string]> = [
      ['app.css', 'text/css'],
      ['app.js', 'text/javascript'],
    ];
    for (const [name, type] of expected) {
      const res = await ctx.app.inject({ method: 'GET', url: `/assets/${name}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain(type);
      expect(res.body.length).toBeGreaterThan(0);
    }
  });

  it('serves the brand artwork as intact PNG bytes', async () => {
    ctx = await createCtx();
    for (const name of ['mark.png', 'lockup.png']) {
      const res = await ctx.app.inject({ method: 'GET', url: `/assets/${name}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
      // The PNG signature, to prove the binary survived the read and the send
      // rather than being mangled by a text encoding somewhere.
      expect([...res.rawPayload.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(res.rawPayload.length).toBeGreaterThan(1000);
    }
  });

  it('404s an asset outside the allowlist', async () => {
    ctx = await createCtx();
    const res = await ctx.app.inject({ method: 'GET', url: '/assets/secrets.db' });
    expect(res.statusCode).toBe(404);
  });

  it('404s a traversal attempt rather than reading outside the directory', async () => {
    ctx = await createCtx();
    for (const path of ['/assets/../../package.json', '/assets/..%2f..%2fpackage.json']) {
      const res = await ctx.app.inject({ method: 'GET', url: path });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('better-sqlite3');
    }
  });

  it('serves the app shell once configured', async () => {
    ctx = await createCtx(true);
    const res = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('CipherGate');
    expect(res.body).toContain('/assets/app.js');
  });

  it('serves only the bootstrap page when unconfigured', async () => {
    ctx = await createCtx(false);
    const res = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Setup required');
    expect(res.body).toContain('gateway ui set-password');
    // The real app must not be reachable before a password exists.
    expect(res.body).not.toContain('/assets/app.js');
  });

  it('getAsset rejects anything not in the allowlist', () => {
    expect(getAsset('app.css')).toBeDefined();
    expect(getAsset('../../package.json')).toBeUndefined();
    expect(getAsset('nope.txt')).toBeUndefined();
  });
});

describe('UI front-end source discipline', () => {
  const sources = ['app.js', 'index.html'].map(f => readFileSync(join(PUBLIC_DIR, f), 'utf-8'));

  // These match member access and calls rather than the bare word, so the
  // comments explaining why these APIs are avoided don't trip their own rule.

  it('never touches localStorage or sessionStorage', () => {
    for (const src of sources) {
      expect(src).not.toMatch(/\blocalStorage\s*[.[]/);
      expect(src).not.toMatch(/\bsessionStorage\s*[.[]/);
    }
  });

  it('never assigns innerHTML, so server data cannot become markup', () => {
    for (const src of sources) {
      expect(src).not.toMatch(/\.\s*innerHTML/);
      expect(src).not.toMatch(/\.\s*outerHTML/);
      expect(src).not.toMatch(/insertAdjacentHTML\s*\(/);
    }
  });

  it('loads no external resources', () => {
    for (const src of sources) {
      expect(src).not.toMatch(/https?:\/\//);
    }
  });
});
