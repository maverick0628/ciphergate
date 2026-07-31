export interface RemoteConfig {
  url: string;
  apiKey: string;
}

export function getRemoteConfigFromEnv(): RemoteConfig | null {
  const url = process.env.GATEWAY_URL;
  if (!url) return null;
  const apiKey = process.env.GATEWAY_CONSUMER_KEY;
  if (!apiKey) {
    throw new Error(
      'GATEWAY_URL is set but GATEWAY_CONSUMER_KEY is missing. ' +
      'Set GATEWAY_CONSUMER_KEY to the API key of the consumer the CLI should authenticate as.',
    );
  }
  return { url: url.replace(/\/+$/, ''), apiKey };
}

export interface SecretGetResult {
  name: string;
  value: string;
  version: number;
}

export interface SecretListItem {
  name: string;
  version: number;
  updated_at: string;
  // Optional: older gateway builds omit these from the list response.
  tags?: string[];
  consumers?: string[];
}

export interface HistoryResult {
  name: string;
  current_version: number;
  history: Array<{ version: number; changed_at: string; changed_by: string }>;
}

export interface RotationReportResult {
  overdue: Array<{ name: string; age_days: number; rotation_days: number }>;
  due: Array<{ name: string; age_days: number; rotation_days: number }>;
  ok: Array<{ name: string; age_days: number; rotation_days: number }>;
}

export interface AuditEntry {
  timestamp: string;
  consumer: string;
  action: string;
  success: number | boolean;
  secret_name?: string;
  ip_address?: string;
  details?: string;
}

export class RemoteClient {
  constructor(
    private config: RemoteConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.config.apiKey}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await this.fetchImpl(`${this.config.url}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      try {
        const parsed = JSON.parse(text) as { message?: string; error?: string };
        msg = parsed.message ?? parsed.error ?? text;
      } catch { /* keep raw text */ }
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }

    if (res.status === 204) return undefined as T;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  }

  async getSecret(name: string): Promise<SecretGetResult> {
    return this.request('GET', `/v1/secret/${encodeURIComponent(name)}`);
  }

  async secretExists(name: string): Promise<boolean> {
    try {
      await this.getSecret(name);
      return true;
    } catch (e: unknown) {
      const msg = (e as Error).message ?? '';
      if (msg.startsWith('HTTP 404')) return false;
      throw e;
    }
  }

  async createSecret(body: {
    name: string;
    value: string;
    consumers: string[];
    tags: string[];
    rotation_days?: number;
    description?: string;
  }): Promise<unknown> {
    return this.request('POST', '/v1/secret', body);
  }

  async updateSecret(
    name: string,
    body: { value?: string; consumers?: string[]; tags?: string[]; rotation_days?: number; description?: string },
  ): Promise<unknown> {
    return this.request('PUT', `/v1/secret/${encodeURIComponent(name)}`, body);
  }

  async listSecrets(tag?: string): Promise<{ secrets: SecretListItem[] }> {
    const qs = tag ? `?tag=${encodeURIComponent(tag)}` : '';
    return this.request('GET', `/v1/secrets${qs}`);
  }

  async deleteSecret(name: string): Promise<void> {
    await this.request<void>('DELETE', `/v1/secret/${encodeURIComponent(name)}`);
  }

  async getEnv(opts: { tag?: string; names?: string[] }): Promise<string> {
    const params = new URLSearchParams();
    if (opts.tag) params.set('tag', opts.tag);
    if (opts.names?.length) params.set('names', opts.names.join(','));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/v1/env${qs}`);
  }

  async getHistory(name: string): Promise<HistoryResult> {
    return this.request('GET', `/v1/secret/${encodeURIComponent(name)}/history`);
  }

  async rotationReport(): Promise<RotationReportResult> {
    return this.request('GET', '/v1/rotation-report');
  }

  async getAudit(opts: { limit?: number; consumer?: string; since?: string }): Promise<{ entries: AuditEntry[] }> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.consumer) params.set('consumer', opts.consumer);
    if (opts.since) params.set('since', opts.since);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/v1/audit${qs}`);
  }
}
