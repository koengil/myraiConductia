// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { isProductionAppEnv } from '@/lib/appEnv';
import { assertWorkerSecretKeyShape, WorkerSecretKeyShapeError } from '@/lib/supabase/secretKeyShape';

// Built from fragments so no key-shaped literal sits in the repo.
const JWT_SHAPED = ['eyJhbGciOiJIUzI1NiJ9', 'eyJyb2xlIjoic2VydmljZV9yb2xlIn0', 'canary-signature'].join('.');
const SECRET_KEY = ['sb', 'secret', 'canary0123456789'].join('_');

describe('assertWorkerSecretKeyShape (#344, design R18)', () => {
  it('refuses a JWT-shaped key in production, naming the variable and never the value', () => {
    let thrown: unknown;
    try {
      assertWorkerSecretKeyShape({ NEXT_PUBLIC_APP_ENV: 'prod', SUPABASE_SECRET_KEY: JWT_SHAPED });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkerSecretKeyShapeError);
    const message = (thrown as Error).message;
    expect(message).toContain('SUPABASE_SECRET_KEY');
    expect(message).not.toContain('canary');
    expect(message).not.toContain('eyJ');
    expect(JSON.stringify(thrown)).not.toContain('canary');
  });

  it('refuses a missing or blank key in production', () => {
    expect(() => assertWorkerSecretKeyShape({ NEXT_PUBLIC_APP_ENV: 'prod' })).toThrow(WorkerSecretKeyShapeError);
    expect(() => assertWorkerSecretKeyShape({ NEXT_PUBLIC_APP_ENV: 'prod', SUPABASE_SECRET_KEY: '  ' })).toThrow(
      WorkerSecretKeyShapeError,
    );
  });

  it('accepts an sb_secret_ key in production, surrounding whitespace included', () => {
    expect(() => assertWorkerSecretKeyShape({ NEXT_PUBLIC_APP_ENV: 'prod', SUPABASE_SECRET_KEY: SECRET_KEY })).not.toThrow();
    expect(() => assertWorkerSecretKeyShape({ NEXT_PUBLIC_APP_ENV: 'prod', SUPABASE_SECRET_KEY: ` ${SECRET_KEY}\n` })).not.toThrow();
  });

  it.each(['prod', 'production', ' PROD ', 'Production\n'])('reads %j as production, fail-closed (as the #339 gate does)', (appEnv) => {
    expect(isProductionAppEnv({ NEXT_PUBLIC_APP_ENV: appEnv })).toBe(true);
    expect(() => assertWorkerSecretKeyShape({ NEXT_PUBLIC_APP_ENV: appEnv, SUPABASE_SECRET_KEY: JWT_SHAPED })).toThrow(WorkerSecretKeyShapeError);
  });

  it('checks nothing outside production (local stacks use the JWT-shaped local key)', () => {
    for (const env of ['dev', 'staging', undefined]) {
      expect(() => assertWorkerSecretKeyShape({ NEXT_PUBLIC_APP_ENV: env, SUPABASE_SECRET_KEY: JWT_SHAPED })).not.toThrow();
    }
  });
});
