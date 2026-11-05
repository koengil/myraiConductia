// The worker's Supabase key must be a revocable secret key in production (#344,
// design R18). Deleting a secret key (sb_secret_…) in the dashboard cuts REST
// access at once (kill-switch lever 3); the legacy JWT service_role key survives
// that deletion, so a task holding it would outlive the lever. Every entry the
// worker image runs calls this before it builds a client: the classify service
// and classify-once (serviceClientFromEnv), and the probe whenever it asks the
// guard on a database (--tenant, and a laptop run with --guard-db).

import { isProductionAppEnv } from '@/lib/appEnv';

import { SUPABASE_ENV_KEYS } from './config';

type Env = Record<string, string | undefined>;

export const SUPABASE_SECRET_KEY_PREFIX = 'sb_secret_';

export class WorkerSecretKeyShapeError extends Error {
  override readonly name = 'WorkerSecretKeyShapeError';
  constructor() {
    // Names the variable, never the value.
    super(
      `${SUPABASE_ENV_KEYS.secretKey} must be a Supabase secret key (${SUPABASE_SECRET_KEY_PREFIX}…) in production; ` +
        'the legacy JWT service_role key is refused',
    );
  }
}

/** In production, refuses any SUPABASE_SECRET_KEY that is missing or does not start with sb_secret_. */
export function assertWorkerSecretKeyShape(env: Env = process.env): void {
  if (!isProductionAppEnv(env)) return;
  const key = env[SUPABASE_ENV_KEYS.secretKey]?.trim();
  if (!key || !key.startsWith(SUPABASE_SECRET_KEY_PREFIX)) throw new WorkerSecretKeyShapeError();
}
