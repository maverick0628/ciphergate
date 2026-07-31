import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const SCRIPT = join(process.cwd(), 'scripts', 'mcp-wrap-audit.mjs');

// Mirrors the real ~/.claude.json shape: root mcpServers + per-project.
const CONFIG = {
  mcpServers: {
    'n8n-mcp': { command: '/Users/d/bin/mcp-wrap', args: ['N8N_API_KEY', 'n8n-mcp'] }, // already wrapped
    resend: { command: 'npx', args: ['-y', 'resend-mcp'], env: { RESEND_API_KEY: 'rk_live_abc123def456ghi789' } }, // migrate
    blender: { command: '/usr/local/bin/blender-mcp' }, // no secret
    github: { type: 'http', url: 'https://api.githubcopilot.com/mcp' }, // remote
    coinbase: { command: 'coinbase', args: ['mcp'], env: { COINBASE_API_KEY: 'organizations/abc/apiKeys/xyz-secret-value' } }, // migrate
  },
  projects: {
    '/Users/d/proj': {
      mcpServers: {
        'fal-ai': { type: 'http', url: 'https://mcp.fal.ai/mcp' }, // remote
      },
    },
  },
};

describe('mcp-wrap-audit', () => {
  let dir: string;
  let cfgPath: string;
  let out: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sg-audit-'));
    cfgPath = join(dir, 'claude.json');
    writeFileSync(cfgPath, JSON.stringify(CONFIG));
    out = (await run('node', [SCRIPT, cfgPath])).stdout;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('classifies already-wrapped servers', () => {
    expect(out).toMatch(/ALREADY via mcp-wrap \(1\): n8n-mcp/);
  });

  it('flags servers with inline secrets for migration with set + rewrite steps', () => {
    expect(out).toMatch(/MIGRATE — inline secret\(s\) detected \(2\)/);
    expect(out).toContain('resend — secrets: RESEND_API_KEY');
    expect(out).toContain('gateway secret set RESEND_API_KEY --consumers mcp-clients');
    expect(out).toContain('"command": "mcp-wrap"');
    expect(out).toContain('["RESEND_API_KEY","npx","-y","resend-mcp"]');
    expect(out).toContain('coinbase — secrets: COINBASE_API_KEY');
  });

  it('skips remote/OAuth servers (url or http type), including nested project scopes', () => {
    expect(out).toMatch(/SKIP — remote\/OAuth, no static key \(2\)/);
    expect(out).toContain('github');
    expect(out).toContain('fal-ai [/Users/d/proj]');
  });

  it('lists stdio servers with no secret as nothing to centralize', () => {
    expect(out).toMatch(/NO SECRET — stdio, nothing to centralize \(1\): blender/);
  });

  it('honours a custom --consumer', async () => {
    const r = await run('node', [SCRIPT, cfgPath, '--consumer=mcp-readers']);
    expect(r.stdout).toContain('--consumers mcp-readers');
  });
});
