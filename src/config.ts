import type { AlertSeverity } from './core/audit.js';

export interface GatewayConfig {
  dbPath: string;
  keyfilePath: string;
  port: number;
  host: string;
  cacheTtl: number;
  pushoverEnabled: boolean;
  pushoverAppToken: string | null;
  pushoverUserKey: string | null;
  // Audit alert toggles
  alertAuthFailure: boolean;
  alertDelete: boolean;
  alertUpdate: boolean;
  alertCreate: boolean;
  alertRead: boolean;
  alertList: boolean;
  alertRotationWarning: boolean;
  alertMinSeverity: AlertSeverity;
  alertRateLimitMax: number;
  alertRateLimitWindowSec: number;
  logLevel: string;
  rateLimitEnabled: boolean;
  maxHistory: number;
  tlsEnabled: boolean;
  tlsCert: string | null;
  tlsKey: string | null;
  // Browser UI. Its own listener, so it can be firewalled independently of the
  // API and so consumers on the API port never see the login route.
  uiEnabled: boolean;
  uiPort: number;
  uiHost: string;
  uiTlsCert: string | null;
  uiTlsKey: string | null;
}

function envBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  return v === 'true' || v === '1';
}

function envInt(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  const parsed = parseInt(v, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function envSeverity(name: string, defaultValue: AlertSeverity): AlertSeverity {
  const v = process.env[name];
  if (!v) return defaultValue;
  const allowed: AlertSeverity[] = ['min', 'low', 'default', 'high', 'max'];
  return (allowed as string[]).includes(v) ? (v as AlertSeverity) : defaultValue;
}

export function loadConfig(): GatewayConfig {
  return {
    dbPath: process.env.GATEWAY_DB_PATH ?? '/data/gateway.db',
    keyfilePath: process.env.GATEWAY_KEYFILE ?? '/data/gateway.key',
    port: envInt('GATEWAY_PORT', 8400),
    host: process.env.GATEWAY_HOST ?? '0.0.0.0',
    cacheTtl: envInt('GATEWAY_CACHE_TTL', 300),
    pushoverEnabled: envBool('GATEWAY_PUSHOVER_ENABLED', false),
    pushoverAppToken: process.env.PUSHOVER_APP_TOKEN ?? null,
    pushoverUserKey: process.env.PUSHOVER_USER_KEY ?? null,
    // Audit alert configuration — see docs/pushover-alerts.md
    alertAuthFailure: envBool('GATEWAY_ALERT_AUTH_FAILURE', true),
    alertDelete: envBool('GATEWAY_ALERT_DELETE', true),
    alertUpdate: envBool('GATEWAY_ALERT_UPDATE', true),
    alertCreate: envBool('GATEWAY_ALERT_CREATE', false),
    alertRead: envBool('GATEWAY_ALERT_READ', false),
    alertList: envBool('GATEWAY_ALERT_LIST', false),
    alertRotationWarning: envBool('GATEWAY_ALERT_ROTATION_WARNING', true),
    alertMinSeverity: envSeverity('GATEWAY_ALERT_MIN_SEVERITY', 'default'),
    alertRateLimitMax: envInt('GATEWAY_ALERT_RATE_LIMIT_MAX', 10),
    alertRateLimitWindowSec: envInt('GATEWAY_ALERT_RATE_LIMIT_WINDOW', 60),
    logLevel: process.env.GATEWAY_LOG_LEVEL ?? 'info',
    rateLimitEnabled: envBool('GATEWAY_RATE_LIMIT_ENABLED', true),
    maxHistory: envInt('GATEWAY_MAX_HISTORY', 10),
    tlsEnabled: envBool('GATEWAY_TLS_ENABLED', false),
    tlsCert: process.env.GATEWAY_TLS_CERT ?? null,
    tlsKey: process.env.GATEWAY_TLS_KEY ?? null,
    uiEnabled: envBool('GATEWAY_UI_ENABLED', true),
    // 8400 REST and 8401 MCP http are taken, and 8402-8404 are commonly used by
    // 8402 is occupied in the reference deployment.
    uiPort: envInt('GATEWAY_UI_PORT', 8405),
    uiHost: process.env.GATEWAY_UI_HOST ?? '0.0.0.0',
    uiTlsCert: process.env.GATEWAY_UI_TLS_CERT ?? null,
    uiTlsKey: process.env.GATEWAY_UI_TLS_KEY ?? null,
  };
}
