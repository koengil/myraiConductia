import type { SupabaseClient } from '@supabase/supabase-js';
import { sendInviteEmail, sendInviteVerificationEmail } from '@/lib/email/resend';
import { USER_STATUS } from '@/lib/constants/users';
import { emailInviteAppMetadata } from '@/lib/auth/mfaPolicy';
import { INVITE_AUTH_METHOD, USER_PROVISIONING, type InviteAuthMethod } from '@/lib/constants/workIdentity';
import { OperatorCopyError, errorCodeOf } from '@/lib/errors/upstream';

// `error` is always a code. `operatorCopy` is set only when the failure was
// first-party operator copy (a missing key, an unset sender), so the server log
// can say what to fix; no route puts it in a response.
type DeliveryResult = { deliveryStatus: 'sent' | 'unsent'; error?: string; operatorCopy?: string };

const EMAIL_RETRY_DELAYS_MS = [200, 600] as const;

type DeliveryError = Error & { status?: number };

function isRetryableEmailError(error: unknown): boolean {
  if (error instanceof TypeError) return true; // fetch/network failure
  const status = (error as DeliveryError | null)?.status;
  return status === 408 || status === 429 || (typeof status === 'number' && status >= 500);
}

async function sendWithBackoff(send: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= EMAIL_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await send();
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableEmailError(error) || attempt === EMAIL_RETRY_DELAYS_MS.length) break;
      await new Promise<void>((resolve) => setTimeout(resolve, EMAIL_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError;
}

type InvitePayload = {
  id: string;
  /**
   * The STORED invites.auth_method. Delivery never chooses or changes it; it
   * only branches on it (plan 1c). Callers read it from the row they created
   * or rotated.
   */
  authMethod: InviteAuthMethod;
  /** Whether work_identity_onboarding is on for this request. */
  workIdentityEnabled: boolean;
  email: string;
  credentialNonce: string;
  tenantId: string;
  isExternal: boolean;
  verificationCode: string;
  challengeVersion: number;
  inviterName: string;
  inviterCompanyName: string | null;
  dealCodename: string | null;
};

function inviteMetadata(invite: InvitePayload) {
  // Server-owned identity fields from the invite row (cr-plan-v4 1.1): the
  // handle_new_auth_user no longer reads them (plan 1a: every new profile is
  // contained and accept_invite sets tenant/is_external from the invite row);
  // invite_id + credential_nonce ride to the accept endpoint.
  return {
    invite_id: invite.id,
    credential_nonce: invite.credentialNonce,
    is_external: invite.isExternal,
    tenant_id: invite.tenantId,
  };
}

// An auth-service failure as a code. GoTrue's message can quote the invitee's
// address, so only its code travels; without one the step's own token stands.
function authFailureCode(error: { code?: string } | null): string {
  const code = errorCodeOf(error);
  return code === 'unexpected' ? 'link_generation_failed' : code;
}

function sendFailure(err: unknown): DeliveryResult {
  return {
    deliveryStatus: 'unsent',
    error: errorCodeOf(err),
    ...(err instanceof OperatorCopyError ? { operatorCopy: err.message } : {}),
  };
}

function isExistingIdentityError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === 'email_exists') return true;
  return /already.*registered/i.test(error.message ?? '');
}

/**
 * Callers answer with a single opaque token so internal state names and
 * third-party payloads never reach the client. That makes the server log the
 * only record of which cause fired, and several are permanent
 * (tenant_mismatch_no_credential, containment_failed, deal_not_found) — an
 * operator cannot tell those from a transient mail failure without it.
 */
function contextFailed(
  reason: string,
  ids: { actorId: string; companyId: string; dealId: string | null },
): Error {
  console.error('invite email context failed', { reason, ...ids });
  return new Error('email_context_failed');
}

/**
 * Generate the Supabase invite link and deliver it via Resend, then finalize.
 * Shared by invite create and resend. A failure anywhere here leaves the
 * invite pending/unsent — the row already exists, so recovery is the resend
 * path, never a duplicate create (cr-plan-v2 4.2).
 *
 * Two credential paths (cr-prr-124 1.3):
 * - Fresh identity: generateLink(type 'invite') creates the auth user; the
 *   trigger mirrors a contained 'invited' profile whose containment is
 *   re-asserted, and delivery ABORTS unless that is
 *   proven (error checked AND exactly one row affected, cr-prr-124 2.1).
 * - Existing invited identity (resend, or retry after email failure): the
 *   invite-type link is rejected by Supabase for a registered user, so the
 *   rotated nonce is written onto the auth user's metadata (updateUserById)
 *   and a magiclink is generated instead. GoTrue keeps one live one-time token
 *   per identity, so the previous link stays usable until either link is
 *   consumed and consuming one retires the other; what a resend actually
 *   retires is the six-digit challenge, re-issued by rotate_invite_credential.
 *   The previously delivered PAIR can no longer accept, which is why the
 *   challenge travels in its own email (e2e/journeys/invite-rotation.spec.ts).
 */
export async function deliverInvite(
  admin: SupabaseClient,
  origin: string,
  invite: InvitePayload,
): Promise<DeliveryResult> {
  const result = await attemptDelivery(admin, origin, invite);
  if (result.error) {
    // result.error is already a code (a provider status or one of this
    // file's own tokens), never a provider body or a message.
    console.error('invite delivery failed', {
      inviteId: invite.id,
      code: result.error,
      ...(result.operatorCopy ? { operatorCopy: result.operatorCopy } : {}),
    });
  }
  return result;
}

async function attemptDelivery(
  admin: SupabaseClient,
  origin: string,
  invite: InvitePayload,
): Promise<DeliveryResult> {
  if (invite.authMethod === INVITE_AUTH_METHOD.WORK_IDENTITY) {
    return deliverWorkIdentityInvite(admin, origin, invite);
  }
  let actionLink: string;
  try {
    const { data, error } = await admin.auth.admin.generateLink({
      type: 'invite',
      email: invite.email,
      options: {
        data: inviteMetadata(invite),
        redirectTo: `${origin}/accept-invite`,
      },
    });

    if (error || !data?.properties?.action_link) {
      if (isExistingIdentityError(error)) {
        const existing = await deliverToExistingIdentity(admin, origin, invite);
        if ('error' in existing) return { deliveryStatus: 'unsent', error: existing.error };
        actionLink = existing.actionLink;
      } else {
        return { deliveryStatus: 'unsent', error: authFailureCode(error) };
      }
    } else {
      // Fresh identity: the trigger mirrors every new auth user as a contained
      // 'invited' profile (plan 1a), so this assertion is a no-op that still
      // proves the row exists and is unprovisioned. It never promotes:
      // only accept_invite does. Assert 'invited' BEFORE the credential leaves the building, and require
      // proof: an update error, a missing auth user id, or zero affected rows
      // all abort delivery (fail-closed, cr-prr-124 2.1). The company_id guard
      // means an already-provisioned account can never be demoted.
      const authUserId = data.user?.id ?? null;
      if (!authUserId) {
        return { deliveryStatus: 'unsent', error: 'containment_failed_no_auth_user' };
      }
      const { data: contained, error: containError } = await admin
        .from('users')
        .update({ status: USER_STATUS.INVITED })
        .eq('id', authUserId)
        .is('company_id', null)
        .select('id');
      if (containError || !contained || contained.length !== 1) {
        return { deliveryStatus: 'unsent', error: 'containment_failed' };
      }
      // app_metadata is writable only through the admin API, unlike
      // user_metadata. The invite-only MFA policy therefore cannot be bypassed
      // by an invitee editing their own profile metadata.
      //
      // user_metadata is rewritten here, not left to generateLink's `data`:
      // GoTrue applies `data` only when it CREATES the identity and silently
      // ignores it for one that already exists, so a resend that reaches this
      // branch would otherwise deliver a rotated nonce the identity never
      // learns — bricking the invitation, because both verify_invite_challenge
      // and accept_invite compare the two.
      const { error: markerError } = await admin.auth.admin.updateUserById(authUserId, {
        user_metadata: inviteMetadata(invite),
        app_metadata: emailInviteAppMetadata(),
      });
      if (markerError) {
        return { deliveryStatus: 'unsent', error: 'mfa_policy_marker_failed' };
      }
      actionLink = data.properties.action_link;
    }
  } catch {
    return { deliveryStatus: 'unsent', error: 'link_generation_failed' };
  }

  try {
    // Send the non-actionable code first. If it fails, no credential link has
    // escaped; sending the link first could leave an invitee with a valid
    // link that acceptance rejects because delivery never finalized.
    // Resend idempotency keys remain fixed for all attempts of one credential
    // version. That makes retrying transient provider/network failures safe:
    // a completed but response-lost request cannot create a duplicate email.
    const idempotencyBase = `invite-${invite.id}-challenge-${invite.challengeVersion}`;
    await sendWithBackoff(() => sendInviteVerificationEmail({
      to: invite.email,
      verificationCode: invite.verificationCode,
      challengeVersion: invite.challengeVersion,
      origin,
      idempotencyKey: `${idempotencyBase}-code`,
    }));
    await sendWithBackoff(() => sendInviteEmail({
      to: invite.email,
      acceptUrl: actionLink,
      origin,
      inviterName: invite.inviterName,
      companyName: invite.inviterCompanyName,
      dealCodename: invite.dealCodename,
      idempotencyKey: `${idempotencyBase}-link`,
    }));
  } catch (err) {
    return sendFailure(err);
  }

  // Conditional flip + invite_sent audit, atomic and idempotent. A failure
  // AFTER a successful send is reconciled at acceptance (valid nonce) or by a
  // resend; the rare double email is the accepted cost (plan-v5 M3).
  const { error: finalizeError } = await admin.rpc('finalize_invite_delivery', {
    p_invite_id: invite.id,
  });
  if (finalizeError) {
    return { deliveryStatus: 'unsent', error: 'finalize_failed_retry_via_resend' };
  }
  return { deliveryStatus: 'sent' };
}

/**
 * Work-identity invite (plan section 3): ONE email carrying the join link. No
 * generateLink, no challenge code and no pre-created auth user; the invitee
 * proves identity with the firm's provider on /join. With the flag off a
 * stored work_identity invite is refused rather than downgraded to email_code.
 */
async function deliverWorkIdentityInvite(
  admin: SupabaseClient,
  origin: string,
  invite: InvitePayload,
): Promise<DeliveryResult> {
  if (!invite.workIdentityEnabled) {
    return { deliveryStatus: 'unsent', error: 'work_identity_disabled' };
  }
  const joinUrl = new URL('/join', origin);
  joinUrl.searchParams.set('invite', invite.id);
  joinUrl.searchParams.set('k', invite.credentialNonce);
  try {
    await sendWithBackoff(() => sendInviteEmail({
      to: invite.email,
      acceptUrl: joinUrl.toString(),
      origin,
      inviterName: invite.inviterName,
      companyName: invite.inviterCompanyName,
      dealCodename: invite.dealCodename,
      idempotencyKey: `invite-${invite.id}-challenge-${invite.challengeVersion}-join`,
    }));
  } catch (err) {
    return sendFailure(err);
  }
  const { error: finalizeError } = await admin.rpc('finalize_invite_delivery', {
    p_invite_id: invite.id,
  });
  if (finalizeError) {
    return { deliveryStatus: 'unsent', error: 'finalize_failed_retry_via_resend' };
  }
  return { deliveryStatus: 'sent' };
}

/**
 * Credential path for an auth identity that already exists (plan-v5 M3 resend
 * semantics). The mirror row is the id bridge (users.id = auth.users.id,
 * ADR-0008 Option A) and the containment gate: only a still-'invited',
 * still-unprovisioned profile may receive a credential — an active account
 * never gets one (cr-prr-124 2.1 applies here too).
 */
async function deliverToExistingIdentity(
  admin: SupabaseClient,
  origin: string,
  invite: InvitePayload,
): Promise<{ actionLink: string } | { error: string }> {
  const { data: mirror, error: mirrorError } = await admin
    .from('users')
    .select('id, status, company_id, tenant_id, provisioning')
    .eq('email', invite.email)
    .maybeSingle();
  if (mirrorError || !mirror) return { error: 'containment_failed_no_mirror' };
  // A contained profile has no tenant yet (its tenant_id is a private empty
  // one), so it is tenant-compatible; only accept_invite promotes it into the
  // invite's tenant (plan 1a). Authorized profiles keep strict equality.
  const contained = mirror.provisioning === USER_PROVISIONING.CONTAINED;
  if (!contained && mirror.tenant_id !== invite.tenantId) {
    // Cross-tenant mirror: never a credential, no repair path — the invite
    // and the identity must live in the same tenant before anything is
    // delivered (cr-prr-124-r3 2.1).
    return { error: 'tenant_mismatch_no_credential' };
  }
  if (mirror.company_id !== null) {
    // Provisioned account: never a credential, no repair path.
    return { error: 'active_account_no_credential' };
  }
  if (mirror.status !== USER_STATUS.INVITED) {
    // Containment repair (cr-prr-124-r2 2.1): a prior delivery attempt can
    // create the auth identity (trigger mirrors it as 'active') and then fail
    // the invited flip, which would otherwise leave this pending invite
    // permanently unrecoverable. Ownership is proven — the mirror matches the
    // invite email, is unprovisioned, and a genuinely pre-existing active
    // account cannot reach delivery because create_invite 409s first. Only
    // the trigger-default 'active' state is repairable; anything else
    // (suspended) stays refused.
    if (mirror.status !== USER_STATUS.ACTIVE) {
      return { error: 'active_account_no_credential' };
    }
    const { data: repaired, error: repairError } = await admin
      .from('users')
      .update({ status: USER_STATUS.INVITED })
      .eq('id', mirror.id as string)
      .eq('status', USER_STATUS.ACTIVE)
      .eq('tenant_id', invite.tenantId)
      .is('company_id', null)
      .select('id');
    if (repairError || !repaired || repaired.length !== 1) {
      return { error: 'containment_failed' };
    }
  }

  // Carry the rotated nonce onto the identity — accept_invite compares the
  // metadata nonce against the invite row, so this is what kills old links.
  const { error: metadataError } = await admin.auth.admin.updateUserById(mirror.id as string, {
    user_metadata: inviteMetadata(invite),
    app_metadata: emailInviteAppMetadata(),
  });
  if (metadataError) return { error: 'credential_rotation_failed' };

  const { data, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: invite.email,
    options: { redirectTo: `${origin}/accept-invite` },
  });
  if (error || !data?.properties?.action_link) {
    return { error: authFailureCode(error) };
  }
  return { actionLink: data.properties.action_link };
}

export async function fetchInviteEmailContext(
  admin: SupabaseClient,
  actorId: string,
  companyId: string,
  dealId: string | null,
): Promise<{
  inviterName: string;
  inviterCompanyName: string | null;
  companyName: string;
  companyType: string;
  dealCodename: string | null;
}> {
  const [actorRes, companyRes, dealRes] = await Promise.all([
    admin.from('users').select('display_name, full_name, email, company_id').eq('id', actorId).maybeSingle(),
    admin.from('companies').select('name, type').eq('id', companyId).maybeSingle(),
    dealId
      ? admin.from('deals').select('codename').eq('id', dealId).maybeSingle()
      : Promise.resolve({ data: null as { codename: string } | null, error: null }),
  ]);
  const ids = { actorId, companyId, dealId };
  // The original inviter may have been offboarded after creating the pending
  // invite. Their name and company are optional email context, so a missing
  // actor row must not make resend unrecoverable.
  // Query errors and a missing target company/deal still fail closed.
  const lookupError = actorRes.error ?? companyRes.error ?? dealRes.error;
  if (lookupError || !companyRes.data) {
    throw contextFailed(lookupError ? errorCodeOf(lookupError) : 'company_not_found', ids);
  }
  if (dealId && !dealRes.data) throw contextFailed('deal_not_found', ids);
  const actor = actorRes.data;
  const company = companyRes.data;
  const inviterCompanyRes = actor?.company_id
    ? await admin.from('companies').select('name').eq('id', actor.company_id).maybeSingle()
    : { data: null, error: null };
  if (inviterCompanyRes.error) throw contextFailed(errorCodeOf(inviterCompanyRes.error), ids);
  const inviterCompany = inviterCompanyRes.data;
  return {
    inviterName:
      (actor?.display_name as string | null) ??
      (actor?.full_name as string | null) ??
      (actor?.email as string) ??
      'A colleague',
    inviterCompanyName: (inviterCompany?.name as string | null) ?? null,
    companyName: (company?.name as string | null) ?? 'Conductia',
    companyType: (company?.type as string | null) ?? '',
    dealCodename: (dealRes?.data?.codename as string | null) ?? null,
  };
}
