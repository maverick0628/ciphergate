import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestEnv } from './helpers.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { AuditLogger } from '../src/core/audit.js';

let storage: SqliteStorage;
let env: ReturnType<typeof createTestEnv>;

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

beforeEach(() => { env = createTestEnv(); storage = new SqliteStorage(env.dbPath); });
afterEach(() => { storage.close(); env.cleanup(); });

/** Parse the form body of a captured Pushover fetch call into a plain object. */
function formFields(call: unknown[]): Record<string, string> {
  const init = call[1] as { body: URLSearchParams | string };
  const params = init.body instanceof URLSearchParams ? init.body : new URLSearchParams(init.body);
  return Object.fromEntries(params.entries());
}

describe('AuditLogger', () => {
  it('logs an audit entry to storage', () => {
    const audit = new AuditLogger(storage, { enabled: false, appToken: '', userKey: '' });
    audit.log({ consumer: 'n8n', action: 'read', secret_name: 'KEY', success: 1, ip_address: '127.0.0.1', details: null });
    const logs = storage.getAuditLog({ limit: 10 });
    expect(logs).toHaveLength(1);
    expect(logs[0].consumer).toBe('n8n');
  });

  it('masks secret values in details field', () => {
    const audit = new AuditLogger(storage, { enabled: false, appToken: '', userKey: '' });
    audit.log({ consumer: 'n8n', action: 'read', secret_name: 'KEY', success: 0, ip_address: null,
      details: 'Failed to decrypt sk-proj-abc123def456ghi789' });
    const logs = storage.getAuditLog({ limit: 10 });
    expect(logs[0].details).not.toContain('abc123def456ghi789');
  });

  it('still logs to storage even when push is enabled', () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
    const audit = new AuditLogger(storage, { enabled: true, appToken: 'apptok', userKey: 'usrkey' });
    audit.log({ consumer: 'n8n', action: 'delete', secret_name: 'KEY', success: 1, ip_address: null, details: null });
    const logs = storage.getAuditLog({ limit: 10 });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('delete');
    vi.unstubAllGlobals();
  });

  it('sends a Pushover push for auth_failure', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
    const audit = new AuditLogger(storage, { enabled: true, appToken: 'apptok', userKey: 'usrkey' });
    audit.log({ consumer: 'unknown', action: 'auth_failure', secret_name: null, success: 0, ip_address: '10.0.0.5', details: 'Invalid API key' });
    // Push is fire-and-forget, give it a tick
    await new Promise(r => setTimeout(r, 50));
    expect(mockFetch).toHaveBeenCalledWith(
      PUSHOVER_URL,
      expect.objectContaining({ method: 'POST' }),
    );
    const fields = formFields(mockFetch.mock.calls[0]);
    expect(fields.token).toBe('apptok');
    expect(fields.user).toBe('usrkey');
    expect(fields.title).toContain('Auth failure');
    expect(fields.message).toContain('unknown');
    vi.unstubAllGlobals();
  });

  it('sends Pushover for delete with high priority (1)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
    const audit = new AuditLogger(storage, { enabled: true, appToken: 'apptok', userKey: 'usrkey' });
    audit.log({ consumer: 'admin', action: 'delete', secret_name: 'OLD_KEY', success: 1, ip_address: null, details: null });
    await new Promise(r => setTimeout(r, 50));
    const fields = formFields(mockFetch.mock.calls[0]);
    expect(fields.priority).toBe('1');
    vi.unstubAllGlobals();
  });

  it('sends Pushover for auth_failure with high priority (1)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
    const audit = new AuditLogger(storage, { enabled: true, appToken: 'apptok', userKey: 'usrkey' });
    audit.log({ consumer: 'unknown', action: 'auth_failure', secret_name: null, success: 0, ip_address: '10.0.0.5', details: null });
    await new Promise(r => setTimeout(r, 50));
    const fields = formFields(mockFetch.mock.calls[0]);
    expect(fields.priority).toBe('1');
    vi.unstubAllGlobals();
  });

  it('sends normal events with priority 0', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
    // update is a 'default' severity event; minSeverity default lets it through
    const audit = new AuditLogger(storage, { enabled: true, appToken: 'apptok', userKey: 'usrkey' });
    audit.log({ consumer: 'admin', action: 'update', secret_name: 'KEY', success: 1, ip_address: null, details: null });
    await new Promise(r => setTimeout(r, 50));
    const fields = formFields(mockFetch.mock.calls[0]);
    expect(fields.priority).toBe('0');
    vi.unstubAllGlobals();
  });

  it('skips push when disabled', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const audit = new AuditLogger(storage, { enabled: false, appToken: '', userKey: '' });
    audit.log({ consumer: 'n8n', action: 'read', secret_name: 'KEY', success: 1, ip_address: null, details: null });
    await new Promise(r => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('skips push when credentials are missing even if enabled', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const audit = new AuditLogger(storage, { enabled: true, appToken: '', userKey: '' });
    audit.log({ consumer: 'admin', action: 'delete', secret_name: 'KEY', success: 1, ip_address: null, details: null });
    await new Promise(r => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('respects the rate limit', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
    const audit = new AuditLogger(storage, {
      enabled: true, appToken: 'apptok', userKey: 'usrkey',
      rateLimitMax: 2, rateLimitWindowSec: 60,
    });
    for (let i = 0; i < 5; i++) {
      audit.log({ consumer: 'admin', action: 'delete', secret_name: `KEY${i}`, success: 1, ip_address: null, details: null });
    }
    await new Promise(r => setTimeout(r, 50));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // all five still hit the audit table
    expect(storage.getAuditLog({ limit: 10 })).toHaveLength(5);
    vi.unstubAllGlobals();
  });
});
