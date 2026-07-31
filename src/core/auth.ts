import { createHash, randomBytes } from 'node:crypto';
import type { Consumer } from '../types.js';
import type { StorageBackend } from '../storage/interface.js';

export interface AuthResult {
  consumer: Consumer | null;
  reason?: 'invalid' | 'revoked' | 'expired';
  expiresAt?: string;
}

export class AuthManager {
  constructor(private storage: StorageBackend) {}

  createConsumer(name: string, role: 'reader' | 'admin', description?: string, expiresAt?: string): { apiKey: string; consumer: Consumer } {
    const apiKey = randomBytes(32).toString('base64');
    const hash = this.hashKey(apiKey);
    const consumer = this.storage.createConsumer(name, hash, role, description, expiresAt);
    return { apiKey, consumer };
  }

  authenticate(apiKey: string): AuthResult {
    const hash = this.hashKey(apiKey);
    const consumer = this.storage.getConsumerByKeyHash(hash);
    if (!consumer) return { consumer: null, reason: 'invalid' };
    if (!consumer.is_active) return { consumer: null, reason: 'revoked' };
    if (consumer.expires_at && new Date(consumer.expires_at) < new Date()) {
      return { consumer: null, reason: 'expired', expiresAt: consumer.expires_at };
    }
    return { consumer };
  }

  isAuthorized(consumerName: string, secretConsumers: string[], role: string = 'reader'): boolean {
    if (role === 'admin') return true;
    return secretConsumers.includes(consumerName);
  }

  rotateKey(name: string, expiresAt?: string): { apiKey: string; consumer: Consumer } {
    const apiKey = randomBytes(32).toString('base64');
    const hash = this.hashKey(apiKey);
    const consumer = this.storage.rotateConsumerKey(name, hash, expiresAt);
    return { apiKey, consumer };
  }

  private hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }
}
