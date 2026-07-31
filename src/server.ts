import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig } from './config.js';
import { SqliteStorage } from './storage/sqlite.js';
import { deriveKey } from './storage/crypto.js';
import { SecretCache } from './core/cache.js';
import { AuthManager } from './core/auth.js';
import { AuditLogger } from './core/audit.js';
import { SecretsService } from './core/secrets-service.js';
import { registerRoutes } from './api/routes.js';
import { registerAuth, registerRateLimiter } from './api/middleware.js';
import { startUiServer } from './ui/server.js';
import { isUiConfigured } from './ui/credentials.js';

async function main() {
  const config = loadConfig();

  // Read keyfile
  const keyfileContent = readFileSync(config.keyfilePath);

  // Init storage
  const storage = new SqliteStorage(config.dbPath, config.maxHistory);

  // Get or create salt
  let salt: Buffer;
  try { salt = storage.getSalt(); }
  catch {
    salt = randomBytes(32);
    storage.setSalt(salt);
  }

  // Derive encryption key
  const encryptionKey = await deriveKey(keyfileContent, salt);

  // Init components
  const cache = new SecretCache(config.cacheTtl);
  const auth = new AuthManager(storage);
  const audit = new AuditLogger(storage, {
    enabled: config.pushoverEnabled,
    appToken: config.pushoverAppToken ?? '',
    userKey: config.pushoverUserKey ?? '',
    alertAuthFailure: config.alertAuthFailure,
    alertDelete: config.alertDelete,
    alertUpdate: config.alertUpdate,
    alertCreate: config.alertCreate,
    alertRead: config.alertRead,
    alertList: config.alertList,
    alertRotationWarning: config.alertRotationWarning,
    minSeverity: config.alertMinSeverity,
    rateLimitMax: config.alertRateLimitMax,
    rateLimitWindowSec: config.alertRateLimitWindowSec,
  });
  const service = new SecretsService(storage, encryptionKey, cache, audit);

  // Create Fastify app with optional TLS
  const fastifyOpts: Record<string, unknown> = { logger: config.logLevel !== 'error' };
  if (config.tlsEnabled && config.tlsCert && config.tlsKey) {
    fastifyOpts.https = {
      cert: readFileSync(config.tlsCert),
      key: readFileSync(config.tlsKey),
    };
  }
  const app = Fastify(fastifyOpts);

  // Register middleware
  registerAuth(app, auth);
  if (config.rateLimitEnabled) registerRateLimiter(app);

  // Register routes
  const startTime = Date.now();
  registerRoutes(app, service, auth, config, startTime);

  // Start
  await app.listen({ port: config.port, host: config.host });
  console.log(`CipherGate listening on ${config.host}:${config.port}`);

  // Browser UI on its own listener. Failures here must never stop the API from
  // serving — the gateway's job is handing credentials to consumers, and an
  // admin panel that cannot start is not a reason to take that down.
  let uiApp: FastifyInstance | null = null;
  if (config.uiEnabled) {
    try {
      const ui = await startUiServer({
        storage,
        service,
        host: config.uiHost,
        port: config.uiPort,
        dataDir: dirname(config.dbPath),
        tlsCertPath: config.uiTlsCert,
        tlsKeyPath: config.uiTlsKey,
        logger: config.logLevel !== 'error',
      });
      uiApp = ui.app;
      console.log(`CipherGate UI listening on ${ui.address}`);
      if (!ui.secure) {
        console.warn(
          'UI is serving plain HTTP: no certificate could be resolved or generated. ' +
            'Secret values will cross the network in the clear when written.',
        );
      }
      if (!isUiConfigured(storage)) {
        console.warn('UI has no password set. Run `gateway ui set-password` to enable it.');
      }
    } catch (err) {
      console.error(`UI failed to start: ${(err as Error).message}`);
    }
  }

  // Graceful shutdown
  const shutdown = () => {
    void uiApp?.close();
    storage.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => { console.error(err); process.exit(1); });
