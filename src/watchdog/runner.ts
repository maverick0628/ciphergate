/**
 * Sweep orchestrator: probe every target, diff against the persisted state, and
 * dispatch an alert on each transition. `runOnce` is one sweep (the `run`
 * command); `watchLoop` repeats it every `intervalSec` (the `watch` command).
 */
import { loadTargets, type WatchdogTarget } from './manifest.js';
import { watchdogConfigFromEnv, type WatchdogConfig } from './config.js';
import { probeTarget, type ProbeResult, type ProbeStatus } from './probe.js';
import { loadState, saveState, applyProbe, type WatchdogState } from './state.js';
import { eventFor, dispatchAlert, type AlertEvent, type DispatchResult } from './alert.js';

export interface SweepResult {
  results: ProbeResult[];
  events: Array<{ event: AlertEvent; dispatch: DispatchResult }>;
  state: WatchdogState;
}

const nowIso = (): string => new Date().toISOString();

/**
 * Run one sweep. Probes are issued concurrently; transitions are committed to the
 * state file before alerts fire so a crash mid-dispatch can't replay an incident.
 */
export async function runOnce(
  cfg: WatchdogConfig,
  opts: { targets?: WatchdogTarget[]; dispatch?: boolean; fetchFn?: typeof fetch } = {},
): Promise<SweepResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const targets = opts.targets ?? loadTargets(cfg.targetsPath);
  const state = loadState(cfg.statePath);
  const now = nowIso();

  const results = await Promise.all(targets.map((t) => probeTarget(t, cfg, fetchFn)));

  const pending: AlertEvent[] = [];
  for (const result of results) {
    const transition = applyProbe(state.targets[result.name], result, cfg.failThreshold, now);
    state.targets[result.name] = transition.next;
    const event = eventFor(transition, now);
    if (event) pending.push(event);
  }

  saveState(cfg.statePath, state);

  const events: SweepResult['events'] = [];
  if (opts.dispatch !== false) {
    for (const event of pending) {
      const dispatch = await dispatchAlert(cfg, event, fetchFn);
      events.push({ event, dispatch });
    }
  } else {
    for (const event of pending) {
      events.push({ event, dispatch: { pushover: false, ntfy: false, recorded: false, errors: [] } });
    }
  }

  return { results, events, state };
}

const ICON: Record<ProbeStatus, string> = { ok: '✅', degraded: '⚠️ ', down: '⛔' };

/** Render the sweep as an aligned text table for the CLI. */
export function renderTable(results: ProbeResult[]): string {
  const nameW = Math.max(4, ...results.map((r) => r.name.length));
  const header = `${'NAME'.padEnd(nameW)}  STATUS    LATENCY  DETAIL`;
  const rows = results.map((r) => {
    const status = `${ICON[r.status]} ${r.status}`.padEnd(11);
    const latency = `${r.latencyMs}ms`.padStart(6);
    return `${r.name.padEnd(nameW)}  ${status}  ${latency}  ${r.detail}`;
  });
  return [header, ...rows].join('\n');
}

/** Summarise a sweep's transitions for log output. */
export function summarize(sweep: SweepResult): string {
  const down = sweep.results.filter((r) => r.status === 'down').length;
  const degraded = sweep.results.filter((r) => r.status === 'degraded').length;
  const ok = sweep.results.length - down - degraded;
  const transitions = sweep.events.map((e) => `${e.event.kind}:${e.event.name}`).join(', ');
  const base = `${ok} ok, ${degraded} degraded, ${down} down`;
  return transitions ? `${base} — ${transitions}` : base;
}

/**
 * Loop forever, one sweep every `intervalSec`. `onSweep` is invoked after each
 * sweep (for logging); `signal` aborts the loop between sweeps.
 */
export async function watchLoop(
  cfg: WatchdogConfig = watchdogConfigFromEnv(),
  onSweep: (sweep: SweepResult) => void = () => {},
  signal?: AbortSignal,
): Promise<void> {
  while (!signal?.aborted) {
    try {
      const sweep = await runOnce(cfg);
      onSweep(sweep);
    } catch (err) {
      process.stderr.write(`[watchdog] sweep failed: ${(err as Error).message}\n`);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, cfg.intervalSec * 1000);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
