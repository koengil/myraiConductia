import { NextResponse } from 'next/server';
import { isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { deliverInvite, fetchInviteEmailContext } from '@/lib/api/v1/inviteDelivery';
import { INVITE_AUTH_METHOD } from '@/lib/constants/workIdentity';
import { resolvePublicOrigin } from '@/lib/api/v1/publicOrigin';
import { classifyInviteDomain, normalizeInviteEmail } from '@/lib/api/v1/inviteDomain';
import {
  digestInviteChallengeCode,
  generateInviteChallengeCode,
} from '@/lib/api/v1/inviteChallenge';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { COMPANY_ROLE, FIRM_ROLE } from '@/lib/constants/roles';
import { COMPANY_TYPE, COMPANY_TYPES, type CompanyType } from '@/lib/constants/companies';

type OnboardBody = {
  name?: string;
  type?: CompanyType;
  ownerEmail?: string;
  /** Second call of the two-step flow: the confirmation id returned by the
   *  409 domain_confirmation_required response. */
  confirmationId?: string;
};

/**
 * Company bootstrap (Aug 4 sync, Roberto): the admin-fired "first invite" for
 * a brand-new company. Creates (or reuses) the company record and sends its
 * first director invite in one call, so the accepted owner lands with member
 * management rights (the >=1-director DB invariant is satisfied by that first
 * acceptance; a memberless company row is legal until then).
 *
 * Firm-admin only. Fired from /dev-api until an admin UI exists.
 *   POST /api/v1/companies/onboard { name, type, ownerEmail }
 */
export async function POST(request: Request) {
  const gate = await requireFlag('platform_onboarding');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { data: actor } = await auth.admin
    .from('users')
    .select('firm_role, tenant_id')
    .eq('id', auth.user.id)
    .maybeSingle();
  if (!actor || actor.firm_role !== FIRM_ROLE.ADMIN) {
    return jsonError('Only a firm admin can onboard a company', 403);
  }

  let body: OnboardBody;
  try {
    body = (await request.json()) as OnboardBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const name = body.name?.trim();
  if (!name) return jsonError('name is required', 400);
  const type = body.type;
  if (!type || !COMPANY_TYPES.includes(type)) {
    return jsonError(`type must be one of: ${COMPANY_TYPES.join(', ')}`, 400);
  }
  const ownerEmail = normalizeInviteEmail(body.ownerEmail ?? '');
  if (!ownerEmail) return jsonError('A valid ownerEmail is required', 400);

  // A bank is a FIRM: it owns a tenant rather than living in the actor's. Every
  // other type (client, target, counterparty) is a party in this firm's book and
  // must share the actor's tenant to be usable on a deal. Onboarding both into
  // one tenant is what let an Ignatious director enumerate Conductia's client
  // leads (#156).
  const isFirm = type === COMPANY_TYPE.BANK;

  // Find-or-create by name, case-insensitive — same identity rule as the
  // non-client tenant-name unique index. ilike without wildcards is a
  // case-insensitive equality match.
  // ilike treats % and _ as wildcards; escape them so "100% Partners" can
  // only ever match itself.
  const namePattern = name.replace(/[\\%_]/g, (ch) => `\\${ch}`);

  // A firm is matched across tenants, because the tenant is what this call is
  // deciding. Scoping the lookup to the actor would make the second call of the
  // domain-confirmation exchange miss the company the first call just created
  // and mint it a second tenant.
  const findCompany = async () => {
    let query = auth.admin.from('companies').select('id, name, type').ilike('name', namePattern);
    if (!isFirm) query = query.eq('tenant_id', actor.tenant_id);
    const { data, error } = await query.order('created_at').limit(1).maybeSingle();
    return { data, error };
  };

  const { data: existing, error: lookupError } = await findCompany();
  if (lookupError) return jsonError(lookupError.message, 500);

  let company = existing;
  let created = false;
  if (!company) {
    const { data: inserted, error: insertError } = await auth.admin
      .from('companies')
      .insert({ name, type, tenant_id: isFirm ? crypto.randomUUID() : actor.tenant_id })
      .select('id, name, type')
      .single();
    if (insertError) {
      // 23505 = a concurrent create won the unique index; re-read the winner.
      if ((insertError as { code?: string }).code === '23505') {
        const { data: winner } = await findCompany();
        company = winner ?? null;
      }
      if (!company) return jsonError(insertError.message, 500);
    } else {
      company = inserted;
      created = true;
      const { error: auditError } = await auth.admin.from('audit_log').insert({
        actor_id: auth.user.id,
        action: AUDIT_ACTION.CREATE,
        detail: {
          reason: 'company_onboarded',
          company_id: company.id,
          name: company.name,
          type: company.type,
        },
      });
      if (auditError) {
        // No unaudited company: the row is brand new with no references, so
        // remove it and surface the failure. Durable fix is a transactional
        // RPC; tracked for the RLS/hardening pass.
        const { error: cleanupError } = await auth.admin
          .from('companies')
          .delete()
          .eq('id', company.id);
        if (cleanupError) {
          return jsonError(
            `Unable to record the company creation and cleanup failed for company ${company.id}. Escalate before retrying.`,
            500,
          );
        }
        return jsonError('Unable to record the company creation. Try again.', 500);
      }
    }
  }

  if (company.type !== type) {
    return jsonError(
      `A company named "${company.name}" already exists with type ${company.type}`,
      409,
    );
  }

  // The owner's invite: a director seat, no deal. Same challenge + domain
  // sequence as POST /api/v1/invites. A brand-new company has no verified
  // domains yet, so a non-matching owner email requires the same explicit
  // confirmation as any other invite: the first call answers 409 with a
  // confirmation id, and the admin re-submits it to confirm the address.
  let verificationCode: string;
  let challengeDigest: string;
  try {
    verificationCode = generateInviteChallengeCode();
    challengeDigest = digestInviteChallengeCode(verificationCode);
  } catch {
    return jsonError('Invite verification is not configured', 500);
  }

  const { data: configured, error: domainError } = await auth.admin
    .from('company_verified_domains')
    .select('domain')
    .eq('company_id', company.id)
    .order('domain', { ascending: true });
  if (domainError) return jsonError('Unable to check the company email domain', 500);
  const classification = classifyInviteDomain(
    ownerEmail,
    (configured ?? []).map((row) => row.domain as string),
  );

  let confirmationId: string | null = null;
  if (classification !== 'match') {
    if (body.confirmationId) {
      if (!isUuid(body.confirmationId)) return jsonError('confirmationId must be a UUID', 400);
      confirmationId = body.confirmationId;
    } else {
      const { data: confirmation, error: confirmationError } = await auth.admin
        .from('invite_domain_confirmations')
        .insert({
          actor_id: auth.user.id,
          email: ownerEmail,
          company_id: company.id,
          company_role: COMPANY_ROLE.DIRECTOR,
          deal_id: null,
          deal_role: null,
          classification,
        })
        .select('id, expires_at')
        .single();
      if (confirmationError || !confirmation) {
        return jsonError('Unable to record the domain confirmation', 500);
      }
      return NextResponse.json(
        {
          error: 'domain_confirmation_required',
          classification,
          normalizedEmail: ownerEmail,
          confirmationId: confirmation.id,
          expiresAt: confirmation.expires_at,
          company: { id: company.id, name: company.name, type: company.type, created },
        },
        { status: 409 },
      );
    }
  }

  const { data: inviteResult, error: createError } = await auth.admin.rpc('create_invite', {
    p_actor: auth.user.id,
    p_email: ownerEmail,
    p_company_id: company.id,
    p_company_role: COMPANY_ROLE.DIRECTOR,
    p_challenge_digest: challengeDigest,
    p_domain_confirmation_id: confirmationId,
    p_deal_id: null,
    p_deal_role: null,
  });
  if (createError) {
    if (createError.message.includes('active_account')) {
      return jsonError(
        'This email already has an active account. Assign them to the company via members instead.',
        409,
      );
    }
    return jsonError(createError.message, 500);
  }

  const result = inviteResult as {
    duplicate: boolean;
    id: string;
    delivery_status?: string;
    credential_nonce?: string;
    tenant_id?: string;
    expires_at?: string;
    challenge_version?: number;
  };
  if (result.duplicate) {
    // Actor is a firm admin, so disclosing the pending invite id is in scope.
    return NextResponse.json(
      { error: 'duplicate_pending', inviteId: result.id, deliveryStatus: result.delivery_status },
      { status: 409 },
    );
  }

  let emailContext: Awaited<ReturnType<typeof fetchInviteEmailContext>>;
  try {
    emailContext = await fetchInviteEmailContext(auth.admin, auth.user.id, company.id, null);
  } catch {
    return NextResponse.json(
      {
        company: { id: company.id, name: company.name, type: company.type, created },
        invite: {
          id: result.id, email: ownerEmail, companyId: company.id, companyRole: COMPANY_ROLE.DIRECTOR,
          status: 'pending', deliveryStatus: 'unsent', expiresAt: result.expires_at,
        },
        deliveryError: 'email_context_failed',
      },
      { status: 201 },
    );
  }
  // Onboarding always creates the email_code default (plan 1c).
  const delivery = await deliverInvite(auth.admin, resolvePublicOrigin(request), {
    id: result.id,
    authMethod: INVITE_AUTH_METHOD.EMAIL_CODE,
    workIdentityEnabled: false,
    email: ownerEmail,
    credentialNonce: result.credential_nonce as string,
    tenantId: result.tenant_id as string,
    isExternal: company.type !== COMPANY_TYPE.BANK,
    verificationCode,
    challengeVersion: result.challenge_version ?? 1,
    inviterName: emailContext.inviterName,
    inviterCompanyName: emailContext.inviterCompanyName,
    dealCodename: null,
  });

  return NextResponse.json(
    {
      company: { id: company.id, name: company.name, type: company.type, created },
      invite: {
        id: result.id,
        email: ownerEmail,
        companyId: company.id,
        companyRole: COMPANY_ROLE.DIRECTOR,
        status: 'pending',
        deliveryStatus: delivery.deliveryStatus,
        expiresAt: result.expires_at,
      },
      ...(delivery.error ? { deliveryError: 'email_delivery_failed' } : {}),
    },
    { status: 201 },
  );
}
