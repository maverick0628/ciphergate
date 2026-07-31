import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv } from './helpers.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { encrypt, deriveKey } from '../src/storage/crypto.js';
import { randomBytes } from 'node:crypto';

let storage: SqliteStorage;
let env: ReturnType<typeof createTestEnv>;
let encryptionKey: Buffer;

beforeEach(async () => {
  env = createTestEnv();
  storage = new SqliteStorage(env.dbPath);
  const salt = randomBytes(16);
  storage.setSalt(salt);
  const keyfileContent = Buffer.from('dGVzdGtleWZpbGVjb250ZW50MTIzNDU2Nzg=', 'base64');
  encryptionKey = await deriveKey(keyfileContent, salt);
});

afterEach(() => {
  storage.close();
  env.cleanup();
});

describe('secrets CRUD', () => {
  it('creates and retrieves a secret', () => {
    const { ciphertext, iv, authTag } = encrypt('sk-test-123', encryptionKey);
    storage.createSecret({
      name: 'OPENAI_API_KEY',
      value_enc: ciphertext, iv, auth_tag: authTag,
      consumers: ['n8n', 'claude-code'],
      tags: ['ai'],
      description: 'Test key',
    });
    const secret = storage.getSecret('OPENAI_API_KEY');
    expect(secret).toBeDefined();
    expect(secret!.name).toBe('OPENAI_API_KEY');
    expect(secret!.version).toBe(1);
    expect(secret!.consumers).toEqual(['n8n', 'claude-code']);
  });

  it('lists secrets scoped to a consumer', () => {
    const e1 = encrypt('val1', encryptionKey);
    const e2 = encrypt('val2', encryptionKey);
    storage.createSecret({ name: 'KEY_A', value_enc: e1.ciphertext, iv: e1.iv, auth_tag: e1.authTag, consumers: ['n8n'], tags: [] });
    storage.createSecret({ name: 'KEY_B', value_enc: e2.ciphertext, iv: e2.iv, auth_tag: e2.authTag, consumers: ['claude-code'], tags: [] });
    const n8nSecrets = storage.listSecrets('n8n');
    expect(n8nSecrets).toHaveLength(1);
    expect(n8nSecrets[0].name).toBe('KEY_A');
  });

  it('filters by tag', () => {
    const e1 = encrypt('v1', encryptionKey);
    const e2 = encrypt('v2', encryptionKey);
    storage.createSecret({ name: 'A', value_enc: e1.ciphertext, iv: e1.iv, auth_tag: e1.authTag, consumers: ['n8n'], tags: ['ai'] });
    storage.createSecret({ name: 'B', value_enc: e2.ciphertext, iv: e2.iv, auth_tag: e2.authTag, consumers: ['n8n'], tags: ['docker'] });
    const aiSecrets = storage.listSecrets('n8n', 'ai');
    expect(aiSecrets).toHaveLength(1);
    expect(aiSecrets[0].name).toBe('A');
  });

  it('updates a secret and increments version', () => {
    const e1 = encrypt('old', encryptionKey);
    storage.createSecret({ name: 'KEY', value_enc: e1.ciphertext, iv: e1.iv, auth_tag: e1.authTag, consumers: ['n8n'], tags: [] });
    const e2 = encrypt('new', encryptionKey);
    const updated = storage.updateSecret('KEY', { value_enc: e2.ciphertext, iv: e2.iv, auth_tag: e2.authTag }, 'admin');
    expect(updated.version).toBe(2);
  });

  it('archives history on update', () => {
    const e1 = encrypt('v1', encryptionKey);
    storage.createSecret({ name: 'KEY', value_enc: e1.ciphertext, iv: e1.iv, auth_tag: e1.authTag, consumers: ['n8n'], tags: [] });
    const e2 = encrypt('v2', encryptionKey);
    storage.updateSecret('KEY', { value_enc: e2.ciphertext, iv: e2.iv, auth_tag: e2.authTag }, 'admin');
    const history = storage.getSecretHistory('KEY');
    expect(history).toHaveLength(1);
    expect(history[0].version).toBe(1);
  });

  it('deletes a secret', () => {
    const e1 = encrypt('v1', encryptionKey);
    storage.createSecret({ name: 'KEY', value_enc: e1.ciphertext, iv: e1.iv, auth_tag: e1.authTag, consumers: ['n8n'], tags: [] });
    storage.deleteSecret('KEY');
    expect(storage.getSecret('KEY')).toBeUndefined();
  });

  it('caps history at configured max (10)', () => {
    const e = encrypt('v0', encryptionKey);
    storage.createSecret({ name: 'KEY', value_enc: e.ciphertext, iv: e.iv, auth_tag: e.authTag, consumers: ['n8n'], tags: [] });
    for (let i = 1; i <= 12; i++) {
      const enc = encrypt(`v${i}`, encryptionKey);
      storage.updateSecret('KEY', { value_enc: enc.ciphertext, iv: enc.iv, auth_tag: enc.authTag }, 'admin');
    }
    const history = storage.getSecretHistory('KEY');
    expect(history.length).toBeLessThanOrEqual(10);
  });
});

describe('consumers', () => {
  it('creates and finds consumer by key hash', () => {
    storage.createConsumer('n8n', 'hash123', 'reader', 'n8n automation');
    const found = storage.getConsumerByKeyHash('hash123');
    expect(found).toBeDefined();
    expect(found!.name).toBe('n8n');
    expect(found!.role).toBe('reader');
  });

  it('revokes a consumer', () => {
    storage.createConsumer('test', 'hash', 'reader');
    storage.revokeConsumer('test');
    const found = storage.getConsumerByName('test');
    expect(found!.is_active).toBe(0);
  });

  it('rotates consumer key', () => {
    storage.createConsumer('test', 'old_hash', 'reader');
    storage.rotateConsumerKey('test', 'new_hash');
    expect(storage.getConsumerByKeyHash('old_hash')).toBeUndefined();
    expect(storage.getConsumerByKeyHash('new_hash')).toBeDefined();
  });
});

describe('audit', () => {
  it('logs and retrieves audit entries', () => {
    storage.logAudit({ consumer: 'n8n', action: 'read', secret_name: 'KEY', success: 1, ip_address: '127.0.0.1', details: null });
    const logs = storage.getAuditLog({ limit: 10 });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('read');
  });

  it('filters audit by consumer', () => {
    storage.logAudit({ consumer: 'n8n', action: 'read', secret_name: 'KEY', success: 1, ip_address: null, details: null });
    storage.logAudit({ consumer: 'claude', action: 'read', secret_name: 'KEY2', success: 1, ip_address: null, details: null });
    const logs = storage.getAuditLog({ consumer: 'n8n' });
    expect(logs).toHaveLength(1);
  });
});

describe('metadata', () => {
  it('stores and retrieves salt', () => {
    const salt = randomBytes(16);
    storage.setSalt(salt);
    const retrieved = storage.getSalt();
    expect(retrieved.equals(salt)).toBe(true);
  });
});
