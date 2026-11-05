// The worker-side read of the owner's per-tenant switches (G-01 #173; 20261023110100_discovery_tenant_approvals.sql).
// Service-role client only: the table is closed to every other role and written only by reviewed migrations.
//
// A capability is on for a firm company while its row is live (never revoked). The table is shared: each task asks
// for its own capability (team_proposals, milestone_rules, firm_name_alias) and sees only that capability's rows.
// team_proposals also needs the reviewed TS list (TEAM_PROPOSAL_FIRMS); the other two need only the row.

import type { SupabaseClient } from '@supabase/supabase-js';

import type { TenantCapability } from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';

/**
 * The firm company ids with `capability` on in a tenant. Fail closed: any read error, a thrown call or a malformed
 * answer is "none", which is off. Nothing here logs; an error is a code the caller never needs.
 */
export async function loadTenantApprovals(
  db: SupabaseClient,
  tenantId: string,
  capability: TenantCapability,
): Promise<string[]> {
  try {
    const { data, error } = await db
      .from(TABLE.DISCOVERY_TENANT_APPROVALS)
      .select('firm_company_id')
      .eq('tenant_id', tenantId)
      .eq('capability', capability)
      .is('revoked_at', null);
    if (error || !Array.isArray(data)) return [];
    const firms = new Set<string>();
    for (const row of data as Array<{ firm_company_id?: unknown }>) {
      if (typeof row?.firm_company_id === 'string') firms.add(row.firm_company_id);
    }
    return [...firms];
  } catch {
    return [];
  }
}
