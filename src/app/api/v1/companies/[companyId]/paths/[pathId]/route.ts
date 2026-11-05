import { NextResponse } from 'next/server';
import { userCanViewCompanyLeadMaps } from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';

type RouteContext = { params: Promise<{ companyId: string; pathId: string }> };

/**
 * DELETE /api/v1/companies/{companyId}/paths/{pathId}
 */
export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId, pathId } = await context.params;

  const allowed = await userCanViewCompanyLeadMaps(auth.admin, auth.user.id, companyId);
  if (!allowed) return jsonError('Not permitted to access company paths', 403);

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
    .from('lead_relationship_paths')
    .delete()
    .eq('tenant_id', profile.tenant_id)
    .eq('company_id', companyId)
    .eq('id', pathId)
    .select('id');
  if (error) return jsonError(error.message, 500);
  if (!data || data.length === 0) return jsonError('Path not found', 404);

  return new NextResponse(null, { status: 204 });
}
