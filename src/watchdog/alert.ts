/**
 * Alert dispatch.
 *
 * On a transition the watchdog fans out to its sinks, each best-effort (one
 * failing sink never blocks the others, mirroring the gateway's fire-and-forget
 * Pushover dispatch):
 *
 *   Pushover — push to phone/desktop. High priority for down, normal for recovery.
 *              The live homelab push channel.
 *   ntfy     — optional. POST to an ntfy topic, priority `high` / `default`.
 *              Skipped unless NTFY_URL is set; the homelab ntfy was retired
 *              2026-06-22 (Pushover replaced it), so this stays dormant until a
 *              topic exists again.
 *   Qdrant   — record an incident or recovery point, embedding a one-line
 *              summary so the history stays semantically searchable. Optional:
 *              skipped unless an embeddings endpoint and Qdrant URL are set.
 */
import { randomUUID } from 'node:crypto';
import { embedQuery, type EmbedConfig } from './embed.js';
import type { WatchdogConfig } from './config.js';
import type { Transition } from './state.js';

export interface AlertEvent {
  name: string;
  kind: 'incident' | 'recovery';
  /** The probe status that drove this event (`down` | `degraded` for incidents). */
  status: string;
  detail: string;
  at: string;
}

/** Build the alert event for a committed transition, or null if nothing to send. */
export function eventFor(t: Transition, now: string): AlertEvent | null {
  if (t.kind === 'none') return null;
  return { name: t.name, kind: t.kind, status: t.status, detail: t.detail, at: now };
}

export interface FormattedAlert {
  title: string;
  message: string;
  /** Pushover priority: 1 high, 0 normal. */
  pushoverPriority: 0 | 1;
  /** ntfy priority header. */
  ntfyPriority: 'high' | 'default';
}

/** Format an event into the Pushover/ntfy message, e.g. `⛔ vector-db DOWN — health 502`. */
export function formatAlert(e: AlertEvent): FormattedAlert {
  if (e.kind === 'recovery') {
    return {
      title: `${e.name} recovered`,
      message: `✅ ${e.name} recovered`,
      pushoverPriority: 0,
      ntfyPriority: 'default',
    };
  }
  const label = e.status === 'degraded' ? 'DEGRADED' : 'DOWN';
  const emoji = e.status === 'degraded' ? '⚠️' : '⛔';
  return {
    title: `${e.name} ${label}`,
    message: `${emoji} ${e.name} ${label} — ${e.detail}`,
    pushoverPriority: 1,
    ntfyPriority: 'high',
  };
}

/** POST to Pushover. No-ops (returns false) when credentials are absent. */
export async function sendPushover(
  cfg: WatchdogConfig,
  alert: FormattedAlert,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  if (!cfg.pushoverToken || !cfg.pushoverUser) return false;
  const form = new URLSearchParams({
    token: cfg.pushoverToken,
    user: cfg.pushoverUser,
    title: alert.title,
    message: alert.message,
    priority: String(alert.pushoverPriority),
  });
  const res = await fetchFn('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!res.ok) throw new Error(`pushover ${res.status}`);
  return true;
}

/**
 * POST to the ntfy topic with title + priority headers. No-ops (returns false)
 * when no topic is configured, mirroring `sendPushover` — the homelab ntfy was
 * retired 2026-06-22, so this is dormant until NTFY_URL is set again.
 */
export async function sendNtfy(
  cfg: WatchdogConfig,
  alert: FormattedAlert,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  if (!cfg.ntfyUrl) return false;
  const res = await fetchFn(cfg.ntfyUrl, {
    method: 'POST',
    headers: { Title: alert.title, Priority: alert.ntfyPriority },
    body: alert.message,
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
  return true;
}

/** The embedding-relevant subset of the watchdog's config. */
function embedConfig(cfg: WatchdogConfig): EmbedConfig {
  return {
    embedUrl: cfg.embedUrl,
    embedModel: cfg.embedModel,
    embedApiKey: cfg.embedApiKey,
    queryPrefix: '',
  };
}

/**
 * Embed a one-line summary and upsert it as an un-named-vector point into the
 * incident (down) or outcome (recovery) collection.
 */
export async function recordEvent(
  cfg: WatchdogConfig,
  e: AlertEvent,
  fetchFn: typeof fetch = fetch,
): Promise<{ collection: string; id: string }> {
  const collection = e.kind === 'incident' ? cfg.incidentsCollection : cfg.outcomesCollection;
  const summary =
    e.kind === 'incident'
      ? `${e.name} ${e.status} — ${e.detail}`
      : `${e.name} recovered — back to healthy`;

  const vector = await embedQuery(summary, embedConfig(cfg), fetchFn);
  const id = randomUUID();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.qdrantApiKey) headers['api-key'] = cfg.qdrantApiKey;
  const res = await fetchFn(`${cfg.qdrantUrl}/collections/${encodeURIComponent(collection)}/points`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      points: [
        {
          id,
          vector, // un-named (top-level) vector
          payload: {
            summary,
            target: e.name,
            status: e.status,
            kind: e.kind,
            detail: e.detail,
            ts: e.at,
            source: 'watchdog',
          },
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`qdrant upsert ${collection} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { collection, id };
}

export interface DispatchResult {
  pushover: boolean;
  ntfy: boolean;
  recorded: boolean;
  errors: string[];
}

/**
 * Dispatch an event to all three sinks, best-effort. Each sink runs independently
 * and a failure is collected, not thrown — a Pushover outage must not stop the
 * incident from being recorded, and vice versa.
 */
export async function dispatchAlert(
  cfg: WatchdogConfig,
  e: AlertEvent,
  fetchFn: typeof fetch = fetch,
): Promise<DispatchResult> {
  const alert = formatAlert(e);
  const errors: string[] = [];
  const [pushover, ntfy, recorded] = await Promise.all([
    sendPushover(cfg, alert, fetchFn).catch((err) => {
      errors.push(`pushover: ${(err as Error).message}`);
      return false;
    }),
    sendNtfy(cfg, alert, fetchFn).catch((err) => {
      errors.push(`ntfy: ${(err as Error).message}`);
      return false;
    }),
    recordEvent(cfg, e, fetchFn)
      .then(() => true)
      .catch((err) => {
        errors.push(`qdrant: ${(err as Error).message}`);
        return false;
      }),
  ]);
  return { pushover, ntfy, recorded, errors };
}
