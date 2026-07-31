import type { ProxyManifest, ProxyServer } from './manifest.js';

/** Shape of the gateway's POST /v1/secrets/batch response. */
interface BatchResponse {
  secrets: Array<{ name: string; value: string; version?: number }>;
  missing?: string[];
  denied?: string[];
}

export interface InjectionResult {
  /** Target env var name → secret value, ready to inject into the child process. */
  env: Record<string, string>;
  /** Gateway secret names successfully fetched. */
  fetched: string[];
  /** Requested secrets the gateway reported as missing. */
  missing: string[];
  /** Requested secrets the consumer is not scoped for. */
  denied: string[];
}

export interface InjectorOptions {
  gatewayUrl: string;
  consumerKey: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/** Mask a secret value for safe logging (keeps length signal, hides content). */
export function maskValue(value: string): string {
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

/**
 * Fetch the secrets a downstream server needs and map them onto their target
 * env var names. Uses the gateway's batch endpoint so the whole set is fetched
 * (and audited) in one authenticated request.
 *
 * Throws if the consumer key is missing, the request fails, or any required
 * secret is missing/denied — we fail closed rather than launch a downstream
 * server with half its credentials.
 */
export async function fetchInjectedEnv(server: ProxyServer, opts: InjectorOptions): Promise<InjectionResult> {
  const names = Object.keys(server.secrets);
  if (names.length === 0) {
    return { env: {}, fetched: [], missing: [], denied: [] };
  }
  if (!opts.consumerKey) {
    throw new Error('No gateway consumer key provided; cannot fetch secrets for injection.');
  }

  const doFetch = opts.fetchFn ?? fetch;
  const res = await doFetch(`${opts.gatewayUrl.replace(/\/$/, '')}/v1/secrets/batch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.consumerKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ names }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gateway batch fetch failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as BatchResponse;
  const byName = new Map(data.secrets.map((s) => [s.name, s.value]));
  const missing = data.missing ?? [];
  const denied = data.denied ?? [];

  const env: Record<string, string> = {};
  const fetched: string[] = [];
  for (const [gatewayName, targetEnv] of Object.entries(server.secrets)) {
    const value = byName.get(gatewayName);
    if (value !== undefined) {
      env[targetEnv] = value;
      fetched.push(gatewayName);
    }
  }

  if (missing.length > 0 || denied.length > 0) {
    const parts: string[] = [];
    if (denied.length) parts.push(`denied (out of scope): ${denied.join(', ')}`);
    if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
    throw new Error(`Cannot inject all required secrets — ${parts.join('; ')}.`);
  }

  return { env, fetched, missing, denied };
}

/** Resolve the consumer key env var for a server, falling back to the manifest default. */
export function resolveConsumerKey(
  manifest: ProxyManifest,
  server: ProxyServer,
  environ: NodeJS.ProcessEnv,
): string {
  const keyEnv = server.consumerKeyEnv ?? manifest.consumerKeyEnv;
  return environ[keyEnv] ?? '';
}
