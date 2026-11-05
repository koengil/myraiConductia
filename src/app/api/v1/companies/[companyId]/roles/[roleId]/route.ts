import { NextResponse } from 'next/server';
import {
  canWriteCompanyRoles,
  parseCompanyRoleInput,
  parseExpectedVersion,
  parseRoleMutationResult,
  roleMutationErrorResponse,
} from '@/lib/api/v1/companyRoleApi';
import { isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/api/v1/requireFlag';

type RouteContext = { params: Promise<{ companyId: string; roleId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const gate = await requireFlag('company_access_management');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId, roleId } = await context.params;
  if (!isUuid(roleId)) return jsonError('Not found', 404);
  if (!(await canWriteCompanyRoles(auth.admin, auth.user.id, companyId))) {
    return jsonError('Not permitted to manage company roles', 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError('JSON body must be an object', 400);
  }
  const record = body as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter(
    (key) => !['expectedVersion', 'name', 'description', 'permissionKeys'].includes(key),
  );
  if (unknownFields.length > 0) return jsonError(`Unknown field: ${unknownFields[0]}`, 400);

  const expectedVersion = parseExpectedVersion(record.expectedVersion);
  if (!expectedVersion.ok) return jsonError(expectedVersion.error, 400);
  const roleInput = parseCompanyRoleInput({
    name: record.name,
    description: record.description,
    permissionKeys: record.permissionKeys,
  });
  if (!roleInput.ok) return jsonError(roleInput.error, 400);

  const { data, error } = await auth.admin.rpc('replace_company_role', {
    p_actor_id: auth.user.id,
    p_company_id: companyId,
    p_role_id: roleId,
    p_expected_version: expectedVersion.value,
    p_name: roleInput.value.name,
    p_description: roleInput.value.description,
    p_permission_keys: roleInput.value.permissionKeys,
  });
  if (error) return roleMutationErrorResponse(auth.admin, error, companyId, roleId);

  const role = parseRoleMutationResult(data);
  if (!role) return jsonError('Unable to update company role', 500);
  return NextResponse.json({ role });
}

export async function DELETE(request: Request, context: RouteContext) {
  const gate = await requireFlag('company_access_management');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId, roleId } = await context.params;
  if (!isUuid(roleId)) return jsonError('Not found', 404);
  if (!(await canWriteCompanyRoles(auth.admin, auth.user.id, companyId))) {
    return jsonError('Not permitted to manage company roles', 403);
  }

  const rawVersion = new URL(request.url).searchParams.get('expectedVersion');
  const numericVersion = rawVersion === null || rawVersion.trim() === '' ? null : Number(rawVersion);
  const expectedVersion = parseExpectedVersion(numericVersion);
  if (!expectedVersion.ok) return jsonError(expectedVersion.error, 400);

  const { data, error } = await auth.admin.rpc('archive_company_role', {
    p_actor_id: auth.user.id,
    p_company_id: companyId,
    p_role_id: roleId,
    p_expected_version: expectedVersion.value,
  });
  if (error) return roleMutationErrorResponse(auth.admin, error, companyId, roleId);

  const role = parseRoleMutationResult(data);
  if (!role) return jsonError('Unable to archive company role', 500);
  return NextResponse.json({ role });
}
