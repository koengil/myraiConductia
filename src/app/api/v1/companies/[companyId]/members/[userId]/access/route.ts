import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getCompanyEffectivePermissionsChecked,
  hasCompanyPermissionChecked,
} from '@/lib/api/v1/companyAccess';
import { isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import {
  COMPANY_PERMISSION,
  isCompanyPermission,
  type CompanyPermission,
} from '@/lib/constants/companyPermissions';
import { USER_STATUS } from '@/lib/constants/users';
import { COMPANY_TYPE } from '@/lib/constants/companies';

type RouteContext = { params: Promise<{ companyId: string; userId: string }> };

type AccessSnapshot = {
  company_id: string;
  user_id: string;
  version: number;
  assigned_roles: Array<{
    id: string;
    name: string;
    version: number;
    permission_keys: CompanyPermission[];
  }>;
  direct_permissions: CompanyPermission[];
  effective_permissions: Awaited<ReturnType<typeof getCompanyEffectivePermissionsChecked>>;
};

async function loadEligibleMember(
  admin: SupabaseClient,
  companyId: string,
  userId: string,
) {
  const { data: company, error: companyError } = await admin
    .from('companies')
    .select('type')
    .eq('id', companyId)
    .maybeSingle();
  if (companyError) return { kind: 'unreadable' as const };
  if (!company) return { kind: 'ineligible' as const };

  const { data, error } = await admin
    .from('users')
    .select('id, company_id, status, is_external')
    .eq('id', userId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) return { kind: 'unreadable' as const };
  if (!data || data.status !== USER_STATUS.ACTIVE) {
    return { kind: 'ineligible' as const };
  }
  if (company.type === COMPANY_TYPE.BANK && data.is_external) {
    return { kind: 'ineligible' as const };
  }
  return { kind: 'eligible' as const };
}

async function loadAccessSnapshot(
  admin: SupabaseClient,
  companyId: string,
  userId: string,
): Promise<AccessSnapshot | 'unreadable'> {
  const [accessResult, roleResult, directResult, effective] = await Promise.all([
    admin
      .from('company_member_access')
      .select('version')
      .eq('company_id', companyId)
      .eq('user_id', userId)
      .maybeSingle(),
    admin
      .from('company_member_roles')
      .select('role_id')
      .eq('company_id', companyId)
      .eq('user_id', userId),
    admin
      .from('company_member_permissions')
      .select('permission_key')
      .eq('company_id', companyId)
      .eq('user_id', userId),
    getCompanyEffectivePermissionsChecked(admin, userId, companyId),
  ]);

  if (accessResult.error || roleResult.error || directResult.error || effective === 'unreadable') {
    return 'unreadable';
  }

  const roleIds = ((roleResult.data ?? []) as { role_id: string }[]).map(
    (row) => row.role_id,
  );
  let roles: Array<{ id: string; name: string; version: number }> = [];
  let rolePermissions: Array<{ role_id: string; permission_key: string }> = [];
  if (roleIds.length > 0) {
    const [rolesResult, permissionsResult] = await Promise.all([
      admin
        .from('company_roles')
        .select('id, name, version')
        .eq('company_id', companyId)
        .is('archived_at', null)
        .in('id', roleIds),
      admin
        .from('company_role_permissions')
        .select('role_id, permission_key')
        .eq('company_id', companyId)
        .in('role_id', roleIds),
    ]);
    if (rolesResult.error || permissionsResult.error) return 'unreadable';
    roles = (rolesResult.data ?? []) as typeof roles;
    rolePermissions = (permissionsResult.data ?? []) as typeof rolePermissions;
  }

  const directPermissions = ((directResult.data ?? []) as { permission_key: unknown }[])
    .map((row) => row.permission_key)
    .filter(isCompanyPermission);
  if (directPermissions.length !== (directResult.data ?? []).length) return 'unreadable';

  return {
    company_id: companyId,
    user_id: userId,
    version: Number(accessResult.data?.version ?? 0),
    assigned_roles: roles.map((role) => ({
      ...role,
      permission_keys: rolePermissions
        .filter((row) => row.role_id === role.id)
        .map((row) => row.permission_key)
        .filter(isCompanyPermission),
    })),
    direct_permissions: directPermissions,
    effective_permissions: effective,
  };
}

async function mayReadAccess(
  admin: SupabaseClient,
  actorId: string,
  companyId: string,
  userId: string,
): Promise<boolean | 'unreadable'> {
  if (actorId === userId) return true;
  return hasCompanyPermissionChecked(
    admin,
    actorId,
    companyId,
    COMPANY_PERMISSION.ACCESS_ASSIGN,
  );
}

export async function GET(_request: Request, context: RouteContext) {
  const gate = await requireFlag('company_access_management');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const { companyId, userId } = await context.params;

  const allowed = await mayReadAccess(auth.admin, auth.user.id, companyId, userId);
  if (allowed === 'unreadable') return jsonError('Company access is unavailable', 503);
  if (!allowed) return jsonError('Forbidden', 403);

  const member = await loadEligibleMember(auth.admin, companyId, userId);
  if (member.kind === 'unreadable') return jsonError('Company access is unavailable', 503);
  if (member.kind === 'ineligible') return jsonError('Company member not found', 404);

  const access = await loadAccessSnapshot(auth.admin, companyId, userId);
  if (access === 'unreadable') return jsonError('Company access is unavailable', 503);
  return NextResponse.json({ access });
}

export async function PATCH(request: Request, context: RouteContext) {
  const gate = await requireFlag('company_access_management');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const { companyId, userId } = await context.params;

  const allowed = await hasCompanyPermissionChecked(
    auth.admin,
    auth.user.id,
    companyId,
    COMPANY_PERMISSION.ACCESS_ASSIGN,
  );
  if (allowed === 'unreadable') return jsonError('Company access is unavailable', 503);
  if (!allowed) return jsonError('Forbidden', 403);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return jsonError('JSON body must be an object', 400);
  }
  const body = rawBody as Record<string, unknown>;
  const expectedKeys = ['expectedVersion', 'roleIds', 'directPermissions'];
  if (
    Object.keys(body).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in body))
  ) {
    return jsonError('Send expectedVersion, roleIds, and directPermissions only', 400);
  }
  if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) {
    return jsonError('expectedVersion must be a non-negative integer', 400);
  }
  if (!Array.isArray(body.roleIds) || !body.roleIds.every(isUuid)) {
    return jsonError('roleIds must contain UUIDs', 400);
  }
  if (
    !Array.isArray(body.directPermissions) ||
    !body.directPermissions.every(isCompanyPermission)
  ) {
    return jsonError('directPermissions contains an unknown company permission', 400);
  }
  const roleIds = [...new Set(body.roleIds as string[])];
  const directPermissions = [...new Set(body.directPermissions as CompanyPermission[])];
  if (roleIds.length !== body.roleIds.length || directPermissions.length !== body.directPermissions.length) {
    return jsonError('Role and permission assignments must be unique', 400);
  }

  const member = await loadEligibleMember(auth.admin, companyId, userId);
  if (member.kind === 'unreadable') return jsonError('Company access is unavailable', 503);
  if (member.kind === 'ineligible') return jsonError('Company member not found', 404);

  const { error } = await auth.admin.rpc('replace_company_member_access', {
    p_actor_id: auth.user.id,
    p_company_id: companyId,
    p_user_id: userId,
    p_expected_version: Number(body.expectedVersion),
    p_role_ids: roleIds,
    p_direct_permission_keys: directPermissions,
  });
  if (error) {
    if (error.message.includes('stale_version')) {
      return jsonError('Employee access changed concurrently. Reload and retry.', 409);
    }
    if (error.message.includes('protected_access_root')) {
      return jsonError('Protected company administrators have immutable access', 409);
    }
    if (
      error.message.includes('grant_outside_envelope') ||
      error.message.includes('grant_envelope_exceeded') ||
      error.message.includes('not_permitted')
    ) {
      return jsonError('Forbidden', 403);
    }
    if (error.message.includes('member_not_eligible')) {
      return jsonError('Company member not found', 404);
    }
    if (error.message.includes('invalid_role') || error.message.includes('invalid_permission')) {
      return jsonError('Invalid company access assignment', 400);
    }
    return jsonError('Unable to update company access', 500);
  }

  const access = await loadAccessSnapshot(auth.admin, companyId, userId);
  if (access === 'unreadable') return jsonError('Company access is unavailable', 503);
  return NextResponse.json({ access });
}
