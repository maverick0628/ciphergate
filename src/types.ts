export interface Secret {
  id: string;
  name: string;
  value_enc: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  description: string | null;
  consumers: string[];
  tags: string[];
  rotation_days: number | null;
  created_at: string;
  updated_at: string;
  last_accessed: string | null;
  version: number;
}

export interface SecretMetadata {
  name: string;
  description: string | null;
  tags: string[];
  consumers: string[];
  version: number;
  updated_at: string;
  rotation_status: 'ok' | 'due_soon' | 'overdue';
}

export interface SecretResponse {
  name: string;
  value: string;
  masked: string;
  version: number;
  updated_at: string;
  is_current?: boolean;
  rotation_status?: string;
}

export interface Consumer {
  id: string;
  name: string;
  api_key_hash: string;
  role: 'reader' | 'admin';
  description: string | null;
  is_active: number;
  expires_at: string | null;
  created_at: string;
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  consumer: string;
  action: 'read' | 'create' | 'update' | 'delete' | 'list' | 'auth_failure' | 'rotation_warning';
  secret_name: string | null;
  success: number;
  ip_address: string | null;
  details: string | null;
}

export interface SecretHistory {
  id: number;
  secret_id: string;
  secret_name: string;
  value_enc: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  version: number;
  changed_at: string;
  changed_by: string;
}

export interface CacheEntry {
  value: string;
  version: number;
  expires_at: number;
}

export interface BatchResponse {
  secrets: SecretResponse[];
  missing: string[];
  denied: string[];
}

export interface RotationReportEntry {
  name: string;
  age_days: number;
  rotation_days: number;
  status: 'ok' | 'due_soon' | 'overdue';
}

export interface GatewayStatus {
  uptime_seconds: number;
  version: string;
  tls_enabled: boolean;
  secrets: {
    total: number;
    rotation_ok: number;
    rotation_due_soon: number;
    rotation_overdue: number;
  };
  consumers: {
    total: number;
    active: number;
    expired: number;
  };
  cache: {
    entries: number;
    hit_rate_percent: number;
    ttl_seconds: number;
  };
  audit: {
    total_events_24h: number;
    auth_failures_24h: number;
  };
  database: {
    size_bytes: number;
    path: string;
  };
}

/** A browser-UI login credential. The hash is argon2id; the plaintext is never stored. */
export interface UiCredential {
  name: string;
  password_hash: string;
}

/** A browser-UI session. `token_hash` is the sha256 of the cookie value. */
export interface UiSession {
  token_hash: string;
  ui_user: string;
  expires_at: string;
  last_seen: string;
}

/**
 * What the browser UI's detail view receives. Carries `masked` and never a
 * plaintext value — no UI response body should be able to leak a secret.
 */
export interface UiSecretDetail {
  name: string;
  description: string | null;
  tags: string[];
  consumers: string[];
  version: number;
  created_at: string;
  updated_at: string;
  rotation_days: number | null;
  rotation_status: 'ok' | 'due_soon' | 'overdue';
  /**
   * Like rotation_status, but distinguishes "no policy" from "healthy".
   * computeRotationStatus reports `ok` for a null policy, which makes an
   * unwatched secret look identical to a checked one.
   */
  rotation_state: RotationState;
  masked: string;
  history: Array<{ version: number; changed_at: string; changed_by: string }>;
}

/**
 * Rotation state for the browser UI.
 *
 * `none` means no rotation policy is set, so nothing is being checked. The REST
 * API's `rotation_status` collapses this into `ok`, which reads as reassurance
 * the gateway has not earned.
 */
export type RotationState = 'none' | 'ok' | 'due_soon' | 'overdue';

/** One row of the UI's secret list. Carries no value and no mask. */
export interface UiSecretSummary {
  name: string;
  description: string | null;
  tags: string[];
  consumers: string[];
  version: number;
  updated_at: string;
  rotation_days: number | null;
  rotation_state: RotationState;
}
