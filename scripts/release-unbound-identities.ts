/**
 * Release a user's unbound work identities (#316).
 *
 *   USER_ID=<uuid> [PROVIDER=google|azure] \
 *     node --env-file=.env.<target> --import tsx scripts/release-unbound-identities.ts
 *
 * Deletes the user's provider identities that no work_identity_bindings row
 * claims, so a person refused with work_identity_not_connected can sign in
 * with their existing method and connect their work account from a fully
 * signed-in session. Bound identities, email/phone identities, memberships
 * and audit history are untouched. The release_unbound_identities RPC writes
 * work_identity_released in the same transaction.
 */
import { createClient } from '@supabase/supabase-js';
import { isWorkIdentityProvider } from '../src/lib/constants/workIdentity';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

async function main(): Promise<void> {
  const url = requiredEnv('NEXT_PUBLIC_SUPABASE_URL');
  const key = requiredEnv('SUPABASE_SECRET_KEY');
  const userId = requiredEnv('USER_ID');
  const provider = process.env.PROVIDER?.trim().toLowerCase() || null;
  if (provider !== null && !isWorkIdentityProvider(provider)) {
    throw new Error('PROVIDER must be google or azure when set');
  }

  const ref = new URL(url).hostname.split('.')[0];
  console.log(`Target: supabase ${ref}, user ${userId}, provider ${provider ?? 'any'}`);

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db.rpc('release_unbound_identities', {
    p_user_id: userId,
    p_provider: provider,
  });
  if (error) throw new Error(`release_unbound_identities failed: ${error.message}`);
  console.log(`Released ${Number(data ?? 0)} unbound identities.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
