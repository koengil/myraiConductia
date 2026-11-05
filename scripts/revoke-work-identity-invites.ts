/**
 * Rollback step: revoke every pending work-identity invitation (#316).
 *
 *   EXPECT_SUPABASE_REF=<project ref> ACTOR_ID=<firm admin uuid> [COMPANY_ID=<uuid>] [CONFIRM=1] \
 *     node --env-file=.env.<target> --import tsx scripts/revoke-work-identity-invites.ts
 *
 * Without CONFIRM=1 it lists what it would revoke and changes nothing. With
 * it, each invitation goes through the existing revoke_invite RPC, which
 * revokes only a still-pending row and writes invite_revoked in the same
 * transaction. Accepted invitations, bindings and memberships are untouched.
 * Never prints a credential nonce. A hosted target needs EXPECT_SUPABASE_REF:
 * the script exits before any read or write when the URL's project ref differs
 * (scripts/lib/supabaseTarget.ts).
 */
import { createClient } from '@supabase/supabase-js';
import { TABLE } from '../src/lib/constants/tables';
import { INVITE_STATUS } from '../src/lib/constants/invites';
import { INVITE_AUTH_METHOD } from '../src/lib/constants/workIdentity';
import { assertSupabaseTarget } from './lib/supabaseTarget';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

async function main(): Promise<void> {
  const url = requiredEnv('NEXT_PUBLIC_SUPABASE_URL');
  const key = requiredEnv('SUPABASE_SECRET_KEY');
  const actor = requiredEnv('ACTOR_ID');
  const companyId = process.env.COMPANY_ID?.trim() || null;
  const confirm = process.env.CONFIRM === '1';

  const { ref } = assertSupabaseTarget(url, process.env.EXPECT_SUPABASE_REF);
  console.log(`Target: supabase ${ref}, company ${companyId ?? 'all'}, ${confirm ? 'REVOKING' : 'dry run'}`);

  const db = createClient(url, key, { auth: { persistSession: false } });
  let query = db
    .from(TABLE.INVITES)
    .select('id, email, company_id')
    .eq('status', INVITE_STATUS.PENDING)
    .eq('auth_method', INVITE_AUTH_METHOD.WORK_IDENTITY);
  if (companyId) query = query.eq('company_id', companyId);
  const { data, error } = await query;
  if (error) throw new Error(`invite read failed: ${error.message}`);

  const invites = (data ?? []) as Array<{ id: string; email: string; company_id: string }>;
  console.log(`${invites.length} pending work-identity invitations.`);
  if (!confirm) {
    for (const invite of invites) console.log(`would revoke ${invite.id} (${invite.email})`);
    return;
  }

  let failures = 0;
  for (const invite of invites) {
    const { error: revokeError } = await db.rpc('revoke_invite', {
      p_invite_id: invite.id,
      p_actor: actor,
    });
    if (revokeError && !/not_pending/.test(revokeError.message)) {
      failures += 1;
      console.error(`revoke ${invite.id} failed: ${revokeError.message}`);
    } else {
      console.log(`revoked ${invite.id}`);
    }
  }
  if (failures > 0) throw new Error(`${failures} invitations were not revoked`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
