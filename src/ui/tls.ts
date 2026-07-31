import { readFileSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Filenames used for the self-signed pair generated into the data directory. */
export const UI_CERT_FILE = 'ui-cert.pem';
export const UI_KEY_FILE = 'ui-key.pem';

export interface UiTls {
  cert: Buffer;
  key: Buffer;
}

export interface ResolveUiTlsOptions {
  /** Directory the generated pair is written to. Normally the gateway data dir. */
  dataDir: string;
  /** Explicitly configured certificate path, if any. */
  certPath: string | null;
  /** Explicitly configured key path, if any. */
  keyPath: string | null;
}

function readPair(certPath: string, keyPath: string): UiTls | null {
  try {
    return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  } catch {
    return null;
  }
}

/**
 * Generate a self-signed pair with openssl.
 *
 * Node cannot sign an X.509 certificate without a third-party library, and
 * adding one for this would break the gateway's dependency discipline. openssl
 * is an image package instead.
 */
function generatePair(dataDir: string): UiTls | null {
  const certPath = join(dataDir, UI_CERT_FILE);
  const keyPath = join(dataDir, UI_KEY_FILE);

  // No mkdir here. The data directory necessarily exists — the SQLite database
  // was already opened inside it — so creating it was dead defensiveness, and
  // `mkdirSync(path, { recursive: true })` does not fail fast on every path:
  // against a Linux procfs path it hung indefinitely, which wedged CI. If the
  // directory really is missing, openssl fails and this returns null, which is
  // the same outcome by a path that cannot hang.
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509',
        '-newkey', 'rsa:2048',
        '-nodes',
        '-days', '3650',
        '-subj', '/CN=ciphergate-ui',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout', keyPath,
        '-out', certPath,
      ],
      { stdio: 'ignore' },
    );
    // The private key must not be world-readable on a shared data volume.
    chmodSync(keyPath, 0o600);
    return readPair(certPath, keyPath);
  } catch {
    return null;
  }
}

/**
 * Resolve a certificate for the UI listener.
 *
 * Order: explicitly configured paths, then a previously generated pair in the
 * data directory, then generate one.
 *
 * Returns null on any failure. The caller falls back to plain HTTP with a
 * warning rather than refusing to start — a broken openssl in some future base
 * image should degrade, not take the UI offline at the moment someone needs to
 * rotate a credential.
 */
export function resolveUiTls(opts: ResolveUiTlsOptions): UiTls | null {
  if (opts.certPath && opts.keyPath) {
    return readPair(opts.certPath, opts.keyPath);
  }

  const generatedCert = join(opts.dataDir, UI_CERT_FILE);
  const generatedKey = join(opts.dataDir, UI_KEY_FILE);
  if (existsSync(generatedCert) && existsSync(generatedKey)) {
    return readPair(generatedCert, generatedKey);
  }

  return generatePair(opts.dataDir);
}
