import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AuthManager } from '../core/auth.js';
import type { Consumer } from '../types.js';
import { isLockedOut, recordFailure, resetLockoutState } from '../core/lockout.js';

/** Lockout bucket for REST API bearer-token failures. */
const API_SCOPE = 'api';

// Extend Fastify request to carry the authenticated consumer
declare module 'fastify' {
  interface FastifyRequest {
    consumer?: Consumer;
  }
}

// Per-consumer rate limit tracking
interface WindowEntry {
  count: number;
  resetAt: number;
}

export const consumerWindows = new Map<string, Map<string, WindowEntry>>();

/** Reset all rate-limit and auth-failure state — for use in tests only. */
export function resetRateLimitState(): void {
  consumerWindows.clear();
  resetLockoutState();
}

const RATE_LIMITS: Array<{ pattern: RegExp; method: string; limit: number }> = [
  { pattern: /^\/v1\/secret\/[^/]+$/, method: 'GET', limit: 60 },
  { pattern: /^\/v1\/secrets\/batch$/, method: 'POST', limit: 20 },
  { pattern: /^\/v1\/env$/, method: 'GET', limit: 10 },
  { pattern: /^\/v1\/secret$/, method: 'POST', limit: 10 },
];

function getLimitForRequest(method: string, path: string): number {
  for (const rule of RATE_LIMITS) {
    if (rule.method === method && rule.pattern.test(path)) {
      return rule.limit;
    }
  }
  return 60; // default
}

function isRateLimited(consumerName: string, key: string, limit: number): boolean {
  const now = Date.now();
  const windowMs = 60 * 1000;

  if (!consumerWindows.has(consumerName)) {
    consumerWindows.set(consumerName, new Map());
  }
  const windows = consumerWindows.get(consumerName)!;
  const entry = windows.get(key);

  if (!entry || now >= entry.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }

  entry.count++;
  if (entry.count > limit) return true;
  return false;
}

function checkAuthFailureLimit(ip: string): boolean {
  return isLockedOut(API_SCOPE, ip);
}

export function recordAuthFailure(ip: string): void {
  recordFailure(API_SCOPE, ip);
}

export function registerAuth(app: FastifyInstance, auth: AuthManager): void {
  // Decorate request with consumer property
  app.decorateRequest('consumer', undefined);

  // Auth hook for all /v1/* routes
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/v1/')) return;

    const ip = request.ip ?? 'unknown';

    // Check if IP is locked out due to too many auth failures
    if (checkAuthFailureLimit(ip)) {
      return reply.status(429).send({ error: 'too_many_requests', message: 'Too many failed authentication attempts. Try again later.' });
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // Missing header is not a brute-force attempt — don't count toward lockout
      return reply.status(401).send({ error: 'unauthorized', message: 'Invalid or missing API key' });
    }

    const token = authHeader.slice('Bearer '.length).trim();
    const result = auth.authenticate(token);

    if (result.reason === 'expired') {
      recordAuthFailure(ip);
      return reply.status(401).send({ error: 'key_expired', message: `Consumer API key expired at ${result.expiresAt}` });
    }

    if (result.reason === 'revoked' || result.reason === 'invalid') {
      recordAuthFailure(ip);
      return reply.status(401).send({ error: 'unauthorized', message: 'Invalid or missing API key' });
    }

    // Valid — attach consumer to request
    request.consumer = result.consumer!;
  });
}

export function registerRateLimiter(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/v1/')) return;
    if (!request.consumer) return; // Auth hook will handle the 401

    const consumerName = request.consumer.name;
    const path = request.url.split('?')[0];
    const method = request.method;
    const limit = getLimitForRequest(method, path);
    const key = `${method}:${path}`;

    if (isRateLimited(consumerName, key, limit)) {
      return reply.status(429).send({ error: 'rate_limited', message: `Rate limit exceeded. Max ${limit} requests/minute for this endpoint.` });
    }
  });
}

export function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.consumer || request.consumer.role !== 'admin') {
    reply.status(403).send({ error: 'forbidden', message: 'Admin access required' });
    return false;
  }
  return true;
}
