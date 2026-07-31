import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createTestEnv } from './helpers.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { SecretCache } from '../src/core/cache.js';
import { AuditLogger } from '../src/core/audit.js';
import { SecretsService } from '../src/core/secrets-service.js';
import { deriveKey } from '../src/storage/crypto.js';
import type { SecretResponse, SecretMetadata, BatchResponse, RotationReportEntry } from '../src/types.js';

let env: ReturnType<typeof createTestEnv>;
let storage: SqliteStorage;
let service: SecretsService;
let cache: SecretCache;

beforeEach(async () => {
  env = createTestEnv();
  storage = new SqliteStorage(env.dbPath);
  const salt = randomBytes(16);
  storage.setSalt(salt);
  const keyContent = readFileSync(env.keyfilePath);
  const key = await deriveKey(keyContent, salt);
  cache = new SecretCache(300);
  const audit = new AuditLogger(storage, { enabled: false, url: '', topic: '' });
  service = new SecretsService(storage, key, cache, audit);

  // Create some consumers
  storage.createConsumer('admin-bot', 'hash-admin', 'admin');
  storage.createConsumer('n8n', 'hash-n8n', 'reader');
  storage.createConsumer('homer', 'hash-homer', 'reader');

  // Create a secret accessible to n8n
  service.createSecret(
    { name: 'OPENAI_KEY', value: 'sk-proj-abc123def456ghi789jkl', description: 'OpenAI API key', consumers: ['n8n'], tags: ['ai', 'prod'], rotation_days: 90 },
    'admin-bot',
    '127.0.0.1',
  );

  // Create a secret NOT accessible to n8n (only homer)
  service.createSecret(
    { name: 'STRIPE_SECRET', value: 'sk-stripe-xyz987uvw654', description: 'Stripe key', consumers: ['homer'], tags: ['billing'], rotation_days: 30 },
    'admin-bot',
    '127.0.0.1',
  );
});

afterEach(() => {
  storage.close();
  env.cleanup();
});

describe('getSecret', () => {
  it('decrypts and returns with masked value; updates last_accessed; uses cache on second call', () => {
    const result = service.getSecret('OPENAI_KEY', 'n8n', 'reader', '127.0.0.1') as SecretResponse;
    expect(result.name).toBe('OPENAI_KEY');
    expect(result.value).toBe('sk-proj-abc123def456ghi789jkl');
    expect(result.masked).toBe('sk-p...89jkl'.slice(0, 4) + '...' + 'sk-proj-abc123def456ghi789jkl'.slice(-4));
    expect(result.version).toBe(1);

    // last_accessed should be set now
    const stored = storage.getSecret('OPENAI_KEY')!;
    expect(stored.last_accessed).not.toBeNull();

    // Second call should hit cache — invalidate storage entry to prove it
    // (Cache stores the value; a direct storage read should still work,
    //  but we verify the same result comes back quickly)
    const result2 = service.getSecret('OPENAI_KEY', 'n8n', 'reader', '127.0.0.1') as SecretResponse;
    expect(result2.value).toBe(result.value);
    const stats = cache.stats();
    expect(stats.hits).toBeGreaterThan(0);
  });

  it('rejects unauthorized consumer with 403', () => {
    const result = service.getSecret('STRIPE_SECRET', 'n8n', 'reader', '127.0.0.1') as { error: string; status: number; message: string };
    expect(result.error).toBe('access_denied');
    expect(result.status).toBe(403);
  });

  it('returns 404 for nonexistent secret', () => {
    const result = service.getSecret('NONEXISTENT', 'n8n', 'reader', '127.0.0.1') as { error: string; status: number; message: string };
    expect(result.error).toBe('not_found');
    expect(result.status).toBe(404);
  });

  it('admin can read any secret regardless of consumers list', () => {
    const result = service.getSecret('STRIPE_SECRET', 'admin-bot', 'admin', '127.0.0.1') as SecretResponse;
    expect(result.name).toBe('STRIPE_SECRET');
    expect(result.value).toBe('sk-stripe-xyz987uvw654');
  });
});

describe('listSecrets', () => {
  it('returns metadata only (no values), scoped to consumer', () => {
    const list = service.listSecrets('n8n') as SecretMetadata[];
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('OPENAI_KEY');
    expect((list[0] as any).value).toBeUndefined();
    expect(list[0].rotation_status).toBeDefined();
    expect(['ok', 'due_soon', 'overdue']).toContain(list[0].rotation_status);
  });

  it('includes consumers so remote list rendering can read them', () => {
    const list = service.listSecrets('n8n') as SecretMetadata[];
    expect(list[0].consumers).toEqual(['n8n']);
  });

  it('admin role sees all secrets regardless of consumer assignment', () => {
    const list = service.listSecrets('admin-bot', undefined, 'admin') as SecretMetadata[];
    expect(list.map(s => s.name).sort()).toEqual(['OPENAI_KEY', 'STRIPE_SECRET']);
  });

  it('admin role still honors the tag filter', () => {
    const list = service.listSecrets('admin-bot', 'billing', 'admin') as SecretMetadata[];
    expect(list.map(s => s.name)).toEqual(['STRIPE_SECRET']);
  });

  it('filters by tag', () => {
    const list = service.listSecrets('n8n', 'billing') as SecretMetadata[];
    expect(list).toHaveLength(0);

    const list2 = service.listSecrets('n8n', 'ai') as SecretMetadata[];
    expect(list2).toHaveLength(1);
  });
});

describe('createSecret', () => {
  it('encrypts value, stores, and returns metadata', () => {
    const result = service.createSecret(
      { name: 'GITHUB_TOKEN', value: 'ghp_abc123def456ghi789', description: 'GitHub PAT', consumers: ['n8n'], tags: ['vcs'], rotation_days: 180 },
      'admin-bot',
      '127.0.0.1',
    );
    expect(result.name).toBe('GITHUB_TOKEN');
    expect(result.version).toBe(1);
    expect(result.created_at).toBeDefined();

    // Stored value should be encrypted (not plaintext)
    const raw = storage.getSecret('GITHUB_TOKEN')!;
    expect(raw.value_enc).toBeInstanceOf(Buffer);
    expect(raw.value_enc.toString()).not.toContain('ghp_abc123def456ghi789');
  });
});

describe('updateSecret', () => {
  it('increments version when value changes, invalidates cache', () => {
    // Populate cache first
    service.getSecret('OPENAI_KEY', 'n8n', 'reader', '127.0.0.1');
    expect(cache.get('OPENAI_KEY')).toBeDefined();

    const result = service.updateSecret(
      'OPENAI_KEY',
      { value: 'sk-proj-newvalue12345678901' },
      'admin-bot',
      '127.0.0.1',
    );
    expect(result.version).toBe(2);
    // Cache should be invalidated
    expect(cache.get('OPENAI_KEY')).toBeUndefined();

    // New value should decrypt correctly
    const fetched = service.getSecret('OPENAI_KEY', 'n8n', 'reader', '127.0.0.1') as SecretResponse;
    expect(fetched.value).toBe('sk-proj-newvalue12345678901');
  });

  it('updates consumers without incrementing version', () => {
    const result = service.updateSecret(
      'OPENAI_KEY',
      { consumers: ['n8n', 'homer'] },
      'admin-bot',
      '127.0.0.1',
    );
    // Version stays the same (metadata-only update)
    expect(result.version).toBe(1);

    const stored = storage.getSecret('OPENAI_KEY')!;
    expect(stored.consumers).toContain('homer');
  });
});

describe('deleteSecret', () => {
  it('removes secret and invalidates cache', () => {
    // Populate cache
    service.getSecret('OPENAI_KEY', 'n8n', 'reader', '127.0.0.1');
    expect(cache.get('OPENAI_KEY')).toBeDefined();

    service.deleteSecret('OPENAI_KEY', 'admin-bot', '127.0.0.1');

    expect(storage.getSecret('OPENAI_KEY')).toBeUndefined();
    expect(cache.get('OPENAI_KEY')).toBeUndefined();
  });
});

describe('batchGet', () => {
  it('returns secrets + missing + denied, each secret has rotation_status', () => {
    const result = service.batchGet(
      ['OPENAI_KEY', 'STRIPE_SECRET', 'NONEXISTENT'],
      'n8n',
      'reader',
      '127.0.0.1',
    ) as BatchResponse;

    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0].name).toBe('OPENAI_KEY');
    expect(result.secrets[0].rotation_status).toBeDefined();

    expect(result.denied).toContain('STRIPE_SECRET');
    expect(result.missing).toContain('NONEXISTENT');
  });
});

describe('getEnv', () => {
  it('returns dotenv-formatted string for accessible secrets', () => {
    const result = service.getEnv('n8n', 'reader', {});
    expect(result).toContain('OPENAI_KEY=sk-proj-abc123def456ghi789jkl');
    expect(result).not.toContain('STRIPE_SECRET');
  });

  it('filters by tag', () => {
    const result = service.getEnv('n8n', 'reader', { tag: 'ai' });
    expect(result).toContain('OPENAI_KEY=');

    const result2 = service.getEnv('n8n', 'reader', { tag: 'billing' });
    expect(result2.trim()).toBe('');
  });

  it('filters by names', () => {
    // Add another secret for n8n
    service.createSecret(
      { name: 'ANOTHER_KEY', value: 'val-another-key-12345', description: '', consumers: ['n8n'], tags: [], rotation_days: undefined },
      'admin-bot',
      '127.0.0.1',
    );
    const result = service.getEnv('n8n', 'reader', { names: ['OPENAI_KEY'] });
    expect(result).toContain('OPENAI_KEY=');
    expect(result).not.toContain('ANOTHER_KEY');
  });
});

describe('rotationReport', () => {
  it('computes age_days and categorizes ok/due_soon/overdue', () => {
    // Add a secret without rotation_days (should be excluded)
    service.createSecret(
      { name: 'NO_ROTATION', value: 'val-no-rotation-12345', description: '', consumers: ['n8n'], tags: [] },
      'admin-bot',
      '127.0.0.1',
    );

    const report = service.rotationReport();
    // All entries should have rotation_days set
    for (const entry of [...report.due, ...report.overdue, ...report.ok]) {
      expect(entry.rotation_days).toBeGreaterThan(0);
      expect(entry.age_days).toBeGreaterThanOrEqual(0);
      expect(['ok', 'due_soon', 'overdue']).toContain(entry.status);
    }

    // NO_ROTATION secret should not appear (no rotation_days)
    const allNames = [...report.due, ...report.overdue, ...report.ok].map(e => e.name);
    expect(allNames).not.toContain('NO_ROTATION');

    // OPENAI_KEY and STRIPE_SECRET should appear
    expect(allNames).toContain('OPENAI_KEY');
    expect(allNames).toContain('STRIPE_SECRET');
  });
});

describe('getHistory', () => {
  it('returns version metadata without decrypting values', () => {
    // Create a version in history by updating with a new value
    service.updateSecret('OPENAI_KEY', { value: 'sk-proj-updated12345678' }, 'admin-bot', '127.0.0.1');

    const history = service.getHistory('OPENAI_KEY');
    expect(history.name).toBe('OPENAI_KEY');
    expect(history.current_version).toBe(2);
    expect(history.history).toHaveLength(1);
    expect(history.history[0].version).toBe(1);
    expect(history.history[0].changed_by).toBe('admin-bot');
    expect(history.history[0].changed_at).toBeDefined();
    // Should NOT include value (metadata only)
    expect((history.history[0] as any).value).toBeUndefined();
  });
});

describe('getVersion', () => {
  it('returns specific historical version decrypted with is_current: false', () => {
    const originalValue = 'sk-proj-abc123def456ghi789jkl';
    // Update to push version 1 into history
    service.updateSecret('OPENAI_KEY', { value: 'sk-proj-newvalue12345678901' }, 'admin-bot', '127.0.0.1');

    const result = service.getVersion('OPENAI_KEY', 1, 'admin-bot', 'admin', '127.0.0.1') as SecretResponse;
    expect(result.name).toBe('OPENAI_KEY');
    expect(result.value).toBe(originalValue);
    expect(result.is_current).toBe(false);
    expect(result.version).toBe(1);
  });

  it('returns error when version not found', () => {
    const result = service.getVersion('OPENAI_KEY', 99, 'admin-bot', 'admin', '127.0.0.1') as { error: string; status: number };
    expect(result.error).toBe('not_found');
    expect(result.status).toBe(404);
  });
});

describe('cache invalidation', () => {
  it('cache is invalidated on update', () => {
    service.getSecret('OPENAI_KEY', 'n8n', 'reader', '127.0.0.1');
    expect(cache.get('OPENAI_KEY')).toBeDefined();
    service.updateSecret('OPENAI_KEY', { consumers: ['n8n', 'homer'] }, 'admin-bot', '127.0.0.1');
    expect(cache.get('OPENAI_KEY')).toBeUndefined();
  });

  it('cache is invalidated on delete', () => {
    service.getSecret('OPENAI_KEY', 'n8n', 'reader', '127.0.0.1');
    expect(cache.get('OPENAI_KEY')).toBeDefined();
    service.deleteSecret('OPENAI_KEY', 'admin-bot', '127.0.0.1');
    expect(cache.get('OPENAI_KEY')).toBeUndefined();
  });
});

describe('refreshCache', () => {
  it('clears all cached entries', () => {
    service.getSecret('OPENAI_KEY', 'n8n', 'reader', '127.0.0.1');
    expect(cache.size()).toBeGreaterThan(0);
    service.refreshCache();
    expect(cache.size()).toBe(0);
  });
});

describe('getStatus', () => {
  it('returns gateway status metrics', () => {
    const startTime = Date.now() - 5000;
    const status = service.getStatus(env.dbPath, 300, false, startTime);
    expect(status.uptime_seconds).toBeGreaterThanOrEqual(5);
    expect(status.tls_enabled).toBe(false);
    expect(status.secrets.total).toBeGreaterThanOrEqual(2);
    expect(status.consumers.total).toBeGreaterThanOrEqual(3);
    expect(status.cache.ttl_seconds).toBe(300);
    expect(status.database.path).toBe(env.dbPath);
    expect(status.version).toBeDefined();
  });
});
