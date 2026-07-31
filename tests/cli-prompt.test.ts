import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const CLI = join(process.cwd(), 'dist', 'cli.js');

/**
 * Run the built CLI with optional piped stdin, against an isolated db/keyfile.
 *
 * GATEWAY_URL / GATEWAY_CONSUMER_KEY are stripped from the inherited
 * environment. Anyone actually operating a gateway has those exported in their
 * shell profile, which puts the CLI into remote mode and fails every local-mode
 * test here at `init`.
 */
function run(args: string[], env: Record<string, string>, stdin?: string): Promise<{ stdout: string; code: number }> {
  const inherited = { ...process.env };
  delete inherited.GATEWAY_URL;
  delete inherited.GATEWAY_CONSUMER_KEY;
  return new Promise((resolve) => {
    const child = execFile('node', [CLI, ...args], { env: { ...inherited, ...env } }, (err, stdout) => {
      resolve({ stdout, code: (err as { code?: number } | null)?.code ?? 0 });
    });
    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
  });
}

describe('secret set — non-TTY (piped) value still reads correctly', () => {
  let dir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sg-prompt-'));
    const keyfilePath = join(dir, 'test.key');
    writeFileSync(keyfilePath, randomBytes(32).toString('base64'));
    env = { GATEWAY_DB_PATH: join(dir, 'test.db'), GATEWAY_KEYFILE: keyfilePath };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a piped secret value (no --value) and stores it verbatim', async () => {
    const init = await run(['init'], env);
    expect(init.code).toBe(0);

    // No --value: the value is read from stdin via promptHidden (non-TTY path).
    const set = await run(['secret', 'set', 'MY_SECRET'], env, 'piped-secret-123\n');
    expect(set.code).toBe(0);

    const get = await run(['secret', 'get', 'MY_SECRET'], env);
    expect(get.stdout.trim()).toBe('piped-secret-123');
  });

  it('does not echo the piped value back to stdout', async () => {
    await run(['init'], env);
    const set = await run(['secret', 'set', 'TOKEN'], env, 'sup3r-s3cret\n');
    // The prompt label may appear, but the secret value must not be echoed.
    expect(set.stdout).not.toContain('sup3r-s3cret');
  });
});

describe('secret set — an empty value is refused, not stored', () => {
  let dir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sg-empty-'));
    const keyfilePath = join(dir, 'test.key');
    writeFileSync(keyfilePath, randomBytes(32).toString('base64'));
    env = { GATEWAY_DB_PATH: join(dir, 'test.db'), GATEWAY_KEYFILE: keyfilePath };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * Regression for 2026-07-27: `secret set NAME --consumers a,b` with no
   * --value was intended only to widen the consumer list. The prompt returned
   * '', which is not undefined, so updateSecret encrypted the empty string and
   * destroyed the secret. There is no rollback.
   */
  it('does not blank an existing secret when the prompt comes back empty', async () => {
    expect((await run(['init'], env)).code).toBe(0);
    expect((await run(['secret', 'set', 'MY_SECRET', '--value', 'original-value'], env)).code).toBe(0);

    const wipe = await run(['secret', 'set', 'MY_SECRET', '--consumers', 'a,b'], env, '');
    expect(wipe.code).not.toBe(0);

    const got = await run(['secret', 'get', 'MY_SECRET'], env);
    expect(got.stdout.trim()).toBe('original-value');
  });

  it('still refuses on a bare newline', async () => {
    expect((await run(['init'], env)).code).toBe(0);
    expect((await run(['secret', 'set', 'S', '--value', 'v'], env)).code).toBe(0);
    expect((await run(['secret', 'set', 'S'], env, '\n')).code).not.toBe(0);
    expect((await run(['secret', 'get', 'S'], env)).stdout.trim()).toBe('v');
  });

  it('allows an explicit --value "" for a deliberate blank', async () => {
    expect((await run(['init'], env)).code).toBe(0);
    expect((await run(['secret', 'set', 'S', '--value', 'v'], env)).code).toBe(0);
    expect((await run(['secret', 'set', 'S', '--value', ''], env)).code).toBe(0);
    expect((await run(['secret', 'get', 'S'], env)).stdout.trim()).toBe('');
  });
});

describe('secret grant — changes consumers without touching the value', () => {
  let dir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sg-grant-'));
    const keyfilePath = join(dir, 'test.key');
    writeFileSync(keyfilePath, randomBytes(32).toString('base64'));
    env = { GATEWAY_DB_PATH: join(dir, 'test.db'), GATEWAY_KEYFILE: keyfilePath };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('widens the consumer list and leaves the value intact', async () => {
    expect((await run(['init'], env)).code).toBe(0);
    expect(
      (await run(['secret', 'set', 'TOK', '--value', 'secret-value', '--consumers', 'one'], env)).code,
    ).toBe(0);

    const grant = await run(['secret', 'grant', 'TOK', '--consumers', 'one,two'], env);
    expect(grant.code).toBe(0);
    expect(grant.stdout).toContain('value untouched');

    expect((await run(['secret', 'get', 'TOK'], env)).stdout.trim()).toBe('secret-value');
    expect((await run(['secret', 'list'], env)).stdout).toContain('two');
  });

  it('refuses when neither list is given', async () => {
    expect((await run(['init'], env)).code).toBe(0);
    expect((await run(['secret', 'set', 'TOK', '--value', 'v'], env)).code).toBe(0);
    expect((await run(['secret', 'grant', 'TOK'], env)).code).not.toBe(0);
  });

  it('refuses on a secret that does not exist', async () => {
    expect((await run(['init'], env)).code).toBe(0);
    expect((await run(['secret', 'grant', 'NOPE', '--consumers', 'a'], env)).code).not.toBe(0);
  });
});
