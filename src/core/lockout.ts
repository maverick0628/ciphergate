/**
 * Per-IP failure lockout, shared by the REST API's bearer-token auth and the
 * UI's password login.
 *
 * `scope` keeps those two buckets separate: someone brute-forcing the UI login
 * should not be able to lock a legitimate consumer out of the API from the same
 * source address, and vice versa.
 */

export const FAILURE_LIMIT = 5;
export const WINDOW_MS = 60 * 1000;
export const LOCKOUT_MS = 15 * 60 * 1000;

interface FailureEntry {
  count: number;
  resetAt: number;
  lockedUntil?: number;
}

const buckets = new Map<string, FailureEntry>();

function key(scope: string, ip: string): string {
  return `${scope}|${ip}`;
}

/**
 * True while this scope/IP pair is inside an active lockout. Also expires stale
 * counter entries as a side effect, which keeps the map from growing without
 * bound on a busy gateway.
 */
export function isLockedOut(scope: string, ip: string): boolean {
  const k = key(scope, ip);
  const entry = buckets.get(k);
  if (!entry) return false;

  const now = Date.now();

  if (entry.lockedUntil !== undefined) {
    if (now < entry.lockedUntil) return true;
    buckets.delete(k);
    return false;
  }

  if (now >= entry.resetAt) {
    buckets.delete(k);
    return false;
  }

  return false;
}

/**
 * Record one failed attempt. Exceeding FAILURE_LIMIT within WINDOW_MS starts a
 * LOCKOUT_MS lockout.
 */
export function recordFailure(scope: string, ip: string): void {
  const k = key(scope, ip);
  const now = Date.now();
  const entry = buckets.get(k);

  if (!entry || (entry.lockedUntil === undefined && now >= entry.resetAt)) {
    buckets.set(k, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }

  entry.count++;
  if (entry.count > FAILURE_LIMIT) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
}

/** Drop the record entirely — used on a successful authentication. */
export function clearFailures(scope: string, ip: string): void {
  buckets.delete(key(scope, ip));
}

/** Reset all lockout state. For use in tests only. */
export function resetLockoutState(): void {
  buckets.clear();
}
