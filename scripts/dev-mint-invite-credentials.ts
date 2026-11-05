/**
 * Dev-only: mint a fresh invite link + verification code WITHOUT sending email.
 * Use when Resend sandbox blocks delivery (e.g. testing emails outside the
 * account owner's address).
 *
 *   INVITE_ID=... npm run dev:mint-invite
 *   INVITEE_EMAIL=cwiofesfztwiobrusj@jbsze.net npm run dev:mint-invite
 *
 * Prints the accept URL and six-digit code to stdout. Also marks delivery as
 * sent (finalize_invite_delivery) so verify + accept can proceed.
 */
import { createClient } from '@supabase/supabase-js';
import {
  digestInviteChallengeCode,
  generateInviteChallengeCode,
} from '../src/lib/api/v1/inviteChallenge';
import { emailInviteAppMetadata } from '../src/lib/auth/mfaPolicy';
import { COMPANY_TYPE } from '../src/lib/constants/companies';
import { USER_STATUS } from '../src/lib/constants/users';
import { INVITE_AUTH_METHOD, USER_PROVISIONING } from '../src/lib/constants/workIdentity';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const inviteId = process.env.INVITE_ID?.trim();
const inviteeEmail = process.env.INVITEE_EMAIL?.trim().toLowerCase();
const origin = (process.env.APP_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');

if (process.env.NEXT_PUBLIC_APP_ENV !== 'dev') {
  throw new Error('dev-mint-invite is allowed only when NEXT_PUBLIC_APP_ENV=dev');
}
if (!url || !secret) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required (.env.local).');
}
if (!inviteId && !inviteeEmail) {
  throw new Error('Set INVITE_ID or INVITEE_EMAIL');
}
if (!process.env.INVITE_VERIFICATION_PEPPER) {
  throw new Error('INVITE_VERIFICATION_PEPPER is required (.env.local).');
}

const admin = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });

function inviteMetadata(invite: {
  id: string;
  credentialNonce: string;
  tenantId: string;
  isExternal: boolean;
}) {
  return {
    invite_id: invite.id,
    credential_nonce: invite.credentialNonce,
    is_external: invite.isExternal,
    tenant_id: invite.tenantId,
  };
}

function isExistingIdentityError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === 'email_exists') return true;
  return /already.*registered/i.test(error.message ?? '');
}

async function mintActionLink(
  invite: {
    id: string;
    email: string;
    credentialNonce: string;
    tenantId: string;
    isExternal: boolean;
  },
): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'invite',
    email: invite.email,
    options: {
      data: inviteMetadata(invite),
      redirectTo: `${origin}/accept-invite`,
    },
  });

  if (!error && data?.properties?.action_link) {
    const authUserId = data.user?.id ?? null;
    if (!authUserId) throw new Error('containment_failed_no_auth_user');
    const { data: contained, error: containError } = await admin
      .from('users')
      .update({ status: USER_STATUS.INVITED })
      .eq('id', authUserId)
      .is('company_id', null)
      .select('id');
    if (containError || !contained || contained.length !== 1) {
      throw new Error('containment_failed');
    }
    const { error: markerError } = await admin.auth.admin.updateUserById(authUserId, {
      app_metadata: emailInviteAppMetadata(),
    });
    if (markerError) throw new Error('mfa_policy_marker_failed');
    return data.properties.action_link;
  }

  if (!isExistingIdentityError(error)) {
    throw new Error(error?.message ?? 'link_generation_failed');
  }

  const { data: mirror, error: mirrorError } = await admin
    .from('users')
    .select('id, status, company_id, tenant_id, provisioning')
    .eq('email', invite.email)
    .maybeSingle();
  if (mirrorError || !mirror) throw new Error('containment_failed_no_mirror');
  // A contained profile is pre-tenant (tenant_id = its own id), so it is
  // compatible with any invite tenant; acceptance writes the real one.
  if (mirror.provisioning !== USER_PROVISIONING.CONTAINED && mirror.tenant_id !== invite.tenantId) {
    throw new Error('tenant_mismatch_no_credential');
  }
  if (mirror.company_id !== null) throw new Error('active_account_no_credential');
  if (mirror.status !== USER_STATUS.INVITED && mirror.status !== USER_STATUS.ACTIVE) {
    throw new Error('active_account_no_credential');
  }
  if (mirror.status === USER_STATUS.ACTIVE) {
    const { data: repaired, error: repairError } = await admin
      .from('users')
      .update({ status: USER_STATUS.INVITED })
      .eq('id', mirror.id as string)
      .eq('status', USER_STATUS.ACTIVE)
      .eq('tenant_id', invite.tenantId)
      .is('company_id', null)
      .select('id');
    if (repairError || !repaired || repaired.length !== 1) throw new Error('containment_failed');
  }

  const { error: metadataError } = await admin.auth.admin.updateUserById(mirror.id as string, {
    user_metadata: inviteMetadata(invite),
    app_metadata: emailInviteAppMetadata(),
  });
  if (metadataError) throw new Error('credential_rotation_failed');

  const magic = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: invite.email,
    options: { redirectTo: `${origin}/accept-invite` },
  });
  if (magic.error || !magic.data?.properties?.action_link) {
    throw new Error(magic.error?.message ?? 'link_generation_failed');
  }
  return magic.data.properties.action_link;
}

async function main(): Promise<void> {
  let query = admin
    .from('invites')
    .select('id, email, company_id, tenant_id, status')
    .eq('status', 'pending')
    .eq('auth_method', INVITE_AUTH_METHOD.EMAIL_CODE);
  query = inviteId ? query.eq('id', inviteId) : query.eq('email', inviteeEmail as string);
  const { data: invite, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!invite) throw new Error('No pending invite found for that id/email.');

  const { data: company, error: companyError } = await admin
    .from('companies')
    .select('type, name')
    .eq('id', invite.company_id)
    .maybeSingle();
  if (companyError || !company) throw new Error('Company not found');

  const verificationCode = generateInviteChallengeCode();
  const challengeDigest = digestInviteChallengeCode(verificationCode);

  const { data: rotated, error: rotateError } = await admin.rpc('rotate_invite_credential', {
    p_invite_id: invite.id,
    p_challenge_digest: challengeDigest,
  });
  if (rotateError) throw new Error(rotateError.message);

  const credentialNonce = (rotated as { credential_nonce: string }).credential_nonce;
  const actionLink = await mintActionLink({
    id: invite.id as string,
    email: invite.email as string,
    credentialNonce,
    tenantId: invite.tenant_id as string,
    isExternal: company.type !== COMPANY_TYPE.BANK,
  });

  const { error: finalizeError } = await admin.rpc('finalize_invite_delivery', {
    p_invite_id: invite.id,
  });
  if (finalizeError) throw new Error(finalizeError.message);

  console.log('');
  console.log('Invite credentials (dev — not emailed)');
  console.log('=====================================');
  console.log(`Company:  ${company.name} (${company.type})`);
  console.log(`Email:    ${invite.email}`);
  console.log(`Invite:   ${invite.id}`);
  console.log('');
  console.log('Verification code (enter on /accept-invite):');
  console.log(`  ${verificationCode}`);
  console.log('');
  console.log('Accept link (open in a private window):');
  console.log(`  ${actionLink}`);
  console.log('');
  console.log('Flow: open link → enter code → set password → complete accept.');
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
