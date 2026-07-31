import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

export function createTestEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'sg-test-'));
  const dbPath = join(dir, 'test.db');
  const keyfilePath = join(dir, 'test.key');
  writeFileSync(keyfilePath, randomBytes(32).toString('base64'));
  return { dir, dbPath, keyfilePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
