import type { CompanyEffectivePermission } from '@/lib/api/v1/companyAccess';
import type { CompanyPermission } from '@/lib/constants/companyPermissions';

export type CompanyPermissionDefinition = {
  key: CompanyPermission;
  label: string;
  description: string;
  category: string;
  sortOrder: number;
};

export type CompanyRoleSummary = {
  id: string;
  name: string;
  description: string | null;
  version: number;
  permissionKeys: CompanyPermission[];
  assignmentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CompanyRolesResponse = {
  permissions: CompanyPermissionDefinition[];
  roles: CompanyRoleSummary[];
  viewerPermissions: CompanyEffectivePermission[];
};

export type CompanyAssignedRole = {
  id: string;
  name: string;
  version: number;
  permission_keys: CompanyPermission[];
};

export type CompanyMemberAccess = {
  company_id: string;
  user_id: string;
  version: number;
  assigned_roles: CompanyAssignedRole[];
  direct_permissions: CompanyPermission[];
  effective_permissions: CompanyEffectivePermission[];
};

export function effectivePermissionKeys(
  permissions: CompanyEffectivePermission[] | undefined,
): Set<CompanyPermission> {
  return new Set((permissions ?? []).map((permission) => permission.permissionKey));
}

