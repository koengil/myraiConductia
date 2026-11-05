import { createHmac } from 'node:crypto';

import { isProductionAppEnv } from '@/lib/appEnv';

/**
 * The message index's content digest (#461, D93; owner, 2026-10-17): an HMAC-SHA256 of the message's contentHash
 * under a key derived per tenant from the deployment secret DISCOVERY_INDEX_DIGEST_KEY, never an unsalted hash. A
 * holder of the index cannot confirm a guessed message without the key, and one tenant's digests say nothing about
 * another's. It is keyed now because purged content cannot be re-keyed later. The key and the content are never
 * logged, and no error names the key's value.
 *
 * Production (NEXT_PUBLIC_APP_ENV=prod) refuses to write without the secret. Elsewhere (local, CI, the demo replay)
 * a fixed development key stands in, so a missing secret never blocks a dev stack and never reaches production.
 */
export const INDEX_DIGEST_KEY_ENV = 'DISCOVERY_INDEX_DIGEST_KEY';
export const INDEX_DIGEST_PREFIX = 'hmac-sha256:';
/** The one form the database accepts (the CHECK on discovery_message_index.content_digest). */
export const INDEX_DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
/** The shortest secret accepted: 32 characters (`openssl rand -hex 32` gives 64). */
export const INDEX_DIGEST_KEY_MIN_LENGTH = 32;

/** Domain-separates the per-tenant key from any other use of the secret. */
const PURPOSE = 'conductia:discovery-index-digest:v1:';
const DEV_KEY = 'conductia-development-only-index-digest-key';

export class IndexDigestKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexDigestKeyError';
  }
}

type Env = Record<string, string | undefined>;

function secret(env: Env): Buffer {
  const raw = env[INDEX_DIGEST_KEY_ENV]?.trim();
  if (raw) {
    if (raw.length < INDEX_DIGEST_KEY_MIN_LENGTH) {
      throw new IndexDigestKeyError(`${INDEX_DIGEST_KEY_ENV} is shorter than ${INDEX_DIGEST_KEY_MIN_LENGTH} characters`);
    }
    return Buffer.from(raw, 'utf8');
  }
  if (isProductionAppEnv(env)) throw new IndexDigestKeyError(`${INDEX_DIGEST_KEY_ENV} is not set`);
  return Buffer.from(DEV_KEY, 'utf8');
}

/**
 * The digest function for one tenant: derives the tenant's key once, then digests each contentHash with it. Throws
 * IndexDigestKeyError (in production, before any digest) when the secret is missing or too short.
 */
export function indexDigester(tenantId: string, env: Env = process.env): (contentHash: string) => string {
  if (!tenantId) throw new IndexDigestKeyError('index digest needs a tenant');
  const key = createHmac('sha256', secret(env)).update(PURPOSE + tenantId, 'utf8').digest();
  return (contentHash) => INDEX_DIGEST_PREFIX + createHmac('sha256', key).update(contentHash, 'utf8').digest('hex');
}
