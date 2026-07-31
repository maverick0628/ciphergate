/**
 * Guard deny alerting.
 *
 * When the guard hard-blocks a tool call (a money-moving / destructive tool that
 * isn't on the allowlist, or an argument that hit a deny pattern), we want more
 * than a stderr line — the whole point of guarding `coinbase` / `robinhood-trading`
 * is that an attempted trade is a security event worth a push notification.
 *
 * The guard runs as its own stdio child (spawned by `mcp-wrap` → `gateway-proxy
 * guard`), not inside the gateway process, so it can't use the gateway's
 * in-process AuditLogger. Instead it posts directly to Pushover (+ optional ntfy)
 * from env-injected credentials — the same fire-and-forget shape the watchdog and
 * the gateway's audit dispatch use. Every sink is best-effort: a failed alert
 * must never change the deny decision or crash the stream.
 */

export interface GuardAlertConfig {
  pushoverToken?: string;
  pushoverUser?: string;
  /** Optional homelab ntfy topic URL; when set, denies also POST here. */
  ntfyUrl?: string;
}

/** Read the alert sinks from env (PUSHOVER_TOKEN / PUSHOVER_USER / GUARD_NTFY_URL). */
export function guardAlertConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GuardAlertConfig {
  return {
    pushoverToken: env.PUSHOVER_TOKEN || undefined,
    pushoverUser: env.PUSHOVER_USER || undefined,
    ntfyUrl: env.GUARD_NTFY_URL || undefined,
  };
}

export interface DenyEvent {
  /** Manifest server name, e.g. `coinbase`. */
  server: string;
  /** The blocked tool. */
  tool: string;
  /** Why it was blocked (allowlist miss / deny pattern). */
  reason: string;
  /** ISO timestamp. */
  at: string;
}

export interface DenyAlertResult {
  pushover: boolean;
  ntfy: boolean;
  errors: string[];
}

/** `⛔ coinbase guard DENY — coinbase_orders_create: tool "…" is not in the allowlist`. */
export function formatDenyMessage(ev: DenyEvent): { title: string; message: string } {
  return {
    title: `${ev.server} guard blocked ${ev.tool}`,
    message: `⛔ ${ev.server} guard DENY — ${ev.tool}: ${ev.reason}`,
  };
}

async function postPushover(cfg: GuardAlertConfig, ev: DenyEvent, fetchFn: typeof fetch): Promise<boolean> {
  if (!cfg.pushoverToken || !cfg.pushoverUser) return false;
  const { title, message } = formatDenyMessage(ev);
  const body = new URLSearchParams({
    token: cfg.pushoverToken,
    user: cfg.pushoverUser,
    title,
    message,
    priority: '1', // high — an attempted trade/withdraw should bypass quiet hours
  });
  const res = await fetchFn('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`pushover ${res.status}`);
  return true;
}

async function postNtfy(cfg: GuardAlertConfig, ev: DenyEvent, fetchFn: typeof fetch): Promise<boolean> {
  if (!cfg.ntfyUrl) return false;
  const { title, message } = formatDenyMessage(ev);
  const res = await fetchFn(cfg.ntfyUrl, {
    method: 'POST',
    headers: { Title: title, Priority: 'high', Tags: 'no_entry,money_with_wings' },
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
  return true;
}

/**
 * Dispatch a deny event to Pushover (+ optional ntfy), best-effort. Never throws:
 * each sink's failure is collected so a notification outage can't block the guard.
 */
export async function sendGuardDenyAlert(
  cfg: GuardAlertConfig,
  ev: DenyEvent,
  fetchFn: typeof fetch = fetch,
): Promise<DenyAlertResult> {
  const errors: string[] = [];
  const [pushover, ntfy] = await Promise.all([
    postPushover(cfg, ev, fetchFn).catch((err) => {
      errors.push(`pushover: ${(err as Error).message}`);
      return false;
    }),
    postNtfy(cfg, ev, fetchFn).catch((err) => {
      errors.push(`ntfy: ${(err as Error).message}`);
      return false;
    }),
  ]);
  return { pushover, ntfy, errors };
}
