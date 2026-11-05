import { NextResponse } from 'next/server';

import { fetchCrmNetworkPayload } from '@/lib/api/v1/crmNetwork';
import { userCanSearchCompanies, userCanViewLeads } from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';

/**
 * GET /api/v1/crm-network
 *
 * Tenant-scoped CRM relationship graph for the /leads Network tab.
 */
export async function GET() {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const allowed = await userCanViewLeads(auth.admin, auth.user.id);
  if (!allowed) return jsonError('Not permitted to view CRM network', 403);

  const { data: profile, error: profileError } = await auth.admin
    .from('users')
    .select('tenant_id, company_id')
    .eq('id', auth.user.id)
    .single();
  if (profileError || !profile) return jsonError('User profile not found', 404);

  const tenantWide = await userCanSearchCompanies(auth.admin, auth.user.id);

  try {
    const network = await fetchCrmNetworkPayload(
      auth.admin,
      profile.tenant_id as string,
      (profile.company_id as string | null) ?? null,
      tenantWide,
    );
    return NextResponse.json(network);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load CRM network';
    return jsonError(message, 500);
  }
}
