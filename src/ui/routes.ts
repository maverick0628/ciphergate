import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { StorageBackend } from '../storage/interface.js';
import type { SecretsService } from '../core/secrets-service.js';
import { isLockedOut, recordFailure, clearFailures } from '../core/lockout.js';
import { isUiConfigured, verifyUiPassword } from './credentials.js';
import {
  createSession,
  verifySession,
  destroySession,
  buildCookie,
  clearCookie,
  parseCookie,
} from './session.js';
import { getAsset, BOOTSTRAP_PAGE } from './assets.js';

/** Lockout bucket for UI password failures, separate from the API's. */
const UI_SCOPE = 'ui';

const SECRET_NAME_REGEX = /^[A-Z][A-Z0-9_]{0,127}$/;

/**
 * The UI acts as an administrator against SecretsService — that is how the list
 * shows every secret rather than one consumer's slice. Audit entries carry the
 * `ui:` prefix so UI activity is distinguishable from an API consumer's.
 */
const UI_ROLE = 'admin';

export interface UiDeps {
  storage: StorageBackend;
  service: SecretsService;
  /** True when the listener is serving HTTPS. Drives the cookie's Secure flag. */
  secure: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    uiUser?: string;
  }
}

function auditActor(user: string): string {
  return `ui:${user}`;
}

function isValidSecretName(name: string): boolean {
  return SECRET_NAME_REGEX.test(name);
}

/**
 * Validate the mutable fields of a secret write.
 *
 * Type checking here is an authorization concern, not just hygiene. Storage
 * persists `consumers` with JSON.stringify and the REST API authorizes with
 * `secret.consumers.includes(consumerName)`. Given an array that is correct
 * membership testing; given a *string* it silently becomes substring matching,
 * so a secret written with `consumers: "claude-code"` would grant access to a
 * consumer named `claude`. Anything that is not an array of strings is refused
 * before it reaches storage.
 *
 * Returns an error message, or null when the payload is acceptable.
 */
function validateSecretFields(body: {
  description?: unknown;
  consumers?: unknown;
  tags?: unknown;
  rotation_days?: unknown;
  expected_version?: unknown;
}): string | null {
  if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
    return 'description must be a string';
  }

  for (const field of ['consumers', 'tags'] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || v.trim() === '')) {
      return `${field} must be an array of non-empty strings`;
    }
  }

  const rotation = body.rotation_days;
  if (rotation !== undefined && rotation !== null) {
    if (typeof rotation !== 'number' || !Number.isInteger(rotation) || rotation < 1) {
      return 'rotation_days must be a positive integer, or null for no policy';
    }
  }

  const expected = body.expected_version;
  if (expected !== undefined) {
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1) {
      return 'expected_version must be a positive integer';
    }
  }

  return null;
}

/**
 * Reject cross-site mutating requests.
 *
 * SameSite=Strict already stops the browser from attaching the session cookie
 * to a cross-site request. This is the belt to that pair of braces, and it
 * catches the case where a browser or proxy does not honour SameSite.
 *
 * A missing Origin is allowed: non-browser clients do not send one, and the
 * browser case is covered by the cookie attribute.
 */
function originMismatch(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;

  const host = request.headers.host;
  if (!host) return true;

  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export function registerUiRoutes(app: FastifyInstance, deps: UiDeps): void {
  const { storage, service } = deps;

  app.decorateRequest('uiUser', undefined);

  // ── Public routes ─────────────────────────────────────────────────────────
  // Everything below this comment is reachable without a session. Everything
  // that touches secrets lives in the encapsulated scope at the bottom of this
  // file, where the router — not a string comparison — decides what is gated.

  // ── Static ────────────────────────────────────────────────────────────────

  app.get('/', async (_request, reply) => {
    if (!isUiConfigured(storage)) {
      return reply.type('text/html; charset=utf-8').send(BOOTSTRAP_PAGE);
    }
    const asset = getAsset('index.html');
    return reply.type(asset!.contentType).send(asset!.body);
  });

  app.get<{ Params: { '*': string } }>('/assets/*', async (request, reply) => {
    const asset = getAsset(request.params['*']);
    if (!asset) {
      return reply.status(404).send({ error: 'not_found', message: 'Unknown asset' });
    }
    return reply.type(asset.contentType).send(asset.body);
  });

  app.get('/health', async (_request, reply) => {
    return reply.send({ status: 'healthy' });
  });

  // ── Login / logout ────────────────────────────────────────────────────────

  app.post<{ Body: { user?: string; password?: string } }>('/login', async (request, reply) => {
    const ip = request.ip ?? 'unknown';

    if (!isUiConfigured(storage)) {
      return reply.status(503).send({
        error: 'ui_not_configured',
        message: 'No UI password is set. Run: gateway ui set-password',
      });
    }

    if (isLockedOut(UI_SCOPE, ip)) {
      return reply.status(429).send({
        error: 'too_many_requests',
        message: 'Too many failed attempts. Try again later.',
      });
    }

    const user = request.body?.user ?? '';
    const password = request.body?.password ?? '';

    const ok = user !== '' && password !== '' && (await verifyUiPassword(storage, user, password));

    if (!ok) {
      recordFailure(UI_SCOPE, ip);
      // Logged through the existing AuditLogger so the configured auth-failure
      // alert fires for the UI exactly as it does for the API.
      service.logUiEvent({
        consumer: auditActor(user || 'unknown'),
        action: 'auth_failure',
        secret_name: null,
        success: 0,
        ip_address: ip,
        details: null,
      });
      // Deliberately identical for an unknown user and a wrong password.
      return reply.status(401).send({ error: 'unauthorized', message: 'Invalid credentials' });
    }

    clearFailures(UI_SCOPE, ip);
    const token = createSession(storage, user);
    return reply
      .header('set-cookie', buildCookie(token, deps.secure))
      .send({ user });
  });

  app.post('/logout', async (request, reply) => {
    const token = parseCookie(request.headers.cookie);
    if (token) destroySession(storage, token);
    return reply.header('set-cookie', clearCookie(deps.secure)).send({ status: 'ok' });
  });

  // ── Gated scope ───────────────────────────────────────────────────────────
  //
  // Registered as an encapsulated plugin so the onRequest hook applies to these
  // routes and only these routes, decided by Fastify's router.
  //
  // The previous version gated on `request.url.startsWith('/api/')`, which was
  // an authentication bypass: `request.url` is the RAW url, but the router
  // matches the DECODED path, so `GET /%61pi/secrets` routed straight to the
  // handler while the string check saw no match and skipped the gate. Any
  // percent-encoding of any character in the prefix defeated it. Never gate on
  // a raw URL string.
  void app.register(async (api) => {
    api.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      const token = parseCookie(request.headers.cookie);
      const session = token ? verifySession(storage, token) : null;

      if (!session) {
        return reply.status(401).send({ error: 'unauthorized', message: 'Log in to continue' });
      }

      if (request.method !== 'GET' && request.method !== 'HEAD' && originMismatch(request)) {
        return reply.status(403).send({ error: 'forbidden', message: 'Cross-site request rejected' });
      }

      request.uiUser = session.uiUser;
    });

    registerGatedRoutes(api, deps);
  });
}

/**
 * Routes that read or write secrets. Registered only inside the authenticated
 * scope above — never on the root instance.
 */
function registerGatedRoutes(app: FastifyInstance, deps: UiDeps): void {
  const { storage, service } = deps;

  app.get('/api/session', async (request, reply) => {
    return reply.send({ user: request.uiUser });
  });

  // ── Secrets ───────────────────────────────────────────────────────────────

  app.get<{ Querystring: { tag?: string } }>('/api/secrets', async (request, reply) => {
    // listSecretsForUi, not listSecrets: the UI distinguishes "no rotation
    // policy" from "policy set and healthy", which the REST shape collapses.
    const secrets = service.listSecretsForUi(auditActor(request.uiUser!), request.query.tag);
    return reply.send({ secrets });
  });

  app.get<{ Params: { name: string } }>('/api/secrets/:name', async (request, reply) => {
    const { name } = request.params;
    if (!isValidSecretName(name)) {
      return reply.status(400).send({ error: 'bad_request', message: 'Invalid secret name' });
    }

    const detail = service.getUiDetail(name, auditActor(request.uiUser!), request.ip ?? 'unknown');
    if ('error' in detail) {
      return reply.status(detail.status).send({ error: detail.error, message: detail.message });
    }
    return reply.send(detail);
  });

  app.get<{ Params: { name: string } }>('/api/secrets/:name/history', async (request, reply) => {
    const { name } = request.params;
    if (!isValidSecretName(name)) {
      return reply.status(400).send({ error: 'bad_request', message: 'Invalid secret name' });
    }
    return reply.send(service.getHistory(name));
  });

  app.post<{
    Body: {
      name?: string;
      value?: string;
      description?: string;
      consumers?: string[];
      tags?: string[];
      rotation_days?: number | null;
    };
  }>('/api/secrets', async (request, reply) => {
    const body = request.body ?? {};
    const name = body.name ?? '';
    const value = body.value ?? '';

    if (!isValidSecretName(name)) {
      return reply.status(400).send({
        error: 'bad_request',
        message: 'Name must match /^[A-Z][A-Z0-9_]{0,127}$/',
      });
    }

    if (typeof value !== 'string') {
      return reply.status(400).send({ error: 'bad_request', message: 'value must be a string' });
    }

    // An empty value is the failure that destroys credentials. Never write one.
    if (value === '') {
      return reply.status(400).send({ error: 'bad_request', message: 'Value is required' });
    }

    const invalid = validateSecretFields(body);
    if (invalid) {
      return reply.status(400).send({ error: 'bad_request', message: invalid });
    }

    try {
      const result = service.createSecret(
        {
          name,
          value,
          description: body.description,
          consumers: body.consumers ?? [],
          tags: body.tags ?? [],
          rotation_days: body.rotation_days ?? undefined,
        },
        auditActor(request.uiUser!),
        request.ip ?? 'unknown',
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
        return reply.status(409).send({
          error: 'conflict',
          message: `Secret '${name}' already exists`,
        });
      }
      throw err;
    }
  });

  app.put<{
    Params: { name: string };
    Body: {
      value?: string;
      description?: string;
      consumers?: string[];
      tags?: string[];
      rotation_days?: number | null;
      expected_version?: number;
    };
  }>('/api/secrets/:name', async (request, reply) => {
    const { name } = request.params;
    const body = request.body ?? {};

    if (!isValidSecretName(name)) {
      return reply.status(400).send({ error: 'bad_request', message: 'Invalid secret name' });
    }

    const invalid = validateSecretFields(body);
    if (invalid) {
      return reply.status(400).send({ error: 'bad_request', message: invalid });
    }

    if (body.value !== undefined && typeof body.value !== 'string') {
      return reply.status(400).send({ error: 'bad_request', message: 'value must be a string' });
    }

    const current = storage.getSecret(name);
    if (!current) {
      return reply.status(404).send({ error: 'not_found', message: `Secret '${name}' not found` });
    }

    // A stale browser tab must not silently clobber a rotation made elsewhere.
    if (body.expected_version !== undefined && body.expected_version !== current.version) {
      return reply.status(409).send({
        error: 'conflict',
        message: `Secret '${name}' changed since this form was loaded (now at version ${current.version})`,
      });
    }

    // `value` absent means metadata-only: storage leaves the ciphertext, the
    // version and the history untouched. `value` present but empty is the
    // destructive case, and is refused.
    if (body.value !== undefined && body.value === '') {
      return reply.status(400).send({
        error: 'bad_request',
        message: 'Refusing to store an empty value. Omit the field to leave the value unchanged.',
      });
    }

    const result = service.updateSecret(
      name,
      {
        value: body.value,
        description: body.description,
        consumers: body.consumers,
        tags: body.tags,
        rotation_days: body.rotation_days ?? undefined,
      },
      auditActor(request.uiUser!),
      request.ip ?? 'unknown',
    );
    return reply.send(result);
  });

  // ── Consumers (for the picker; never key material) ────────────────────────

  app.get('/api/consumers', async (_request, reply) => {
    const consumers = storage
      .listConsumers()
      .filter(c => c.is_active)
      .map(c => ({ name: c.name, role: c.role }));
    return reply.send({ consumers });
  });
}
