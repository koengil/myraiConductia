import { NextResponse } from 'next/server';
import { canManageCompanyMembers, userCanViewCompany } from '@/lib/api/v1/access';
import { hasCompanyPermissionChecked } from '@/lib/api/v1/companyAccess';
import { auditFailed, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { COMPANY_TYPE } from '@/lib/constants/companies';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import {
  COMPANY_ROLES,
  COMPANY_ROLE,
  DEPARTMENT,
  type CompanyRole,
} from '@/lib/constants/roles';
import { USER_STATUS } from '@/lib/constants/users';

type RouteContext = { params: Promise<{ companyId: string }> };

/**
 * List a company's members. For the bank company this remains the wall-safe Gate
 * 0 roster: research and trading are never listed unless a manager opts in with
 * ?includeWalled=true, and external users are excluded. For client and other
 * managed companies the roster includes every seat holder — including external
 * directors and employees onboarded through the company invite flow.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId } = await context.params;

  const allowed = await userCanViewCompany(auth.admin, auth.user.id, companyId);
  if (!allowed) return jsonError('Not permitted to view this company roster', 403);

  const wantsWalled = new URL(request.url).searchParams.get('includeWalled') === 'true';
  const managing = wantsWalled
    ? await canManageCompanyMembers(auth.admin, auth.user.id, companyId)
    : false;
  let canViewWalled = managing;
  if (wantsWalled && !canViewWalled && (await isFlagEnabled('company_access_management'))) {
    canViewWalled =
      (await hasCompanyPermissionChecked(
        auth.admin,
        auth.user.id,
        companyId,
        COMPANY_PERMISSION.DIRECTORY_VIEW_ALL,
      )) === true;
  }

  const { data: company, error: companyError } = await auth.admin
    .from('companies')
    .select('type')
    .eq('id', companyId)
    .maybeSingle();
  if (companyError) return jsonError(companyError.message, 500);
  if (!company) return jsonError('Company not found', 404);

  const isBankCompany = company.type === COMPANY_TYPE.BANK;

  let query = auth.admin
    .from('users')
    .select(
      'id, full_name, display_name, email, department, firm_role, company_role, can_invite, preferred_deal_role',
    )
    .eq('company_id', companyId);
  if (isBankCompany) {
    query = query.eq('is_external', false);
    if (!canViewWalled) {
      // Exclude only the walled departments; keep members with a null department
      // (three-valued logic would otherwise drop them from a plain NOT IN).
      query = query.or(
        `department.is.null,department.not.in.(${DEPARTMENT.RESEARCH},${DEPARTMENT.TRADING})`,
      );
    }
  }
  const { data, error } = await query.order('full_name');
  if (error) return jsonError(error.message, 500);

  const members = (data ?? []).map((member) => ({
    ...member,
    is_walled:
      member.department === DEPARTMENT.RESEARCH || member.department === DEPARTMENT.TRADING,
  }));
  return NextResponse.json({ members });
}

/**
 * Add (or re-assign the role of) a company member. Director-gated. The target
 * must already have an account (1 email = 1 account; provisioning new accounts
 * is a separate flow) and must not already belong to another company. Also
 * serves promote/demote by setting company_role; directors cannot demote
 * themselves (S3). The DB >=1-director trigger rejects demoting the last
 * director while members remain.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId } = await context.params;

  const allowed = await canManageCompanyMembers(auth.admin, auth.user.id, companyId);
  if (!allowed) return jsonError('Only a company director can add members', 403);

  let body: { email?: string; companyRole?: string };
  try {
    body = (await request.json()) as { email?: string; companyRole?: string };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const email = body.email?.trim().toLowerCase();
  const companyRole = body.companyRole;
  if (!email || !companyRole) {
    return jsonError('email and companyRole are required', 400);
  }
  if (!COMPANY_ROLES.includes(companyRole as CompanyRole)) {
    return jsonError('Invalid companyRole', 400);
  }

  const { data: company, error: companyError } = await auth.admin
    .from('companies')
    .select('tenant_id')
    .eq('id', companyId)
    .maybeSingle();
  if (companyError) return jsonError(companyError.message, 500);
  if (!company) return jsonError('Company not found', 404);

  const { data: target, error: targetError } = await auth.admin
    .from('users')
    .select('id, company_id, department, tenant_id')
    .eq('email', email)
    .maybeSingle();
  if (targetError) return jsonError(targetError.message, 500);
  if (!target || target.tenant_id !== company.tenant_id) {
    return jsonError('User not found. They must have an account first', 404);
  }
  if (target.company_id && target.company_id !== companyId) {
    return jsonError('User already belongs to another company', 409);
  }

  // A director manages seats on every deal the bank owns, so the company
  // management surface must not promote research or trading users.
  const walled =
    target.department === DEPARTMENT.RESEARCH || target.department === DEPARTMENT.TRADING;
  if (walled && companyRole === COMPANY_ROLE.DIRECTOR) {
    return jsonError('A walled-department member cannot be a company director', 403);
  }

  // S3 — no self-demote.
  if (target.id === auth.user.id && companyRole !== COMPANY_ROLE.DIRECTOR) {
    return jsonError('You cannot demote yourself from director', 403);
  }

  const { data: member, error: updateError } = await auth.admin
    .from('users')
    .update({ company_id: companyId, company_role: companyRole, status: USER_STATUS.ACTIVE })
    .eq('id', target.id)
    .select('id, email, company_id, company_role, status')
    .single();
  if (updateError) {
    // Most likely the >=1-director invariant (demoting the last director).
    return jsonError(updateError.message, 409);
  }

  const { error: auditError } = await auth.admin.from('audit_log').insert({
    actor_id: auth.user.id,
    action: AUDIT_ACTION.GRANT,
    detail: {
      reason: 'company_member_added',
      user: target.id,
      company_id: companyId,
      company_role: companyRole,
    },
  });
  if (auditError) return auditFailed(auditError, 'The member change was saved, but its audit record could not be written. Contact compliance before retrying.');

  return NextResponse.json({ member }, { status: 201 });
}
