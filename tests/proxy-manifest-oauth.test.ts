import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseManifest } from '../src/proxy/manifest.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const httpServer = (extra: Record<string, unknown>) => ({
  version: 1,
  gatewayUrl: 'http://x:8400',
  servers: {
    'robinhood-trading': {
      transport: 'http',
      url: 'https://agent.robinhood.com/mcp/trading',
      policyFile: 'policies/robinhood-trading.policy.json',
      ...extra,
    },
  },
});

describe('manifest http transport oauth field', () => {
  it('parses auth:"oauth" on an http server', () => {
    const m = parseManifest(httpServer({ auth: 'oauth' }), repoRoot);
    expect(m.servers['robinhood-trading'].auth).toBe('oauth');
  });

  it('leaves auth undefined when omitted', () => {
    const m = parseManifest(httpServer({}), repoRoot);
    expect(m.servers['robinhood-trading'].auth).toBeUndefined();
  });

  it('rejects an unknown auth value', () => {
    expect(() => parseManifest(httpServer({ auth: 'basic' }), repoRoot)).toThrow(/auth/);
  });

  it('rejects auth on a stdio server', () => {
    expect(() =>
      parseManifest(
        { version: 1, gatewayUrl: 'http://x:8400', servers: { c: { command: 'coinbase', args: ['mcp'], auth: 'oauth' } } },
        repoRoot,
      ),
    ).toThrow(/auth/);
  });
});
