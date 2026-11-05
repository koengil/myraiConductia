import { NextResponse } from 'next/server';
import { userCanCreateLead, userCanSearchCompanies, userCanViewLeads } from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { COMPANY_TYPE, COMPANY_TYPES, type CompanyType } from '@/lib/constants/companies';
import { FREE_TEXT_KEYS } from '@/lib/url/freeTextKeys';
import { DUPLICATE_COMPANY_NAME_CODE, checkLeadName } from '@/lib/validation/inputPolicy';

const LIST_RESULT_LIMIT = 500;

/**
 * In-tenant company list for the Gate 0 step-1 target typeahead.
 *   GET /api/v1/companies?type=target
 *
 * Returns companies in the caller's tenant. `type` optionally narrows the set
 * (e.g. 'target'); the typeahead filters the list client-side. A free-text
 * key (`query`, `q`, `name`, ...) is refused with a 400: search terms never
 * travel in a URL (#331).
 * Create-on-miss is NOT done here: a brand-new target is created inside
 * create_deal_gate0 (G5) when the deal is created, so the typeahead only
 * reflects companies that already exist.
 */
export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  // COMPLIANCE (Chinese wall): company identities are masked behind deal codes,
  // so the directory search is gated to firm overseers and internal (non-walled)
  // staff. External users need an explicit leads-view grant.
  const allowed = await userCanViewLeads(auth.admin, auth.user.id);
  if (!allowed) return jsonError('Not permitted to search companies', 403);

  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) => FREE_TEXT_KEYS.has(key.toLowerCase()))) {
    return jsonError('Search terms are not accepted in the URL', 400);
  }
  const type = url.searchParams.get('type')?.trim();

  const { data: profile, error: profileError } = await auth.admin
    .from('users')
    .select('tenant_id, company_id')
    .eq('id', auth.user.id)
    .single();
  if (profileError || !profile) return jsonError('User profile not found', 404);

  const tenantWide = await userCanSearchCompanies(auth.admin, auth.user.id);

  let builder = auth.admin
    .from('companies')
    .select('id, name, type')
    .eq('tenant_id', profile.tenant_id);

  if (type) builder = builder.eq('type', type);
  if (!tenantWide && profile.company_id) {
    builder = builder.eq('registered_by_company_id', profile.company_id);
  }

  const { data, error } = await builder.order('name').limit(LIST_RESULT_LIMIT);
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ companies: data ?? [] });
}

type CompanyCreateBody = {
  name?: string;
  type?: CompanyType;
  confirmDuplicate?: boolean;
};

/**
 * Register a lead by name. A lead is a companies row: default type = 'client'
 * so the lead-registration UI (Task 2) and wizard selector (Task 3) have a
 * company to attach to before a target/acquirer type is known. Unique per
 * registering org (registered_by_company_id), not tenant-wide, so two banks
 * can both cover "Figma". Maps a unique-index violation to 409.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  // COMPLIANCE (Chinese wall): without a create grant, a walled or external
  // caller could probe whether a company exists via 201 vs 409.
  const allowed = await userCanCreateLead(auth.admin, auth.user.id);
  if (!allowed) return jsonError('Not permitted to register a lead', 403);

  let body: CompanyCreateBody;
  try {
    body = (await request.json()) as CompanyCreateBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const named = checkLeadName(body.name);
  if (!named.ok) return jsonError(named.message, 400);
  const name = named.value;

  // An explicit empty/whitespace type is treated as "not provided" (defaults
  // to CLIENT below) rather than falling through to the DB CHECK as a 500.
  const type = typeof body.type === 'string' && body.type.trim() === '' ? undefined : body.type;
  if (type && !COMPANY_TYPES.includes(type)) {
    return jsonError(`invalid type "${type}"`, 400);
  }

  const { data: profile, error: profileError } = await auth.admin
    .from('users')
    .select('tenant_id, company_id')
    .eq('id', auth.user.id)
    .single();
  if (profileError || !profile) return jsonError('User profile not found', 404);

  const registered_by_company_id = profile.company_id ?? null;

  if (body.confirmDuplicate !== true) {
    const namePattern = name.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const { data: clash } = await auth.admin
      .from('companies')
      .select('name, type')
      .eq('tenant_id', profile.tenant_id)
      .ilike('name', namePattern)
      .limit(1)
      .maybeSingle();
    if (clash) {
      return NextResponse.json(
        {
          error: `${clash.name} is already on the platform as a ${clash.type}. Register this lead anyway, or use the existing record.`,
          code: DUPLICATE_COMPANY_NAME_CODE,
          existing: { name: clash.name, type: clash.type },
        },
        { status: 409 },
      );
    }
  }

  const { data, error } = await auth.admin
    .from('companies')
    .insert({
      name,
      type: type ?? COMPANY_TYPE.CLIENT,
      tenant_id: profile.tenant_id,
      registered_by_company_id,
    })
    .select('id, name, type')
    .single();

  if (error) {
    const pgCode = (error as { code?: string }).code;
    if (pgCode === '23505') {
      return jsonError('Your organization already has a lead with this name', 409);
    }
    return jsonError('The lead could not be registered. Try again.', 500);
  }

  const { error: auditError } = await auth.admin.from('audit_log').insert({
    actor_id: auth.user.id,
    action: AUDIT_ACTION.CREATE,
    detail: {
      reason: 'lead_registered',
      company_id: data.id,
      name: data.name,
      type: data.type,
    },
  });
  if (auditError) {
    const { error: cleanupError } = await auth.admin.from('companies').delete().eq('id', data.id);
    if (cleanupError) {
      return jsonError(
        `Unable to record the lead registration and cleanup failed for company ${data.id}. Escalate before retrying.`,
        500,
      );
    }
    return jsonError('Unable to record the lead registration. Try again.', 500);
  }

  return NextResponse.json({ company: data }, { status: 201 });
}
