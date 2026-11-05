import { NextResponse } from 'next/server';
import { userCanInvite } from '@/lib/api/v1/access';
import { classifyInviteDomain, normalizeInviteEmail } from '@/lib/api/v1/inviteDomain';
import { jsonError, requireApiUser, resolveDealRef } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { inviteDealHidden } from '@/lib/api/v1/dealNotVisible';

type PreflightBody = {
  email?: string;
  companyId?: string;
  companyRole?: string;
  dealId?: string;
  dealRole?: string;
};

export async function POST(request: Request) {
  const gate = await requireFlag('platform_onboarding');
  if (gate) return gate;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  let body: PreflightBody;
  try {
    body = (await request.json()) as PreflightBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const normalizedEmail = normalizeInviteEmail(body.email ?? '');
  if (!normalizedEmail) return jsonError('A valid email is required', 400);
  if (!body.companyId) return jsonError('companyId is required', 400);
  if (!body.companyRole) return jsonError('companyRole is required', 400);
  if ((body.dealId == null) !== (body.dealRole == null)) {
    return jsonError('dealId and dealRole must be provided together', 400);
  }

  let dealId: string | null = null;
  if (body.dealId) {
    const deal = await resolveDealRef(auth.admin, body.dealId);
    if (!deal) return jsonError('Deal not found', 404);
    const hidden = await inviteDealHidden(auth.admin, auth.user, deal.id);
    if (hidden) return hidden;
    dealId = deal.id;
  }
  if (!(await userCanInvite(auth.admin, auth.user.id, { companyId: body.companyId, dealId }))) {
    return jsonError('Forbidden', 403);
  }

  const [{ data: company }, { data: configured, error: domainError }] = await Promise.all([
    auth.admin.from('companies').select('id').eq('id', body.companyId).maybeSingle(),
    auth.admin
      .from('company_verified_domains')
      .select('domain')
      .eq('company_id', body.companyId)
      .order('domain', { ascending: true }),
  ]);
  if (!company) return jsonError('Company not found', 404);
  if (domainError) return jsonError('Unable to check the company email domain', 500);

  const classification = classifyInviteDomain(
    normalizedEmail,
    (configured ?? []).map((row) => row.domain as string),
  );
  if (classification === 'match') {
    return NextResponse.json({ normalizedEmail, classification, confirmationRequired: false });
  }

  const { data: confirmation, error } = await auth.admin
    .from('invite_domain_confirmations')
    .insert({
      actor_id: auth.user.id,
      email: normalizedEmail,
      company_id: body.companyId,
      company_role: body.companyRole,
      deal_id: dealId,
      deal_role: body.dealRole ?? null,
      classification,
    })
    .select('id, expires_at')
    .single();
  if (error || !confirmation) return jsonError('Unable to record the domain confirmation', 500);

  return NextResponse.json({
    normalizedEmail,
    classification,
    confirmationRequired: true,
    confirmationId: confirmation.id,
    expiresAt: confirmation.expires_at,
  });
}
