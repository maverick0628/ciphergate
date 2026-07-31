import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ── Test helpers ──────────────────────────────────────────────────────────────

function createTestEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'sg-cli-test-'));
  const dbPath = join(dir, 'test.db');
  const keyfilePath = join(dir, 'test.key');
  writeFileSync(keyfilePath, randomBytes(32).toString('base64'));
  return { dir, dbPath, keyfilePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Run a CLI command by setting env vars and invoking the program directly.
 * Returns { stdout, stderr, exitCode }.
 */
async function runCLI(args: string[], env: { dbPath: string; keyfilePath: string }) {
  process.env.GATEWAY_DB_PATH = env.dbPath;
  process.env.GATEWAY_KEYFILE = env.keyfilePath;
  // These tests drive the LOCAL gateway. Anyone actually operating a gateway has
  // GATEWAY_URL exported in their shell profile, which flips the CLI to remote
  // mode and fails 32 of the 33 tests here at `init` — so the suite only passed
  // on a clean shell or in CI.
  delete process.env.GATEWAY_URL;
  delete process.env.GATEWAY_CONSUMER_KEY;

  const logs: string[] = [];
  const errs: string[] = [];

  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(' '));

  // Import fresh each time by re-importing the program
  const { program } = await import('../src/cli.js');

  let exitCode = 0;
  const origExit = process.exit.bind(process);
  // Temporarily override process.exit for this call
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  }) as (code?: number) => never);

  try {
    await program.parseAsync(['node', 'gateway', ...args]);
  } catch (e: unknown) {
    const err = e as Error & { code?: string };
    // Ignore commander internal exits (help, version) and our mocked process.exit
    if (err?.code === 'commander.helpDisplayed' || err?.message?.startsWith('process.exit(')) {
      // handled
    } else {
      throw e;
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
    exitSpy.mockRestore();
    delete process.env.GATEWAY_DB_PATH;
    delete process.env.GATEWAY_KEYFILE;
  }

  return { stdout: logs.join('\n'), stderr: errs.join('\n'), exitCode };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CLI', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
    vi.resetModules(); // Ensure fresh program instance each test
  });

  afterEach(() => {
    env.cleanup();
    vi.resetModules();
  });

  // ── Init ────────────────────────────────────────────────────────────────────

  describe('gateway init', () => {
    it('creates database and prints admin API key', async () => {
      const { stdout, stderr, exitCode } = await runCLI(['init'], env);
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('Gateway initialized');
      expect(stdout).toContain('Admin API key');
      // The key is a base64 string — should be reasonably long
      const lines = stdout.split('\n');
      const keyLine = lines[lines.length - 1];
      expect(keyLine.length).toBeGreaterThan(20);
    });

    it('fails if already initialized', async () => {
      await runCLI(['init'], env);
      vi.resetModules();
      const { stderr, exitCode } = await runCLI(['init'], env);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('already initialized');
    });

    it('fails if keyfile does not exist', async () => {
      const badEnv = { dbPath: env.dbPath, keyfilePath: '/nonexistent/keyfile.key' };
      const { stderr, exitCode } = await runCLI(['init'], badEnv);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Keyfile not found');
    });
  });

  // ── Consumer ────────────────────────────────────────────────────────────────

  describe('gateway consumer add', () => {
    beforeEach(async () => {
      await runCLI(['init'], env);
      vi.resetModules();
    });

    it('creates a reader consumer and prints API key', async () => {
      const { stdout, stderr, exitCode } = await runCLI(['consumer', 'add', 'test-reader'], env);
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain("Consumer 'test-reader' created");
      expect(stdout).toContain('reader');
      expect(stdout).toContain('API key');
    });

    it('creates an admin consumer with --admin flag', async () => {
      const { stdout, exitCode } = await runCLI(['consumer', 'add', 'test-admin', '--admin'], env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('admin');
    });

    it('creates a consumer with --expires duration', async () => {
      const { stdout, exitCode } = await runCLI(['consumer', 'add', 'temp-user', '--expires', '90d'], env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Consumer 'temp-user' created");
    });

    it('creates a consumer with --expires ISO date', async () => {
      const { stdout, exitCode } = await runCLI(['consumer', 'add', 'iso-user', '--expires', '2030-01-01'], env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Consumer 'iso-user' created");
    });
  });

  describe('gateway consumer list', () => {
    beforeEach(async () => {
      await runCLI(['init'], env);
      vi.resetModules();
      await runCLI(['consumer', 'add', 'test-reader'], env);
      vi.resetModules();
    });

    it('lists consumers', async () => {
      const { stdout, exitCode } = await runCLI(['consumer', 'list'], env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('admin');
      expect(stdout).toContain('test-reader');
    });
  });

  describe('gateway consumer revoke', () => {
    beforeEach(async () => {
      await runCLI(['init'], env);
      vi.resetModules();
      await runCLI(['consumer', 'add', 'test-reader'], env);
      vi.resetModules();
    });

    it('revokes a consumer', async () => {
      const { stdout, exitCode } = await runCLI(['consumer', 'revoke', 'test-reader'], env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Consumer 'test-reader' revoked");
    });

    it('shows revoked status in list', async () => {
      await runCLI(['consumer', 'revoke', 'test-reader'], env);
      vi.resetModules();
      const { stdout } = await runCLI(['consumer', 'list'], env);
      expect(stdout).toContain('revoked');
    });
  });

  describe('gateway consumer rotate-key', () => {
    beforeEach(async () => {
      await runCLI(['init'], env);
      vi.resetModules();
      await runCLI(['consumer', 'add', 'test-reader'], env);
      vi.resetModules();
    });

    it('rotates a consumer key and prints new key', async () => {
      const { stdout, exitCode } = await runCLI(['consumer', 'rotate-key', 'test-reader'], env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Key rotated for consumer 'test-reader'");
      expect(stdout).toContain('New API key');
    });

    it('rotates key with new expiry', async () => {
      const { stdout, exitCode } = await runCLI(['consumer', 'rotate-key', 'test-reader', '--expires', '6m'], env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Key rotated');
    });
  });

  // ── Secret ──────────────────────────────────────────────────────────────────

  describe('gateway secret set', () => {
    beforeEach(async () => {
      await runCLI(['init'], env);
      vi.resetModules();
      await runCLI(['consumer', 'add', 'reader'], env);
      vi.resetModules();
    });

    it('creates a secret with --value', async () => {
      const { stdout, exitCode } = await runCLI(
        ['secret', 'set', 'TEST_KEY', '--value', 'secret123', '--consumers', 'reader', '--tags', 'test'],
        env,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Secret 'TEST_KEY' created");
    });

    it('updates an existing secret (upsert)', async () => {
      await runCLI(['secret', 'set', 'TEST_KEY', '--value', 'v1'], env);
      vi.resetModules();
      const { stdout, exitCode } = await runCLI(['secret', 'set', 'TEST_KEY', '--value', 'v2'], env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Secret 'TEST_KEY' updated");
    });

    it('creates secret with rotation policy', async () => {
      const { stdout, exitCode } = await runCLI(
        ['secret', 'set', 'ROTATE_KEY', '--value', 'mysecret', '--rotation-days', '30'],
        env,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Secret 'ROTATE_KEY' created");
    });
  });

  describe('gateway secret get', () => {
    beforeEach(async () => {
      await runCLI(['init'], env);
      vi.resetModules();
      await runCLI(['secret', 'set', 'TEST_KEY', '--value', 'secret123'], env);
      vi.resetModules();
    });

    it('prints decrypted secret value', async () => {
      const { stdout, exitCode } = await runCLI(['secret', 'get', 'TEST_KEY'], env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('secret123');
    });

    it('exits with error for unknown secret', async () => {
      const { stderr, exitCode } = await runCLI(['secret', 'get', 'NONEXISTENT'], env);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('not found');
    });
  });

  describe('gateway secret list', () => {
    beforeEach(async () => {
      await runCLI(['init'], env);
      vi.resetModules();
      await runCLI(['secret', 'set', 'KEY_A', '--value', 'val1', '--tags', 'prod'], env);
      vi.resetModules();
      await runCLI(['secret', 'set', 'KEY_B', '--value', 'val2', '--tags', 'test'], env);
      vi.resetModules();
    });

    it('lists all secrets', async () => {
      const { stdout, exitCode } = await runCLI(['secret', 'list'], env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('KEY_A');
      expect(stdout).toContain('KEY_B');
    });
  });

  describe('gateway secret delete', () => {
    beforeEach(async () => {
      await runCLI(['init'], env);
      vi.resetModules();
      await runCLI(['secret', 'set', 'TO_DELETE', '--value', 'val'], env);
      vi.resetModules();
    });

    it('deletes a secret', async () => {
      const { stdout, exitCode } = await runCLI(['secret', 'delete', 'TO_DELETE'], env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Secret 'TO_DELETE' deleted");
    });

    it('errors on unknown secret', async () => {
      const { stderr, exitCode } = await runCLI(['secret', 'delete', 'NONEXISTENT'], env);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('not found');
    });
  });

  describe('gateway secret history', () => {
    beforeEach(async () => {
      await runCLI(['init'], env);
      vi.resetModules();
      await runCLI(['secret', 'set', 'HIST_KEY', '--value', 'v1'], env);
      vi.resetModules();
      await runCLI(['secret', 'set', 'HIST_KEY', '--value', 'v2'], env);
      vi.resetModules();
    });

    it('shows version history', async () => {
      const { stdout, exitCode } = await runCLI(['secret', 'history', 'HIST_KEY'], env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('HIST_KEY');
      expect(stdout).toContain('current_version=2');
      // v1 should appear in history
      expect(stdout).toContain('v1');
    });
  });

  // ── Env ─────────────────────────────────────────────────────────────────────

  describe('gateway env', () => {
    beforeEach(async () => {
      await runCLI(['init'], env);
      vi.resetModules();
      await runCLI(['consumer', 'add', 'reader'], env);
      vi.resetModules();
      await runCLI(['secret', 'set', 'DB_URL', '--value', 'postgres://localhost', '--consumers', 'reader', '--tags', 'infra'], env);
      vi.resetModules();
      await runCLI(['secret', 'set', 'API_KEY', '--value', 'key-abc', '--consumers', 'reader', '--tags', 'api'], env);
      vi.resetModules();
    });

    it('outputs dotenv format for all accessible secrets', async () => {
      const { stdout, exitCode } = await runCLI(['env'], env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('DB_URL=postgres://localhost');
      expect(stdout).toContain('API_KEY=key-abc');
    });

    it('filters by tag', async () => {
      const { stdout } = await runCLI(['env', '--tag', 'infra'], env);
      expect(stdout).toContain('DB_URL=postgres://localhost');
      expect(stdout).not.toContain('API_KEY');
    });

    it('filters by consumer', async () => {
      const { stdout, exitCode } = await runCLI(['env', '--consumer', 'reader'], env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('DB_URL=postgres://localhost');
    });
  });

  // ── Backup/Restore ──────────────────────────────────────────────────────────

  describe('gateway backup', () => {
    beforeEach(async () => {
      await runCLI(['init'], env);
      vi.resetModules();
    });

    it('copies database to output path', async () => {
      const backupPath = join(env.dir, 'backup.db');
      const { stdout, exitCode } = await runCLI(['backup', '--output', backupPath], env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(`Backup written to ${backupPath}`);
      expect(existsSync(backupPath)).toBe(true);
    });

    it('errors if --output not provided', async () => {
      const { stderr, exitCode } = await runCLI(['backup'], env);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--output');
    });
  });

  describe('gateway restore', () => {
    it('restores database from backup', async () => {
      // Init, create a secret, back up, then restore to fresh db
      await runCLI(['init'], env);
      vi.resetModules();
      await runCLI(['secret', 'set', 'RESTORE_KEY', '--value', 'restored_val'], env);
      vi.resetModules();

      const backupPath = join(env.dir, 'backup.db');
      await runCLI(['backup', '--output', backupPath], env);
      vi.resetModules();

      // Point to new db path, restore from backup
      const newDbPath = join(env.dir, 'new.db');
      const altEnv = { dbPath: newDbPath, keyfilePath: env.keyfilePath };
      const { stdout, exitCode } = await runCLI(['restore', backupPath], altEnv);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(`Database restored from ${backupPath}`);
      expect(existsSync(newDbPath)).toBe(true);
    });

    it('errors if backup file does not exist', async () => {
      const { stderr, exitCode } = await runCLI(['restore', '/nonexistent/backup.db'], env);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('not found');
    });
  });

  // ── Audit ────────────────────────────────────────────────────────────────────

  describe('gateway audit', () => {
    beforeEach(async () => {
      await runCLI(['init'], env);
      vi.resetModules();
      await runCLI(['secret', 'set', 'AUDIT_KEY', '--value', 'val'], env);
      vi.resetModules();
      await runCLI(['secret', 'get', 'AUDIT_KEY'], env);
      vi.resetModules();
    });

    it('shows audit log entries', async () => {
      const { stdout, exitCode } = await runCLI(['audit'], env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('AUDIT_KEY');
    });

    it('respects --limit option', async () => {
      const { stdout } = await runCLI(['audit', '--limit', '1'], env);
      const lines = stdout.split('\n').filter(Boolean);
      expect(lines.length).toBe(1);
    });
  });

  // ── Rotation report ───────────────────────────────────────────────────────────

  describe('gateway rotation-report', () => {
    beforeEach(async () => {
      await runCLI(['init'], env);
      vi.resetModules();
      await runCLI(['consumer', 'add', 'reader'], env);
      vi.resetModules();
      await runCLI(
        ['secret', 'set', 'ROTATING_SECRET', '--value', 'val', '--consumers', 'reader', '--rotation-days', '90'],
        env,
      );
      vi.resetModules();
    });

    it('shows rotation report with OK secrets', async () => {
      const { stdout, exitCode } = await runCLI(['rotation-report'], env);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('ROTATING_SECRET');
    });
  });

  // ── Error: not initialized ────────────────────────────────────────────────────

  describe('commands requiring initialized DB', () => {
    it('consumer add fails with helpful message if not initialized', async () => {
      // No init — DB exists but has no salt
      const { stderr, exitCode } = await runCLI(['consumer', 'add', 'foo'], env);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('gateway init');
    });

    it('secret set fails with helpful message if not initialized', async () => {
      const { stderr, exitCode } = await runCLI(['secret', 'set', 'FOO', '--value', 'bar'], env);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('gateway init');
    });
  });
});
