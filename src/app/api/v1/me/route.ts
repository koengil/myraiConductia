import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { jsonError, requireApiUser, type ApiUser } from '@/lib/api/v1/http';
import { getCompanyEffectivePermissionsChecked } from '@/lib/api/v1/companyAccess';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { PARTY_ROLE } from '@/lib/constants/companies';
import { DEV_TENANT_ID } from '@/lib/db/tenant';
import { checkProfileDisplayName, checkProfileFullName } from '@/lib/validation/inputPolicy';
import { errorCodeOf } from '@/lib/errors/upstream';

const USER_COLUMNS =
  'id, email, full_name, display_name, firm_role, department, is_external, status, company_id, company_role, can_invite';

type AuthOk = {
  user: ApiUser;
  admin: SupabaseClient;
};

type ProfileRow = {
  id: string;
  email: string;
  full_name: string;
  display_name: string | null;
  firm_role: string | null;
  department: string | null;
  is_external: boolean;
  status: string;
  company_id: string | null;
  company_role: string | null;
  can_invite: boolean;
};

function nameFromEmail(email: string): string {
  return email.split('@')[0] || email;
}

async function loadOrProvisionProfile(
  auth: AuthOk,
): Promise<{ ok: true; profile: ProfileRow } | { ok: false; response: NextResponse }> {
  const { data, error } = await auth.admin
    .from('users')
    .select(USER_COLUMNS)
    .eq('id', auth.user.id)
    .maybeSingle();

  if (error) return { ok: false, response: jsonError(`Profile lookup failed (${errorCodeOf(error)})`, 500) };
  if (data) return { ok: true, profile: data as ProfileRow };

  const { error: insertError } = await auth.admin.from('users').insert({
    id: auth.user.id,
    tenant_id: DEV_TENANT_ID,
    email: auth.user.email,
    full_name: nameFromEmail(auth.user.email),
    status: 'active',
  });
  if (insertError) return { ok: false, response: jsonError(`Profile write failed (${errorCodeOf(insertError)})`, 500) };

  const { data: created, error: reloadError } = await auth.admin
    .from('users')
    .select(USER_COLUMNS)
    .eq('id', auth.user.id)
    .maybeSingle();
  if (reloadError || !created) {
    return {
      ok: false,
      response: jsonError(
        reloadError ? `Profile could not be created (${errorCodeOf(reloadError)})` : 'Profile could not be created',
        500,
      ),
    };
  }
  return { ok: true, profile: created as ProfileRow };
}

async function meResponse(auth: AuthOk, profile: ProfileRow): Promise<NextResponse> {
  let company: { id: string; name: string } | null = null;
  if (profile.company_id) {
    const { data: companyRow } = await auth.admin
      .from('companies')
      .select('id, name')
      .eq('id', profile.company_id)
      .maybeSingle();
    if (companyRow?.id && companyRow?.name) {
      company = { id: companyRow.id as string, name: companyRow.name as string };
    }
  }

  const { data: memberships, error: membershipError } = await auth.admin
    .from('deal_memberships')
    .select('deal_id, deal_role, phase, deal:deals(code)')
    .eq('user_id', auth.user.id);

  if (membershipError) return jsonError(`Deal membership lookup failed (${errorCodeOf(membershipError)})`, 500);

  let companyPermissions:
    | Awaited<ReturnType<typeof getCompanyEffectivePermissionsChecked>>
    | undefined;
  if (profile.company_id && (await isFlagEnabled('company_access_management'))) {
    companyPermissions = await getCompanyEffectivePermissionsChecked(
      auth.admin,
      auth.user.id,
      profile.company_id,
    );
    if (companyPermissions === 'unreadable') {
      return jsonError('Company access is unavailable', 503);
    }
  }

  // Resolve the primary active mandate for the profile context line. Picks the
  // first membership's deal and its target company. Null for users with no
  // deal membership (e.g. CCO / admin who sit above the walls).
  let mandate: {
    dealId: string;
    code: string;
    codename: string;
    status: string;
    dealRole: string;
    targetName: string | null;
  } | null = null;

  const primary = memberships?.[0];
  if (primary) {
    const { data: deal } = await auth.admin
      .from('deals')
      .select('id, code, codename, status')
      .eq('id', primary.deal_id)
      .maybeSingle();

    if (deal) {
      const { data: targetParty } = await auth.admin
        .from('deal_parties')
        .select('company:companies(name)')
        .eq('deal_id', deal.id)
        .eq('party_role', PARTY_ROLE.TARGET)
        .maybeSingle();

      const targetCompany = targetParty?.company as { name: string } | { name: string }[] | null;
      const targetName = Array.isArray(targetCompany)
        ? (targetCompany[0]?.name ?? null)
        : (targetCompany?.name ?? null);

      mandate = {
        dealId: deal.id,
        code: deal.code,
        codename: deal.codename,
        status: deal.status,
        dealRole: primary.deal_role,
        targetName,
      };
    }
  }

  return NextResponse.json({
    user: profile,
    company,
    // deal_code lets clients match a membership against a project URL segment,
    // which is the human-readable deal code (not the UUID).
    memberships: (memberships ?? []).map((m) => {
      const deal = Array.isArray(m.deal) ? m.deal[0] : m.deal;
      return {
        deal_id: m.deal_id,
        deal_role: m.deal_role,
        phase: m.phase,
        deal_code: (deal as { code?: string } | null)?.code ?? null,
      };
    }),
    mandate,
    company_permissions: companyPermissions,
  });
}

export async function GET() {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const loaded = await loadOrProvisionProfile(auth);
  if (!loaded.ok) return loaded.response;
  return meResponse(auth, loaded.profile);
}

export async function PATCH(request: Request) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  let body: { fullName?: unknown; displayName?: unknown };
  try {
    body = (await request.json()) as { fullName?: unknown; displayName?: unknown };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const updates: { full_name?: string; display_name?: string | null } = {};

  if (body.fullName !== undefined) {
    const fullName = checkProfileFullName(body.fullName);
    if (!fullName.ok) return jsonError(fullName.message, 400);
    updates.full_name = fullName.value;
  }

  if (body.displayName !== undefined) {
    const displayName = checkProfileDisplayName(body.displayName);
    if (!displayName.ok) return jsonError(displayName.message, 400);
    updates.display_name = displayName.value;
  }

  if (Object.keys(updates).length === 0) {
    return jsonError('Enter a full name or a nickname to save.', 400);
  }

  const loaded = await loadOrProvisionProfile(auth);
  if (!loaded.ok) return loaded.response;

  const { error: updateError } = await auth.admin
    .from('users')
    .update(updates)
    .eq('id', auth.user.id);
  if (updateError) return jsonError(`Profile update failed (${errorCodeOf(updateError)})`, 500);

  const { data: profile, error: reloadError } = await auth.admin
    .from('users')
    .select(USER_COLUMNS)
    .eq('id', auth.user.id)
    .maybeSingle();
  if (reloadError || !profile) {
    return jsonError(
      reloadError ? `Profile could not be reloaded (${errorCodeOf(reloadError)})` : 'Profile could not be reloaded',
      500,
    );
  }

  return meResponse(auth, profile as ProfileRow);
}
