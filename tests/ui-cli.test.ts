import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { verifyUiPassword } from '../src/ui/credentials.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const PASSWORD = 'a-sufficiently-long-password';

function run(
  args: string[],
  env: Record<string, string>,
  stdin?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const inherited = { ...process.env };
  delete inherited.GATEWAY_URL;
  delete inherited.GATEWAY_CONSUMER_KEY;
  return new Promise((resolve) => {
    const child = execFile(
      'node',
      [CLI, ...args],
      { env: { ...inherited, ...env } },
      (err, stdout, stderr) => {
        resolve({ stdout, stderr, code: (err as { code?: number } | null)?.code ?? 0 });
      },
    );
    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
  });
}

describe('gateway ui set-password', () => {
  let dir: string;
  let dbPath: string;
  let env: Record<string, string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sg-ui-cli-'));
    dbPath = join(dir, 'test.db');
    const keyfilePath = join(dir, 'test.key');
    writeFileSync(keyfilePath, randomBytes(32).toString('base64'));
    env = { GATEWAY_DB_PATH: dbPath, GATEWAY_KEYFILE: keyfilePath };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stores a verifiable hash when both prompts match', async () => {
    const res = await run(['ui', 'set-password'], env, `${PASSWORD}\n${PASSWORD}\n`);
    expect(res.code).toBe(0);

    const storage = new SqliteStorage(dbPath);
    expect(await verifyUiPassword(storage, 'admin', PASSWORD)).toBe(true);
    storage.close();
  });

  it('never echoes the password back', async () => {
    const res = await run(['ui', 'set-password'], env, `${PASSWORD}\n${PASSWORD}\n`);
    expect(res.stdout).not.toContain(PASSWORD);
    expect(res.stderr).not.toContain(PASSWORD);
  });

  it('honours --user', async () => {
    const res = await run(['ui', 'set-password', '--user', 'operator'], env, `${PASSWORD}\n${PASSWORD}\n`);
    expect(res.code).toBe(0);

    const storage = new SqliteStorage(dbPath);
    expect(await verifyUiPassword(storage, 'operator', PASSWORD)).toBe(true);
    expect(await verifyUiPassword(storage, 'admin', PASSWORD)).toBe(false);
    storage.close();
  });

  it('refuses when the two prompts disagree', async () => {
    const res = await run(['ui', 'set-password'], env, `${PASSWORD}\nsomething-else-entirely\n`);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/did not match/i);

    const storage = new SqliteStorage(dbPath);
    expect(storage.countUiCredentials()).toBe(0);
    storage.close();
  });

  it('refuses a password below the minimum length', async () => {
    const res = await run(['ui', 'set-password'], env, 'short\nshort\n');
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/at least/i);

    const storage = new SqliteStorage(dbPath);
    expect(storage.countUiCredentials()).toBe(0);
    storage.close();
  });

  it('refuses an empty password', async () => {
    const res = await run(['ui', 'set-password'], env, '\n\n');
    expect(res.code).not.toBe(0);

    const storage = new SqliteStorage(dbPath);
    expect(storage.countUiCredentials()).toBe(0);
    storage.close();
  });

  it('refuses in remote mode', async () => {
    const res = await run(
      ['ui', 'set-password'],
      { ...env, GATEWAY_URL: 'http://gw:8400', GATEWAY_CONSUMER_KEY: 'k' },
      `${PASSWORD}\n${PASSWORD}\n`,
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/remote mode/i);
  });

  it('rotates an existing password in place', async () => {
    await run(['ui', 'set-password'], env, `${PASSWORD}\n${PASSWORD}\n`);
    const second = 'an-entirely-different-password';
    const res = await run(['ui', 'set-password'], env, `${second}\n${second}\n`);
    expect(res.code).toBe(0);

    const storage = new SqliteStorage(dbPath);
    expect(storage.countUiCredentials()).toBe(1);
    expect(await verifyUiPassword(storage, 'admin', PASSWORD)).toBe(false);
    expect(await verifyUiPassword(storage, 'admin', second)).toBe(true);
    storage.close();
  });
});
