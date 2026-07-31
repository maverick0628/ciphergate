import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isLockedOut,
  recordFailure,
  clearFailures,
  resetLockoutState,
  FAILURE_LIMIT,
  WINDOW_MS,
  LOCKOUT_MS,
} from '../src/core/lockout.js';

describe('per-IP failure lockout', () => {
  beforeEach(() => {
    resetLockoutState();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetLockoutState();
  });

  it('is not locked out with no recorded failures', () => {
    expect(isLockedOut('api', '10.0.0.1')).toBe(false);
  });

  it('does not lock out at the limit, only past it', () => {
    for (let i = 0; i < FAILURE_LIMIT; i++) recordFailure('api', '10.0.0.1');
    expect(isLockedOut('api', '10.0.0.1')).toBe(false);
  });

  it('locks out on the failure past the limit', () => {
    for (let i = 0; i <= FAILURE_LIMIT; i++) recordFailure('api', '10.0.0.1');
    expect(isLockedOut('api', '10.0.0.1')).toBe(true);
  });

  it('keeps scopes independent', () => {
    for (let i = 0; i <= FAILURE_LIMIT; i++) recordFailure('ui', '10.0.0.1');
    expect(isLockedOut('ui', '10.0.0.1')).toBe(true);
    expect(isLockedOut('api', '10.0.0.1')).toBe(false);
  });

  it('keeps IPs independent', () => {
    for (let i = 0; i <= FAILURE_LIMIT; i++) recordFailure('api', '10.0.0.1');
    expect(isLockedOut('api', '10.0.0.2')).toBe(false);
  });

  it('forgets failures once the window passes without a lockout', () => {
    for (let i = 0; i < FAILURE_LIMIT; i++) recordFailure('api', '10.0.0.1');
    vi.advanceTimersByTime(WINDOW_MS + 1);
    // Window elapsed, so the counter restarts rather than tipping into lockout.
    recordFailure('api', '10.0.0.1');
    expect(isLockedOut('api', '10.0.0.1')).toBe(false);
  });

  it('stays locked out for the full lockout duration', () => {
    for (let i = 0; i <= FAILURE_LIMIT; i++) recordFailure('api', '10.0.0.1');
    vi.advanceTimersByTime(LOCKOUT_MS - 1000);
    expect(isLockedOut('api', '10.0.0.1')).toBe(true);
  });

  it('releases the lockout after it expires', () => {
    for (let i = 0; i <= FAILURE_LIMIT; i++) recordFailure('api', '10.0.0.1');
    vi.advanceTimersByTime(LOCKOUT_MS + 1000);
    expect(isLockedOut('api', '10.0.0.1')).toBe(false);
  });

  it('clearFailures drops the record', () => {
    for (let i = 0; i <= FAILURE_LIMIT; i++) recordFailure('api', '10.0.0.1');
    expect(isLockedOut('api', '10.0.0.1')).toBe(true);
    clearFailures('api', '10.0.0.1');
    expect(isLockedOut('api', '10.0.0.1')).toBe(false);
  });

  it('resetLockoutState clears every scope', () => {
    for (let i = 0; i <= FAILURE_LIMIT; i++) recordFailure('api', '10.0.0.1');
    for (let i = 0; i <= FAILURE_LIMIT; i++) recordFailure('ui', '10.0.0.9');
    resetLockoutState();
    expect(isLockedOut('api', '10.0.0.1')).toBe(false);
    expect(isLockedOut('ui', '10.0.0.9')).toBe(false);
  });
});
