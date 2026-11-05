import { RECIPIENT_AFFILIATIONS, type RecipientAffiliation } from '@/lib/constants/recipientAffiliations';
import { affiliationRpcStatus } from '@/lib/api/v1/recipientAffiliations';
import { NextResponse } from 'next/server';
import { isUuid, jsonError, requireApiUser, resolveDealRef } from '@/lib/api/v1/http';
import { isFlagEnabled, requireFlag } from '@/lib/api/v1/requireFlag';
import { INVITE_AUTH_METHOD, type InviteAuthMethod } from '@/lib/constants/workIdentity';
import {
  canManageCompanyMembers,
  canManageDealMembers,
  userCanInvite,
  userCanManageInvite,
} from '@/lib/api/v1/access';
import { COMPANY_ROLE, DEAL_ROLE, FIRM_ROLE } from '@/lib/constants/roles';
import { COMPANY_TYPE, PARTY_ROLE } from '@/lib/constants/companies';
import { deliverInvite, fetchInviteEmailContext } from '@/lib/api/v1/inviteDelivery';
import { resolvePublicOrigin } from '@/lib/api/v1/publicOrigin';
import { normalizeInviteEmail } from '@/lib/api/v1/inviteDomain';
import {
  digestInviteChallengeCode,
  generateInviteChallengeCode,
} from '@/lib/api/v1/inviteChallenge';
import { companyHasActiveDirector } from '@/lib/api/v1/proposalFeasibility';
import { errorCodeOf } from '@/lib/errors/upstream';
import { inviteDealHidden } from '@/lib/api/v1/dealNotVisible';

// Deal roles an invite may carry, by which side of the wall the target company
// sits on. 'md' is never invitable — MD seats exist only through Gate 0.
const INTERNAL_INVITE_DEAL_ROLES: string[] = [
  DEAL_ROLE.DEAL_TEAM,
  DEAL_ROLE.LEGAL,
  DEAL_ROLE.READ_ONLY,
];
const EXTERNAL_INVITE_DEAL_ROLES: string[] = [DEAL_ROLE.SELLER, DEAL_ROLE.BUYER];

const SELLER_PARTY_ROLES: string[] = [PARTY_ROLE.TARGET, PARTY_ROLE.CO_SELLER];

type InviteRow = {
  id: string;
  email: string;
  company_id: string;
  company_role: string;
  deal_id: string | null;
  deal_role: string | null;
  status: string;
  delivery_status: string;
  expires_at: string;
  created_at: string;
  invited_by: string;
};

function serializeInvite(row: InviteRow) {
  return {
    id: row.id,
    email: row.email,
    companyId: row.company_id,
    companyRole: row.company_role,
    dealId: row.deal_id,
    dealRole: row.deal_role,
    status: row.status,
    deliveryStatus: row.delivery_status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    invitedBy: row.invited_by,
  };
}

type InviteCreateBody = {
  email?: string;
  companyId?: string;
  companyRole?: string;
  dealId?: string;
  dealRole?: string;
  confirmationId?: string;
  recipientAffiliation?: RecipientAffiliation;
  representedCompanyId?: string | null;
  /** Disclosure phase confirmed by the inviter. Defaults to 0 when absent, which
   *  is what every pre-existing caller sends. */
  phase?: number;
};

function isExistingAccountGrant(value: unknown): value is {
  id: string;
  email: string;
  access_granted: boolean;
} {
  return typeof value === 'object' && value !== null &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    typeof (value as Record<string, unknown>).email === 'string' &&
    typeof (value as Record<string, unknown>).access_granted === 'boolean';
}

export async function POST(request: Request) {
  const gate = await requireFlag('platform_onboarding');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  let body: InviteCreateBody;
  try {
    body = (await request.json()) as InviteCreateBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const email = normalizeInviteEmail(body.email ?? '');
  const companyId = body.companyId;
  if (!email) {
    return jsonError('A valid email is required', 400);
  }
  if (!companyId) {
    return jsonError('companyId is required', 400);
  }
  if ((body.dealId == null) !== (body.dealRole == null)) {
    return jsonError('dealId and dealRole must be provided together', 400);
  }
  if (body.confirmationId && !isUuid(body.confirmationId)) {
    return jsonError('confirmationId must be a UUID', 400);
  }
  // The UI passes the project URL segment, which is the deal code; resolve to
  // the canonical UUID before predicates, party checks, and the RPC.
  let dealId: string | null = null;
  if (body.dealId) {
    const dealRef = await resolveDealRef(auth.admin, body.dealId);
    if (!dealRef) return jsonError('Deal not found', 404);
    // A caller who can neither see the deal nor invite onto it gets the
    // missing-deal answer, not a 403 that confirms the deal exists (D65).
    const hidden = await inviteDealHidden(auth.admin, auth.user, dealRef.id);
    if (hidden) return hidden;
    dealId = dealRef.id;
  }

  if (!(await userCanInvite(auth.admin, auth.user.id, { companyId, dealId }))) {
    return jsonError('Forbidden', 403);
  }

  // Shape constraints by wall side (spec-v3 criterion 5; cr-plan-v1 2.1).
  const { data: company } = await auth.admin
    .from('companies')
    .select('name, type')
    .eq('id', companyId)
    .maybeSingle();
  if (!company) return jsonError('Company not found', 404);

  const isExternalCompany = company.type !== COMPANY_TYPE.BANK;
  let companyRole = body.companyRole ?? COMPANY_ROLE.MEMBER;
  const dealRole = body.dealRole ?? null;
  // The disclosure phase the inviter confirmed on screen. Carried to the RPC so
  // the seat granted at acceptance is the one that was previewed and confirmed,
  // rather than a silent phase 0. create_invite re-validates and coerces it to 0
  // for bank-company seats.
  const phase = body.phase ?? 0;
  if (!Number.isInteger(phase) || phase < 0) {
    return jsonError('Phase must be a non-negative integer', 400);
  }

  const { data: actorProfile } = await auth.admin
    .from('users')
    .select('is_external, firm_role')
    .eq('id', auth.user.id)
    .maybeSingle();
  const actorIsExternal = Boolean(actorProfile?.is_external) &&
    actorProfile?.firm_role !== FIRM_ROLE.ADMIN;

  const affiliation = body.recipientAffiliation;
  if (affiliation !== undefined) {
    if (!RECIPIENT_AFFILIATIONS.includes(affiliation) || !dealId || !isExternalCompany ||
        (affiliation.endsWith('_advisor') !== Boolean(body.representedCompanyId)) ||
        (body.representedCompanyId != null && !isUuid(body.representedCompanyId))) {
      return jsonError('Invalid recipient affiliation',400);
    }
    if (actorIsExternal || !await canManageDealMembers(auth.admin,auth.user.id,dealId)) {
      return jsonError('Forbidden',403);
    }
  }
  const affiliationArgs = affiliation === undefined ? {} : {
    p_affiliation:affiliation,p_represented_company_id:body.representedCompanyId??null,
  };

  if (actorIsExternal) {
    // External directors grow their own team only: member seats, party-derived
    // deal role, never internal roles.
    companyRole = COMPANY_ROLE.MEMBER;
  }
  if (![COMPANY_ROLE.DIRECTOR, COMPANY_ROLE.MEMBER].includes(companyRole as never)) {
    return jsonError('companyRole must be director or member', 400);
  }
  // Delegated company invitation permission is send-only for member seats. A director invite is a
  // company-management act: only admins and that company's directors may make it.
  if (
    companyRole === COMPANY_ROLE.DIRECTOR &&
    !(await canManageCompanyMembers(auth.admin, auth.user.id, companyId))
  ) {
    return jsonError('Only a company director or firm admin can invite a director', 403);
  }

  if (dealId && dealRole) {
    if (isExternalCompany) {
      if (!EXTERNAL_INVITE_DEAL_ROLES.includes(dealRole)) {
        return jsonError('External invitees take a seller or buyer seat', 400);
      }
      // Party-derived side check: the company's role on the deal fixes which
      // seat its people can hold.
      const { data: party } = await auth.admin
        .from('deal_parties')
        .select('party_role')
        .eq('deal_id', dealId)
        .eq('company_id', companyId)
        .maybeSingle();
      if (!party) {
        return jsonError('Company is not a party to this deal', 400);
      }
      const expected = SELLER_PARTY_ROLES.includes(party.party_role)
        ? DEAL_ROLE.SELLER
        : DEAL_ROLE.BUYER;
      if (dealRole !== expected) {
        return jsonError(`This company's people take the ${expected} seat on this deal`, 400);
      }
    } else if (!INTERNAL_INVITE_DEAL_ROLES.includes(dealRole)) {
      return jsonError('Internal invitees take a deal_team, legal, or read_only seat', 400);
    }
  }

  if (companyRole === COMPANY_ROLE.MEMBER) {
    const hasDirector = await companyHasActiveDirector(auth.admin, companyId);
    if (hasDirector === null) {
      return jsonError('Unable to verify the company director requirement', 503);
    }
    if (!hasDirector) {
      return NextResponse.json(
        {
          error: 'This company needs its first active director. Invite this person as Company Director.',
          code: 'company_requires_director',
        },
        { status: 409 },
      );
    }
  }

  let verificationCode: string;
  let challengeDigest: string;
  try {
    verificationCode = generateInviteChallengeCode();
    challengeDigest = digestInviteChallengeCode(verificationCode);
  } catch {
    return jsonError('Invite verification is not configured', 500);
  }

  // The method is chosen once, here, and stored on the invite (plan 1c):
  // work_identity only with the flag ON and a provider mapping for the target
  // company. create_invite re-checks the mapping in its own transaction.
  // Every other path keeps the email_code default and the exact legacy args.
  const workIdentityEnabled = await isFlagEnabled('work_identity_onboarding');
  let authMethod: InviteAuthMethod = INVITE_AUTH_METHOD.EMAIL_CODE;
  if (workIdentityEnabled && affiliation === undefined) {
    const { data: provider, error: providerError } = await auth.admin
      .from('firm_identity_providers')
      .select('company_id')
      .eq('company_id', companyId)
      .maybeSingle();
    if (providerError) return jsonError('Unable to read the company sign-in configuration', 503);
    if (provider) authMethod = INVITE_AUTH_METHOD.WORK_IDENTITY;
  }

  const { data: created, error: createError } = await auth.admin.rpc(affiliation === undefined ? 'create_invite' : 'create_invite_with_affiliation', {
    ...affiliationArgs,
    ...(authMethod === INVITE_AUTH_METHOD.WORK_IDENTITY ? { p_auth_method: authMethod } : {}),
    p_actor: auth.user.id,
    p_email: email,
    p_company_id: companyId,
    p_company_role: companyRole,
    p_challenge_digest: challengeDigest,
    p_domain_confirmation_id: body.confirmationId ?? null,
    p_deal_id: dealId,
    p_deal_role: dealRole,
    p_phase: phase,
  });
  if (createError) {
    if (affiliation !== undefined && /affiliation_|invalid_member|invalid_invite|invalid_party|invalid_represented|forbidden|tenant_mismatch/.test(createError.message)) {
      return jsonError('Recipient addition could not be completed',affiliationRpcStatus(createError.message));
    }

    if (createError.message.includes('active_account')) {
      if (!dealId || !dealRole) {
        return jsonError('This email already has an active account.', 409);
      }
      // The direct-grant RPC deliberately grants only a deal membership, so a
      // requested company-role elevation must be refused rather than silently
      // dropped.
      if (companyRole !== COMPANY_ROLE.MEMBER) {
        return jsonError(
          'Existing accounts can be added to a deal only; company-role changes require member management.',
          409,
        );
      }
      // A pending domain confirmation is deliberately ignored here. It exists
      // to make an unverified-domain address explicit, but the RPC proves the
      // target already belongs to p_company_id, which is the stronger claim.
      // Refusing on it would make this branch unreachable for every company
      // whose domains are not yet verified. The unused row simply expires.
      const { data: existingUser, error: grantError } = await auth.admin.rpc(
        affiliation === undefined ? 'grant_existing_account_to_deal' : 'grant_existing_account_with_affiliation',
        {
          ...affiliationArgs,
          p_actor: auth.user.id,
          p_email: email,
          p_company_id: companyId,
          p_deal_id: dealId,
          p_deal_role: dealRole,
          p_phase: phase,
        },
      );
      if (grantError) {
        if (grantError.message.includes('not_permitted')) return jsonError('Forbidden', 403);
        if (grantError.message.includes('existing_account_not_eligible')) {
          return jsonError('This active account cannot be added to that company or deal.', 409);
        }
        if (['invalid_deal_role', 'invalid_phase'].some((code) => grantError.message.includes(code))) {
          return jsonError('This invitation is not valid for that company or deal', 400);
        }
        if (affiliation !== undefined) return jsonError('Recipient addition could not be completed',affiliationRpcStatus(grantError.message));
        return jsonError('Unable to grant this existing account access', 500);
      }
      if (!isExistingAccountGrant(existingUser)) {
        return jsonError('Existing-account grant returned an invalid response', 500);
      }
      return NextResponse.json({
        existingUser: {
          id: existingUser.id,
          email: existingUser.email,
          accessGranted: existingUser.access_granted,
        },
      });
    }
    const confirmationError = [
      'domain_confirmation_required',
      'domain_confirmation_invalid',
      'domain_confirmation_expired',
      'domain_confirmation_stale',
    ].find((code) => createError.message.includes(code));
    if (confirmationError) return jsonError(confirmationError, 409);
    // Authority and seat shape are re-derived inside the write transaction. The
    // route checked the same things above, so reaching here means they changed
    // in between: a director demoted, a party removed. Answer opaquely — a
    // prober learns only that the send was refused.
    if (createError.message.includes('not_permitted')) return jsonError('Forbidden', 403);
    if (
      ['invalid_company_role', 'invalid_deal_role', 'invalid_phase'].some((code) =>
        createError.message.includes(code),
      )
    ) {
      return jsonError('This invitation is not valid for that company or deal', 400);
    }
    return jsonError(`Invite write failed (${errorCodeOf(createError)})`, 500);
  }

  const result = created as {
    duplicate: boolean;
    id: string;
    delivery_status?: string;
    company_id?: string;
    deal_id?: string | null;
    credential_nonce?: string;
    tenant_id?: string;
    expires_at?: string;
    challenge_version?: number;
  };

  if (result.duplicate) {
    // Scoped disclosure (cr-plan-v4 4.1): only an actor authorized over the
    // EXISTING invite's scope learns its id/state; everyone else gets an
    // opaque conflict.
    const canSee = await userCanManageInvite(auth.admin, auth.user.id, {
      companyId: result.company_id as string,
      dealId: (result.deal_id as string | null) ?? null,
    });
    if (canSee) {
      return NextResponse.json(
        {
          error: 'duplicate_pending',
          inviteId: result.id,
          deliveryStatus: result.delivery_status,
        },
        { status: 409 },
      );
    }
    return jsonError('duplicate_pending', 409);
  }

  let emailContext: Awaited<ReturnType<typeof fetchInviteEmailContext>>;
  try {
    emailContext = await fetchInviteEmailContext(auth.admin, auth.user.id, companyId, dealId);
  } catch {
    return NextResponse.json(
      {
        invite: {
          id: result.id, email, companyId, companyRole, dealId, dealRole, status: 'pending',
          deliveryStatus: 'unsent', expiresAt: result.expires_at,
        },
        deliveryError: 'email_context_failed',
      },
      { status: 201 },
    );
  }
  const delivery = await deliverInvite(auth.admin, resolvePublicOrigin(request), {
    id: result.id,
    authMethod,
    workIdentityEnabled,
    email,
    credentialNonce: result.credential_nonce as string,
    tenantId: result.tenant_id as string,
    isExternal: isExternalCompany,
    verificationCode,
    challengeVersion: result.challenge_version ?? 1,
    inviterName: emailContext.inviterName,
    inviterCompanyName: emailContext.inviterCompanyName,
    dealCodename: emailContext.dealCodename,
  });

  return NextResponse.json(
    {
      invite: {
        id: result.id,
        email,
        companyId,
        companyRole,
        dealId,
        dealRole,
        status: 'pending',
        deliveryStatus: delivery.deliveryStatus,
        expiresAt: result.expires_at,
      },
      ...(delivery.error ? { deliveryError: 'email_delivery_failed' } : {}),
    },
    { status: 201 },
  );
}

export async function GET(request: Request) {
  const gate = await requireFlag('platform_onboarding');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const dealIdParam = url.searchParams.get('dealId');
  let dealId: string | null = null;
  if (dealIdParam) {
    const dealRef = await resolveDealRef(auth.admin, dealIdParam);
    if (!dealRef) return jsonError('Deal not found', 404);
    // Before any authority branch: a non-party external director and another
    // firm's admin would otherwise get a 200 for a real deal (D65).
    const hidden = await inviteDealHidden(auth.admin, auth.user, dealRef.id);
    if (hidden) return hidden;
    dealId = dealRef.id;
  }
  const companyId = url.searchParams.get('companyId');
  if (!dealId && !companyId) {
    return jsonError('dealId or companyId is required', 400);
  }

  // Authorization mirrors userCanManageInvite for the queried scope; external
  // directors are additionally pinned to their own company's rows below.
  const { data: actor } = await auth.admin
    .from('users')
    .select('firm_role, is_external, company_id, company_role')
    .eq('id', auth.user.id)
    .maybeSingle();
  if (!actor) return jsonError('Forbidden', 403);

  let effectiveCompanyId = companyId;
  if (actor.is_external && actor.firm_role !== FIRM_ROLE.ADMIN) {
    if (actor.company_role !== COMPANY_ROLE.DIRECTOR) return jsonError('Forbidden', 403);
    effectiveCompanyId = actor.company_id as string;
  } else if (actor.firm_role !== FIRM_ROLE.ADMIN) {
    const authorized = dealId
      ? await canManageDealMembers(auth.admin, auth.user.id, dealId)
      : await canManageCompanyMembers(auth.admin, auth.user.id, companyId as string);
    if (!authorized) return jsonError('Forbidden', 403);
  }

  let query = auth.admin
    .from('invites')
    .select(
      'id, email, company_id, company_role, deal_id, deal_role, status, delivery_status, expires_at, created_at, invited_by',
    )
    .order('created_at', { ascending: false });
  if (dealId) query = query.eq('deal_id', dealId);
  if (effectiveCompanyId) query = query.eq('company_id', effectiveCompanyId);

  const { data, error } = await query;
  if (error) return jsonError(`Invite lookup failed (${errorCodeOf(error)})`, 500);

  return NextResponse.json({ invites: (data ?? []).map((r) => serializeInvite(r as InviteRow)) });
}
