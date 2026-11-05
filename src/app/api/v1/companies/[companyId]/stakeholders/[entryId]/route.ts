import { NextResponse } from 'next/server';
import { userCanViewCompanyLeadMaps } from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';

type RouteContext = { params: Promise<{ companyId: string; entryId: string }> };

/**
 * DELETE /api/v1/companies/{companyId}/stakeholders/{entryId}
 *
 * Same access gate as the parent GET/POST; the delete is scoped by tenant,
 * company, and row id so a caller cannot remove another tenant's row.
 */
export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId, entryId } = await context.params;

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
    .delete()
    .eq('tenant_id', profile.tenant_id)
    .eq('company_id', companyId)
    .eq('id', entryId)
    .select('id');
  if (error) return jsonError(error.message, 500);
  if (!data || data.length === 0) return jsonError('Stakeholder not found', 404);

  return new NextResponse(null, { status: 204 });
}
