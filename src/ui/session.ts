import { randomBytes, createHash } from 'node:crypto';
import type { StorageBackend } from '../storage/interface.js';

export const SESSION_COOKIE = 'sg_ui_session';

/** Hard ceiling on a session's life, regardless of activity. */
export const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;

/** Idle timeout — a session with no activity in this window is dead. */
export const IDLE_TTL_MS = 60 * 60 * 1000;

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
export function createSession(storage: StorageBackend, uiUser: string): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();

  // Sweep dead rows here rather than on a timer. verifySession only deletes
  // sessions it happens to encounter, so a session that is never revisited —
  // browser closed, new login next day — would otherwise sit in the table
  // forever and grow it without bound.
  storage.deleteExpiredUiSessions(new Date(now).toISOString());

  storage.createUiSession(
    hashToken(token),
    uiUser,
    new Date(now + ABSOLUTE_TTL_MS).toISOString(),
    new Date(now).toISOString(),
  );
  return token;
}

/**
 * Validate a session token against both the absolute expiry and the idle
 * timeout, refreshing `last_seen` when it passes. Expired rows are deleted as
 * they are encountered.
 */
export function verifySession(
  storage: StorageBackend,
  token: string,
): { uiUser: string } | null {
  if (!token) return null;

  const tokenHash = hashToken(token);
  const session = storage.getUiSession(tokenHash);
  if (!session) return null;

  const now = Date.now();

  if (now >= parseTimestamp(session.expires_at)) {
    storage.deleteUiSession(tokenHash);
    return null;
  }

  if (now - parseTimestamp(session.last_seen) >= IDLE_TTL_MS) {
    storage.deleteUiSession(tokenHash);
    return null;
  }

  storage.touchUiSession(tokenHash, new Date(now).toISOString());
  return { uiUser: session.ui_user };
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
export function buildCookie(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.floor(ABSOLUTE_TTL_MS / 1000)}`,
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
