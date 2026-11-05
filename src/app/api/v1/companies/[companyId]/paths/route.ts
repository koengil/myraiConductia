import { NextResponse } from 'next/server';
import { userCanViewCompanyLeadMaps } from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { PATH_TYPES } from '@/lib/constants/leadMaps';

type RouteContext = { params: Promise<{ companyId: string }> };

const PATH_SELECT =
  'id, company_id, stakeholder_id, relationship_id, path_type, approved, approved_by, approved_on, created_at';

async function assertCompanyAccess(
  auth: Awaited<ReturnType<typeof requireApiUser>> & { ok: true },
  companyId: string,
) {
  const allowed = await userCanViewCompanyLeadMaps(auth.admin, auth.user.id, companyId);
  if (!allowed) return { error: jsonError('Not permitted to access company paths', 403) };

  const { data: profile, error: profileError } = await auth.admin
    .from('users')
    .select('tenant_id')
    .eq('id', auth.user.id)
    .single();
  if (profileError || !profile) return { error: jsonError('User profile not found', 404) };

  const { data: company, error: companyError } = await auth.admin
    .from('companies')
    .select('id')
    .eq('id', companyId)
    .eq('tenant_id', profile.tenant_id)
    .maybeSingle();
  if (companyError) return { error: jsonError(companyError.message, 500) };
  if (!company) return { error: jsonError('Company not found', 404) };

  return { tenantId: profile.tenant_id as string };
}

/**
 * GET /api/v1/companies/{companyId}/paths — approved and draft warm paths.
 */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId } = await context.params;
  const access = await assertCompanyAccess(auth, companyId);
  if ('error' in access) return access.error;

  const { data, error } = await auth.admin
    .from('lead_relationship_paths')
    .select(PATH_SELECT)
    .eq('tenant_id', access.tenantId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ paths: data ?? [] });
}

type PathUpsertBody = {
  stakeholder_id?: string;
  relationship_id?: string | null;
  path_type?: string;
  approve?: boolean;
};

function localDateIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * POST /api/v1/companies/{companyId}/paths — select or approve a warm path.
 *
 * Upserts one path per stakeholder. Warm paths require relationship_id; cold
 * paths omit it. Pass approve: true to record banker sign-off.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId } = await context.params;
  const access = await assertCompanyAccess(auth, companyId);
  if ('error' in access) return access.error;

  let body: PathUpsertBody;
  try {
    body = (await request.json()) as PathUpsertBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const stakeholder_id = body.stakeholder_id?.trim();
  if (!stakeholder_id) return jsonError('stakeholder_id is required', 400);

  const path_type = body.path_type?.trim() ?? PATH_TYPES[0];
  if (!PATH_TYPES.includes(path_type as (typeof PATH_TYPES)[number])) {
    return jsonError(`invalid path_type "${path_type}"`, 400);
  }

  const relationship_id =
    body.relationship_id === null || body.relationship_id === undefined
      ? null
      : body.relationship_id.trim() || null;

  if (path_type === 'warm' && !relationship_id) {
    return jsonError('relationship_id is required for warm paths', 400);
  }
  if (path_type === 'cold' && relationship_id) {
    return jsonError('relationship_id must be omitted for cold paths', 400);
  }

  const { data: stakeholder, error: stakeholderError } = await auth.admin
    .from('lead_stakeholders')
    .select('id')
    .eq('tenant_id', access.tenantId)
    .eq('company_id', companyId)
    .eq('id', stakeholder_id)
    .maybeSingle();
  if (stakeholderError) return jsonError(stakeholderError.message, 500);
  if (!stakeholder) return jsonError('Stakeholder not found', 404);

  if (relationship_id) {
    const { data: relationship, error: relationshipError } = await auth.admin
      .from('lead_relationships')
      .select('id')
      .eq('tenant_id', access.tenantId)
      .eq('company_id', companyId)
      .eq('id', relationship_id)
      .maybeSingle();
    if (relationshipError) return jsonError(relationshipError.message, 500);
    if (!relationship) return jsonError('Relationship not found', 404);
  }

  const approve = body.approve === true;
  let approved_by: string | null = null;
  let approved_on: string | null = null;
  if (approve) {
    const { data: actor, error: actorError } = await auth.admin
      .from('users')
      .select('display_name, full_name')
      .eq('id', auth.user.id)
      .single();
    if (actorError) return jsonError(actorError.message, 500);
    approved_by =
      actor?.display_name?.trim() || actor?.full_name?.trim() || auth.user.email || 'Banker';
    approved_on = localDateIso();
  }

  const row = {
    tenant_id: access.tenantId,
    company_id: companyId,
    stakeholder_id,
    relationship_id,
    path_type,
    approved: approve,
    approved_by: approve ? approved_by : null,
    approved_on: approve ? approved_on : null,
  };

  const { data, error } = await auth.admin
    .from('lead_relationship_paths')
    .upsert(row, { onConflict: 'tenant_id,company_id,stakeholder_id' })
    .select(PATH_SELECT)
    .single();
  if (error) return jsonError(error.message, 500);

  // The path is the approval gate on Relationship Pathing: a draft and an
  // approval are both material, and neither left an audit row before.
  const { error: auditError } = await auth.admin.from('audit_log').insert({
    actor_id: auth.user.id,
    action: AUDIT_ACTION.UPDATE,
    detail: {
      kind: 'lead_path',
      company_id: companyId,
      stakeholder_id,
      relationship_id,
      path_type,
      approved: approve,
      ...(approve ? { approved_by } : {}),
    },
  });
  if (auditError) return jsonError(`Saved but audit write failed: ${auditError.message}`, 500);

  return NextResponse.json({ path: data }, { status: 201 });
}
