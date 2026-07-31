import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import type { Secret, Consumer, AuditEntry, SecretHistory, UiCredential, UiSession } from '../types.js';
import type { StorageBackend, CreateSecretParams, UpdateSecretParams } from './interface.js';

interface RawSecret {
  id: string;
  name: string;
  value_enc: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  description: string | null;
  consumers: string;
  tags: string;
  rotation_days: number | null;
  created_at: string;
  updated_at: string;
  last_accessed: string | null;
  version: number;
}

interface RawConsumer {
  id: string;
  name: string;
  api_key_hash: string;
  role: 'reader' | 'admin';
  description: string | null;
  is_active: number;
  expires_at: string | null;
  created_at: string;
}

interface RawAuditEntry {
  id: number;
  timestamp: string;
  consumer: string;
  action: string;
  secret_name: string | null;
  success: number;
  ip_address: string | null;
  details: string | null;
}

interface RawSecretHistory {
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

function parseSecret(row: RawSecret): Secret {
  return {
    ...row,
    consumers: JSON.parse(row.consumers) as string[],
    tags: JSON.parse(row.tags) as string[],
  };
}

export class SqliteStorage implements StorageBackend {
  private db: Database.Database;
  private dbPath: string;
  private maxHistory: number;

  constructor(dbPath: string, maxHistory = 10) {
    this.dbPath = dbPath;
    this.maxHistory = maxHistory;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS secrets (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT NOT NULL UNIQUE,
        value_enc BLOB NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        description TEXT,
        consumers TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        rotation_days INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed TEXT,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS consumers (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT NOT NULL UNIQUE,
        api_key_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'reader',
        description TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        consumer TEXT NOT NULL,
        action TEXT NOT NULL,
        secret_name TEXT,
        success INTEGER NOT NULL DEFAULT 1,
        ip_address TEXT,
        details TEXT
      );

      CREATE TABLE IF NOT EXISTS secret_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        secret_id TEXT NOT NULL,
        secret_name TEXT NOT NULL,
        value_enc BLOB NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        version INTEGER NOT NULL,
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        changed_by TEXT NOT NULL,
        FOREIGN KEY (secret_id) REFERENCES secrets(id) ON DELETE CASCADE
      );

      -- Browser UI login. Deliberately separate from the consumers table: a UI
      -- operator authenticates with a password and never holds an API key.
      CREATE TABLE IF NOT EXISTS ui_credentials (
        name          TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Only the sha256 of a session token is stored, so a database read does
      -- not yield usable sessions.
      CREATE TABLE IF NOT EXISTS ui_sessions (
        token_hash TEXT PRIMARY KEY,
        ui_user    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  // ── Secrets ──────────────────────────────────────────────────────────────

  getSecret(name: string): Secret | undefined {
    const stmt = this.db.prepare<[string], RawSecret>('SELECT * FROM secrets WHERE name = ?');
    const row = stmt.get(name);
    return row ? parseSecret(row) : undefined;
  }

  listSecrets(consumerName: string, tag?: string): Secret[] {
    const stmt = this.db.prepare<[], RawSecret>('SELECT * FROM secrets');
    const rows = stmt.all();
    return rows
      .map(parseSecret)
      .filter(s => s.consumers.includes(consumerName))
      .filter(s => tag === undefined || s.tags.includes(tag));
  }

  listAllSecrets(): Secret[] {
    const stmt = this.db.prepare<[], RawSecret>('SELECT * FROM secrets');
    return stmt.all().map(parseSecret);
  }

  createSecret(params: CreateSecretParams): Secret {
    const stmt = this.db.prepare(`
      INSERT INTO secrets (name, value_enc, iv, auth_tag, description, consumers, tags, rotation_days)
      VALUES (@name, @value_enc, @iv, @auth_tag, @description, @consumers, @tags, @rotation_days)
    `);
    stmt.run({
      name: params.name,
      value_enc: params.value_enc,
      iv: params.iv,
      auth_tag: params.auth_tag,
      description: params.description ?? null,
      consumers: JSON.stringify(params.consumers),
      tags: JSON.stringify(params.tags),
      rotation_days: params.rotation_days ?? null,
    });
    return this.getSecret(params.name)!;
  }

  updateSecret(name: string, params: UpdateSecretParams, changedBy: string): Secret {
    const current = this.getSecret(name);
    if (!current) throw new Error(`Secret not found: ${name}`);

    const hasNewValue = params.value_enc !== undefined;

    if (hasNewValue) {
      // Archive current row to history
      const archiveStmt = this.db.prepare(`
        INSERT INTO secret_history (secret_id, secret_name, value_enc, iv, auth_tag, version, changed_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      archiveStmt.run(current.id, current.name, current.value_enc, current.iv, current.auth_tag, current.version, changedBy);

      // Cap history at maxHistory
      const countStmt = this.db.prepare<[string], { cnt: number }>(
        'SELECT COUNT(*) as cnt FROM secret_history WHERE secret_name = ?'
      );
      const { cnt } = countStmt.get(name)!;
      if (cnt > this.maxHistory) {
        const deleteOldestStmt = this.db.prepare(`
          DELETE FROM secret_history WHERE id IN (
            SELECT id FROM secret_history WHERE secret_name = ? ORDER BY version ASC LIMIT ?
          )
        `);
        deleteOldestStmt.run(name, cnt - this.maxHistory);
      }

      // Build UPDATE fields for value update (always increments version)
      const setClauses: string[] = [
        'value_enc = @value_enc',
        'iv = @iv',
        'auth_tag = @auth_tag',
        'version = version + 1',
        "updated_at = datetime('now')",
      ];
      const updateValues: Record<string, unknown> = {
        name,
        value_enc: params.value_enc,
        iv: params.iv,
        auth_tag: params.auth_tag,
      };

      if (params.description !== undefined) {
        setClauses.push('description = @description');
        updateValues.description = params.description;
      }
      if (params.consumers !== undefined) {
        setClauses.push('consumers = @consumers');
        updateValues.consumers = JSON.stringify(params.consumers);
      }
      if (params.tags !== undefined) {
        setClauses.push('tags = @tags');
        updateValues.tags = JSON.stringify(params.tags);
      }
      if (params.rotation_days !== undefined) {
        setClauses.push('rotation_days = @rotation_days');
        updateValues.rotation_days = params.rotation_days;
      }

      const updateStmt = this.db.prepare(
        `UPDATE secrets SET ${setClauses.join(', ')} WHERE name = @name`
      );
      updateStmt.run(updateValues);
    } else {
      // Metadata-only update: no version bump, no history archiving
      const setClauses: string[] = [];
      const updateValues: Record<string, unknown> = { name };

      if (params.description !== undefined) {
        setClauses.push('description = @description');
        updateValues.description = params.description;
      }
      if (params.consumers !== undefined) {
        setClauses.push('consumers = @consumers');
        updateValues.consumers = JSON.stringify(params.consumers);
      }
      if (params.tags !== undefined) {
        setClauses.push('tags = @tags');
        updateValues.tags = JSON.stringify(params.tags);
      }
      if (params.rotation_days !== undefined) {
        setClauses.push('rotation_days = @rotation_days');
        updateValues.rotation_days = params.rotation_days;
      }
      if (params.last_accessed !== undefined) {
        setClauses.push('last_accessed = @last_accessed');
        updateValues.last_accessed = params.last_accessed;
      }

      if (setClauses.length > 0) {
        const updateStmt = this.db.prepare(
          `UPDATE secrets SET ${setClauses.join(', ')} WHERE name = @name`
        );
        updateStmt.run(updateValues);
      }
    }

    return this.getSecret(name)!;
  }

  deleteSecret(name: string): void {
    this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
  }

  getSecretHistory(name: string): SecretHistory[] {
    const stmt = this.db.prepare<[string], RawSecretHistory>(
      'SELECT * FROM secret_history WHERE secret_name = ? ORDER BY version DESC'
    );
    return stmt.all(name);
  }

  getSecretVersion(name: string, version: number): SecretHistory | undefined {
    const stmt = this.db.prepare<[string, number], RawSecretHistory>(
      'SELECT * FROM secret_history WHERE secret_name = ? AND version = ?'
    );
    return stmt.get(name, version) ?? undefined;
  }

  // ── Consumers ─────────────────────────────────────────────────────────────

  getConsumerByKeyHash(keyHash: string): Consumer | undefined {
    const stmt = this.db.prepare<[string], RawConsumer>(
      'SELECT * FROM consumers WHERE api_key_hash = ?'
    );
    const row = stmt.get(keyHash);
    return row ?? undefined;
  }

  getConsumerByName(name: string): Consumer | undefined {
    const stmt = this.db.prepare<[string], RawConsumer>(
      'SELECT * FROM consumers WHERE name = ?'
    );
    const row = stmt.get(name);
    return row ?? undefined;
  }

  createConsumer(
    name: string,
    apiKeyHash: string,
    role: 'reader' | 'admin',
    description?: string,
    expiresAt?: string,
  ): Consumer {
    const stmt = this.db.prepare(`
      INSERT INTO consumers (name, api_key_hash, role, description, expires_at)
      VALUES (@name, @api_key_hash, @role, @description, @expires_at)
    `);
    stmt.run({
      name,
      api_key_hash: apiKeyHash,
      role,
      description: description ?? null,
      expires_at: expiresAt ?? null,
    });
    return this.getConsumerByName(name)!;
  }

  listConsumers(): Consumer[] {
    const stmt = this.db.prepare<[], RawConsumer>('SELECT * FROM consumers');
    return stmt.all();
  }

  revokeConsumer(name: string): void {
    this.db.prepare('UPDATE consumers SET is_active = 0 WHERE name = ?').run(name);
  }

  rotateConsumerKey(name: string, newKeyHash: string, expiresAt?: string): Consumer {
    if (expiresAt !== undefined) {
      this.db.prepare(
        'UPDATE consumers SET api_key_hash = ?, expires_at = ? WHERE name = ?'
      ).run(newKeyHash, expiresAt, name);
    } else {
      this.db.prepare(
        'UPDATE consumers SET api_key_hash = ? WHERE name = ?'
      ).run(newKeyHash, name);
    }
    return this.getConsumerByName(name)!;
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  logAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    this.db.prepare(`
      INSERT INTO audit_log (consumer, action, secret_name, success, ip_address, details)
      VALUES (@consumer, @action, @secret_name, @success, @ip_address, @details)
    `).run(entry);
  }

  getAuditLog(opts: { limit?: number; consumer?: string; since?: string }): AuditEntry[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.consumer !== undefined) {
      conditions.push('consumer = @consumer');
      params.consumer = opts.consumer;
    }
    if (opts.since !== undefined) {
      conditions.push('timestamp >= @since');
      params.since = opts.since;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit !== undefined ? `LIMIT ${opts.limit}` : '';

    const stmt = this.db.prepare<Record<string, unknown>, RawAuditEntry>(
      `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC ${limit}`
    );
    return stmt.all(params) as AuditEntry[];
  }

  getAuditCount24h(): { total: number; authFailures: number } {
    const totalRow = this.db.prepare<[], { cnt: number }>(
      "SELECT COUNT(*) as cnt FROM audit_log WHERE timestamp >= datetime('now', '-24 hours')"
    ).get()!;
    const failuresRow = this.db.prepare<[], { cnt: number }>(
      "SELECT COUNT(*) as cnt FROM audit_log WHERE timestamp >= datetime('now', '-24 hours') AND action = 'auth_failure'"
    ).get()!;
    return { total: totalRow.cnt, authFailures: failuresRow.cnt };
  }

  // ── Metadata ──────────────────────────────────────────────────────────────

  getSalt(): Buffer {
    const row = this.db.prepare<[string], { value: Buffer }>(
      'SELECT value FROM metadata WHERE key = ?'
    ).get('argon2_salt');
    if (!row) throw new Error('Salt not set');
    return row.value;
  }

  setSalt(salt: Buffer): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)'
    ).run('argon2_salt', salt);
  }

  getSecretCount(): { total: number; rotationOk: number; rotationDueSoon: number; rotationOverdue: number } {
    const rows = this.db.prepare<[], RawSecret>('SELECT * FROM secrets').all();
    const now = Date.now();
    let rotationOk = 0;
    let rotationDueSoon = 0;
    let rotationOverdue = 0;

    for (const row of rows) {
      if (row.rotation_days === null) {
        rotationOk++;
        continue;
      }
      const updatedAt = new Date(row.updated_at + 'Z').getTime();
      const ageDays = (now - updatedAt) / (1000 * 60 * 60 * 24);
      const rotationDays = row.rotation_days;
      if (ageDays >= rotationDays) {
        rotationOverdue++;
      } else if (ageDays >= rotationDays * 0.8) {
        rotationDueSoon++;
      } else {
        rotationOk++;
      }
    }

    return { total: rows.length, rotationOk, rotationDueSoon, rotationOverdue };
  }

  getConsumerCount(): { total: number; active: number; expired: number } {
    const rows = this.db.prepare<[], RawConsumer>('SELECT * FROM consumers').all();
    const now = new Date().toISOString();
    let active = 0;
    let expired = 0;

    for (const row of rows) {
      if (row.is_active === 0) {
        expired++;
      } else if (row.expires_at !== null && row.expires_at < now) {
        expired++;
      } else {
        active++;
      }
    }

    return { total: rows.length, active, expired };
  }

  getDatabaseSizeBytes(): number {
    try {
      return statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }

  // ── UI credentials ───────────────────────────────────────────────────────

  getUiCredential(name: string): UiCredential | undefined {
    const stmt = this.db.prepare<[string], UiCredential>(
      'SELECT name, password_hash FROM ui_credentials WHERE name = ?',
    );
    return stmt.get(name);
  }

  setUiCredential(name: string, passwordHash: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO ui_credentials (name, password_hash)
      VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET
        password_hash = excluded.password_hash,
        updated_at = datetime('now')
    `);
    stmt.run(name, passwordHash);
  }

  countUiCredentials(): number {
    const stmt = this.db.prepare<[], { cnt: number }>('SELECT COUNT(*) as cnt FROM ui_credentials');
    return stmt.get()!.cnt;
  }

  // ── UI sessions ──────────────────────────────────────────────────────────

  // Timestamps are supplied by the caller as ISO-8601 UTC rather than taken from
  // SQLite's own clock. Session lifetime logic then lives in one place, and it
  // stays observable to tests that control time.

  createUiSession(tokenHash: string, uiUser: string, expiresAt: string, now: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO ui_sessions (token_hash, ui_user, expires_at, created_at, last_seen)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(tokenHash, uiUser, expiresAt, now, now);
  }

  getUiSession(tokenHash: string): UiSession | undefined {
    const stmt = this.db.prepare<[string], UiSession>(
      'SELECT token_hash, ui_user, expires_at, last_seen FROM ui_sessions WHERE token_hash = ?',
    );
    return stmt.get(tokenHash);
  }

  touchUiSession(tokenHash: string, now: string): void {
    this.db.prepare('UPDATE ui_sessions SET last_seen = ? WHERE token_hash = ?').run(now, tokenHash);
  }

  deleteUiSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM ui_sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteExpiredUiSessions(now: string): void {
    this.db.prepare('DELETE FROM ui_sessions WHERE expires_at <= ?').run(now);
  }

  close(): void {
    this.db.close();
  }
}
