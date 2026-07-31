import type { Secret, Consumer, AuditEntry, SecretHistory, UiCredential, UiSession } from '../types.js';

export interface CreateSecretParams {
  name: string;
  value_enc: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  description?: string;
  consumers: string[];
  tags: string[];
  rotation_days?: number;
}

export interface UpdateSecretParams {
  value_enc?: Buffer;
  iv?: Buffer;
  auth_tag?: Buffer;
  description?: string;
  consumers?: string[];
  tags?: string[];
  rotation_days?: number;
  last_accessed?: string;
}

export interface StorageBackend {
  // Secrets
  getSecret(name: string): Secret | undefined;
  listSecrets(consumerName: string, tag?: string): Secret[];
  listAllSecrets(): Secret[];
  createSecret(params: CreateSecretParams): Secret;
  updateSecret(name: string, params: UpdateSecretParams, changedBy: string): Secret;
  deleteSecret(name: string): void;
  getSecretHistory(name: string): SecretHistory[];
  getSecretVersion(name: string, version: number): SecretHistory | undefined;

  // Consumers
  getConsumerByKeyHash(keyHash: string): Consumer | undefined;
  getConsumerByName(name: string): Consumer | undefined;
  createConsumer(name: string, apiKeyHash: string, role: 'reader' | 'admin', description?: string, expiresAt?: string): Consumer;
  listConsumers(): Consumer[];
  revokeConsumer(name: string): void;
  rotateConsumerKey(name: string, newKeyHash: string, expiresAt?: string): Consumer;

  // Audit
  logAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void;
  getAuditLog(opts: { limit?: number; consumer?: string; since?: string }): AuditEntry[];
  getAuditCount24h(): { total: number; authFailures: number };

  // UI credentials
  getUiCredential(name: string): UiCredential | undefined;
  setUiCredential(name: string, passwordHash: string): void;
  countUiCredentials(): number;

  // UI sessions. Timestamps are ISO-8601 UTC supplied by the caller.
  createUiSession(tokenHash: string, uiUser: string, expiresAt: string, now: string): void;
  getUiSession(tokenHash: string): UiSession | undefined;
  touchUiSession(tokenHash: string, now: string): void;
  deleteUiSession(tokenHash: string): void;
  deleteExpiredUiSessions(now: string): void;

  // Metadata
  getSalt(): Buffer;
  setSalt(salt: Buffer): void;
  getSecretCount(): { total: number; rotationOk: number; rotationDueSoon: number; rotationOverdue: number };
  getConsumerCount(): { total: number; active: number; expired: number };
  getDatabaseSizeBytes(): number;

  close(): void;
}
