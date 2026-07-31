#!/usr/bin/env node
//
// Homelab health watchdog — `gateway-watchdog`.
//
// Probes the homelab MCP servers, tunnels, and core dependencies listed in
// watchdog.targets.json and alerts on *state transition* (not every tick) via
// Pushover (ntfy optional, dormant since the homelab ntfy was retired
// 2026-06-22), recording incidents/recoveries in the overseer Qdrant
// collections. See docs/watchdog.md.
//
//   gateway-watchdog run               # one sweep, print a table, alert on change
//   gateway-watchdog watch [-i secs]   # loop forever, one sweep per interval
//
// Config is env-driven with homelab defaults — see src/watchdog/config.ts.
//   WATCHDOG_TARGETS, WATCHDOG_STATE, WATCHDOG_INTERVAL, WATCHDOG_FAIL_THRESHOLD
//   QDRANT_URL, EMBED_URL, EMBED_MODEL
//   PUSHOVER_TOKEN, PUSHOVER_USER, NTFY_URL  (secrets from the gateway)
//   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET  (for `access` probes)

import { Command } from 'commander';
import { watchdogConfigFromEnv } from './watchdog/config.js';
import { runOnce, watchLoop, renderTable, summarize } from './watchdog/runner.js';

const program = new Command();
program
  .name('gateway-watchdog')
  .description('Probe homelab health and alert on state transitions (Pushover + ntfy + Qdrant)');

program
  .command('run')
  .description('Run a single sweep, print the status table, and alert on any transition')
  .option('--no-alert', 'probe and print only; do not dispatch alerts or write Qdrant')
  .action(async (opts: { alert: boolean }) => {
    const cfg = watchdogConfigFromEnv();
    const sweep = await runOnce(cfg, { dispatch: opts.alert });
    console.log(renderTable(sweep.results));
    console.log(`\n${summarize(sweep)}`);
    for (const { event, dispatch } of sweep.events) {
      const sinks = [
        dispatch.pushover ? 'pushover' : null,
        dispatch.ntfy ? 'ntfy' : null,
        dispatch.recorded ? 'qdrant' : null,
      ].filter(Boolean);
      console.log(`  → ${event.kind} ${event.name}: sent to ${sinks.join(', ') || '(none)'}`);
      for (const e of dispatch.errors) console.error(`    ! ${e}`);
    }
    // Exit non-zero if anything is currently down, so callers (n8n, cron) can react.
    const anyDown = sweep.results.some((r) => r.status === 'down');
    process.exit(anyDown ? 1 : 0);
  });

program
  .command('watch')
  .description('Loop forever, running one sweep per interval')
  .option('-i, --interval <seconds>', 'seconds between sweeps (overrides WATCHDOG_INTERVAL)')
  .action(async (opts: { interval?: string }) => {
    const cfg = watchdogConfigFromEnv();
    if (opts.interval) cfg.intervalSec = Math.max(1, parseInt(opts.interval, 10) || cfg.intervalSec);
    process.stderr.write(`[watchdog] watching ${cfg.targetsPath} every ${cfg.intervalSec}s\n`);
    const controller = new AbortController();
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.on(sig, () => {
        process.stderr.write(`\n[watchdog] ${sig} — stopping\n`);
        controller.abort();
      });
    }
    await watchLoop(
      cfg,
      (sweep) => process.stderr.write(`[watchdog] ${new Date().toISOString()} — ${summarize(sweep)}\n`),
      controller.signal,
    );
  });

program.parseAsync().catch((err) => {
  process.stderr.write(`[gateway-watchdog] ${(err as Error).message}\n`);
  process.exit(1);
});
