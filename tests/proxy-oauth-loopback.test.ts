import { describe, it, expect } from 'vitest';
import { createLoopbackAuthorizer, FileOAuthStore, GuardOAuthProvider } from '../src/proxy/oauth.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('createLoopbackAuthorizer', () => {
  it('opens the auth URL and resolves with the code from the redirect callback', async () => {
    let opened: string | undefined;
    const authorizer = await createLoopbackAuthorizer({ port: 0,
      log: () => {},
      // Stand in for the browser: the moment we are told to open the auth URL,
      // hit the loopback callback the way the authorization server would.
      open: (url) => {
        opened = url;
        const cb = new URL(authorizer.redirectUrl);
        cb.searchParams.set('code', 'auth_code_xyz');
        void fetch(cb.toString());
      },
    });
    try {
      const authUrl = new URL('https://as.example/authorize?response_type=code&state=s1');
      const code = await authorizer.authorize(authUrl, authorizer.redirectUrl);
      expect(code).toBe('auth_code_xyz');
      expect(opened).toBe(authUrl.toString());
      expect(authorizer.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    } finally {
      authorizer.close();
    }
  });

  it('binds the requested port so the redirect_uri is stable across runs', async () => {
    // The registered redirect_uri must match every run, or the auth server's
    // redirect never reaches the loopback. A given port is honored verbatim.
    const a = await createLoopbackAuthorizer({ port: 38655, log: () => {} });
    try {
      expect(a.redirectUrl).toBe('http://127.0.0.1:38655/callback');
    } finally {
      a.close();
    }
  });

  it('rejects when the callback carries an OAuth error', async () => {
    const authorizer = await createLoopbackAuthorizer({ port: 0,
      log: () => {},
      open: (_url) => {
        const cb = new URL(authorizer.redirectUrl);
        cb.searchParams.set('error', 'access_denied');
        void fetch(cb.toString());
      },
    });
    try {
      await expect(authorizer.authorize(new URL('https://as.example/authorize'), authorizer.redirectUrl)).rejects.toThrow(/access_denied/);
    } finally {
      authorizer.close();
    }
  });
});

describe('GuardOAuthProvider', () => {
  const store = new FileOAuthStore(join(mkdtempSync(join(tmpdir(), 'sg-prov-')), 's.json'));

  it('does not block on consent inside redirectToAuthorization', async () => {
    // The SDK calls redirectToAuthorization within the timeout-bound initialize
    // request, so it must return promptly even when consent never resolves.
    let consentResolve!: (code: string) => void;
    const provider = new GuardOAuthProvider({
      redirectUrl: 'http://127.0.0.1:9/callback',
      clientName: 'test',
      store,
      authorize: () => new Promise<string>((res) => { consentResolve = res; }),
    });

    const before = Date.now();
    const ret = provider.redirectToAuthorization(new URL('https://as/authorize'));
    expect(ret).toBeUndefined(); // synchronous return, not a promise awaiting consent
    expect(Date.now() - before).toBeLessThan(50);

    // The parked consent promise resolves later, out of band.
    const pending = provider.takeAuthorizationCode();
    expect(pending).toBeInstanceOf(Promise);
    consentResolve('the_code');
    await expect(pending).resolves.toBe('the_code');
  });
});

describe('FileOAuthStore', () => {
  it('round-trips client, tokens, and verifier independently and clears by scope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-store-'));
    try {
      const store = new FileOAuthStore(join(dir, 'srv.json'));
      expect(store.loadClient()).toBeUndefined();

      store.saveClient({ client_id: 'c1', redirect_uris: ['http://127.0.0.1/cb'] });
      store.saveCodeVerifier('verifier123');
      store.saveTokens({ access_token: 'at', token_type: 'Bearer', refresh_token: 'rt' });

      expect(store.loadClient()?.client_id).toBe('c1');
      expect(store.loadCodeVerifier()).toBe('verifier123');
      expect(store.loadTokens()?.access_token).toBe('at');

      store.clear('tokens');
      expect(store.loadTokens()).toBeUndefined();
      expect(store.loadClient()?.client_id).toBe('c1'); // untouched

      store.clear('all');
      expect(store.loadClient()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
