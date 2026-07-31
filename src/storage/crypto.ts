import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import argon2 from 'argon2';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// Argon2id parameters per OWASP 2024 recommendation
const ARGON2_MEMORY_COST = 65536; // 64 MB
const ARGON2_TIME_COST = 3;
const ARGON2_PARALLELISM = 1;
const KEY_LENGTH = 32; // 256 bits

export async function deriveKey(keyfileContent: Buffer, salt: Buffer): Promise<Buffer> {
  const hash = await argon2.hash(keyfileContent, {
    type: argon2.argon2id,
    memoryCost: ARGON2_MEMORY_COST,
    timeCost: ARGON2_TIME_COST,
    parallelism: ARGON2_PARALLELISM,
    salt,
    hashLength: KEY_LENGTH,
    raw: true,
  });
  return Buffer.from(hash);
}

export function encrypt(plaintext: string, key: Buffer): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: encrypted, iv, authTag };
}

export function decrypt(ciphertext: Buffer, iv: Buffer, authTag: Buffer, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

export function maskValue(value: string): string {
  if (value.length < 12) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
