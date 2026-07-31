import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveUiTls, UI_CERT_FILE, UI_KEY_FILE } from '../src/ui/tls.js';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('UI TLS resolution', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sg-tls-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('prefers explicitly configured paths', () => {
    const certPath = join(dir, 'my-cert.pem');
    const keyPath = join(dir, 'my-key.pem');
    writeFileSync(certPath, 'CERT-CONTENT');
    writeFileSync(keyPath, 'KEY-CONTENT');

    const result = resolveUiTls({ dataDir: dir, certPath, keyPath });

    expect(result).not.toBeNull();
    expect(result!.cert.toString()).toBe('CERT-CONTENT');
    expect(result!.key.toString()).toBe('KEY-CONTENT');
    // Explicit paths short-circuit: nothing generated.
    expect(existsSync(join(dir, UI_CERT_FILE))).toBe(false);
  });

  it('returns null when configured paths are unreadable rather than throwing', () => {
    const result = resolveUiTls({
      dataDir: join(dir, 'nonexistent-dir'),
      certPath: join(dir, 'missing-cert.pem'),
      keyPath: join(dir, 'missing-key.pem'),
    });
    expect(result).toBeNull();
  });

  it('reuses an existing generated pair without regenerating', () => {
    writeFileSync(join(dir, UI_CERT_FILE), 'EXISTING-CERT');
    writeFileSync(join(dir, UI_KEY_FILE), 'EXISTING-KEY');

    const result = resolveUiTls({ dataDir: dir, certPath: null, keyPath: null });

    expect(result).not.toBeNull();
    expect(result!.cert.toString()).toBe('EXISTING-CERT');
    expect(result!.key.toString()).toBe('EXISTING-KEY');
  });

  it.skipIf(!hasOpenssl())('generates a usable self-signed pair on first start', () => {
    const result = resolveUiTls({ dataDir: dir, certPath: null, keyPath: null });

    expect(result).not.toBeNull();
    expect(result!.cert.toString()).toContain('BEGIN CERTIFICATE');
    expect(result!.key.toString()).toContain('PRIVATE KEY');
    expect(existsSync(join(dir, UI_CERT_FILE))).toBe(true);
    expect(existsSync(join(dir, UI_KEY_FILE))).toBe(true);
  });

  it.skipIf(!hasOpenssl())('writes the generated key readable only by its owner', () => {
    resolveUiTls({ dataDir: dir, certPath: null, keyPath: null });
    const mode = statSync(join(dir, UI_KEY_FILE)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.skipIf(!hasOpenssl())('is stable across calls — the second call reuses the first pair', () => {
    const first = resolveUiTls({ dataDir: dir, certPath: null, keyPath: null });
    const second = resolveUiTls({ dataDir: dir, certPath: null, keyPath: null });
    expect(first!.cert.toString()).toBe(second!.cert.toString());
  });

  it('returns null instead of throwing when generation is impossible', () => {
    // A regular FILE standing in for the data directory: any write beneath it
    // fails ENOTDIR, instantly, on every platform. The UI must degrade to HTTP
    // rather than crash.
    //
    // This deliberately does not use a magic OS path. An earlier version passed
    // `/proc/nonexistent-and-unwritable`, which fails instantly on macOS (no
    // /proc) but made `mkdirSync(..., { recursive: true })` hang forever on
    // Linux — green locally, CI wedged until it timed out.
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, 'x');

    const started = Date.now();
    const result = resolveUiTls({
      dataDir: join(blocker, 'nested'),
      certPath: null,
      keyPath: null,
    });

    expect(result).toBeNull();
    // Fails fast, on every platform. Guards the regression directly.
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
