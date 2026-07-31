import argon2 from 'argon2';
import type { StorageBackend } from '../storage/interface.js';

/**
 * Minimum UI password length. The UI can read and write every secret in the
 * store, so this is a deliberately higher bar than a throwaway login.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** True once at least one UI credential exists. */
export function isUiConfigured(storage: StorageBackend): boolean {
  return storage.countUiCredentials() > 0;
}

/**
 * Set or rotate a UI password. Argon2id with library defaults, which salt each
 * hash independently.
 */
export async function setUiPassword(
  storage: StorageBackend,
  name: string,
  password: string,
): Promise<void> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  storage.setUiCredential(name, hash);
}

/**
 * Verify a password. Returns false for an unknown user rather than throwing, so
 * callers cannot distinguish "no such user" from "wrong password" — and neither
 * can anyone probing the login route.
 */
export async function verifyUiPassword(
  storage: StorageBackend,
  name: string,
  password: string,
): Promise<boolean> {
  const credential = storage.getUiCredential(name);
  if (!credential) return false;
  try {
    return await argon2.verify(credential.password_hash, password);
  } catch {
    // A malformed stored hash must read as "wrong password", never as an error
    // that leaks what is in the column.
    return false;
  }
}
