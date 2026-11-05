import { NextResponse } from 'next/server';
import { userCanViewCompanyLeadMaps } from '@/lib/api/v1/access';
import { upsertCrmPerson } from '@/lib/api/v1/crmPeople';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import {
  DECISION_ROLES,
  MOTIVATIONS,
  STANCES,
} from '@/lib/constants/leadMaps';

type RouteContext = { params: Promise<{ companyId: string }> };

const STAKEHOLDER_SELECT =
  'id, company_id, name, title, org, role_in_decision, equity_pct, motivation, stance, ' +
  'board_seat, investor, likely_objections, created_at';

/**
 * GET /api/v1/companies/{companyId}/stakeholders — lead CRM stakeholders.
 *
 * COMPLIANCE (Chinese wall): gated by the same predicate as company search
 * (`userCanViewCompanyLeadMaps`) since stakeholders expose named contacts tied
 * to a masked company identity. Tenant + company scoped.
 */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId } = await context.params;

  const allowed = await userCanViewCompanyLeadMaps(auth.admin, auth.user.id, companyId);
  if (!allowed) return jsonError('Not permitted to access company stakeholders', 403);

  const { data: profile, error: profileError } = await auth.admin
    .from('users')
    .select('tenant_id')
    .eq('id', auth.user.id)
    .single();
  if (profileError || !profile) return jsonError('User profile not found', 404);

  const { data: company, error: companyError } = await auth.admin
    .from('companies')
    .select('id')
    .eq('id', companyId)
    .eq('tenant_id', profile.tenant_id)
    .maybeSingle();
  if (companyError) return jsonError(companyError.message, 500);
  if (!company) return jsonError('Company not found', 404);

  const { data, error } = await auth.admin
    .from('lead_stakeholders')
    .select(STAKEHOLDER_SELECT)
    .eq('tenant_id', profile.tenant_id)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ stakeholders: data ?? [] });
}

type StakeholderCreateBody = {
  name?: string;
  title?: string;
  org?: string;
  role_in_decision?: string;
  equity_pct?: string | number | null;
  motivation?: string;
  stance?: string;
  board_seat?: boolean;
  investor?: boolean;
  likely_objections?: string;
};

/** An explicit empty/whitespace value is treated as "not provided". */
function trimmedOrUndefined(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * POST /api/v1/companies/{companyId}/stakeholders — add a lead CRM stakeholder.
 *
 * Same access gate as GET. Enum fields default to the first option when
 * omitted/blank and are validated when provided.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId } = await context.params;

  const allowed = await userCanViewCompanyLeadMaps(auth.admin, auth.user.id, companyId);
  if (!allowed) return jsonError('Not permitted to access company stakeholders', 403);

  let body: StakeholderCreateBody;
  try {
    body = (await request.json()) as StakeholderCreateBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const name = body.name?.trim();
  if (!name) return jsonError('name is required', 400);

  const role_in_decision = trimmedOrUndefined(body.role_in_decision) ?? DECISION_ROLES[0];
  if (!DECISION_ROLES.includes(role_in_decision as (typeof DECISION_ROLES)[number])) {
    return jsonError(`invalid role_in_decision "${role_in_decision}"`, 400);
  }

  const motivation = trimmedOrUndefined(body.motivation) ?? MOTIVATIONS[0];
  if (!MOTIVATIONS.includes(motivation as (typeof MOTIVATIONS)[number])) {
    return jsonError(`invalid motivation "${motivation}"`, 400);
  }

  const stance = trimmedOrUndefined(body.stance) ?? STANCES[0];
  if (!STANCES.includes(stance as (typeof STANCES)[number])) {
    return jsonError(`invalid stance "${stance}"`, 400);
  }

  const equity_pct_raw = body.equity_pct;
  let equity_pct: number | null = null;
  if (equity_pct_raw !== undefined && equity_pct_raw !== null && `${equity_pct_raw}`.trim() !== '') {
    const parsed = Number(equity_pct_raw);
    if (Number.isNaN(parsed)) return jsonError('invalid equity_pct', 400);
    equity_pct = parsed;
  }

  const board_seat = typeof body.board_seat === 'boolean' ? body.board_seat : false;
  const investor = typeof body.investor === 'boolean' ? body.investor : false;

  const title = trimmedOrUndefined(body.title) ?? null;
  const org = trimmedOrUndefined(body.org) ?? null;
  const likely_objections = trimmedOrUndefined(body.likely_objections) ?? null;

  const { data: profile, error: profileError } = await auth.admin
    .from('users')
    .select('tenant_id, company_id')
    .eq('id', auth.user.id)
    .single();
  if (profileError || !profile) return jsonError('User profile not found', 404);

  const { data: company, error: companyError } = await auth.admin
    .from('companies')
    .select('id, registered_by_company_id')
    .eq('id', companyId)
    .eq('tenant_id', profile.tenant_id)
    .maybeSingle();
  if (companyError) return jsonError(companyError.message, 500);
  if (!company) return jsonError('Company not found', 404);

  const registeredByCompanyId =
    (company.registered_by_company_id as string | null) ??
    (profile.company_id as string | null) ??
    null;

  const person_id = await upsertCrmPerson(auth.admin, {
    tenantId: profile.tenant_id as string,
    registeredByCompanyId,
    name,
    title,
    org,
  });

  const { data, error } = await auth.admin
    .from('lead_stakeholders')
    .insert({
      tenant_id: profile.tenant_id,
      company_id: companyId,
      person_id,
      name,
      title,
      org,
      role_in_decision,
      equity_pct,
      motivation,
      stance,
      board_seat,
      investor,
      likely_objections,
    })
    .select(STAKEHOLDER_SELECT)
    .single();
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ stakeholder: data }, { status: 201 });
}
