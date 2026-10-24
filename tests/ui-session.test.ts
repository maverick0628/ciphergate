import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestEnv } from './helpers.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import {
  createSession,
  verifySession,
  inspectSession,
  destroySession,
  buildCookie,
  clearCookie,
  parseCookie,
  SESSION_COOKIE,
  DEFAULT_ABSOLUTE_TTL_MS,
  DEFAULT_IDLE_TTL_MS,
  type SessionTtls,
} from '../src/ui/session.js';

const ABSOLUTE_TTL_MS = DEFAULT_ABSOLUTE_TTL_MS;
const IDLE_TTL_MS = DEFAULT_IDLE_TTL_MS;

/** The shipped defaults: 12h ceiling, 60m idle. */
const TTLS: SessionTtls = { absoluteTtlMs: ABSOLUTE_TTL_MS, idleTtlMs: IDLE_TTL_MS };

/** Both rules off — what a single-operator deployment runs. */
const NEVER: SessionTtls = { absoluteTtlMs: 0, idleTtlMs: 0 };

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
    const token = createSession(storage, 'admin', TTLS);
    expect(verifySession(storage, token, TTLS)).toEqual({ uiUser: 'admin' });
  });

  it('returns null for an unknown token', () => {
    createSession(storage, 'admin', TTLS);
    expect(verifySession(storage, 'not-a-real-token', TTLS)).toBeNull();
  });

  it('stores only the hash, never the raw token', () => {
    const token = createSession(storage, 'admin', TTLS);
    const expectedHash = createHash('sha256').update(token).digest('hex');
    const row = storage.getUiSession(expectedHash);
    expect(row).toBeDefined();
    expect(row!.token_hash).toBe(expectedHash);
    expect(row!.token_hash).not.toBe(token);
  });

  it('issues a different token each time', () => {
    expect(createSession(storage, 'admin', TTLS)).not.toBe(createSession(storage, 'admin', TTLS));
  });

  it('expires at the absolute TTL even with continuous activity', () => {
    const token = createSession(storage, 'admin', TTLS);
    // Stay active well inside the idle window the whole way there.
    for (let elapsed = 0; elapsed < ABSOLUTE_TTL_MS; elapsed += IDLE_TTL_MS / 2) {
      vi.advanceTimersByTime(IDLE_TTL_MS / 2);
      verifySession(storage, token, TTLS);
    }
    vi.advanceTimersByTime(IDLE_TTL_MS);
    expect(verifySession(storage, token, TTLS)).toBeNull();
  });

  it('expires after the idle timeout', () => {
    const token = createSession(storage, 'admin', TTLS);
    vi.advanceTimersByTime(IDLE_TTL_MS + 1000);
    expect(verifySession(storage, token, TTLS)).toBeNull();
  });

  it('activity inside the idle window keeps the session alive', () => {
    const token = createSession(storage, 'admin', TTLS);
    vi.advanceTimersByTime(IDLE_TTL_MS - 60_000);
    expect(verifySession(storage, token, TTLS)).toEqual({ uiUser: 'admin' });
    vi.advanceTimersByTime(IDLE_TTL_MS - 60_000);
    expect(verifySession(storage, token, TTLS)).toEqual({ uiUser: 'admin' });
  });

  it('destroy invalidates immediately', () => {
    const token = createSession(storage, 'admin', TTLS);
    destroySession(storage, token);
    expect(verifySession(storage, token, TTLS)).toBeNull();
  });

  it('sweeps rows that expired without ever being revisited', () => {
    // verifySession only deletes what it encounters. A session abandoned after
    // login would otherwise persist forever and grow the table without bound.
    const abandoned = createSession(storage, 'admin', TTLS);
    const abandonedHash = createHash('sha256').update(abandoned).digest('hex');
    expect(storage.getUiSession(abandonedHash)).toBeDefined();

    vi.advanceTimersByTime(ABSOLUTE_TTL_MS + 1000);

    // A later login is what triggers the sweep.
    createSession(storage, 'admin', TTLS);
    expect(storage.getUiSession(abandonedHash)).toBeUndefined();
  });

  it('sweeps expired rows rather than leaving them', () => {
    const token = createSession(storage, 'admin', TTLS);
    const hash = createHash('sha256').update(token).digest('hex');
    vi.advanceTimersByTime(ABSOLUTE_TTL_MS + 1000);
    expect(verifySession(storage, token, TTLS)).toBeNull();
    expect(storage.getUiSession(hash)).toBeUndefined();
  });
});

describe('UI sessions that never expire', () => {
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

  it('survives an idle stretch far past the default idle timeout', () => {
    const token = createSession(storage, 'admin', NEVER);
    vi.advanceTimersByTime(IDLE_TTL_MS * 100);
    expect(verifySession(storage, token, NEVER)).toEqual({ uiUser: 'admin' });
  });

  it('survives far past the default absolute ceiling', () => {
    const token = createSession(storage, 'admin', NEVER);
    vi.advanceTimersByTime(ABSOLUTE_TTL_MS * 365);
    expect(verifySession(storage, token, NEVER)).toEqual({ uiUser: 'admin' });
  });

  it('is still revoked by an explicit logout', () => {
    // The only way out when nothing expires, so it had better work.
    const token = createSession(storage, 'admin', NEVER);
    destroySession(storage, token);
    expect(verifySession(storage, token, NEVER)).toBeNull();
  });

  it('is not swept by the creation-time sweep', () => {
    const abandoned = createSession(storage, 'admin', NEVER);
    const hash = createHash('sha256').update(abandoned).digest('hex');
    vi.advanceTimersByTime(ABSOLUTE_TTL_MS * 365);
    createSession(storage, 'admin', NEVER);
    expect(storage.getUiSession(hash)).toBeDefined();
  });

  it('still sweeps rows that were minted under a finite TTL', () => {
    // Switching the setting must not strand old bounded rows in the table.
    const old = createSession(storage, 'admin', TTLS);
    const oldHash = createHash('sha256').update(old).digest('hex');
    vi.advanceTimersByTime(ABSOLUTE_TTL_MS + 1000);
    createSession(storage, 'admin', NEVER);
    expect(storage.getUiSession(oldHash)).toBeUndefined();
  });

  it('honours the expiry a session was minted with, not the current setting', () => {
    // A row issued under the 12h ceiling keeps that ceiling even after the
    // operator turns expiry off, rather than being retroactively immortal.
    const token = createSession(storage, 'admin', TTLS);
    vi.advanceTimersByTime(ABSOLUTE_TTL_MS + 1000);
    expect(verifySession(storage, token, NEVER)).toBeNull();
  });

  it('caps the cookie Max-Age at the 400-day browser ceiling', () => {
    const cookie = buildCookie('tok', true, 0);
    expect(cookie).toContain(`Max-Age=${400 * 24 * 60 * 60}`);
  });
});

describe('UI session cookies', () => {
  it('marks the cookie HttpOnly, SameSite=Strict and Path=/', () => {
    const cookie = buildCookie('tok', false, ABSOLUTE_TTL_MS);
    expect(cookie).toContain(`${SESSION_COOKIE}=tok`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
  });

  it('omits Secure when the listener is plain HTTP', () => {
    // Setting Secure over HTTP means the browser never sends the cookie back,
    // which would break login in the TLS fallback path.
    expect(buildCookie('tok', false, ABSOLUTE_TTL_MS)).not.toContain('Secure');
  });

  it('sets Secure when the listener is HTTPS', () => {
    expect(buildCookie('tok', true, ABSOLUTE_TTL_MS)).toContain('Secure');
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

describe('inspectSession', () => {
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

  it('accepts a live session and names the user', () => {
    const token = createSession(storage, 'admin', TTLS);
    expect(inspectSession(storage, token, TTLS)).toEqual({ ok: true, uiUser: 'admin' });
  });

  it('reports no_cookie for an absent or empty token', () => {
    expect(inspectSession(storage, undefined, TTLS)).toEqual({ ok: false, reason: 'no_cookie' });
    expect(inspectSession(storage, '', TTLS)).toEqual({ ok: false, reason: 'no_cookie' });
  });

  it('reports unknown_token for a token the server never issued', () => {
    createSession(storage, 'admin', TTLS);
    expect(inspectSession(storage, 'not-a-real-token', TTLS)).toEqual({
      ok: false,
      reason: 'unknown_token',
    });
  });

  it('reports unknown_token for a session that was logged out', () => {
    const token = createSession(storage, 'admin', TTLS);
    destroySession(storage, token);
    expect(inspectSession(storage, token, TTLS)).toEqual({ ok: false, reason: 'unknown_token' });
  });

  it('reports expired past the absolute TTL', () => {
    const token = createSession(storage, 'admin', TTLS);
    vi.advanceTimersByTime(ABSOLUTE_TTL_MS + 1000);
    expect(inspectSession(storage, token, { ...TTLS, idleTtlMs: 0 })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('reports idle past the idle timeout', () => {
    const token = createSession(storage, 'admin', TTLS);
    vi.advanceTimersByTime(IDLE_TTL_MS + 1000);
    expect(inspectSession(storage, token, TTLS)).toEqual({ ok: false, reason: 'idle' });
  });
});
