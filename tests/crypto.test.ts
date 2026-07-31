import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv } from './helpers.js';

let encrypt: any, decrypt: any, deriveKey: any, maskValue: any;
let env: ReturnType<typeof createTestEnv>;

beforeAll(async () => {
  env = createTestEnv();
  const mod = await import('../src/storage/crypto.js');
  encrypt = mod.encrypt;
  decrypt = mod.decrypt;
  deriveKey = mod.deriveKey;
  maskValue = mod.maskValue;
});

afterAll(() => env.cleanup());

describe('deriveKey', () => {
  it('derives a 32-byte key from keyfile content and salt', async () => {
    const keyfileContent = Buffer.from('dGVzdGtleWZpbGVjb250ZW50MTIzNDU2Nzg=', 'base64');
    const salt = Buffer.alloc(16, 0xab);
    const key = await deriveKey(keyfileContent, salt);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it('produces different keys for different salts', async () => {
    const keyfileContent = Buffer.from('dGVzdGtleWZpbGVjb250ZW50MTIzNDU2Nzg=', 'base64');
    const salt1 = Buffer.alloc(16, 0xab);
    const salt2 = Buffer.alloc(16, 0xcd);
    const key1 = await deriveKey(keyfileContent, salt1);
    const key2 = await deriveKey(keyfileContent, salt2);
    expect(key1.equals(key2)).toBe(false);
  });
});

describe('encrypt/decrypt', () => {
  it('round-trips a secret value', async () => {
    const keyfileContent = Buffer.from('dGVzdGtleWZpbGVjb250ZW50MTIzNDU2Nzg=', 'base64');
    const salt = Buffer.alloc(16, 0xab);
    const key = await deriveKey(keyfileContent, salt);
    const plaintext = 'sk-test-secret-value-12345';
    const { ciphertext, iv, authTag } = encrypt(plaintext, key);
    expect(ciphertext).toBeInstanceOf(Buffer);
    expect(iv).toBeInstanceOf(Buffer);
    expect(iv.length).toBe(12);
    expect(authTag).toBeInstanceOf(Buffer);
    expect(authTag.length).toBe(16);
    const decrypted = decrypt(ciphertext, iv, authTag, key);
    expect(decrypted).toBe(plaintext);
  });

  it('fails with wrong key', async () => {
    const keyfileContent = Buffer.from('dGVzdGtleWZpbGVjb250ZW50MTIzNDU2Nzg=', 'base64');
    const salt1 = Buffer.alloc(16, 0xab);
    const salt2 = Buffer.alloc(16, 0xcd);
    const key1 = await deriveKey(keyfileContent, salt1);
    const key2 = await deriveKey(keyfileContent, salt2);
    const { ciphertext, iv, authTag } = encrypt('secret', key1);
    expect(() => decrypt(ciphertext, iv, authTag, key2)).toThrow();
  });

  it('fails with tampered ciphertext', async () => {
    const keyfileContent = Buffer.from('dGVzdGtleWZpbGVjb250ZW50MTIzNDU2Nzg=', 'base64');
    const salt = Buffer.alloc(16, 0xab);
    const key = await deriveKey(keyfileContent, salt);
    const { ciphertext, iv, authTag } = encrypt('secret', key);
    ciphertext[0] ^= 0xff;
    expect(() => decrypt(ciphertext, iv, authTag, key)).toThrow();
  });

  it('produces unique IVs per encryption', async () => {
    const keyfileContent = Buffer.from('dGVzdGtleWZpbGVjb250ZW50MTIzNDU2Nzg=', 'base64');
    const salt = Buffer.alloc(16, 0xab);
    const key = await deriveKey(keyfileContent, salt);
    const r1 = encrypt('same-value', key);
    const r2 = encrypt('same-value', key);
    expect(r1.iv.equals(r2.iv)).toBe(false);
  });
});

describe('maskValue', () => {
  it('masks a long secret showing first 4 and last 4 chars', () => {
    expect(maskValue('sk-proj-abcdefghij1234')).toBe('sk-p...1234');
  });

  it('returns **** for short secrets', () => {
    expect(maskValue('short')).toBe('****');
  });
});
