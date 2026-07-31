/**
 * Watchdog configuration — env-driven, with this homelab's defaults baked in
 * The watchdog runs on
 * a host that reaches both llm-host and
 * the gateway host over the LAN.
 *
 * Secrets (Pushover token/user, Cloudflare Access service token) are NEVER
 * hardcoded — they arrive as env at deploy time, injected from the gateway
 * (`gateway env` / `mcp-wrap` / the REST `/v1/secret/:name` endpoint). The code
 * only reads them from the environment.
 */
export interface WatchdogConfig {
  /** Path to the editable targets manifest. */
  targetsPath: string;
  /** Path to the transition-memory state file. */
  statePath: string;
  /** Seconds between sweeps in `watch` mode. */
  intervalSec: number;
  /** Consecutive failed sweeps required before a target flips to `down` (flap dampening). */
  failThreshold: number;
  /** Default per-probe timeout (ms) when a target sets none. */
  timeoutMs: number;

  /** Qdrant base for the incident/outcome store. */
  qdrantUrl: string;
  qdrantApiKey?: string;
  incidentsCollection: string;
  outcomesCollection: string;

  /** OpenAI-compatible embeddings base. Optional; only used to record incidents. */
  embedUrl: string;
  embedModel: string;
  embedApiKey?: string;

  /** Pushover credentials (from the gateway). Alerts are skipped if either is absent. */
  pushoverToken?: string;
  pushoverUser?: string;
  /**
   * Optional ntfy topic URL. Empty by default — the homelab ntfy was retired
   * 2026-06-22 (Pushover replaced it), so the ntfy sink stays dormant until a
   * topic URL is supplied via NTFY_URL.
   */
  ntfyUrl: string;

  /** Cloudflare Access service-token headers for `access` probes (from the gateway). */
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

function envInt(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = env[name];
  if (v === undefined) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const strip = (s: string): string => s.replace(/\/$/, '');

/** Read watchdog config from env with the homelab defaults baked in. */
export function watchdogConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WatchdogConfig {
  return {
    targetsPath: env.WATCHDOG_TARGETS ?? './watchdog.targets.json',
    statePath: env.WATCHDOG_STATE ?? '/data/watchdog-state.json',
    intervalSec: envInt(env, 'WATCHDOG_INTERVAL', 60),
    failThreshold: Math.max(1, envInt(env, 'WATCHDOG_FAIL_THRESHOLD', 2)),
    timeoutMs: envInt(env, 'WATCHDOG_TIMEOUT_MS', 5000),

    qdrantUrl: strip(env.QDRANT_URL ?? 'http://llm-host:6333'),
    qdrantApiKey: env.QDRANT_API_KEY || undefined,
    incidentsCollection: env.WATCHDOG_INCIDENTS_COLLECTION ?? 'overseer_incidents',
    outcomesCollection: env.WATCHDOG_OUTCOMES_COLLECTION ?? 'overseer_outcomes',

    embedUrl: strip(env.EMBED_URL ?? 'http://llm-host:1234/v1'),
    embedModel: env.EMBED_MODEL ?? 'text-embedding-nomic-embed-text-v2',
    embedApiKey: env.EMBED_API_KEY || undefined,

    // Spec uses PUSHOVER_TOKEN / PUSHOVER_USER; fall back to the gateway's own
    // var names so a single injected set serves both services.
    pushoverToken: env.PUSHOVER_TOKEN || env.PUSHOVER_APP_TOKEN || undefined,
    pushoverUser: env.PUSHOVER_USER || env.PUSHOVER_USER_KEY || undefined,
    ntfyUrl: strip(env.NTFY_URL ?? ''),

    cfAccessClientId: env.CF_ACCESS_CLIENT_ID || undefined,
    cfAccessClientSecret: env.CF_ACCESS_CLIENT_SECRET || undefined,
  };
}
