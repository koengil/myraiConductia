// @vitest-environment node
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  INDEX_DIGEST_KEY_ENV,
  INDEX_DIGEST_PATTERN,
  IndexDigestKeyError,
  indexDigester,
} from '@/lib/discovery/indexDigest';

// The message index's digest is keyed per tenant (#461, D93; owner, 2026-10-17): never the unsalted hash, different
// across tenants and keys, stable for one tenant and key, and production refuses to write without the secret.

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SECRET = 'k'.repeat(64);
const HASH = createHash('sha256').update('Project Falcon update\nbody').digest('hex');
const prod = (key?: string) => ({ NEXT_PUBLIC_APP_ENV: 'prod', ...(key === undefined ? {} : { [INDEX_DIGEST_KEY_ENV]: key }) });

describe('indexDigester', () => {
  it('writes hmac-sha256: and 64 hex, never the hash it was given', () => {
    const digest = indexDigester(A, prod(SECRET))(HASH);
    expect(digest).toMatch(INDEX_DIGEST_PATTERN);
    expect(digest).not.toContain(HASH);
  });

  it('is stable for one tenant and key, and differs across tenants and keys', () => {
    const a = indexDigester(A, prod(SECRET))(HASH);
    expect(indexDigester(A, prod(SECRET))(HASH)).toBe(a);
    expect(indexDigester(B, prod(SECRET))(HASH)).not.toBe(a);
    expect(indexDigester(A, prod('j'.repeat(64)))(HASH)).not.toBe(a);
  });

  it('refuses in production without the secret, or with a short one, and never names the value', () => {
    expect(() => indexDigester(A, prod())).toThrow(new IndexDigestKeyError(`${INDEX_DIGEST_KEY_ENV} is not set`));
    expect(() => indexDigester(A, prod('   '))).toThrow(IndexDigestKeyError);
    let message = '';
    try {
      indexDigester(A, prod('short-secret'));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/shorter than 32/);
    expect(message).not.toContain('short-secret');
  });

  it('uses a development key outside production, which is not the production key', () => {
    const dev = indexDigester(A, {})(HASH);
    expect(dev).toMatch(INDEX_DIGEST_PATTERN);
    expect(dev).not.toBe(indexDigester(A, prod(SECRET))(HASH));
  });

  it('refuses a missing tenant', () => {
    expect(() => indexDigester('', prod(SECRET))).toThrow(IndexDigestKeyError);
  });
});
