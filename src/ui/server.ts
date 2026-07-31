import Fastify, { type FastifyInstance } from 'fastify';
import { registerUiRoutes, type UiDeps } from './routes.js';
import { resolveUiTls } from './tls.js';

export type { UiDeps };

export interface UiServerOptions extends UiDeps {
  logger?: boolean;
}

/**
 * Build the UI Fastify instance without listening. Kept separate from
 * `startUiServer` so tests can drive it through `inject()`.
 */
export function buildUiApp(deps: UiServerOptions): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });
  registerUiRoutes(app, deps);
  return app;
}

export interface StartUiServerOptions extends Omit<UiDeps, 'secure'> {
  host: string;
  port: number;
  /** Where a generated certificate is written. Normally the gateway data dir. */
  dataDir: string;
  tlsCertPath: string | null;
  tlsKeyPath: string | null;
  logger?: boolean;
}

export interface StartedUiServer {
  app: FastifyInstance;
  secure: boolean;
  address: string;
}

/**
 * Start the UI listener.
 *
 * TLS is resolved first because the cookie's Secure flag depends on whether the
 * listener actually ends up serving HTTPS. When no certificate can be resolved
 * the listener falls back to plain HTTP: degrading is better than refusing to
 * start, since the moment someone needs this is the moment they need to rotate
 * a credential.
 */
export async function startUiServer(opts: StartUiServerOptions): Promise<StartedUiServer> {
  const tls = resolveUiTls({
    dataDir: opts.dataDir,
    certPath: opts.tlsCertPath,
    keyPath: opts.tlsKeyPath,
  });

  const secure = tls !== null;

  const app = Fastify({
    logger: opts.logger ?? false,
    ...(tls ? { https: { cert: tls.cert, key: tls.key } } : {}),
  });

  registerUiRoutes(app, {
    storage: opts.storage,
    service: opts.service,
    secure,
  });

  await app.listen({ port: opts.port, host: opts.host });

  return {
    app,
    secure,
    address: `${secure ? 'https' : 'http'}://${opts.host}:${opts.port}`,
  };
}
