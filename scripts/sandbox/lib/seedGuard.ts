import { isProductionAppEnv } from '../../../src/lib/appEnv';
import { assertSupabaseTarget } from '../../lib/supabaseTarget';

/** Hosted dev project (ADR-0007). */
export const DEFAULT_SANDBOX_EXPECT_SUPABASE_REF = 'sqyjqdjazefceixkjtdp';

/** Production Supabase project ref; always refused for sandbox seed. */
export const PRODUCTION_SUPABASE_REF = 'fsaucpwponmzajupvsey';

export function refuseSandboxSeedInCi(apply: boolean, env: Record<string, string | undefined> = process.env): void {
  if (apply && env.CI?.trim().toLowerCase() === 'true') {
    throw new Error('Refusing: sandbox seed --apply in CI');
  }
}

export function assertSandboxSeedSupabaseTarget(
  url: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (isProductionAppEnv(env)) {
    throw new Error('Refusing: production app environment');
  }
  const expected = env.EXPECT_SUPABASE_REF?.trim() || DEFAULT_SANDBOX_EXPECT_SUPABASE_REF;
  if (expected === PRODUCTION_SUPABASE_REF) {
    throw new Error(`Refusing: EXPECT_SUPABASE_REF must not be the production project`);
  }
  const { ref } = assertSupabaseTarget(url, expected);
  if (ref === PRODUCTION_SUPABASE_REF) {
    throw new Error(`Refusing: production Supabase project ${ref}`);
  }
  return ref;
}
