import { modelCallsAllowed, type ModelCallDecision, type ModelPurpose } from '@/lib/ai/modelPolicy';
import { DEV_TENANT_ID } from '@/lib/db/tenant';

/*
 * Real model-gate decisions for tests (#339). The minter takes no env and no
 * policy, so a test mints the way production does: through modelCallsAllowed
 * under a process.env that says what the test needs, restored afterwards.
 */

export type TestEnv = Record<string, string | undefined>;

/** A local stack that says it is dev: the DEV tenant's synthetic path. */
export const LOCAL_DEV_ENV: TestEnv = { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', NEXT_PUBLIC_APP_ENV: 'dev' };
/** A hosted stack: every tenant withheld while the verified list ships empty. */
export const HOSTED_ENV: TestEnv = { NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', NEXT_PUBLIC_APP_ENV: undefined };

/** modelCallsAllowed under `env`, with process.env restored whatever happens. */
export function mintUnderEnv(env: TestEnv, tenantId: string | null, purpose: ModelPurpose): ModelCallDecision {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const apply = (values: TestEnv) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(env);
  try {
    return modelCallsAllowed(tenantId, purpose);
  } finally {
    apply(saved);
  }
}

/** An allowed decision: the DEV tenant on a local dev stack (basis synthetic_tenant). */
export const allowedDecision = (purpose: ModelPurpose) => mintUnderEnv(LOCAL_DEV_ENV, DEV_TENANT_ID, purpose);
/** A withheld decision: a real tenant on a hosted stack (reason not_local). */
export const withheldDecision = (purpose: ModelPurpose) => mintUnderEnv(HOSTED_ENV, 'tenant-1', purpose);
