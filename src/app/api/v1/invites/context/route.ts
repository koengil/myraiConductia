import { NextResponse } from 'next/server';
import { inviteContextMissing, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { USER_PROVISIONING } from '@/lib/constants/workIdentity';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { fetchInviteEmailContext } from '@/lib/api/v1/inviteDelivery';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { INVITE_STATUS } from '@/lib/constants/invites';

/**
 * Acceptance context for the signed-in invitee (spec-v3 criterion 3,
 * cr-prr-124 1.1, re-scoped per cr-prr-124-r2 1.1): who invited them, into
 * which company, and the deal codename when the invite carries a deal. The
 * invite id arrives via auth metadata, but metadata is client-mutable
 * (auth.updateUser), so it is treated as a hint only — the invite is bound to
 * the caller's authenticated email and tenant before anything is returned,
 * and any mismatch 404s exactly like a missing invite (no oracle).
 */
export async function GET() {
  const gate = await requireFlag('platform_onboarding');
  if (gate) return gate;

  const auth = await requireApiUser({ allowInvited: true, allowAal1: true });
  if (!auth.ok) return auth.response;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const inviteId = user?.user_metadata?.invite_id as string | undefined;
  const credentialNonce = user?.user_metadata?.credential_nonce as string | undefined;
  if (!inviteId || !credentialNonce) return inviteContextMissing();

  const { data: invite, error } = await auth.admin
    .from('invites')
    .select('id, email, tenant_id, invited_by, company_id, company_role, deal_id, deal_role, status, delivery_status, expires_at, credential_nonce, challenge_digest, challenge_version, challenge_verified_at, challenge_verified_user_id, challenge_verified_version, challenge_locked_at')
    .eq('id', inviteId)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!invite) return jsonError('Invite not found', 404);

  // Authoritative binding: the invite must be addressed to the authenticated
  // email, and the caller's mirror row must live in the invite's tenant.
  if ((invite.email as string).toLowerCase() !== auth.user.email.toLowerCase()) {
    return jsonError('Invite not found', 404);
  }
  const { data: mirror, error: mirrorError } = await auth.admin
    .from('users')
    .select('tenant_id, provisioning')
    .eq('id', auth.user.id)
    .maybeSingle();
  if (mirrorError) return jsonError(mirrorError.message, 500);
  // A contained profile has no tenant yet (accept_invite assigns it), so it is
  // tenant-compatible; an authorized profile must already be in the tenant.
  const tenantCompatible = mirror
    && (mirror.provisioning === USER_PROVISIONING.CONTAINED || mirror.tenant_id === invite.tenant_id);
  if (!tenantCompatible) {
    return jsonError('Invite not found', 404);
  }

  const expired =
    invite.status === INVITE_STATUS.PENDING && new Date(invite.expires_at as string) < new Date();
  const status = expired ? INVITE_STATUS.EXPIRED : invite.status;
  const credentialMatches = Boolean(credentialNonce) && credentialNonce === invite.credential_nonce;
  const verified =
    status === INVITE_STATUS.PENDING &&
    invite.delivery_status === 'sent' &&
    !expired &&
    credentialMatches &&
    Boolean(invite.challenge_digest) &&
    !invite.challenge_locked_at &&
    Boolean(invite.challenge_verified_at) &&
    invite.challenge_verified_user_id === auth.user.id &&
    invite.challenge_verified_version === invite.challenge_version;

  const generic = {
    status,
    email: invite.email,
    verificationRequired: !verified,
    locked: Boolean(invite.challenge_locked_at),
  };
  if (!verified) return NextResponse.json(generic);

  const context = await fetchInviteEmailContext(
    auth.admin,
    invite.invited_by as string,
    invite.company_id as string,
    (invite.deal_id as string | null) ?? null,
  );
  return NextResponse.json({
    ...generic,
    inviterName: context.inviterName,
    companyName: context.companyName,
    dealCodename: context.dealCodename,
    companyRole: invite.company_role,
    dealRole: invite.deal_role,
  });
}
