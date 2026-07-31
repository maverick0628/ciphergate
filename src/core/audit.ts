import type { AuditEntry } from '../types.js';
import type { StorageBackend } from '../storage/interface.js';

/**
 * Internal severity scale used for the per-event threshold check.
 * This is independent of the Pushover wire priority — it only drives
 * `minSeverity` filtering, then maps to a Pushover priority at send time.
 */
export type AlertSeverity = 'min' | 'low' | 'default' | 'high' | 'max';

/** Pushover wire priority. -2 silent, -1 quiet, 0 normal, 1 high, 2 emergency. */
type PushoverPriority = -1 | 0 | 1 | 2;

const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json';

/**
 * Configuration for audit event notifications.
 *
 * Every audit event gets logged to the SQLite audit table unconditionally.
 * This config only controls which events push to Pushover and at what priority.
 */
export interface PushoverConfig {
  enabled: boolean;
  /** Pushover application token */
  appToken: string;
  /** Pushover user (or group) key */
  userKey: string;

  /** Event-type toggles — defaults are tuned for a quiet homelab */
  alertAuthFailure?: boolean;       // default: true
  alertDelete?: boolean;            // default: true
  alertUpdate?: boolean;            // default: true
  alertCreate?: boolean;            // default: false (create is normal operation)
  alertRead?: boolean;              // default: false (reads are noisy)
  alertList?: boolean;              // default: false (enumeration is noisy)
  alertRotationWarning?: boolean;   // default: true

  /**
   * Minimum severity threshold — events below this are silently dropped.
   * Useful for "quiet mode" where you only want high-priority alerts.
   */
  minSeverity?: AlertSeverity;

  /** Rate limit: max notifications per window */
  rateLimitMax?: number;            // default: 10
  /** Rate limit window in seconds */
  rateLimitWindowSec?: number;      // default: 60
}

interface Notification {
  title: string;
  message: string;
  severity: AlertSeverity;
  tags: string[];
}

const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  min: 1,
  low: 2,
  default: 3,
  high: 4,
  max: 5,
};

/**
 * Map the internal severity scale to a Pushover wire priority.
 * High-severity events (auth_failure, secret delete, rotation overdue) ride
 * at priority 1 so they bypass quiet hours; everything else is normal (0).
 */
function toPushoverPriority(severity: AlertSeverity): PushoverPriority {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER.high ? 1 : 0;
}

export class AuditLogger {
  private readonly config: Required<PushoverConfig>;
  private readonly rateLimitBuckets: number[] = [];

  constructor(
    private storage: StorageBackend,
    pushoverConfig: PushoverConfig,
  ) {
    // Resolve defaults for optional fields
    this.config = {
      enabled: pushoverConfig.enabled,
      appToken: pushoverConfig.appToken,
      userKey: pushoverConfig.userKey,
      alertAuthFailure: pushoverConfig.alertAuthFailure ?? true,
      alertDelete: pushoverConfig.alertDelete ?? true,
      alertUpdate: pushoverConfig.alertUpdate ?? true,
      alertCreate: pushoverConfig.alertCreate ?? false,
      alertRead: pushoverConfig.alertRead ?? false,
      alertList: pushoverConfig.alertList ?? false,
      alertRotationWarning: pushoverConfig.alertRotationWarning ?? true,
      minSeverity: pushoverConfig.minSeverity ?? 'default',
      rateLimitMax: pushoverConfig.rateLimitMax ?? 10,
      rateLimitWindowSec: pushoverConfig.rateLimitWindowSec ?? 60,
    };
  }

  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    // Sanitize details to never contain secret values
    const sanitized = {
      ...entry,
      details: entry.details ? this.sanitizeDetails(entry.details) : null,
    };
    this.storage.logAudit(sanitized);
    // Fire-and-forget Pushover notification
    this.maybeNotify(sanitized);
  }

  private sanitizeDetails(details: string): string {
    // Strip anything that looks like a secret value (long alphanumeric strings)
    return details.replace(/\b[A-Za-z0-9_-]{12,}\b/g, (match) => {
      // Preserve common identifiers/timestamps, mask everything else
      if (/^\d{4}-\d{2}/.test(match)) return match; // ISO dates
      if (match.length < 12) return match;
      return `${match.slice(0, 4)}...${match.slice(-4)}`;
    });
  }

  private maybeNotify(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    if (!this.config.enabled || !this.config.appToken || !this.config.userKey) return;

    const notification = this.buildNotification(entry);
    if (!notification) return;

    // Severity threshold check — drop anything below minSeverity
    if (SEVERITY_ORDER[notification.severity] < SEVERITY_ORDER[this.config.minSeverity]) {
      return;
    }

    // Rate limiting — sliding window
    if (this.isRateLimited()) {
      // Drop silently; the event is still in the audit table
      return;
    }

    this.sendPushover(notification);
  }

  /**
   * Sliding-window rate limiter. Returns true if this notification should
   * be dropped because we've already sent rateLimitMax in the last window.
   */
  private isRateLimited(): boolean {
    const now = Date.now();
    const windowMs = this.config.rateLimitWindowSec * 1000;
    const cutoff = now - windowMs;

    // Drop timestamps outside the window
    while (this.rateLimitBuckets.length > 0 && this.rateLimitBuckets[0] < cutoff) {
      this.rateLimitBuckets.shift();
    }

    if (this.rateLimitBuckets.length >= this.config.rateLimitMax) {
      return true;
    }

    this.rateLimitBuckets.push(now);
    return false;
  }

  private sendPushover(n: Notification): void {
    const body = new URLSearchParams({
      token: this.config.appToken,
      user: this.config.userKey,
      title: n.title,
      message: n.message,
      priority: String(toPushoverPriority(n.severity)),
    });

    fetch(PUSHOVER_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }).catch(() => {
      // Pushover errors should never crash the gateway
    });
  }

  private buildNotification(
    entry: Omit<AuditEntry, 'id' | 'timestamp'>,
  ): Notification | null {
    const actor = entry.consumer || 'unknown';
    const secret = entry.secret_name || 'unknown';
    const from = entry.ip_address ? ` from ${entry.ip_address}` : '';

    switch (entry.action) {
      case 'auth_failure':
        if (!this.config.alertAuthFailure) return null;
        return {
          title: 'CipherGate — Auth failure',
          message: `Consumer '${actor}' failed authentication${from}`,
          severity: 'high',
          tags: ['warning', 'lock', 'ciphergate'],
        };

      case 'delete':
        if (!this.config.alertDelete) return null;
        return {
          title: 'CipherGate — Secret deleted',
          message: `Secret '${secret}' deleted by ${actor}${from}`,
          severity: 'high',
          tags: ['wastebasket', 'key', 'ciphergate'],
        };

      case 'update':
        if (!this.config.alertUpdate) return null;
        return {
          title: 'CipherGate — Secret rotated',
          message: `Secret '${secret}' updated by ${actor}${from}`,
          severity: 'default',
          tags: ['arrows_counterclockwise', 'key', 'ciphergate'],
        };

      case 'create':
        if (!this.config.alertCreate) return null;
        return {
          title: 'CipherGate — New secret',
          message: `Secret '${secret}' created by ${actor}${from}`,
          severity: 'low',
          tags: ['sparkles', 'key', 'ciphergate'],
        };

      case 'read':
        if (!this.config.alertRead) return null;
        return {
          title: 'CipherGate — Secret accessed',
          message: `Secret '${secret}' read by ${actor}${from}`,
          severity: 'min',
          tags: ['eyes', 'key', 'ciphergate'],
        };

      case 'list':
        if (!this.config.alertList) return null;
        return {
          title: 'CipherGate — List enumeration',
          message: `Consumer '${actor}' listed secrets${from}`,
          severity: 'low',
          tags: ['clipboard', 'ciphergate'],
        };

      case 'rotation_warning':
        if (!this.config.alertRotationWarning) return null;
        return {
          title: 'CipherGate — Rotation overdue',
          message: `Secret '${secret}' is overdue for rotation`,
          severity: 'high',
          tags: ['warning', 'hourglass', 'ciphergate'],
        };

      default:
        return null;
    }
  }
}
