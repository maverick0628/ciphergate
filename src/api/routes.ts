import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SecretsService } from '../core/secrets-service.js';
import type { AuthManager } from '../core/auth.js';
import type { GatewayConfig } from '../config.js';
import { requireAdmin } from './middleware.js';

const SECRET_NAME_REGEX = /^[A-Z][A-Z0-9_]{0,127}$/;

function isValidSecretName(name: string): boolean {
  return SECRET_NAME_REGEX.test(name);
}

export function registerRoutes(
  app: FastifyInstance,
  service: SecretsService,
  auth: AuthManager,
  config: GatewayConfig,
  startTime: number,
): void {
  // ── Health ────────────────────────────────────────────────────────────────

  app.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  // ── Get Secret ────────────────────────────────────────────────────────────

  app.get<{ Params: { name: string }; Querystring: { version?: string } }>(
    '/v1/secret/:name',
    async (request, reply) => {
      const consumer = request.consumer!;
      const { name } = request.params;

      if (!isValidSecretName(name)) {
        return reply.status(400).send({ error: 'bad_request', message: 'name must match /^[A-Z][A-Z0-9_]{0,127}$/' });
      }

      const versionParam = request.query.version;

      if (versionParam !== undefined) {
        const version = parseInt(versionParam, 10);
        if (isNaN(version)) {
          return reply.status(400).send({ error: 'bad_request', message: 'version must be a number' });
        }
        const result = service.getVersion(name, version, consumer.name, consumer.role, request.ip ?? 'unknown');
        if ('error' in result) {
          return reply.status(result.status).send({ error: result.error, message: result.message });
        }
        return reply.send(result);
      }

      const result = service.getSecret(name, consumer.name, consumer.role, request.ip ?? 'unknown');
      if ('error' in result) {
        return reply.status(result.status).send({ error: result.error, message: result.message });
      }
      return reply.send(result);
    },
  );

  // ── List Secrets ──────────────────────────────────────────────────────────

  app.get<{ Querystring: { tag?: string } }>(
    '/v1/secrets',
    async (request, reply) => {
      const consumer = request.consumer!;
      const { tag } = request.query;
      const secrets = service.listSecrets(consumer.name, tag, consumer.role);
      return reply.send({ secrets });
    },
  );

  // ── Batch Get ─────────────────────────────────────────────────────────────

  app.post<{ Body: { names: string[] } }>(
    '/v1/secrets/batch',
    async (request, reply) => {
      const consumer = request.consumer!;
      const { names } = request.body ?? {};
      if (!Array.isArray(names)) {
        return reply.status(400).send({ error: 'bad_request', message: 'body.names must be an array' });
      }
      const result = service.batchGet(names, consumer.name, consumer.role, request.ip ?? 'unknown');
      return reply.send(result);
    },
  );

  // ── Create Secret (admin) ─────────────────────────────────────────────────

  app.post<{
    Body: {
      name: string;
      value: string;
      description?: string;
      consumers: string[];
      tags: string[];
      rotation_days?: number;
    };
  }>(
    '/v1/secret',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const consumer = request.consumer!;
      const { name, value, description, consumers, tags, rotation_days } = request.body ?? {};
      if (!name || !value) {
        return reply.status(400).send({ error: 'bad_request', message: 'name and value are required' });
      }
      if (!isValidSecretName(name)) {
        return reply.status(400).send({ error: 'bad_request', message: 'name must match /^[A-Z][A-Z0-9_]{0,127}$/' });
      }
      try {
        const result = service.createSecret(
          { name, value, description, consumers: consumers ?? [], tags: tags ?? [], rotation_days },
          consumer.name,
          request.ip ?? 'unknown',
        );
        return reply.status(201).send(result);
      } catch (err: any) {
        if (err.message?.includes('UNIQUE constraint')) {
          return reply.status(409).send({ error: 'conflict', message: `Secret '${name}' already exists` });
        }
        throw err;
      }
    },
  );

  // ── Update Secret (admin) ─────────────────────────────────────────────────

  app.put<{
    Params: { name: string };
    Body: { value?: string; description?: string; consumers?: string[]; tags?: string[]; rotation_days?: number };
  }>(
    '/v1/secret/:name',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const consumer = request.consumer!;
      const { name } = request.params;
      if (!isValidSecretName(name)) {
        return reply.status(400).send({ error: 'bad_request', message: 'name must match /^[A-Z][A-Z0-9_]{0,127}$/' });
      }
      const { value, description, consumers, tags, rotation_days } = request.body ?? {};
      const result = service.updateSecret(name, { value, description, consumers, tags, rotation_days }, consumer.name, request.ip ?? 'unknown');
      return reply.send(result);
    },
  );

  // ── Delete Secret (admin) ─────────────────────────────────────────────────

  app.delete<{ Params: { name: string } }>(
    '/v1/secret/:name',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const consumer = request.consumer!;
      const { name } = request.params;
      if (!isValidSecretName(name)) {
        return reply.status(400).send({ error: 'bad_request', message: 'name must match /^[A-Z][A-Z0-9_]{0,127}$/' });
      }
      service.deleteSecret(name, consumer.name, request.ip ?? 'unknown');
      return reply.status(204).send();
    },
  );

  // ── Get Env ───────────────────────────────────────────────────────────────

  app.get<{ Querystring: { tag?: string; names?: string } }>(
    '/v1/env',
    async (request, reply) => {
      const consumer = request.consumer!;
      const { tag, names } = request.query;
      const namesList = names ? names.split(',').map(n => n.trim()).filter(Boolean) : undefined;
      const result = service.getEnv(consumer.name, consumer.role, { tag, names: namesList });
      reply.header('Content-Type', 'text/plain');
      return reply.send(result);
    },
  );

  // ── Refresh Cache (admin) ─────────────────────────────────────────────────

  app.post(
    '/v1/cache/refresh',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      service.refreshCache();
      return reply.send({ status: 'ok', message: 'Cache cleared' });
    },
  );

  // ── Audit Log (admin) ─────────────────────────────────────────────────────

  app.get<{ Querystring: { limit?: string; consumer?: string; since?: string } }>(
    '/v1/audit',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const { limit, consumer, since } = request.query;
      const entries = service.getAuditLog({
        limit: limit ? parseInt(limit, 10) : 100,
        consumer,
        since,
      });
      return reply.send({ entries });
    },
  );

  // ── Rotation Report (admin) ───────────────────────────────────────────────

  app.get(
    '/v1/rotation-report',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const result = service.rotationReport();
      return reply.send(result);
    },
  );

  // ── Secret History ────────────────────────────────────────────────────────

  app.get<{ Params: { name: string } }>(
    '/v1/secret/:name/history',
    async (request, reply) => {
      const { name } = request.params;
      const result = service.getHistory(name);
      return reply.send(result);
    },
  );

  // ── Status (admin) ────────────────────────────────────────────────────────

  app.get(
    '/v1/status',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const result = service.getStatus(config.dbPath, config.cacheTtl, config.tlsEnabled, startTime);
      return reply.send(result);
    },
  );
}
