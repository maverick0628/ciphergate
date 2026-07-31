/**
 * Transition memory.
 *
 * The watchdog alerts on *state change*, not every tick. This module persists the
 * last committed health of each target to a JSON file and decides — per sweep —
 * whether a probe result represents an incident (ok→down), a recovery (down→ok),
 * or no change.
 *
 * Flap dampening: a target only flips to `down` after `failThreshold` consecutive
 * unhealthy probes (default 2), so a single transient blip never pages. Recovery
 * is immediate — one healthy probe clears it. Persisting the state file means a
 * watchdog restart never re-alerts for an already-known-down target.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProbeResult, ProbeStatus } from './probe.js';

/** Committed health of one target. `degraded` collapses into `down` for alerting. */
export interface TargetState {
  status: 'ok' | 'down';
  /** Consecutive unhealthy probes observed while still `ok` (resets on recovery). */
  failures: number;
  /** Last probe status seen (for the table / detail), including `degraded`. */
  lastStatus: ProbeStatus;
  /** Last reason string. */
  detail: string;
  /** ISO timestamp of the last committed transition. */
  since: string;
}

export interface WatchdogState {
  version: 1;
  targets: Record<string, TargetState>;
}

export type TransitionKind = 'none' | 'incident' | 'recovery';

export interface Transition {
  name: string;
  kind: TransitionKind;
  status: ProbeStatus;
  detail: string;
  /** The committed state after applying this probe. */
  next: TargetState;
}

export function emptyState(): WatchdogState {
  return { version: 1, targets: {} };
}

/** Load the state file; a missing or unreadable file starts from empty. */
export function loadState(path: string): WatchdogState {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(content) as Partial<WatchdogState>;
    if (parsed && typeof parsed === 'object' && parsed.targets && typeof parsed.targets === 'object') {
      return { version: 1, targets: parsed.targets as Record<string, TargetState> };
    }
  } catch {
    /* fall through to empty */
  }
  return emptyState();
}

/** Persist the state file, creating its directory if needed. */
export function saveState(path: string, state: WatchdogState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/**
 * Apply one probe result against the prior state and decide the transition.
 *
 * A target unseen before is treated as previously `ok`, so a service that is
 * already down when the watchdog first runs still fires one incident.
 */
export function applyProbe(
  prev: TargetState | undefined,
  result: ProbeResult,
  failThreshold: number,
  now: string,
): Transition {
  const prevStatus: 'ok' | 'down' = prev?.status ?? 'ok';
  const healthy = result.status === 'ok';

  if (healthy) {
    const recovered = prevStatus === 'down';
    const next: TargetState = {
      status: 'ok',
      failures: 0,
      lastStatus: result.status,
      detail: result.detail,
      since: recovered ? now : prev?.since ?? now,
    };
    return { name: result.name, kind: recovered ? 'recovery' : 'none', status: result.status, detail: result.detail, next };
  }

  // Unhealthy (down or degraded): count toward the dampening threshold.
  const failures = (prev?.failures ?? 0) + 1;
  if (prevStatus === 'down') {
    // Already committed down — no new alert, just keep the failure tally.
    const next: TargetState = { status: 'down', failures, lastStatus: result.status, detail: result.detail, since: prev?.since ?? now };
    return { name: result.name, kind: 'none', status: result.status, detail: result.detail, next };
  }
  if (failures >= failThreshold) {
    const next: TargetState = { status: 'down', failures, lastStatus: result.status, detail: result.detail, since: now };
    return { name: result.name, kind: 'incident', status: result.status, detail: result.detail, next };
  }
  // Below threshold — stay `ok`, remember the failure but don't alert yet.
  const next: TargetState = { status: 'ok', failures, lastStatus: result.status, detail: result.detail, since: prev?.since ?? now };
  return { name: result.name, kind: 'none', status: result.status, detail: result.detail, next };
}
