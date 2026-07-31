import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestEnv } from './helpers.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import {
  createSession,
  verifySession,
  destroySession,
  buildCookie,
  clearCookie,
  parseCookie,
  SESSION_COOKIE,
  ABSOLUTE_TTL_MS,
  IDLE_TTL_MS,
} from '../src/ui/session.js';

describe('UI sessions', () => {
  let env: ReturnType<typeof createTestEnv>;
  let storage: SqliteStorage;

  beforeEach(() => {
    env = createTestEnv();
    storage = new SqliteStorage(env.dbPath);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    storage.close();
    env.cleanup();
  });

  it('round-trips a freshly created session', () => {
    const token = createSession(storage, 'admin');
    expect(verifySession(storage, token)).toEqual({ uiUser: 'admin' });
  });

  it('returns null for an unknown token', () => {
    createSession(storage, 'admin');
    expect(verifySession(storage, 'not-a-real-token')).toBeNull();
  });

  it('stores only the hash, never the raw token', () => {
    const token = createSession(storage, 'admin');
    const expectedHash = createHash('sha256').update(token).digest('hex');
    const row = storage.getUiSession(expectedHash);
    expect(row).toBeDefined();
    expect(row!.token_hash).toBe(expectedHash);
    expect(row!.token_hash).not.toBe(token);
  });

  it('issues a different token each time', () => {
    expect(createSession(storage, 'admin')).not.toBe(createSession(storage, 'admin'));
  });

  it('expires at the absolute TTL even with continuous activity', () => {
    const token = createSession(storage, 'admin');
    // Stay active well inside the idle window the whole way there.
    for (let elapsed = 0; elapsed < ABSOLUTE_TTL_MS; elapsed += IDLE_TTL_MS / 2) {
      vi.advanceTimersByTime(IDLE_TTL_MS / 2);
      verifySession(storage, token);
    }
    vi.advanceTimersByTime(IDLE_TTL_MS);
    expect(verifySession(storage, token)).toBeNull();
  });

  it('expires after the idle timeout', () => {
    const token = createSession(storage, 'admin');
    vi.advanceTimersByTime(IDLE_TTL_MS + 1000);
    expect(verifySession(storage, token)).toBeNull();
  });

  it('activity inside the idle window keeps the session alive', () => {
    const token = createSession(storage, 'admin');
    vi.advanceTimersByTime(IDLE_TTL_MS - 60_000);
    expect(verifySession(storage, token)).toEqual({ uiUser: 'admin' });
    vi.advanceTimersByTime(IDLE_TTL_MS - 60_000);
    expect(verifySession(storage, token)).toEqual({ uiUser: 'admin' });
  });

  it('destroy invalidates immediately', () => {
    const token = createSession(storage, 'admin');
    destroySession(storage, token);
    expect(verifySession(storage, token)).toBeNull();
  });

  it('sweeps rows that expired without ever being revisited', () => {
    // verifySession only deletes what it encounters. A session abandoned after
    // login would otherwise persist forever and grow the table without bound.
    const abandoned = createSession(storage, 'admin');
    const abandonedHash = createHash('sha256').update(abandoned).digest('hex');
    expect(storage.getUiSession(abandonedHash)).toBeDefined();

    vi.advanceTimersByTime(ABSOLUTE_TTL_MS + 1000);

    // A later login is what triggers the sweep.
    createSession(storage, 'admin');
    expect(storage.getUiSession(abandonedHash)).toBeUndefined();
  });

  it('sweeps expired rows rather than leaving them', () => {
    const token = createSession(storage, 'admin');
    const hash = createHash('sha256').update(token).digest('hex');
    vi.advanceTimersByTime(ABSOLUTE_TTL_MS + 1000);
    expect(verifySession(storage, token)).toBeNull();
    expect(storage.getUiSession(hash)).toBeUndefined();
  });
});

describe('UI session cookies', () => {
  it('marks the cookie HttpOnly, SameSite=Strict and Path=/', () => {
    const cookie = buildCookie('tok', false);
    expect(cookie).toContain(`${SESSION_COOKIE}=tok`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
  });

  it('omits Secure when the listener is plain HTTP', () => {
    // Setting Secure over HTTP means the browser never sends the cookie back,
    // which would break login in the TLS fallback path.
    expect(buildCookie('tok', false)).not.toContain('Secure');
  });

  it('sets Secure when the listener is HTTPS', () => {
    expect(buildCookie('tok', true)).toContain('Secure');
  });

  it('clearCookie expires the cookie', () => {
    const cookie = clearCookie(false);
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('Max-Age=0');
  });

  it('parses the session cookie out of a multi-cookie header', () => {
    const header = `other=1; ${SESSION_COOKIE}=abc123; another=2`;
    expect(parseCookie(header)).toBe('abc123');
  });

  it('returns undefined when the header is absent or lacks the cookie', () => {
    expect(parseCookie(undefined)).toBeUndefined();
    expect(parseCookie('other=1; another=2')).toBeUndefined();
  });
});
