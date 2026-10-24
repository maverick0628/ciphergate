import { randomBytes, createHash } from 'node:crypto';
import type { StorageBackend } from '../storage/interface.js';

export const SESSION_COOKIE = 'sg_ui_session';

/** Default hard ceiling on a session's life, regardless of activity. */
export const DEFAULT_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;

/** Default idle timeout — a session with no activity in this window is dead. */
export const DEFAULT_IDLE_TTL_MS = 60 * 60 * 1000;

/**
 * How long a session lives. Either value at `0` disables that rule outright.
 *
 * Disabling both is what a single-operator deployment wants: being logged out
 * mid-rotation is a worse day-to-day cost than the extra exposure of a
 * long-lived cookie, given the cookie is HttpOnly/SameSite=Strict/Secure, login
 * is rate-limited per IP, and no UI endpoint returns a plaintext secret.
 */
export interface SessionTtls {
  absoluteTtlMs: number;
  idleTtlMs: number;
}

/**
 * `expires_at` written for a session with no absolute expiry. The column is NOT
 * NULL, and `deleteExpiredUiSessions` compares it as a string, so a far-future
 * ISO-8601 value sorts after every real timestamp and is never swept.
 */
const NEVER_EXPIRES_AT = '9999-12-31T23:59:59.999Z';

/**
 * Browsers clamp cookie lifetime to 400 days, so a never-expiring session asks
 * for exactly the cap rather than a larger number that gets silently trimmed.
 * The session row outlives the cookie; hitting this means one more login, not
 * lost state.
 */
const COOKIE_MAX_AGE_CAP_SEC = 400 * 24 * 60 * 60;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Parse a timestamp written by this module. Values are stored as ISO-8601 UTC,
 * but tolerate SQLite's space-separated form in case a row predates that.
 */
function parseTimestamp(value: string): number {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  return new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`).getTime();
}

/**
 * Mint a session and return the raw token for the cookie. Only the sha256 of
 * the token is persisted, so reading the database does not yield usable
 * sessions.
 */
export function createSession(
  storage: StorageBackend,
  uiUser: string,
  ttls: SessionTtls,
): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();

  // Sweep dead rows here rather than on a timer. verifySession only deletes
  // sessions it happens to encounter, so a session that is never revisited —
  // browser closed, new login next day — would otherwise sit in the table
  // forever and grow it without bound.
  //
  // With no absolute expiry there is nothing to sweep, so the table grows by a
  // row per login. That is the accepted cost of never expiring: one small row
  // per login on a single-operator instance.
  storage.deleteExpiredUiSessions(new Date(now).toISOString());

  storage.createUiSession(
    hashToken(token),
    uiUser,
    ttls.absoluteTtlMs > 0
      ? new Date(now + ttls.absoluteTtlMs).toISOString()
      : NEVER_EXPIRES_AT,
    new Date(now).toISOString(),
  );
  return token;
}

/**
 * Validate a session token against both the absolute expiry and the idle
 * timeout, refreshing `last_seen` when it passes. Expired rows are deleted as
 * they are encountered.
 *
 * The absolute check reads the stored `expires_at` rather than the configured
 * TTL, so sessions minted under an older setting keep the lifetime they were
 * issued with.
 */
export function verifySession(
  storage: StorageBackend,
  token: string,
  ttls: SessionTtls,
): { uiUser: string } | null {
  const result = inspectSession(storage, token, ttls);
  return result.ok ? { uiUser: result.uiUser } : null;
}

/**
 * Why a session check failed. Logged by the auth gate so a 401 can be traced to
 * a browser that stopped sending the cookie (`no_cookie`), a token the server
 * has never seen or has since dropped (`unknown_token`), or a TTL rule.
 */
export type SessionRejection = 'no_cookie' | 'unknown_token' | 'expired' | 'idle';

export type SessionCheck = { ok: true; uiUser: string } | { ok: false; reason: SessionRejection };

/**
 * `verifySession` with the reason attached. An undefined or empty token is
 * `no_cookie`; the caller passes whatever `parseCookie` returned.
 */
export function inspectSession(
  storage: StorageBackend,
  token: string | undefined,
  ttls: SessionTtls,
): SessionCheck {
  if (!token) return { ok: false, reason: 'no_cookie' };

  const tokenHash = hashToken(token);
  const session = storage.getUiSession(tokenHash);
  if (!session) return { ok: false, reason: 'unknown_token' };

  const now = Date.now();

  if (now >= parseTimestamp(session.expires_at)) {
    storage.deleteUiSession(tokenHash);
    return { ok: false, reason: 'expired' };
  }

  if (ttls.idleTtlMs > 0 && now - parseTimestamp(session.last_seen) >= ttls.idleTtlMs) {
    storage.deleteUiSession(tokenHash);
    return { ok: false, reason: 'idle' };
  }

  storage.touchUiSession(tokenHash, new Date(now).toISOString());
  return { ok: true, uiUser: session.ui_user };
}

export function destroySession(storage: StorageBackend, token: string): void {
  if (!token) return;
  storage.deleteUiSession(hashToken(token));
}

/**
 * `Secure` is conditional on the listener actually serving HTTPS. Setting it on
 * a plain-HTTP listener means the browser never sends the cookie back, which
 * would break login silently in the TLS fallback path.
 */
export function buildCookie(token: string, secure: boolean, absoluteTtlMs: number): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${absoluteTtlMs > 0 ? Math.floor(absoluteTtlMs / 1000) : COOKIE_MAX_AGE_CAP_SEC}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function parseCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) {
      return part.slice(idx + 1).trim();
    }
  }
  return undefined;
}
