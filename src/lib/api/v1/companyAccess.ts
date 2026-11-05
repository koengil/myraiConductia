import type { SupabaseClient } from '@supabase/supabase-js';
import {
  isCompanyPermission,
  type CompanyPermission,
} from '@/lib/constants/companyPermissions';

export const COMPANY_PERMISSION_SOURCE = {
  ROOT: 'root',
  ROLE: 'role',
  DIRECT: 'direct',
} as const;

export type CompanyPermissionSourceType =
  (typeof COMPANY_PERMISSION_SOURCE)[keyof typeof COMPANY_PERMISSION_SOURCE];

export type CompanyPermissionSource = {
  type: CompanyPermissionSourceType;
  id: string | null;
  name: string | null;
};

/** One effective permission and the authoritative database source that grants it. */
export type CompanyEffectivePermission = {
  permissionKey: CompanyPermission;
  source: CompanyPermissionSource;
};

export type CompanyAccessReadResult<T> = T | 'unreadable';

type EffectivePermissionRow = {
  permission_key: unknown;
  source_type: unknown;
  source_id: unknown;
  source_name: unknown;
};

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

const isSourceType = (value: unknown): value is CompanyPermissionSourceType =>
  value === COMPANY_PERMISSION_SOURCE.ROOT ||
  value === COMPANY_PERMISSION_SOURCE.ROLE ||
  value === COMPANY_PERMISSION_SOURCE.DIRECT;

function parseEffectivePermissionRow(row: unknown): CompanyEffectivePermission | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;

  const candidate = row as EffectivePermissionRow;
  if (
    !isCompanyPermission(candidate.permission_key) ||
    !isSourceType(candidate.source_type) ||
    !isNullableString(candidate.source_id) ||
    !isNullableString(candidate.source_name)
  ) {
    return null;
  }

  return {
    permissionKey: candidate.permission_key,
    source: {
      type: candidate.source_type,
      id: candidate.source_id,
      name: candidate.source_name,
    },
  };
}

/**
 * Resolve a user's effective company permissions, including every granting
 * source. SQL owns eligibility, root resolution, and assignment joins; this
 * wrapper only validates and types that authoritative result.
 */
export async function getCompanyEffectivePermissionsChecked(
  admin: SupabaseClient,
  userId: string,
  companyId: string,
): Promise<CompanyAccessReadResult<CompanyEffectivePermission[]>> {
  const { data, error } = await admin.rpc('app_company_effective_permissions', {
    p_user_id: userId,
    p_company_id: companyId,
  });

  if (error || !Array.isArray(data)) return 'unreadable';

  const permissions: CompanyEffectivePermission[] = [];
  for (const row of data) {
    const parsed = parseEffectivePermissionRow(row);
    if (!parsed) return 'unreadable';
    permissions.push(parsed);
  }
  return permissions;
}

/** A readable authorization decision. Database and contract failures remain distinct. */
export async function hasCompanyPermissionChecked(
  admin: SupabaseClient,
  userId: string,
  companyId: string,
  permissionKey: CompanyPermission,
): Promise<CompanyAccessReadResult<boolean>> {
  const { data, error } = await admin.rpc('app_has_company_permission', {
    p_user_id: userId,
    p_company_id: companyId,
    p_permission_key: permissionKey,
  });

  if (error || typeof data !== 'boolean') return 'unreadable';
  return data;
}

/** Enforcement form: any unreadable authorization result denies. */
export async function hasCompanyPermission(
  admin: SupabaseClient,
  userId: string,
  companyId: string,
  permissionKey: CompanyPermission,
): Promise<boolean> {
  return (
    (await hasCompanyPermissionChecked(admin, userId, companyId, permissionKey)) === true
  );
}
