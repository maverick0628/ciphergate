import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv } from './helpers.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { AuthManager } from '../src/core/auth.js';

let storage: SqliteStorage;
let auth: AuthManager;
let env: ReturnType<typeof createTestEnv>;

beforeEach(() => {
  env = createTestEnv();
  storage = new SqliteStorage(env.dbPath);
  auth = new AuthManager(storage);
});

afterEach(() => { storage.close(); env.cleanup(); });

describe('AuthManager', () => {
  it('generates and validates an API key', () => {
    const { apiKey } = auth.createConsumer('test', 'reader');
    const result = auth.authenticate(apiKey);
    expect(result.consumer).toBeDefined();
    expect(result.consumer!.name).toBe('test');
    expect(result.reason).toBeUndefined();
  });

  it('rejects invalid key with reason', () => {
    const result = auth.authenticate('bogus-key');
    expect(result.consumer).toBeNull();
    expect(result.reason).toBe('invalid');
  });

  it('rejects revoked consumer with reason', () => {
    const { apiKey } = auth.createConsumer('test', 'reader');
    storage.revokeConsumer('test');
    const result = auth.authenticate(apiKey);
    expect(result.consumer).toBeNull();
    expect(result.reason).toBe('revoked');
  });

  it('rejects expired consumer with reason and expiry time', () => {
    const { apiKey } = auth.createConsumer('test', 'reader', undefined, '2020-01-01T00:00:00Z');
    const result = auth.authenticate(apiKey);
    expect(result.consumer).toBeNull();
    expect(result.reason).toBe('expired');
    expect(result.expiresAt).toBe('2020-01-01T00:00:00Z');
  });

  it('checks consumer authorization for a secret', () => {
    expect(auth.isAuthorized('n8n', ['n8n', 'claude-code'])).toBe(true);
    expect(auth.isAuthorized('docker', ['n8n', 'claude-code'])).toBe(false);
  });

  it('admin role has full access', () => {
    const { apiKey } = auth.createConsumer('admin', 'admin');
    const result = auth.authenticate(apiKey);
    expect(result.consumer!.role).toBe('admin');
  });

  it('admin bypasses consumer scoping for reads', () => {
    expect(auth.isAuthorized('admin-user', ['n8n'], 'admin')).toBe(true);
    expect(auth.isAuthorized('docker-five', ['n8n'], 'reader')).toBe(false);
  });

  it('rotates consumer key', () => {
    const { apiKey: oldKey } = auth.createConsumer('test', 'reader');
    const { apiKey: newKey } = auth.rotateKey('test');
    expect(auth.authenticate(oldKey).consumer).toBeNull();
    expect(auth.authenticate(newKey).consumer).toBeDefined();
  });
});
