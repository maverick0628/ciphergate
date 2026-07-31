import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const CLI = join(process.cwd(), 'dist', 'proxy-cli.js');

const MANIFEST = {
  version: 1,
  gatewayUrl: 'http://gw:8400',
  servers: {
    qdrant: { command: 'uvx', args: ['mcp-server-qdrant'], secrets: { QDRANT_API_KEY: 'QDRANT_API_KEY' } },
  },
};

describe('gateway-proxy CLI', () => {
  let dir: string;
  let manifestPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sg-proxy-cli-'));
    manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(MANIFEST));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('lists servers from the manifest', async () => {
    const { stdout } = await run('node', [CLI, '--manifest', manifestPath, 'list']);
    expect(stdout).toContain('qdrant');
    expect(stdout).toContain('uvx mcp-server-qdrant');
    expect(stdout).toContain('QDRANT_API_KEY');
  });

  it('exits non-zero with a clear message on a bad manifest', async () => {
    const badPath = join(dir, 'bad.json');
    writeFileSync(badPath, JSON.stringify({ version: 2 }));
    await expect(run('node', [CLI, '--manifest', badPath, 'list'])).rejects.toMatchObject({
      stderr: expect.stringContaining('version must be 1'),
    });
  });
});
