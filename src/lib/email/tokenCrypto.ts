import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Mailbox token encryption at rest, shared by every connected-mailbox provider
 * (mailbox_connections.tokens_encrypted). AES-256-GCM with the platform key
 * MAILBOX_TOKEN_KEY (32 bytes, 64 hex chars or base64).
 *
 * Stored shape: base64(iv[12] | authTag[16] | ciphertext) over the JSON of the
 * payload. The envelope carries no key id or version, so it must not change:
 * blobs written before this module existed (Graph's {accessToken,
 * refreshToken, expiresAt}) still decrypt.
 */

function keyBytes(): Buffer {
  const raw = process.env.MAILBOX_TOKEN_KEY ?? '';
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('MAILBOX_TOKEN_KEY must be 32 bytes (hex or base64)');
  return buf;
}

export function encryptTokens<T>(tokens: T): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(), iv);
  const plain = Buffer.from(JSON.stringify(tokens), 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

/** The decrypted payload, or null for a wrong key, a tampered blob or anything unreadable. */
export function decryptTokens<T = unknown>(stored: string): T | null {
  try {
    const buf = Buffer.from(stored, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as T;
  } catch {
    return null;
  }
}
