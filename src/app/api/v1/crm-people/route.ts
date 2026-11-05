import { NextResponse } from 'next/server';

import { userCanSearchCompanies, userCanViewLeads } from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { FREE_TEXT_KEYS } from '@/lib/url/freeTextKeys';

const CRM_PERSON_SELECT = 'id, name, email, title, org, created_at';

/**
 * GET /api/v1/crm-people
 *
 * Tenant-scoped CRM people catalog for the /leads People tab. Scoped to the
 * caller's customer org unless they have tenant-wide company search.
 */
export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const allowed = await userCanViewLeads(auth.admin, auth.user.id);
  if (!allowed) return jsonError('Not permitted to view CRM people', 403);

  // Search terms never travel in a URL (#331). Person search is POST /api/v1/people/search.
  const keys = [...new URL(request.url).searchParams.keys()];
  if (keys.some((key) => FREE_TEXT_KEYS.has(key.toLowerCase()))) {
    return jsonError('Search terms are not accepted in the URL', 400);
  }

  const { data: profile, error: profileError } = await auth.admin
    .from('users')
    .select('tenant_id, company_id')
    .eq('id', auth.user.id)
    .single();
  if (profileError || !profile) return jsonError('User profile not found', 404);

  const tenantWide = await userCanSearchCompanies(auth.admin, auth.user.id);

  let builder = auth.admin
    .from('crm_people')
    .select(CRM_PERSON_SELECT)
    .eq('tenant_id', profile.tenant_id);

  if (!tenantWide && profile.company_id) {
    builder = builder.eq('registered_by_company_id', profile.company_id);
  }

  const { data, error } = await builder.order('name').limit(100);
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ people: data ?? [] });
}
