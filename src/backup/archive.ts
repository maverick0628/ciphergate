/**
 * Encrypt-at-rest for backup payloads that aren't already encrypted (the Qdrant
 * snapshots and Letta agent exports — the gateway DB arrives encrypted already).
 *
 * Same primitives as the gateway's secret store: argon2id KDF + AES-256-GCM
 * (see {@link deriveKey} in src/storage/crypto.ts). Output is self-describing so
 * a restore needs only the passphrase:
 *
 *   [ salt(16) | iv(12) | authTag(16) | ciphertext ]
 *
 * A random per-object salt means identical inputs never produce identical
 * ciphertext, and GCM's auth tag makes tampering (or a wrong key) a hard failure.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveKey } from '../storage/crypto.js';

const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const ALGO = 'aes-256-gcm';

/** Encrypt arbitrary bytes under a passphrase. Returns the self-describing blob. */
export async function sealBuffer(plaintext: Buffer, passphrase: string): Promise<Buffer> {
  const salt = randomBytes(SALT_LEN);
  const key = await deriveKey(Buffer.from(passphrase, 'utf8'), salt);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, ciphertext]);
}

/** Decrypt a blob produced by {@link sealBuffer}. Throws on a wrong key or tampering. */
export async function openBuffer(sealed: Buffer, passphrase: string): Promise<Buffer> {
  if (sealed.length < SALT_LEN + IV_LEN + TAG_LEN) throw new Error('sealed blob too short');
  const salt = sealed.subarray(0, SALT_LEN);
  const iv = sealed.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const authTag = sealed.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const ciphertext = sealed.subarray(SALT_LEN + IV_LEN + TAG_LEN);
  const key = await deriveKey(Buffer.from(passphrase, 'utf8'), Buffer.from(salt));
  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
