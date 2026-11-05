import { NextResponse } from 'next/server';
import { userCanAccessDeal, userIsDealMd } from '@/lib/api/v1/access';
import { auditFailed, jsonError, requireApiUser, resolveDealRef } from '@/lib/api/v1/http';
import { dealNotVisible, forbiddenOrNotVisible } from '@/lib/api/v1/dealNotVisible';
import { requireFlag, isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { DEAL_ROLES, type DealRole } from '@/lib/constants/roles';

type RouteContext = { params: Promise<{ dealId: string }> };

/** Supabase embeds come back as an object or a one-element array; normalize. */
function embedded<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

type MemberRow = {
  user_id: string;
  deal_role: string;
  phase: number | null;
  user:
    | {
        display_name: string | null;
        full_name: string;
        email: string;
        company_id: string | null;
        company_role: string | null;
        is_external: boolean;
      }
    | Array<{
        display_name: string | null;
        full_name: string;
        email: string;
        company_id: string | null;
        company_role: string | null;
        is_external: boolean;
      }>
    | null;
};

type PartyRow = { company_id: string; party_role: string };

/**
 * The live Team roster: every seat on the deal joined to its holder,
 * plus the deal's parties and owning bank so the client can group the roster by
 * company (bank first, then parties). Flag-gated: the route does not exist
 * until platform_onboarding is on. Readable by anyone on the deal.
 */
export async function GET(_request: Request, context: RouteContext) {
  const gate = await requireFlag('platform_onboarding');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId: dealParam } = await context.params;
  // Project URLs address deals by human-readable code; resolve to the
  // canonical UUID before any membership/document query (a raw code would
  // match nothing and read as Forbidden).
  const dealRef = await resolveDealRef(auth.admin, dealParam);
  if (!dealRef) return jsonError('Deal not found', 404);
  const dealId = dealRef.id;
  if (!(await userCanAccessDeal(auth.admin, auth.user.id, dealId))) {
    return dealNotVisible();
  }

  const { data: deal, error: dealError } = await auth.admin
    .from('deals')
    .select('bank_id')
    .eq('id', dealId)
    .maybeSingle();
  if (dealError) return jsonError(dealError.message, 500);
  if (!deal) return jsonError('Deal not found', 404);

  const { data: memberRows, error: memberError } = await auth.admin
    .from('deal_memberships')
    .select(
      // deal_memberships has two FKs to users (user_id and added_by), so the
      // embed must name the relationship or PostgREST rejects it as ambiguous.
      'user_id, deal_role, phase, user:users!deal_memberships_user_id_fkey(display_name, full_name, email, company_id, company_role, is_external)',
    )
    .eq('deal_id', dealId);
  if (memberError) return jsonError(memberError.message, 500);

  const { data: partyRows, error: partyError } = await auth.admin
    .from('deal_parties')
    .select('company_id, party_role')
    .eq('deal_id', dealId);
  if (partyError) return jsonError(partyError.message, 500);

  // One companies read covers the bank, every party, and every member's firm.
  const companyIds = new Set<string>();
  if (deal.bank_id) companyIds.add(deal.bank_id as string);
  for (const p of (partyRows ?? []) as PartyRow[]) companyIds.add(p.company_id);
  for (const m of (memberRows ?? []) as MemberRow[]) {
    const u = embedded(m.user);
    if (u?.company_id) companyIds.add(u.company_id);
  }

  const companyNames = new Map<string, string>();
  if (companyIds.size > 0) {
    const { data: companies, error: companyError } = await auth.admin
      .from('companies')
      .select('id, name')
      .in('id', Array.from(companyIds));
    if (companyError) return jsonError(companyError.message, 500);
    for (const c of (companies ?? []) as Array<{ id: string; name: string }>) {
      companyNames.set(c.id, c.name);
    }
  }

  const members = ((memberRows ?? []) as MemberRow[]).map((row) => {
    const u = embedded(row.user);
    return {
      userId: row.user_id,
      displayName: u?.display_name ?? null,
      fullName: u?.full_name ?? null,
      email: u?.email ?? null,
      dealRole: row.deal_role,
      phase: row.phase ?? 0,
      isExternal: u?.is_external ?? false,
      companyId: u?.company_id ?? null,
      companyName: u?.company_id ? (companyNames.get(u.company_id) ?? null) : null,
      companyRole: u?.company_role ?? null,
    };
  });

  const parties = ((partyRows ?? []) as PartyRow[]).map((row) => ({
    companyId: row.company_id,
    companyName: companyNames.get(row.company_id) ?? null,
    partyRole: row.party_role,
  }));

  return NextResponse.json({ members, parties, bankCompanyId: deal.bank_id });
}

export async function POST(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId: dealParam } = await context.params;
  // Flag-off parity (spec c.16): pre-onboarding behavior used the raw route
  // segment; resolve human-readable deal codes only when the flag is on.
  let dealId = dealParam;
  if (await isFlagEnabled('platform_onboarding')) {
    const dealRef = await resolveDealRef(auth.admin, dealParam);
    if (!dealRef) return jsonError('Deal not found', 404);
    dealId = dealRef.id;
  }
  const canGrant = await userIsDealMd(auth.admin, auth.user.id, dealId);
  if (!canGrant) {
    return forbiddenOrNotVisible(auth.admin, auth.user.id, dealId, 'Only the deal MD can add members');
  }

  let body: { email?: string; dealRole?: string };
  try {
    body = (await request.json()) as { email?: string; dealRole?: string };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const email = body.email?.trim().toLowerCase();
  const dealRole = body.dealRole;
  if (!email || !dealRole) {
    return jsonError('email and dealRole are required', 400);
  }
  if (!DEAL_ROLES.includes(dealRole as DealRole)) {
    return jsonError('Invalid dealRole', 400);
  }

  const { data: deal, error: dealError } = await auth.admin
    .from('deals')
    .select('tenant_id')
    .eq('id', dealId)
    .maybeSingle();
  if (dealError) return jsonError(dealError.message, 500);
  if (!deal) return jsonError('Deal not found', 404);

  const { data: invitee, error: inviteeError } = await auth.admin
    .from('users')
    .select('id, email, tenant_id')
    .eq('email', email)
    .maybeSingle();
  if (inviteeError) return jsonError(inviteeError.message, 500);
  if (!invitee || invitee.tenant_id !== deal.tenant_id) {
    return jsonError('User not found. The invitee must sign up first', 404);
  }

  const { data: role, error: roleError } = await auth.admin
    .from('roles')
    .select('id')
    .eq('slug', dealRole)
    .single();
  if (roleError || !role) return jsonError('Role not found', 404);

  const { data: membership, error: membershipError } = await auth.admin
    .from('deal_memberships')
    .upsert(
      {
        deal_id: dealId,
        user_id: invitee.id,
        role_id: role.id,
        deal_role: dealRole,
        added_by: auth.user.id,
      },
      { onConflict: 'deal_id,user_id' },
    )
    .select('id, deal_id, user_id, deal_role, access_granted_at')
    .single();
  if (membershipError) return jsonError(membershipError.message, 500);

  const { error: auditError } = await auth.admin.from('audit_log').insert({
    actor_id: auth.user.id,
    action: AUDIT_ACTION.GRANT,
    deal_id: dealId,
    detail: { email, dealRole },
  });
  if (auditError) return auditFailed(auditError, 'The deal seat was saved, but its audit record could not be written. Contact compliance before retrying.');

  return NextResponse.json({ membership }, { status: 201 });
}
