import type { SupabaseClient } from '@supabase/supabase-js';

import { hasCompanyPermissionChecked } from '@/lib/api/v1/companyAccess';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import { TABLE } from '@/lib/constants/tables';

export type TemplateActor =
  | { ok: true; companyId: string }
  | { ok: false; status: number; error: string };

export async function requireTemplateActor(
  admin: SupabaseClient,
  userId: string,
): Promise<TemplateActor> {
  const { data, error } = await admin
    .from(TABLE.USERS)
    .select('company_id, is_external')
    .eq('id', userId)
    .maybeSingle();
  if (error) return { ok: false, status: 503, error: 'Could not read the caller.' };
  if (!data || data.is_external || !data.company_id) {
    return { ok: false, status: 403, error: 'Not permitted to configure rail templates.' };
  }

  const allowed = await hasCompanyPermissionChecked(
    admin,
    userId,
    data.company_id as string,
    COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE,
  );
  if (allowed === 'unreadable') {
    return { ok: false, status: 503, error: 'Could not read the caller.' };
  }
  if (!allowed) {
    return { ok: false, status: 403, error: 'Not permitted to configure rail templates.' };
  }
  return { ok: true, companyId: data.company_id as string };
}
