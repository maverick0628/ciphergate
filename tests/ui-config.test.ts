import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

const UI_VARS = [
  'GATEWAY_UI_ENABLED',
  'GATEWAY_UI_PORT',
  'GATEWAY_UI_HOST',
  'GATEWAY_UI_TLS_CERT',
  'GATEWAY_UI_TLS_KEY',
];

describe('UI configuration', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of UI_VARS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of UI_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('enables the UI by default', () => {
    expect(loadConfig().uiEnabled).toBe(true);
  });

  it('defaults to a port that does not collide with the other listeners', () => {
    const config = loadConfig();
    // 8400 REST and 8401 MCP http are already spoken for, and 8402-8404 are
    // and 8402 is used by another homelab service in the reference deployment.
    expect(config.uiPort).toBe(8405);
    expect([8400, 8401, 8402, 8403, 8404]).not.toContain(config.uiPort);
  });

  it('defaults the bind host', () => {
    expect(loadConfig().uiHost).toBe('0.0.0.0');
  });

  it('leaves TLS paths unset by default so a cert is generated', () => {
    const config = loadConfig();
    expect(config.uiTlsCert).toBeNull();
    expect(config.uiTlsKey).toBeNull();
  });

  it('honours GATEWAY_UI_ENABLED=false', () => {
    process.env.GATEWAY_UI_ENABLED = 'false';
    expect(loadConfig().uiEnabled).toBe(false);
  });

  it('honours GATEWAY_UI_ENABLED=0', () => {
    process.env.GATEWAY_UI_ENABLED = '0';
    expect(loadConfig().uiEnabled).toBe(false);
  });

  it('honours port and host overrides', () => {
    process.env.GATEWAY_UI_PORT = '9999';
    process.env.GATEWAY_UI_HOST = '127.0.0.1';
    const config = loadConfig();
    expect(config.uiPort).toBe(9999);
    expect(config.uiHost).toBe('127.0.0.1');
  });

  it('honours explicit TLS paths', () => {
    process.env.GATEWAY_UI_TLS_CERT = '/etc/ssl/ui.crt';
    process.env.GATEWAY_UI_TLS_KEY = '/etc/ssl/ui.key';
    const config = loadConfig();
    expect(config.uiTlsCert).toBe('/etc/ssl/ui.crt');
    expect(config.uiTlsKey).toBe('/etc/ssl/ui.key');
  });

  it('falls back to the default port when the override is not a number', () => {
    process.env.GATEWAY_UI_PORT = 'not-a-port';
    expect(loadConfig().uiPort).toBe(8405);
  });
});
