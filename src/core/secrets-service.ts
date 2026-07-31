import { encrypt, decrypt, maskValue } from '../storage/crypto.js';
import type { StorageBackend } from '../storage/interface.js';
import type { SecretResponse, SecretMetadata, BatchResponse, RotationReportEntry, GatewayStatus, UiSecretDetail, UiSecretSummary, RotationState } from '../types.js';
import type { SecretCache } from './cache.js';
import type { AuditLogger } from './audit.js';

const GATEWAY_VERSION = '1.0.0';

/**
 * Rotation state for the UI, which reports "no policy" as its own thing rather
 * than folding it into `ok`. See UiSecretSummary.
 */
function computeRotationState(updatedAt: string, rotationDays: number | null): RotationState {
  if (rotationDays === null) return 'none';
  return computeRotationStatus(updatedAt, rotationDays);
}

function computeRotationStatus(updatedAt: string, rotationDays: number | null): 'ok' | 'due_soon' | 'overdue' {
  if (rotationDays === null) return 'ok';
  const updatedMs = new Date(updatedAt.endsWith('Z') ? updatedAt : updatedAt + 'Z').getTime();
  const ageDays = (Date.now() - updatedMs) / (1000 * 60 * 60 * 24);
  if (ageDays >= rotationDays) return 'overdue';
  if (ageDays >= rotationDays * 0.8) return 'due_soon';
  return 'ok';
}

export class SecretsService {
  constructor(
    private storage: StorageBackend,
    private encryptionKey: Buffer,
    private cache: SecretCache,
    private audit: AuditLogger,
  ) {}

  getSecret(
    name: string,
    consumerName: string,
    consumerRole: string,
    ip: string,
  ): SecretResponse | { error: string; status: number; message: string } {
    const secret = this.storage.getSecret(name);

    if (!secret) {
      this.audit.log({ consumer: consumerName, action: 'read', secret_name: name, success: 0, ip_address: ip, details: 'not_found' });
      return { error: 'not_found', status: 404, message: `Secret '${name}' not found` };
    }

    // Authorization check
    if (consumerRole !== 'admin' && !secret.consumers.includes(consumerName)) {
      this.audit.log({ consumer: consumerName, action: 'read', secret_name: name, success: 0, ip_address: ip, details: 'access_denied' });
      return { error: 'access_denied', status: 403, message: `Consumer '${consumerName}' does not have access to '${name}'` };
    }

    // Check cache: if hit and version matches, return cached value
    const cached = this.cache.get(name);
    if (cached && cached.version === secret.version) {
      this.audit.log({ consumer: consumerName, action: 'read', secret_name: name, success: 1, ip_address: ip, details: 'cache_hit' });
      return {
        name,
        value: cached.value,
        masked: maskValue(cached.value),
        version: secret.version,
        updated_at: secret.updated_at,
        rotation_status: computeRotationStatus(secret.updated_at, secret.rotation_days),
      };
    }

    // Decrypt
    const value = decrypt(secret.value_enc, secret.iv, secret.auth_tag, this.encryptionKey);

    // Update last_accessed
    this.storage.updateSecret(name, { last_accessed: new Date().toISOString() }, consumerName);

    // Cache the decrypted value
    this.cache.set(name, value, secret.version);

    this.audit.log({ consumer: consumerName, action: 'read', secret_name: name, success: 1, ip_address: ip, details: null });

    return {
      name,
      value,
      masked: maskValue(value),
      version: secret.version,
      updated_at: secret.updated_at,
      rotation_status: computeRotationStatus(secret.updated_at, secret.rotation_days),
    };
  }

  listSecrets(consumerName: string, tag?: string, role?: string): SecretMetadata[] {
    // Admin sees all secrets; regular consumers only their assigned ones (parity with getEnv).
    let secrets = role === 'admin'
      ? this.storage.listAllSecrets()
      : this.storage.listSecrets(consumerName, tag);
    if (role === 'admin' && tag !== undefined) {
      secrets = secrets.filter(s => s.tags.includes(tag));
    }
    return secrets.map(s => ({
      name: s.name,
      description: s.description,
      tags: s.tags,
      consumers: s.consumers,
      version: s.version,
      updated_at: s.updated_at,
      rotation_status: computeRotationStatus(s.updated_at, s.rotation_days),
    }));
  }

  batchGet(
    names: string[],
    consumerName: string,
    consumerRole: string,
    ip: string,
  ): BatchResponse {
    const secrets: SecretResponse[] = [];
    const missing: string[] = [];
    const denied: string[] = [];

    for (const name of names) {
      const result = this.getSecret(name, consumerName, consumerRole, ip);
      if ('error' in result) {
        if (result.error === 'not_found') {
          missing.push(name);
        } else if (result.error === 'access_denied') {
          denied.push(name);
        }
      } else {
        secrets.push(result);
      }
    }

    return { secrets, missing, denied };
  }

  createSecret(
    params: { name: string; value: string; description?: string; consumers: string[]; tags: string[]; rotation_days?: number },
    consumerName: string,
    ip: string,
  ): { name: string; version: number; created_at: string } {
    const { ciphertext, iv, authTag } = encrypt(params.value, this.encryptionKey);
    const secret = this.storage.createSecret({
      name: params.name,
      value_enc: ciphertext,
      iv,
      auth_tag: authTag,
      description: params.description,
      consumers: params.consumers,
      tags: params.tags,
      rotation_days: params.rotation_days,
    });

    this.audit.log({ consumer: consumerName, action: 'create', secret_name: params.name, success: 1, ip_address: ip, details: null });

    return { name: secret.name, version: secret.version, created_at: secret.created_at };
  }

  updateSecret(
    name: string,
    params: { value?: string; description?: string; consumers?: string[]; tags?: string[]; rotation_days?: number },
    consumerName: string,
    ip: string,
  ): { name: string; version: number; updated_at: string } {
    const updateParams: Parameters<StorageBackend['updateSecret']>[1] = {};

    if (params.value !== undefined) {
      const { ciphertext, iv, authTag } = encrypt(params.value, this.encryptionKey);
      updateParams.value_enc = ciphertext;
      updateParams.iv = iv;
      updateParams.auth_tag = authTag;
    }

    if (params.description !== undefined) updateParams.description = params.description;
    if (params.consumers !== undefined) updateParams.consumers = params.consumers;
    if (params.tags !== undefined) updateParams.tags = params.tags;
    if (params.rotation_days !== undefined) updateParams.rotation_days = params.rotation_days;

    const updated = this.storage.updateSecret(name, updateParams, consumerName);

    // Invalidate cache
    this.cache.invalidate(name);

    this.audit.log({ consumer: consumerName, action: 'update', secret_name: name, success: 1, ip_address: ip, details: null });

    return { name: updated.name, version: updated.version, updated_at: updated.updated_at };
  }

  deleteSecret(name: string, consumerName: string, ip: string): void {
    this.storage.deleteSecret(name);
    this.cache.invalidate(name);
    this.audit.log({ consumer: consumerName, action: 'delete', secret_name: name, success: 1, ip_address: ip, details: null });
  }

  getEnv(
    consumerName: string,
    consumerRole: string,
    opts: { tag?: string; names?: string[] },
  ): string {
    // Admin gets all secrets; regular consumers only get their assigned secrets
    let secrets = consumerRole === 'admin'
      ? this.storage.listAllSecrets()
      : this.storage.listSecrets(consumerName, opts.tag);

    // For admin, apply tag filter manually if provided
    if (consumerRole === 'admin' && opts.tag) {
      secrets = secrets.filter(s => s.tags.includes(opts.tag!));
    }

    // Filter by names if provided
    const filtered = opts.names ? secrets.filter(s => opts.names!.includes(s.name)) : secrets;

    const lines: string[] = [];
    for (const secret of filtered) {
      const result = this.getSecret(secret.name, consumerName, consumerRole, 'internal');
      if (!('error' in result)) {
        lines.push(`${secret.name}=${result.value}`);
      }
    }

    return lines.join('\n') + (lines.length > 0 ? '\n' : '');
  }

  rotationReport(): { due: RotationReportEntry[]; overdue: RotationReportEntry[]; ok: RotationReportEntry[] } {
    const allSecrets = this.storage.listAllSecrets();

    const due: RotationReportEntry[] = [];
    const overdue: RotationReportEntry[] = [];
    const ok: RotationReportEntry[] = [];

    const now = Date.now();

    for (const { name, updated_at: updatedAt, rotation_days: rotationDays } of allSecrets) {
      if (rotationDays === null) continue; // Skip secrets without rotation policy

      const updatedMs = new Date(updatedAt.endsWith('Z') ? updatedAt : updatedAt + 'Z').getTime();
      const ageDays = (now - updatedMs) / (1000 * 60 * 60 * 24);

      const entry: RotationReportEntry = {
        name,
        age_days: Math.floor(ageDays * 10) / 10,
        rotation_days: rotationDays,
        status: 'ok',
      };

      if (ageDays >= rotationDays) {
        entry.status = 'overdue';
        overdue.push(entry);
      } else if (ageDays >= rotationDays * 0.8) {
        entry.status = 'due_soon';
        due.push(entry);
      } else {
        entry.status = 'ok';
        ok.push(entry);
      }
    }

    return { due, overdue, ok };
  }

  getHistory(name: string): { name: string; current_version: number; history: Array<{ version: number; changed_at: string; changed_by: string }> } {
    const secret = this.storage.getSecret(name);
    const current_version = secret?.version ?? 0;
    const history = this.storage.getSecretHistory(name);

    return {
      name,
      current_version,
      history: history.map(h => ({
        version: h.version,
        changed_at: h.changed_at,
        changed_by: h.changed_by,
      })),
    };
  }

  getVersion(
    name: string,
    version: number,
    consumerName: string,
    consumerRole: string,
    ip: string,
  ): SecretResponse | { error: string; status: number; message: string } {
    const histEntry = this.storage.getSecretVersion(name, version);

    if (!histEntry) {
      this.audit.log({ consumer: consumerName, action: 'read', secret_name: name, success: 0, ip_address: ip, details: `version ${version} not found` });
      return { error: 'not_found', status: 404, message: `Version ${version} of secret '${name}' not found` };
    }

    // Authorization: check against current secret's consumers list
    if (consumerRole !== 'admin') {
      const current = this.storage.getSecret(name);
      if (!current || !current.consumers.includes(consumerName)) {
        this.audit.log({ consumer: consumerName, action: 'read', secret_name: name, success: 0, ip_address: ip, details: 'access_denied' });
        return { error: 'access_denied', status: 403, message: `Consumer '${consumerName}' does not have access to '${name}'` };
      }
    }

    const value = decrypt(histEntry.value_enc, histEntry.iv, histEntry.auth_tag, this.encryptionKey);

    this.audit.log({ consumer: consumerName, action: 'read', secret_name: name, success: 1, ip_address: ip, details: `version ${version}` });

    return {
      name,
      value,
      masked: maskValue(value),
      version,
      updated_at: histEntry.changed_at,
      is_current: false,
    };
  }

  /**
   * The browser UI's secret list.
   *
   * Separate from listSecrets because the UI needs to tell "no rotation policy"
   * apart from "policy set and healthy". computeRotationStatus collapses both
   * into `ok`, so an unwatched secret renders exactly like a checked one — and
   * most secrets have no policy, which makes the reassurance actively
   * misleading. The REST API's shape is deliberately left alone.
   *
   * Carries no values and no masks: browsing decrypts nothing.
   */
  listSecretsForUi(consumerName: string, tag?: string): UiSecretSummary[] {
    let secrets = this.storage.listAllSecrets();
    if (tag !== undefined) secrets = secrets.filter(s => s.tags.includes(tag));

    return secrets.map(s => ({
      name: s.name,
      description: s.description,
      tags: s.tags,
      consumers: s.consumers,
      version: s.version,
      updated_at: s.updated_at,
      rotation_days: s.rotation_days,
      rotation_state: computeRotationState(s.updated_at, s.rotation_days),
    }));
  }

  /**
   * Metadata plus a masked preview, for the browser UI's detail view.
   *
   * Computing the mask needs the plaintext, so this genuinely is a read and is
   * audit-logged as one. The plaintext never leaves this method — callers get
   * `masked` only, so no UI response body can carry a secret value.
   */
  getUiDetail(
    name: string,
    consumerName: string,
    ip: string,
  ): UiSecretDetail | { error: string; status: number; message: string } {
    const secret = this.storage.getSecret(name);

    if (!secret) {
      this.audit.log({ consumer: consumerName, action: 'read', secret_name: name, success: 0, ip_address: ip, details: 'not_found' });
      return { error: 'not_found', status: 404, message: `Secret '${name}' not found` };
    }

    const value = decrypt(secret.value_enc, secret.iv, secret.auth_tag, this.encryptionKey);

    this.audit.log({ consumer: consumerName, action: 'read', secret_name: name, success: 1, ip_address: ip, details: 'ui_detail' });

    return {
      name: secret.name,
      description: secret.description,
      tags: secret.tags,
      consumers: secret.consumers,
      version: secret.version,
      created_at: secret.created_at,
      updated_at: secret.updated_at,
      rotation_days: secret.rotation_days,
      rotation_status: computeRotationStatus(secret.updated_at, secret.rotation_days),
      rotation_state: computeRotationState(secret.updated_at, secret.rotation_days),
      masked: maskValue(value),
      history: this.storage.getSecretHistory(name).map(h => ({
        version: h.version,
        changed_at: h.changed_at,
        changed_by: h.changed_by,
      })),
    };
  }

  /**
   * Record a non-secret event (a UI login failure) on the shared audit trail so
   * the configured alerts fire for the UI as they do for the API.
   */
  logUiEvent(entry: Parameters<AuditLogger['log']>[0]): void {
    this.audit.log(entry);
  }

  getAuditLog(opts: { limit?: number; consumer?: string; since?: string }) {
    return this.storage.getAuditLog(opts);
  }

  refreshCache(): void {
    this.cache.clear();
  }

  getStatus(dbPath: string, cacheTtl: number, tlsEnabled: boolean, startTime: number): GatewayStatus {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const secretCount = this.storage.getSecretCount();
    const consumerCount = this.storage.getConsumerCount();
    const auditCount = this.storage.getAuditCount24h();
    const cacheStats = this.cache.stats();

    let dbSizeBytes = 0;
    try {
      dbSizeBytes = this.storage.getDatabaseSizeBytes();
    } catch {
      // ignore
    }

    return {
      uptime_seconds: uptimeSeconds,
      version: GATEWAY_VERSION,
      tls_enabled: tlsEnabled,
      secrets: {
        total: secretCount.total,
        rotation_ok: secretCount.rotationOk,
        rotation_due_soon: secretCount.rotationDueSoon,
        rotation_overdue: secretCount.rotationOverdue,
      },
      consumers: {
        total: consumerCount.total,
        active: consumerCount.active,
        expired: consumerCount.expired,
      },
      cache: {
        entries: cacheStats.entries,
        hit_rate_percent: Math.round(cacheStats.hitRatePercent * 10) / 10,
        ttl_seconds: cacheTtl,
      },
      audit: {
        total_events_24h: auditCount.total,
        auth_failures_24h: auditCount.authFailures,
      },
      database: {
        size_bytes: dbSizeBytes,
        path: dbPath,
      },
    };
  }
}
