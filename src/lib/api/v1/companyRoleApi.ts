import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  hasCompanyPermission,
  hasCompanyPermissionChecked,
} from '@/lib/api/v1/companyAccess';
import { jsonError } from '@/lib/api/v1/http';
import {
  COMPANY_PERMISSION,
  isCompanyPermission,
  type CompanyPermission,
} from '@/lib/constants/companyPermissions';
import { TABLE } from '@/lib/constants/tables';

export type CompanyRoleInput = {
  name: string;
  description: string | null;
  permissionKeys: CompanyPermission[];
};

type RoleMutationResult = {
  id: string;
  version: number;
};

type DatabaseError = {
  code?: string;
  message?: string;
};

const ROLE_FIELDS = new Set(['name', 'description', 'permissionKeys']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseCompanyRoleInput(
  value: unknown,
): { ok: true; value: CompanyRoleInput } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'JSON body must be an object' };

  const unknownFields = Object.keys(value).filter((key) => !ROLE_FIELDS.has(key));
  if (unknownFields.length > 0) {
    return { ok: false, error: `Unknown field: ${unknownFields[0]}` };
  }

  if (typeof value.name !== 'string') {
    return { ok: false, error: 'name must be a string' };
  }
  const name = value.name.trim();
  if (name.length < 2 || name.length > 80) {
    return { ok: false, error: 'name must be between 2 and 80 characters' };
  }

  if (value.description !== null && typeof value.description !== 'string') {
    return { ok: false, error: 'description must be a string or null' };
  }
  const description =
    typeof value.description === 'string' ? value.description.trim() || null : null;

  if (!Array.isArray(value.permissionKeys)) {
    return { ok: false, error: 'permissionKeys must be a list' };
  }
  if (!value.permissionKeys.every(isCompanyPermission)) {
    return { ok: false, error: 'permissionKeys contains an invalid company permission' };
  }
  if (new Set(value.permissionKeys).size !== value.permissionKeys.length) {
    return { ok: false, error: 'permissionKeys must not contain duplicates' };
  }

  return {
    ok: true,
    value: { name, description, permissionKeys: value.permissionKeys },
  };
}

export function parseExpectedVersion(
  value: unknown,
): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return { ok: false, error: 'expectedVersion must be a positive integer' };
  }
  return { ok: true, value };
}

export function parseRoleMutationResult(value: unknown): RoleMutationResult | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string') return null;
  if (typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1) {
    return null;
  }
  return { id: value.id, version: value.version };
}

export async function canReadCompanyRoles(
  admin: SupabaseClient,
  userId: string,
  companyId: string,
): Promise<boolean | 'unreadable'> {
  const canManage = await hasCompanyPermissionChecked(
    admin,
    userId,
    companyId,
    COMPANY_PERMISSION.ROLES_MANAGE,
  );
  if (canManage === 'unreadable' || canManage) return canManage;

  return hasCompanyPermissionChecked(
    admin,
    userId,
    companyId,
    COMPANY_PERMISSION.ACCESS_ASSIGN,
  );
}

export async function canWriteCompanyRoles(
  admin: SupabaseClient,
  userId: string,
  companyId: string,
): Promise<boolean> {
  return hasCompanyPermission(
    admin,
    userId,
    companyId,
    COMPANY_PERMISSION.ROLES_MANAGE,
  );
}

const ERROR_MESSAGES: Record<string, { status: number; message: string }> = {
  invalid_role_name: { status: 400, message: 'Invalid role name' },
  invalid_company_permission: { status: 400, message: 'Invalid company permission' },
  not_permitted: { status: 403, message: 'Not permitted to manage company roles' },
  grant_outside_envelope: {
    status: 403,
    message: 'A role cannot grant permissions the actor does not have',
  },
  actor_not_found: { status: 403, message: 'Not permitted to manage company roles' },
  company_not_eligible: { status: 404, message: 'Company not found' },
  company_access_requires_bank_company: { status: 404, message: 'Company not found' },
  company_access_requires_managed_company: { status: 404, message: 'Company not found' },
  role_not_found: { status: 404, message: 'Role not found' },
  role_archived: { status: 404, message: 'Role not found' },
  role_name_conflict: { status: 409, message: 'An active role with this name already exists' },
  stale_version: { status: 409, message: 'Role version is stale' },
  role_assigned: { status: 409, message: 'Assigned roles cannot be archived' },
};

function knownError(error: DatabaseError): { key: string; status: number; message: string } | null {
  const message = error.message ?? '';
  for (const [key, mapped] of Object.entries(ERROR_MESSAGES)) {
    if (message.includes(key)) return { key, ...mapped };
  }
  if (error.code === '23505') {
    return {
      key: 'role_name_conflict',
      status: 409,
      message: ERROR_MESSAGES.role_name_conflict.message,
    };
  }
  return null;
}

export async function roleMutationErrorResponse(
  admin: SupabaseClient,
  error: DatabaseError,
  companyId: string,
  roleId?: string,
): Promise<NextResponse> {
  const mapped = knownError(error);
  if (!mapped) return jsonError('Unable to update company role', 500);

  if (mapped.key !== 'role_assigned' || !roleId) {
    return jsonError(mapped.message, mapped.status);
  }

  const countResult = await admin
    .from(TABLE.COMPANY_MEMBER_ROLES)
    .select('role_id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('role_id', roleId);
  if (countResult.error || typeof countResult.count !== 'number') {
    return jsonError('Unable to update company role', 500);
  }
  return NextResponse.json(
    { error: mapped.message, assignmentCount: countResult.count },
    { status: mapped.status },
  );
}
