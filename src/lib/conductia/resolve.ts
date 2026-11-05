import type { SupabaseClient } from '@supabase/supabase-js';

import { loadDealByIdOrCode } from '@/lib/dataroom/steps';

export type LeadCompany = {
  id: string;
  name: string;
  tenantId: string;
  registeredByCompanyId: string | null;
};

export async function resolveLeadCompany(
  admin: SupabaseClient,
  leadId: string,
): Promise<LeadCompany | null> {
  const { data: company } = await admin
    .from('companies')
    .select('id, name, tenant_id, registered_by_company_id')
    .eq('id', leadId)
    .maybeSingle();
  if (company?.id) {
    return {
      id: company.id as string,
      name: (company.name as string | null)?.trim() || 'Lead',
      tenantId: company.tenant_id as string,
      registeredByCompanyId: (company.registered_by_company_id as string | null) ?? null,
    };
  }

  const dealRef = await loadDealByIdOrCode(admin, leadId);
  if (!dealRef) return null;

  const { data: parties } = await admin
    .from('deal_parties')
    .select('party_role, company:companies(id, name, tenant_id, registered_by_company_id)')
    .eq('deal_id', dealRef.id);
  const target = (parties ?? []).find((row) => row.party_role === 'target');
  const raw = target?.company;
  const row = (Array.isArray(raw) ? raw[0] : raw) as
    | {
        id?: string;
        name?: string | null;
        tenant_id?: string;
        registered_by_company_id?: string | null;
      }
    | null;
  if (!row?.id) return null;
  return {
    id: row.id,
    name: row.name?.trim() || 'Lead',
    tenantId: row.tenant_id ?? '',
    registeredByCompanyId: row.registered_by_company_id ?? null,
  };
}
