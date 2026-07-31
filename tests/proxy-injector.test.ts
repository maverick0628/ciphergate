import { describe, it, expect } from 'vitest';
import { parseManifest } from '../src/proxy/manifest.js';
import { fetchInjectedEnv, resolveConsumerKey, maskValue } from '../src/proxy/injector.js';
import { buildChildEnv, runServer } from '../src/proxy/runner.js';
import type { ProxyManifest } from '../src/proxy/manifest.js';

const RAW = {
  version: 1,
  gatewayUrl: 'http://gw:8400',
  servers: {
    qdrant: {
      command: 'uvx',
      args: ['mcp-server-qdrant'],
      secrets: { QDRANT_API_KEY: 'QDRANT_API_KEY', OPENAI_API_KEY: 'EMBEDDING_API_KEY' },
      env: { QDRANT_URL: 'http://qdrant:6333' },
    },
  },
};

function stubFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as Response) as unknown as typeof fetch;
}

describe('parseManifest', () => {
  it('parses a valid manifest and defaults consumerKeyEnv', () => {
    const m = parseManifest(RAW);
    expect(m.consumerKeyEnv).toBe('GATEWAY_PROXY_KEY');
    expect(m.servers.qdrant.command).toBe('uvx');
    expect(m.servers.qdrant.secrets.OPENAI_API_KEY).toBe('EMBEDDING_API_KEY');
  });

  it('rejects wrong version', () => {
    expect(() => parseManifest({ ...RAW, version: 2 })).toThrow(/version must be 1/);
  });

  it('rejects a server missing command', () => {
    expect(() => parseManifest({ ...RAW, servers: { x: { args: [] } } })).toThrow(/command/);
  });

  it('rejects non-string secret map', () => {
    expect(() => parseManifest({ ...RAW, servers: { x: { command: 'c', args: [], secrets: { A: 1 } } } })).toThrow(/secrets/);
  });

  it('rejects empty servers', () => {
    expect(() => parseManifest({ ...RAW, servers: {} })).toThrow(/at least one/);
  });
});

describe('fetchInjectedEnv', () => {
  const manifest = parseManifest(RAW);
  const server = manifest.servers.qdrant;

  it('maps gateway secrets onto target env var names', async () => {
    const result = await fetchInjectedEnv(server, {
      gatewayUrl: 'http://gw:8400',
      consumerKey: 'k',
      fetchFn: stubFetch({
        secrets: [
          { name: 'QDRANT_API_KEY', value: 'qk' },
          { name: 'OPENAI_API_KEY', value: 'ok' },
        ],
        missing: [],
        denied: [],
      }),
    });
    expect(result.env).toEqual({ QDRANT_API_KEY: 'qk', EMBEDDING_API_KEY: 'ok' });
    expect(result.fetched.sort()).toEqual(['OPENAI_API_KEY', 'QDRANT_API_KEY']);
  });

  it('fails closed when a secret is denied (out of scope)', async () => {
    await expect(
      fetchInjectedEnv(server, {
        gatewayUrl: 'http://gw:8400',
        consumerKey: 'k',
        fetchFn: stubFetch({ secrets: [{ name: 'QDRANT_API_KEY', value: 'qk' }], missing: [], denied: ['OPENAI_API_KEY'] }),
      }),
    ).rejects.toThrow(/denied/);
  });

  it('fails closed when a secret is missing', async () => {
    await expect(
      fetchInjectedEnv(server, {
        gatewayUrl: 'http://gw:8400',
        consumerKey: 'k',
        fetchFn: stubFetch({ secrets: [{ name: 'QDRANT_API_KEY', value: 'qk' }], missing: ['OPENAI_API_KEY'], denied: [] }),
      }),
    ).rejects.toThrow(/missing/);
  });

  it('throws on missing consumer key', async () => {
    await expect(
      fetchInjectedEnv(server, { gatewayUrl: 'http://gw:8400', consumerKey: '' }),
    ).rejects.toThrow(/consumer key/);
  });

  it('throws on non-OK gateway response', async () => {
    await expect(
      fetchInjectedEnv(server, { gatewayUrl: 'http://gw:8400', consumerKey: 'k', fetchFn: stubFetch({ error: 'boom' }, false, 500) }),
    ).rejects.toThrow(/batch fetch failed \(500\)/);
  });

  it('returns empty when server declares no secrets', async () => {
    const noSecrets = { ...server, secrets: {} };
    const result = await fetchInjectedEnv(noSecrets, { gatewayUrl: 'http://gw:8400', consumerKey: '' });
    expect(result.env).toEqual({});
  });
});

describe('resolveConsumerKey', () => {
  const manifest = parseManifest(RAW);
  it('reads the manifest default env var', () => {
    expect(resolveConsumerKey(manifest, manifest.servers.qdrant, { GATEWAY_PROXY_KEY: 'abc' })).toBe('abc');
  });
  it('honours a per-server override', () => {
    const m: ProxyManifest = { ...manifest, servers: { qdrant: { ...manifest.servers.qdrant, consumerKeyEnv: 'QK' } } };
    expect(resolveConsumerKey(m, m.servers.qdrant, { QK: 'xyz', GATEWAY_PROXY_KEY: 'abc' })).toBe('xyz');
  });
});

describe('buildChildEnv', () => {
  const manifest = parseManifest(RAW);
  it('strips the consumer key, applies static env, then injected secrets', () => {
    const env = buildChildEnv(
      manifest,
      'qdrant',
      { env: { QDRANT_API_KEY: 'qk', EMBEDDING_API_KEY: 'ok' }, fetched: [], missing: [], denied: [] },
      { GATEWAY_PROXY_KEY: 'super-secret', PATH: '/usr/bin', QDRANT_URL: 'http://override-me' },
    );
    expect(env.GATEWAY_PROXY_KEY).toBeUndefined(); // gateway key never reaches the child
    expect(env.PATH).toBe('/usr/bin'); // inherited
    expect(env.QDRANT_URL).toBe('http://qdrant:6333'); // static manifest env wins over inherited
    expect(env.QDRANT_API_KEY).toBe('qk'); // injected secret
    expect(env.EMBEDDING_API_KEY).toBe('ok');
  });
});

describe('runServer', () => {
  const manifest = parseManifest(RAW);
  it('fetches secrets then spawns the command with injected env', async () => {
    let spawned: { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | undefined;
    const fakeSpawn = ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      spawned = { cmd, args, env: opts.env };
      return { on: () => {} } as never;
    }) as unknown as typeof import('node:child_process').spawn;

    await runServer(manifest, 'qdrant', {
      environ: { GATEWAY_PROXY_KEY: 'k', PATH: '/bin' },
      fetchFn: stubFetch({
        secrets: [
          { name: 'QDRANT_API_KEY', value: 'qk' },
          { name: 'OPENAI_API_KEY', value: 'ok' },
        ],
        missing: [],
        denied: [],
      }),
      spawnFn: fakeSpawn,
      log: () => {},
    });

    expect(spawned?.cmd).toBe('uvx');
    expect(spawned?.args).toEqual(['mcp-server-qdrant']);
    expect(spawned?.env.QDRANT_API_KEY).toBe('qk');
    expect(spawned?.env.EMBEDDING_API_KEY).toBe('ok');
    expect(spawned?.env.GATEWAY_PROXY_KEY).toBeUndefined();
  });

  it('throws on unknown server name', async () => {
    await expect(runServer(manifest, 'nope', { log: () => {} })).rejects.toThrow(/No server "nope"/);
  });
});

describe('maskValue', () => {
  it('masks long values keeping ends', () => {
    expect(maskValue('abcdefgh')).toBe('ab****gh');
  });
  it('fully masks short values', () => {
    expect(maskValue('abcd')).toBe('****');
  });
});
