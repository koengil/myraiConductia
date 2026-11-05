import { NextResponse } from 'next/server';
import {
  canReadCompanyRoles,
  canWriteCompanyRoles,
  parseCompanyRoleInput,
  parseRoleMutationResult,
  roleMutationErrorResponse,
} from '@/lib/api/v1/companyRoleApi';
import { getCompanyEffectivePermissionsChecked } from '@/lib/api/v1/companyAccess';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { TABLE } from '@/lib/constants/tables';

type RouteContext = { params: Promise<{ companyId: string }> };

type PermissionRow = {
  key: string;
  label: string;
  description: string;
  category: string;
  sort_order: number;
};

type RoleRow = {
  id: string;
  name: string;
  description: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type RolePermissionRow = { role_id: string; permission_key: string };
type RoleAssignmentRow = { role_id: string };

export async function GET(_request: Request, context: RouteContext) {
  const gate = await requireFlag('company_access_management');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId } = await context.params;
  const allowed = await canReadCompanyRoles(auth.admin, auth.user.id, companyId);
  if (allowed === 'unreadable') return jsonError('Unable to resolve company role access', 500);
  if (!allowed) return jsonError('Not permitted to view company roles', 403);

  await auth.admin.rpc('seed_bank_compliance_role', {
    p_company_id: companyId,
    p_actor_id: auth.user.id,
  });

  const [permissionsResult, rolesResult, rolePermissionsResult, assignmentsResult, viewerResult] =
    await Promise.all([
      auth.admin
        .from(TABLE.COMPANY_PERMISSIONS)
        .select('key, label, description, category, sort_order')
        .order('sort_order'),
      auth.admin
        .from(TABLE.COMPANY_ROLES)
        .select('id, name, description, version, created_at, updated_at')
        .eq('company_id', companyId)
        .is('archived_at', null)
        .order('name'),
      auth.admin
        .from(TABLE.COMPANY_ROLE_PERMISSIONS)
        .select('role_id, permission_key')
        .eq('company_id', companyId),
      auth.admin
        .from(TABLE.COMPANY_MEMBER_ROLES)
        .select('role_id')
        .eq('company_id', companyId),
      getCompanyEffectivePermissionsChecked(auth.admin, auth.user.id, companyId),
    ]);

  if (
    permissionsResult.error ||
    rolesResult.error ||
    rolePermissionsResult.error ||
    assignmentsResult.error ||
    viewerResult === 'unreadable'
  ) {
    return jsonError('Unable to load company roles', 500);
  }

  const permissionKeysByRole = new Map<string, string[]>();
  for (const row of (rolePermissionsResult.data ?? []) as RolePermissionRow[]) {
    const keys = permissionKeysByRole.get(row.role_id) ?? [];
    keys.push(row.permission_key);
    permissionKeysByRole.set(row.role_id, keys);
  }

  const assignmentCounts = new Map<string, number>();
  for (const row of (assignmentsResult.data ?? []) as RoleAssignmentRow[]) {
    assignmentCounts.set(row.role_id, (assignmentCounts.get(row.role_id) ?? 0) + 1);
  }

  const permissions = ((permissionsResult.data ?? []) as PermissionRow[]).map((permission) => ({
    key: permission.key,
    label: permission.label,
    description: permission.description,
    category: permission.category,
    sortOrder: permission.sort_order,
  }));
  const roles = ((rolesResult.data ?? []) as RoleRow[]).map((role) => ({
    id: role.id,
    name: role.name,
    description: role.description,
    version: role.version,
    permissionKeys: (permissionKeysByRole.get(role.id) ?? []).sort(),
    assignmentCount: assignmentCounts.get(role.id) ?? 0,
    createdAt: role.created_at,
    updatedAt: role.updated_at,
  }));

  return NextResponse.json({ permissions, roles, viewerPermissions: viewerResult });
}

export async function POST(request: Request, context: RouteContext) {
  const gate = await requireFlag('company_access_management');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId } = await context.params;
  if (!(await canWriteCompanyRoles(auth.admin, auth.user.id, companyId))) {
    return jsonError('Not permitted to manage company roles', 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const parsed = parseCompanyRoleInput(body);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  const { data, error } = await auth.admin.rpc('create_company_role', {
    p_actor_id: auth.user.id,
    p_company_id: companyId,
    p_name: parsed.value.name,
    p_description: parsed.value.description,
    p_permission_keys: parsed.value.permissionKeys,
  });
  if (error) return roleMutationErrorResponse(auth.admin, error, companyId);

  const role = parseRoleMutationResult(data);
  if (!role) return jsonError('Unable to create company role', 500);
  return NextResponse.json({ role }, { status: 201 });
}
