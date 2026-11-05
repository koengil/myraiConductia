import { NextResponse } from 'next/server';
import { jsonError, requireApiUser, isUuid } from '@/lib/api/v1/http';
import { isFlagEnabled, requireFlag } from '@/lib/api/v1/requireFlag';
import { INVITE_AUTH_METHOD, type InviteAuthMethod } from '@/lib/constants/workIdentity';
import { userCanManageInvite } from '@/lib/api/v1/access';
import { deliverInvite, fetchInviteEmailContext } from '@/lib/api/v1/inviteDelivery';
import { resolvePublicOrigin } from '@/lib/api/v1/publicOrigin';
import { COMPANY_TYPE } from '@/lib/constants/companies';
import { errorCodeOf } from '@/lib/errors/upstream';
import {
  digestInviteChallengeCode,
  generateInviteChallengeCode,
} from '@/lib/api/v1/inviteChallenge';

/**
 * Resend: rotate the credential nonce (invalidating any previously delivered
 * link at acceptance), regenerate the Supabase link, re-deliver via Resend.
 * Also the recovery path for created-but-email-failed invites (cr-plan-v2 4.2).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ inviteId: string }> },
) {
  const gate = await requireFlag('platform_onboarding');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { inviteId } = await params;
  if (!isUuid(inviteId)) return jsonError('Not found', 404);

  const { data: invite } = await auth.admin
    .from('invites')
    .select('id, email, company_id, deal_id, tenant_id, status, invited_by, auth_method')
    .eq('id', inviteId)
    .maybeSingle();
  if (!invite) return jsonError('Not found', 404);

  const authorized = await userCanManageInvite(auth.admin, auth.user.id, {
    companyId: invite.company_id,
    dealId: invite.deal_id,
  });
  if (!authorized) return jsonError('Forbidden', 403);

  // Resend never changes the stored method (plan 1c). A stored work_identity
  // invite with the flag off is refused before rotation, so the credential
  // already delivered is not invalidated by a send that cannot happen.
  const authMethod = (invite.auth_method ?? INVITE_AUTH_METHOD.EMAIL_CODE) as InviteAuthMethod;
  const workIdentityEnabled = authMethod === INVITE_AUTH_METHOD.WORK_IDENTITY
    && await isFlagEnabled('work_identity_onboarding');
  if (authMethod === INVITE_AUTH_METHOD.WORK_IDENTITY && !workIdentityEnabled) {
    return NextResponse.json({ error: 'work_identity_disabled' }, { status: 409 });
  }

  // These reads must precede rotation. A failed context lookup must never
  // invalidate a working credential before a replacement can be delivered.
  const { data: company } = await auth.admin
    .from('companies')
    .select('type')
    .eq('id', invite.company_id)
    .maybeSingle();
  if (!company) return jsonError('Company not found', 404);
  let emailContext: Awaited<ReturnType<typeof fetchInviteEmailContext>>;
  try {
    emailContext = await fetchInviteEmailContext(
      auth.admin, invite.invited_by, invite.company_id, invite.deal_id,
    );
  } catch {
    return NextResponse.json({
      inviteId: invite.id,
      deliveryStatus: 'unsent',
      deliveryError: 'email_context_failed',
    });
  }

  let verificationCode: string;
  let challengeDigest: string;
  try {
    verificationCode = generateInviteChallengeCode();
    challengeDigest = digestInviteChallengeCode(verificationCode);
  } catch {
    return jsonError('Invite verification is not configured', 500);
  }

  const { data: rotated, error: rotateError } = await auth.admin.rpc(
    'rotate_invite_credential',
    { p_invite_id: inviteId, p_challenge_digest: challengeDigest },
  );
  if (rotateError) {
    if (rotateError.message.includes('not_pending')) {
      return jsonError('Only a pending invite can be resent', 409);
    }
    return jsonError(`Invite credential rotation failed (${errorCodeOf(rotateError)})`, 500);
  }

  const nonce = (rotated as { credential_nonce: string }).credential_nonce;
  const challengeVersion = (rotated as { challenge_version?: number }).challenge_version ?? 1;
  const delivery = await deliverInvite(auth.admin, resolvePublicOrigin(request), {
    id: invite.id,
    authMethod,
    workIdentityEnabled,
    email: invite.email,
    credentialNonce: nonce,
    tenantId: invite.tenant_id,
    isExternal: company.type !== COMPANY_TYPE.BANK,
    verificationCode,
    challengeVersion,
    inviterName: emailContext.inviterName,
    inviterCompanyName: emailContext.inviterCompanyName,
    dealCodename: emailContext.dealCodename,
  });

  return NextResponse.json({
    inviteId: invite.id,
    deliveryStatus: delivery.deliveryStatus,
    ...(delivery.error ? { deliveryError: 'email_delivery_failed' } : {}),
  });
}
