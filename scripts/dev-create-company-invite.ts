/**
 * Dev-only: create a pending company invite (no email).
 *
 *   ACTOR_EMAIL=zaqa7jn@tokmail.net INVITEE_EMAIL=tm2@co.net COMPANY_ID=... npm run dev:create-invite
 */
import { createClient } from '@supabase/supabase-js';
import {
  digestInviteChallengeCode,
  generateInviteChallengeCode,
} from '../src/lib/api/v1/inviteChallenge';
import { COMPANY_ROLE } from '../src/lib/constants/roles';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const actorEmail = process.env.ACTOR_EMAIL?.trim().toLowerCase();
const inviteeEmail = process.env.INVITEE_EMAIL?.trim().toLowerCase();
const companyId = process.env.COMPANY_ID?.trim();
const companyRole = process.env.COMPANY_ROLE?.trim() || COMPANY_ROLE.MEMBER;

if (process.env.NEXT_PUBLIC_APP_ENV !== 'dev') {
  throw new Error('dev:create-invite is allowed only when NEXT_PUBLIC_APP_ENV=dev');
}
if (!url || !secret || !actorEmail || !inviteeEmail || !companyId) {
  throw new Error('Set ACTOR_EMAIL, INVITEE_EMAIL, COMPANY_ID');
}
if (!process.env.INVITE_VERIFICATION_PEPPER) {
  throw new Error('INVITE_VERIFICATION_PEPPER is required (.env.local).');
}

const admin = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });

async function main(): Promise<void> {
  const { data: actor, error: actorError } = await admin
    .from('users')
    .select('id')
    .eq('email', actorEmail)
    .maybeSingle();
  if (actorError || !actor) throw new Error(`Actor not found: ${actorError?.message ?? 'missing'}`);

  const { data: existing } = await admin
    .from('invites')
    .select('id')
    .eq('email', inviteeEmail)
    .eq('status', 'pending')
    .maybeSingle();
  if (existing?.id) {
    console.log(`Pending invite already exists: ${existing.id}`);
    return;
  }

  const { data: inviteResult, error } = await admin.rpc('create_invite', {
    p_actor: actor.id,
    p_email: inviteeEmail,
    p_company_id: companyId,
    p_company_role: companyRole,
    p_challenge_digest: digestInviteChallengeCode(generateInviteChallengeCode()),
    p_domain_confirmation_id: null,
    p_deal_id: null,
    p_deal_role: null,
  });
  if (error) throw new Error(error.message);
  console.log(`Created invite: ${(inviteResult as { id: string }).id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
