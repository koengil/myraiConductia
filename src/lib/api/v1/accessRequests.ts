import type { SupabaseClient } from '@supabase/supabase-js';

import { hasCompanyPermission } from '@/lib/api/v1/companyAccess';
import {
  ACCESS_DESTINATION_DEFS,
  ACCESS_REQUEST_STATUS,
  type AccessDestination,
} from '@/lib/constants/accessRequests';
import {
  COMPANY_PERMISSION,
  type CompanyPermission,
} from '@/lib/constants/companyPermissions';
import { COMPANY_ROLE } from '@/lib/constants/roles';
import { TABLE } from '@/lib/constants/tables';
import { USER_STATUS } from '@/lib/constants/users';
import { dbFailure } from '@/lib/errors/upstream';

export type AccessRequestRow = {
  id: string;
  company_id: string;
  requester_id: string;
  destination: AccessDestination;
  permission_key: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
};

export type CallerProfile = {
  id: string;
  tenant_id: string;
  company_id: string | null;
  company_role: string | null;
  firm_role: string | null;
  display_name: string | null;
  full_name: string;
  status: string;
};

export async function loadCallerProfile(
  admin: SupabaseClient,
  userId: string,
): Promise<CallerProfile | null> {
  const { data, error } = await admin
    .from(TABLE.USERS)
    .select('id, tenant_id, company_id, company_role, firm_role, display_name, full_name, status')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return data as CallerProfile;
}

export function displayNameFor(profile: { display_name: string | null; full_name: string }): string {
  return profile.display_name || profile.full_name;
}

export async function isCompanyAccessAdmin(
  admin: SupabaseClient,
  profile: CallerProfile,
  companyId: string,
): Promise<boolean> {
  if (profile.firm_role === 'admin') return true;
  if (profile.company_id === companyId && profile.company_role === COMPANY_ROLE.DIRECTOR) {
    return true;
  }
  return hasCompanyPermission(admin, profile.id, companyId, COMPANY_PERMISSION.ACCESS_ASSIGN);
}

export async function listApproverIds(
  admin: SupabaseClient,
  companyId: string,
): Promise<string[]> {
  const { data, error } = await admin
    .from(TABLE.USERS)
    .select('id, company_role, firm_role')
    .eq('company_id', companyId)
    .eq('status', USER_STATUS.ACTIVE);
  if (error) throw dbFailure('Company members lookup', error);

  const ids: string[] = [];
  for (const row of data ?? []) {
    const id = row.id as string;
    if (row.firm_role === 'admin' || row.company_role === COMPANY_ROLE.DIRECTOR) {
      ids.push(id);
      continue;
    }
    if (await hasCompanyPermission(admin, id, companyId, COMPANY_PERMISSION.ACCESS_ASSIGN)) {
      ids.push(id);
    }
  }
  return ids;
}

export async function grantRequestedPermission(
  admin: SupabaseClient,
  opts: {
    actorId: string;
    companyId: string;
    userId: string;
    permission: CompanyPermission;
  },
): Promise<void> {
  const already = await hasCompanyPermission(
    admin,
    opts.userId,
    opts.companyId,
    opts.permission,
  );
  if (already) return;

  const { error } = await admin.rpc('grant_access_request_permission', {
    p_actor_id: opts.actorId,
    p_company_id: opts.companyId,
    p_user_id: opts.userId,
    p_permission_key: opts.permission,
  });
  if (error) throw dbFailure('Access grant', error);
}

export function serializeRequest(
  row: AccessRequestRow,
  requesterName?: string,
): {
  id: string;
  companyId: string;
  requesterId: string;
  requesterName: string | null;
  destination: AccessDestination;
  destinationLabel: string;
  permissionKey: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
} {
  const def = ACCESS_DESTINATION_DEFS[row.destination];
  return {
    id: row.id,
    companyId: row.company_id,
    requesterId: row.requester_id,
    requesterName: requesterName ?? null,
    destination: row.destination,
    destinationLabel: def?.label ?? row.destination,
    permissionKey: row.permission_key,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

export { ACCESS_REQUEST_STATUS };
