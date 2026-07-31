import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv } from './helpers.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import {
  setUiPassword,
  verifyUiPassword,
  isUiConfigured,
  MIN_PASSWORD_LENGTH,
} from '../src/ui/credentials.js';

const GOOD = 'correct-horse-battery-staple';

describe('UI credentials', () => {
  let env: ReturnType<typeof createTestEnv>;
  let storage: SqliteStorage;

  beforeEach(() => {
    env = createTestEnv();
    storage = new SqliteStorage(env.dbPath);
  });

  afterEach(() => {
    storage.close();
    env.cleanup();
  });

  it('reports unconfigured before any password is set', () => {
    expect(isUiConfigured(storage)).toBe(false);
  });

  it('reports configured once a password is set', async () => {
    await setUiPassword(storage, 'admin', GOOD);
    expect(isUiConfigured(storage)).toBe(true);
  });

  it('verifies the correct password', async () => {
    await setUiPassword(storage, 'admin', GOOD);
    expect(await verifyUiPassword(storage, 'admin', GOOD)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    await setUiPassword(storage, 'admin', GOOD);
    expect(await verifyUiPassword(storage, 'admin', 'wrong-horse-battery-staple')).toBe(false);
  });

  it('rejects an unknown user without throwing', async () => {
    await setUiPassword(storage, 'admin', GOOD);
    await expect(verifyUiPassword(storage, 'nobody', GOOD)).resolves.toBe(false);
  });

  it('rejects a password shorter than the minimum', async () => {
    await expect(setUiPassword(storage, 'admin', 'a'.repeat(MIN_PASSWORD_LENGTH - 1)))
      .rejects.toThrow(/at least/i);
  });

  it('accepts a password exactly at the minimum', async () => {
    await setUiPassword(storage, 'admin', 'a'.repeat(MIN_PASSWORD_LENGTH));
    expect(await verifyUiPassword(storage, 'admin', 'a'.repeat(MIN_PASSWORD_LENGTH))).toBe(true);
  });

  it('never stores the password in the clear', async () => {
    await setUiPassword(storage, 'admin', GOOD);
    const row = storage.getUiCredential('admin');
    expect(row).toBeDefined();
    expect(row!.password_hash).not.toContain(GOOD);
    expect(row!.password_hash.startsWith('$argon2')).toBe(true);
  });

  it('re-setting overwrites rather than duplicating', async () => {
    await setUiPassword(storage, 'admin', GOOD);
    await setUiPassword(storage, 'admin', 'a-completely-different-password');
    expect(storage.countUiCredentials()).toBe(1);
    expect(await verifyUiPassword(storage, 'admin', GOOD)).toBe(false);
    expect(await verifyUiPassword(storage, 'admin', 'a-completely-different-password')).toBe(true);
  });

  it('salts each hash, so the same password stores differently', async () => {
    await setUiPassword(storage, 'admin', GOOD);
    const first = storage.getUiCredential('admin')!.password_hash;
    await setUiPassword(storage, 'admin', GOOD);
    const second = storage.getUiCredential('admin')!.password_hash;
    expect(first).not.toBe(second);
  });
});
