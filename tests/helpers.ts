import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_ABSOLUTE_TTL_MS,
  DEFAULT_IDLE_TTL_MS,
  type SessionTtls,
} from '../src/ui/session.js';

/** The shipped defaults, for UI tests that are not about expiry policy. */
export const DEFAULT_TTLS: SessionTtls = {
  absoluteTtlMs: DEFAULT_ABSOLUTE_TTL_MS,
  idleTtlMs: DEFAULT_IDLE_TTL_MS,
};

export function createTestEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'sg-test-'));
  const dbPath = join(dir, 'test.db');
  const keyfilePath = join(dir, 'test.key');
  writeFileSync(keyfilePath, randomBytes(32).toString('base64'));
  return { dir, dbPath, keyfilePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
