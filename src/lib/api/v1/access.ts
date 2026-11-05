import type { SupabaseClient } from '@supabase/supabase-js';
import { COMPANY_ROLE, DEAL_ROLE, DEPARTMENT, FIRM_ROLE } from '@/lib/constants/roles';
import { COMPANY_TYPE } from '@/lib/constants/companies';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import { hasCompanyPermission, hasCompanyPermissionChecked } from '@/lib/api/v1/companyAccess';
import { USER_STATUS } from '@/lib/constants/users';
import { STEP_STATUS } from '@/lib/constants/dealSteps';

/** The id used for a read that must happen but has nothing real to look up. */
const NO_SUCH_ROW = '00000000-0000-0000-0000-000000000000';

// The conditions the invite-authority family is built from, as plain
// predicates over rows already read. They exist so the constant-shape path
// below and the branching helpers above state each rule once.
const inTenant = (
  actor: { tenant_id?: string | null } | null,
  row: { tenant_id?: string | null } | null,
) => Boolean(actor && row && row.tenant_id === actor.tenant_id);
const directorOf = (
  actor: { company_role?: string | null; company_id?: string | null } | null,
  companyId: string | null | undefined,
) =>
  Boolean(actor) &&
  actor!.company_role === COMPANY_ROLE.DIRECTOR &&
  Boolean(companyId) &&
  actor!.company_id === companyId;
const holdsMdSeat = (seat: { deal_role?: string | null } | null) =>
  seat?.deal_role === DEAL_ROLE.MD;
const holdsDelegatedSeat = (seat: { access_scope?: unknown } | null) =>
  ((seat?.access_scope ?? null) as { can_manage_members?: boolean } | null)
    ?.can_manage_members === true;

/**
 * Can the actor manage (add/remove) members of `companyId`?
 * A firm admin can manage any company IN THEIR OWN TENANT; otherwise the actor
 * must be a 'director' of that same company. (Self-removal is blocked
 * separately in the handler.)
 */
export async function canManageCompanyMembersChecked(
  admin: SupabaseClient,
  actorId: string,
  companyId: string,
): Promise<boolean | 'unreadable'> {
  // `maybeSingle` rather than `single`: with `single` a missing row IS an
  // error, so binding the error would report an absent actor as unreadable
  // instead of false. For the boolean view the two are identical (no row ->
  // null data -> false); the difference is that here `error` now means only
  // one thing, a read that failed.
  const { data: actor, error: actorError } = await admin
    .from('users')
    .select('firm_role, company_id, company_role, tenant_id')
    .eq('id', actorId)
    .maybeSingle();

  if (actorError) return 'unreadable';
  if (!actor) return false;
  if (actor.firm_role === FIRM_ROLE.ADMIN) {
    // Admin reach is tenant-wide, never cross-tenant: an admin of another
    // tenant must not manage this company's members (third of the #116/#141
    // family). Unknown company -> false.
    const { data: company, error: companyError } = await admin
      .from('companies')
      .select('tenant_id')
      .eq('id', companyId)
      .maybeSingle();
    if (companyError) return 'unreadable';
    return inTenant(actor, company);
  }
  return directorOf(actor, companyId);
}

export async function canManageCompanyMembers(
  admin: SupabaseClient,
  actorId: string,
  companyId: string,
): Promise<boolean> {
  return (await canManageCompanyMembersChecked(admin, actorId, companyId)) === true;
}

export async function userCanAccessDeal(
  admin: SupabaseClient,
  userId: string,
  dealId: string,
): Promise<boolean> {
  const { data: profile } = await admin
    .from('users')
    .select('firm_role, tenant_id')
    .eq('id', userId)
    .single();

  if (profile?.firm_role === FIRM_ROLE.CCO || profile?.firm_role === FIRM_ROLE.ADMIN) {
    // Overseer reach is tenant-wide, never cross-tenant: a CCO/admin of
    // another tenant must not read this deal (#116). Unknown deal -> false.
    const { data: deal } = await admin
      .from('deals')
      .select('tenant_id')
      .eq('id', dealId)
      .maybeSingle();
    return Boolean(deal && deal.tenant_id === profile.tenant_id);
  }

  const [{ data: membership }, { data: deal }] = await Promise.all([
    admin
      .from('deal_memberships')
      .select('id')
      .eq('deal_id', dealId)
      .eq('user_id', userId)
      .maybeSingle(),
    admin.from('deals').select('tenant_id').eq('id', dealId).maybeSingle(),
  ]);

  return Boolean(
    membership && deal && profile && deal.tenant_id === profile.tenant_id,
  );
}

export async function userIsDealMdChecked(
  admin: SupabaseClient,
  userId: string,
  dealId: string,
): Promise<boolean | 'unreadable'> {
  // `maybeSingle` for the same reason as `canManageCompanyMembersChecked`: a
  // missing actor must stay false, not become unreadable.
  const { data: profile, error: profileError } = await admin
    .from('users')
    .select('firm_role, tenant_id')
    .eq('id', userId)
    .maybeSingle();

  if (profileError) return 'unreadable';
  if (profile?.firm_role === FIRM_ROLE.ADMIN) {
    // Admin reach is tenant-wide, never cross-tenant: an admin of another
    // tenant must not pass as this deal's MD (#141, sibling of #116).
    // Unknown deal -> false.
    const { data: deal, error: dealError } = await admin
      .from('deals')
      .select('tenant_id')
      .eq('id', dealId)
      .maybeSingle();
    if (dealError) return 'unreadable';
    return inTenant(profile, deal);
  }

  const { data: membership, error: membershipError } = await admin
    .from('deal_memberships')
    .select('deal_role')
    .eq('deal_id', dealId)
    .eq('user_id', userId)
    .maybeSingle();

  if (membershipError) return 'unreadable';
  return holdsMdSeat(membership);
}

export async function userIsDealMd(
  admin: SupabaseClient,
  userId: string,
  dealId: string,
): Promise<boolean> {
  return (await userIsDealMdChecked(admin, userId, dealId)) === true;
}

/**
 * Can the actor manage (add/remove) seats on this deal?
 * True for: the deal MD or firm admin (userIsDealMd); a director of the deal's
 * owning company (deals.bank_id); or a member whose seat carries the delegated
 * `can_manage_members` capability (set by the MD). The seat owner's "added_by"
 * right is checked in the handler, per-seat.
 */
export async function canManageDealMembersChecked(
  admin: SupabaseClient,
  actorId: string,
  dealId: string,
): Promise<boolean | 'unreadable'> {
  const isMd = await userIsDealMdChecked(admin, actorId, dealId);
  if (isMd === 'unreadable') return 'unreadable';
  if (isMd) return true;

  // A company director of the deal's owning company manages its seats.
  const { data: deal, error: dealError } = await admin
    .from('deals')
    .select('bank_id')
    .eq('id', dealId)
    .maybeSingle();
  if (dealError) return 'unreadable';
  const { data: actor, error: actorError } = await admin
    .from('users')
    .select('company_id, company_role')
    .eq('id', actorId)
    .maybeSingle();
  if (actorError) return 'unreadable';
  if (directorOf(actor, deal?.bank_id)) return true;

  // A member explicitly delegated by the MD.
  const { data: seat, error: seatError } = await admin
    .from('deal_memberships')
    .select('access_scope')
    .eq('deal_id', dealId)
    .eq('user_id', actorId)
    .maybeSingle();

  if (seatError) return 'unreadable';
  return holdsDelegatedSeat(seat);
}

export async function canManageDealMembers(
  admin: SupabaseClient,
  actorId: string,
  dealId: string,
): Promise<boolean> {
  return (await canManageDealMembersChecked(admin, actorId, dealId)) === true;
}

/**
 * Can the actor view a company's member roster?
 * True for a firm overseer (cco/admin) or a user who belongs to that company.
 * (The roster itself is wall-filtered in the handler — research/trading are
 * never listed.)
 */
export async function userCanViewCompany(
  admin: SupabaseClient,
  actorId: string,
  companyId: string,
): Promise<boolean> {
  const { data: actor, error: actorError } = await admin
    .from('users')
    .select('firm_role, company_id, tenant_id')
    .eq('id', actorId)
    .maybeSingle();

  if (actorError || !actor) return false;
  if (actor.firm_role === FIRM_ROLE.CCO || actor.firm_role === FIRM_ROLE.ADMIN) {
    const { data: company, error: companyError } = await admin
      .from('companies')
      .select('tenant_id')
      .eq('id', companyId)
      .maybeSingle();
    if (companyError || !actor.tenant_id || !company?.tenant_id) return false;
    return company.tenant_id === actor.tenant_id;
  }
  return actor.company_id === companyId;
}

/**
 * Can the actor use the in-tenant company search / Gate 0 target typeahead?
 * COMPLIANCE (Chinese wall, permissions_schema_v3.md §5): the search returns
 * company identities (targets/acquirers/counterparties) that are otherwise
 * masked behind deal codes, so it must not be open to every authenticated
 * tenant user. Allow only firm overseers (cco/admin) and internal staff who
 * can hold deal work — i.e. non-external users outside the research/trading
 * walls. External users (sellers/buyers/counterparties) and walled analysts
 * must not be able to enumerate the bank's deal pipeline.
 */
export async function userCanSearchCompanies(
  admin: SupabaseClient,
  actorId: string,
): Promise<boolean> {
  const { data: actor } = await admin
    .from('users')
    .select('firm_role, department, is_external')
    .eq('id', actorId)
    .maybeSingle();

  if (!actor) return false;
  if (actor.firm_role === FIRM_ROLE.CCO || actor.firm_role === FIRM_ROLE.ADMIN) {
    return true;
  }
  if (actor.is_external) return false;
  return actor.department !== DEPARTMENT.RESEARCH && actor.department !== DEPARTMENT.TRADING;
}

/** Can the actor read the leads list (GET /companies for lead registration)? */
export async function userCanViewLeads(
  admin: SupabaseClient,
  actorId: string,
): Promise<boolean> {
  const { data: actor } = await admin
    .from('users')
    .select('company_id, is_external, firm_role, company_role, department')
    .eq('id', actorId)
    .maybeSingle();
  if (!actor) return false;
  if (actor.firm_role === FIRM_ROLE.CCO || actor.firm_role === FIRM_ROLE.ADMIN) {
    return true;
  }
  if (actor.is_external && actor.company_role === COMPANY_ROLE.DIRECTOR) {
    return true;
  }
  // PL-06 (#198): company permissions are enforced for every seated user,
  // whatever the company_access_management flag says. A missing flag row
  // must never fall through to the permissive department check below.
  if (actor.company_id) {
    return hasCompanyPermission(
      admin,
      actorId,
      actor.company_id,
      COMPANY_PERMISSION.LEADS_VIEW,
    );
  }
  if (!actor.is_external) {
    return actor.department !== DEPARTMENT.RESEARCH && actor.department !== DEPARTMENT.TRADING;
  }
  return false;
}


/**
 * Can the actor read or write lead CRM maps (relationships, stakeholders,
 * paths) for a specific lead company?
 *
 * COMPLIANCE: tenant-wide company search stays walled (`userCanSearchCompanies`).
 * Company-scoped users may only touch leads their org registered
 * (`registered_by_company_id`), including via deal work on that target.
 * Research/trading remain blocked. Legacy bank-registered leads (null owner)
 * are internal-only.
 */
export async function userCanViewCompanyLeadMaps(
  admin: SupabaseClient,
  actorId: string,
  companyId: string,
): Promise<boolean> {
  if (await userCanSearchCompanies(admin, actorId)) return true;

  const { data: actor } = await admin
    .from('users')
    .select('company_id, is_external, department')
    .eq('id', actorId)
    .maybeSingle();
  if (!actor) return false;

  if (
    !actor.is_external &&
    (actor.department === DEPARTMENT.RESEARCH || actor.department === DEPARTMENT.TRADING)
  ) {
    return false;
  }

  const { data: lead, error: leadError } = await admin
    .from('companies')
    .select('id, registered_by_company_id')
    .eq('id', companyId)
    .maybeSingle();
  if (leadError || !lead) return false;

  const ownerCompanyId = lead.registered_by_company_id as string | null;
  if (!ownerCompanyId || ownerCompanyId !== actor.company_id) return false;

  if (await userCanViewLeads(admin, actorId)) return true;

  const { data: parties, error: partiesError } = await admin
    .from('deal_parties')
    .select('deal_id')
    .eq('company_id', companyId);
  if (partiesError) return false;

  for (const party of parties ?? []) {
    if (await userCanAccessDeal(admin, actorId, party.deal_id as string)) {
      return true;
    }
  }
  return false;
}

/** Can the actor register a new lead (POST /companies)? */
export async function userCanCreateLead(
  admin: SupabaseClient,
  actorId: string,
): Promise<boolean> {
  const { data: actor } = await admin
    .from('users')
    .select('company_id, is_external, firm_role, company_role, department')
    .eq('id', actorId)
    .maybeSingle();
  if (!actor) return false;
  if (actor.firm_role === FIRM_ROLE.CCO || actor.firm_role === FIRM_ROLE.ADMIN) {
    return true;
  }
  if (actor.is_external && actor.company_role === COMPANY_ROLE.DIRECTOR) {
    return true;
  }
  // PL-06 (#198): company permissions are enforced for every seated user,
  // whatever the company_access_management flag says. A missing flag row
  // must never fall through to the permissive department check below.
  if (actor.company_id) {
    return hasCompanyPermission(
      admin,
      actorId,
      actor.company_id,
      COMPANY_PERMISSION.LEADS_CREATE,
    );
  }
  if (!actor.is_external) {
    return actor.department !== DEPARTMENT.RESEARCH && actor.department !== DEPARTMENT.TRADING;
  }
  return false;
}

export type DealStepCapabilities = {
  canAssign: boolean;
  canComplete: boolean;
  canEditWork: boolean;
};

/** Resolve who may assign, save, or complete a deal step for this actor. */
export async function resolveDealStepCapabilities(
  admin: SupabaseClient,
  userId: string,
  dealId: string,
  step: { assigned_to: string | null; status: string },
): Promise<DealStepCapabilities | 'unreadable'> {
  const wall = await classifyInternalUser(admin, userId);
  if (wall === 'error') return 'unreadable';

  const isMd = await userIsDealMdChecked(admin, userId, dealId);
  if (isMd === 'unreadable') return 'unreadable';

  const isAssignee = step.assigned_to === userId;
  const isUnassigned = step.assigned_to == null;
  const isComplete = step.status === STEP_STATUS.COMPLETE;

  if (wall === 'internal') {
    return {
      canAssign: isMd,
      canComplete: !isComplete && (isMd || isAssignee),
      canEditWork: isMd || isAssignee || isUnassigned,
    };
  }

  const { data: actor, error: actorError } = await admin
    .from('users')
    .select('company_id')
    .eq('id', userId)
    .maybeSingle();
  if (actorError || !actor?.company_id) {
    return { canAssign: false, canComplete: false, canEditWork: false };
  }

  const companyId = actor.company_id as string;
  const [canAssignPerm, canCompletePerm, canUpdateUnassignedPerm] = await Promise.all([
    hasCompanyPermissionChecked(admin, userId, companyId, COMPANY_PERMISSION.DEAL_STEPS_ASSIGN),
    hasCompanyPermissionChecked(admin, userId, companyId, COMPANY_PERMISSION.DEAL_STEPS_COMPLETE),
    hasCompanyPermissionChecked(
      admin,
      userId,
      companyId,
      COMPANY_PERMISSION.DEAL_STEPS_UPDATE_UNASSIGNED,
    ),
  ]);
  if (
    canAssignPerm === 'unreadable' ||
    canCompletePerm === 'unreadable' ||
    canUpdateUnassignedPerm === 'unreadable'
  ) {
    return 'unreadable';
  }

  return {
    canAssign: canAssignPerm || isMd,
    canComplete: !isComplete && canCompletePerm && (isMd || isAssignee),
    canEditWork: isMd || isAssignee || (canUpdateUnassignedPerm && isUnassigned),
  };
}

export async function resolveDealStepStructureCapability(
  admin: SupabaseClient,
  userId: string,
): Promise<boolean | 'unreadable'> {
  const wall = await classifyInternalUser(admin, userId);
  if (wall === 'error') return 'unreadable';
  if (wall !== 'internal') return false;

  const { data: actor, error } = await admin
    .from('users')
    .select('company_id')
    .eq('id', userId)
    .maybeSingle();
  if (error) return 'unreadable';
  if (!actor?.company_id) return false;

  return hasCompanyPermissionChecked(
    admin,
    userId,
    actor.company_id as string,
    COMPANY_PERMISSION.DEAL_STEPS_STRUCTURE,
  );
}

/**
 * Can the actor read the firm's mail channel (Inbox + supervisory surfaces)?
 * Bank-side only: external users (sellers/buyers/counterparties) never see the
 * firm inbox, and the research/trading walls apply — same rule family as
 * userCanSearchCompanies. Returns the tenant for the read scope.
 */
export async function firmMailAccess(
  admin: SupabaseClient,
  actorId: string,
): Promise<{ ok: boolean; tenantId: string | null; firmRole: string | null }> {
  const { data: actor } = await admin
    .from('users')
    .select('firm_role, department, is_external, tenant_id')
    .eq('id', actorId)
    .maybeSingle();

  if (!actor) return { ok: false, tenantId: null, firmRole: null };
  // The external wall comes FIRST: an external user must never gain the
  // tenant-wide mail reach through a firm_role, which the invite-phase schema
  // permits an external actor to hold.
  if (actor.is_external) return { ok: false, tenantId: null, firmRole: actor.firm_role };
  const overseer = actor.firm_role === FIRM_ROLE.CCO || actor.firm_role === FIRM_ROLE.ADMIN;
  if (overseer) return { ok: true, tenantId: actor.tenant_id, firmRole: actor.firm_role };
  const walled =
    actor.department === DEPARTMENT.RESEARCH || actor.department === DEPARTMENT.TRADING;
  return { ok: !walled, tenantId: walled ? null : actor.tenant_id, firmRole: actor.firm_role };
}

// Columns + embedded target party for the deal-list read side (G13). The target
// company name rides along via the deal_parties → companies embed so the UI can
// show it without a second round-trip. entry/current step drive the rail cursor.
const DEAL_LIST_BASE_SELECT =
  'id, code, codename, status, mandate_owner_id, created_at, entry_step_seq, current_step_seq, ' +
  'conflicts_approved_by, conflicts_approved_on, target_close_date, fee_usd, schedule_status, lifecycle_category, ' +
  'deal_parties(party_role, company:companies(name))';

// The current step carries who it is assigned to and its draft-run state, and
// `steps` the phase and status of every step, so the Conductor Center shows
// per-phase progress and live runs from this one read. The route reduces
// `steps` to counts; it never leaves the server.
const DEAL_LIST_SELECT =
  DEAL_LIST_BASE_SELECT +
  ', current_step:deal_steps!deals_current_deal_step_id_fkey(step_id, seq, phase_index, definition, removed_at, ' +
  'assigned_to, bench_run_status, assignee:users!deal_steps_assigned_to_fkey(id, display_name, full_name, email))' +
  ', steps:deal_steps!deal_steps_deal_id_fkey(step_id, phase_index, status, removed_at)';

type DealListResult = { data: unknown; error: { code?: string | null; message: string } | null };

// The embed depends on 20260916100000_project_rail_model.sql: until it is
// applied the relationship and its columns are not in the schema.
const SCHEMA_MISSING_CODES = new Set(['PGRST200', '42703', '42P01']);

async function selectDealList(
  run: (select: string) => PromiseLike<DealListResult>,
): Promise<DealListResult> {
  const result = await run(DEAL_LIST_SELECT);
  if (!result.error || !SCHEMA_MISSING_CODES.has(result.error.code ?? '')) return result;
  return run(DEAL_LIST_BASE_SELECT);
}

export async function listDealsForUser(admin: SupabaseClient, userId: string) {
  const { data: profile } = await admin
    .from('users')
    .select('firm_role, tenant_id')
    .eq('id', userId)
    .single();

  if (profile?.firm_role === FIRM_ROLE.CCO || profile?.firm_role === FIRM_ROLE.ADMIN) {
    const { data, error } = await selectDealList((select) =>
      admin
        .from('deals')
        .select(select)
        .eq('tenant_id', profile.tenant_id)
        .order('created_at', { ascending: false }),
    );
    return { data, error };
  }

  const { data, error } = await selectDealList((select) =>
    admin
      .from('deals')
      .select(`${select}, deal_memberships!inner(user_id)`)
      .eq('deal_memberships.user_id', userId)
      .order('created_at', { ascending: false }),
  );

  return { data: data ?? [], error };
}

export type MemberDealSummary = { id: string; code: string; codename: string; status: string };

/**
 * The external picker's deals: every deal the user holds a seat on, newest first.
 * Filtered through the membership join, not an id list, so the URL does not
 * grow with the seat count (#160). Deliberately not listDealsForUser: its
 * overseer branch would hand an external user holding a firm_role every tenant
 * deal.
 */
export async function listMemberDealSummaries(
  admin: SupabaseClient,
  userId: string,
): Promise<{ data: MemberDealSummary[]; error: { code?: string | null; message: string } | null }> {
  const { data, error } = await admin
    .from('deals')
    .select('id, code, codename, status, deal_memberships!inner(user_id)')
    .eq('deal_memberships.user_id', userId)
    .order('created_at', { ascending: false });

  return { data: (data ?? []) as MemberDealSummary[], error };
}

/**
 * Onboarding containment (plan-v5 M3, cr-plan-v2 5.1): a user whose profile
 * status is 'invited' has an auth identity (created by invite link generation)
 * but has NOT redeemed an invite. Until acceptance they must be rejected by
 * every /api/v1 entrypoint except POST /invites/accept.
 */
export async function userIsOnboarded(
  admin: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data: profile } = await admin
    .from('users')
    .select('status')
    .eq('id', userId)
    .maybeSingle();
  if (!profile) return false;
  return profile.status !== USER_STATUS.INVITED;
}

export type InviteTarget = {
  companyId: string;
  dealId: string | null;
};

/**
 * May the actor create an invite into `companyId` (optionally granting a seat
 * on `dealId`)? Two-tier delegation (spec-v3 criterion 5):
 * - firm admin: anyone, anywhere;
 * - internal (non-external) staff: need seat-management rights on the deal
 *   (canManageDealMembers) when a deal is attached, or director/admin rights
 *   over the target company when not;
 * - external director: ONLY members of their own company, and only onto deals
 *   that company is a party to. External members never invite.
 * Shape constraints (external invitees get company_role 'member' and a
 * party-derived seller/buyer deal role) are enforced in the route.
 */
/**
 * Same decision as `userCanInvite`, but a read that FAILED is reported as
 * `'unreadable'` instead of collapsing into `false`.
 *
 * The distinction matters where the answer is shown to someone rather than
 * used to permit an action: a preview that renders "cannot invite" because the
 * database was unreachable is a confident lie, where "unavailable" is true.
 * Enforcement callers do not want that distinction — for them a failed read
 * must deny — so `userCanInvite` keeps mapping it to `false` and their
 * behaviour is unchanged.
 *
 * The nested predicates report the same distinction, so an unreadable answer
 * from any depth surfaces here rather than arriving as a confident `false`
 * (B10: unavailable when the perimeter cannot be reliably computed).
 */
export async function userCanInviteChecked(
  admin: SupabaseClient,
  actorId: string,
  target: InviteTarget,
): Promise<boolean | 'unreadable'> {
  const { data: actor, error: actorError } = await admin
    .from('users')
    .select('firm_role, is_external, company_id, company_role, tenant_id')
    .eq('id', actorId)
    .maybeSingle();
  if (actorError) return 'unreadable';
  if (!actor) return false;
  // Deal-attached invitations keep their firm-admin fast path, but only inside
  // the admin's own firm (#248): the admin bit is per firm, not per platform.
  // A company-level invitation is resolved by the authoritative permission RPC
  // below, which includes the admin/director roots as well as role and direct
  // grants.
  if (actor.firm_role === FIRM_ROLE.ADMIN && target.dealId) {
    const { data: deal, error: dealError } = await admin
      .from('deals')
      .select('tenant_id')
      .eq('id', target.dealId)
      .maybeSingle();
    if (dealError) return 'unreadable';
    return Boolean(deal?.tenant_id) && inTenant(actor, deal);
  }

  if (actor.is_external) {
    if (actor.company_role !== COMPANY_ROLE.DIRECTOR) return false;
    if (actor.company_id !== target.companyId) return false;
    // Company HR invites (Employees view) have no deal attached, and only a
    // CLIENT company has that view. An external director of a target, acquirer
    // or counterparty company invites onto a deal their company is a party to,
    // never deal-less: create_invite refuses it (20261003100000), so offering
    // it here would be a button that always fails at the RPC.
    if (!target.dealId) {
      const { data: company, error: companyError } = await admin
        .from('companies')
        .select('type')
        .eq('id', target.companyId)
        .maybeSingle();
      if (companyError) return 'unreadable';
      return company?.type === COMPANY_TYPE.CLIENT;
    }
    const { data: party, error: partyError } = await admin
      .from('deal_parties')
      .select('id')
      .eq('deal_id', target.dealId)
      .eq('company_id', target.companyId)
      .maybeSingle();
    if (partyError) return 'unreadable';
    return Boolean(party);
  }

  if (target.dealId) {
    return canManageDealMembersChecked(admin, actorId, target.dealId);
  }
  return hasCompanyPermissionChecked(
    admin,
    actorId,
    target.companyId,
    COMPANY_PERMISSION.INVITES_SEND,
  );
}

export async function userCanInvite(
  admin: SupabaseClient,
  actorId: string,
  target: InviteTarget,
): Promise<boolean> {
  // A failed read denies. That is the right answer for every caller that is
  // about to permit something.
  return (await userCanInviteChecked(admin, actorId, target)) === true;
}

/**
 * May the actor see/manage (list, resend, revoke, learn of a duplicate) an
 * existing invite? Scoped disclosure (cr-plan-v4 4.1): with the GLOBAL
 * one-pending-invite-per-email index, a duplicate 409 must not leak another
 * tenant's — or another company's — invite state to an unauthorized actor.
 *
 * The reads are UNCONDITIONAL and the decision is made in memory afterwards.
 * That is the point, not an accident of style. This predicate is the one the
 * lookup route asks about an invitation the caller may not be allowed to know
 * exists, so a branch that skips a query would answer "no such row" faster
 * than "a row you cannot see" — the response bytes match while the work does
 * not (A19, D8.4). Four reads, always the same four, in the same order, with
 * the same filter shape; only the values differ. An absent invitation looks up
 * an id that cannot exist rather than looking up nothing.
 *
 * The cost is a handful of reads on paths that could sometimes answer sooner.
 * These are invite-management checks, not a hot path.
 */
export async function userCanManageInvite(
  admin: SupabaseClient,
  actorId: string,
  invite: { companyId: string; dealId: string | null },
): Promise<boolean> {
  const dealId = invite.dealId ?? NO_SUCH_ROW;
  const [{ data: actor }, { data: company }, { data: deal }, { data: seat }] = await Promise.all([
    admin
      .from('users')
      .select('firm_role, is_external, company_id, company_role, tenant_id')
      .eq('id', actorId)
      .maybeSingle(),
    admin.from('companies').select('tenant_id').eq('id', invite.companyId).maybeSingle(),
    admin.from('deals').select('bank_id, tenant_id').eq('id', dealId).maybeSingle(),
    admin
      .from('deal_memberships')
      .select('deal_role, access_scope')
      .eq('deal_id', dealId)
      .eq('user_id', actorId)
      .maybeSingle(),
  ]);

  if (!actor) return false;

  // Tenant coherence, checked for EVERY actor and before the admin branch.
  // The pending-invite index is global, so an address can resolve to an
  // invitation in a tenant the actor has no relationship with. A firm admin is
  // an admin OF A FIRM, not of the platform (A6, A19).
  if (!inTenant(actor, company)) return false;

  if (actor.firm_role === FIRM_ROLE.ADMIN) return true;
  if (actor.is_external) return directorOf(actor, invite.companyId);

  // Deal-scoped: the deal's MD, a director of the deal's owning company, or a
  // seat the MD delegated. Company-scoped: a director of that company. Same
  // rules as canManageDealMembers / canManageCompanyMembers, stated through
  // the shared predicates rather than restated.
  if (invite.dealId) {
    return holdsMdSeat(seat) || directorOf(actor, deal?.bank_id) || holdsDelegatedSeat(seat);
  }
  return directorOf(actor, invite.companyId);
}

/**
 * Fail-closed internal-user classification for internal-only surfaces
 * (rail-step datarooms are bank work product). 'error' must map to a server
 * failure, never to access: a broken profile lookup is not an internal user
 * (review 09a4e78 findings 1-3).
 */
export type InternalWallVerdict = 'internal' | 'external' | 'error';

export async function classifyInternalUser(
  admin: SupabaseClient,
  userId: string,
): Promise<InternalWallVerdict> {
  const { data, error } = await admin
    .from('users')
    .select('is_external')
    .eq('id', userId)
    .maybeSingle();
  if (error) return 'error';
  if (!data || data.is_external) return 'external';
  return 'internal';
}

const UPLOAD_DEAL_ROLES = new Set<string>([
  DEAL_ROLE.MD,
  DEAL_ROLE.DEAL_TEAM,
  DEAL_ROLE.LEGAL,
  DEAL_ROLE.SELLER,
]);

export async function userCanUploadToDataroom(
  admin: SupabaseClient,
  userId: string,
  dealId: string,
): Promise<boolean> {
  const { data: profile } = await admin
    .from('users')
    .select('firm_role')
    .eq('id', userId)
    .single();

  if (profile?.firm_role === FIRM_ROLE.CCO || profile?.firm_role === FIRM_ROLE.ADMIN) {
    return true;
  }

  const { data: membership } = await admin
    .from('deal_memberships')
    .select('deal_role')
    .eq('deal_id', dealId)
    .eq('user_id', userId)
    .maybeSingle();

  return membership?.deal_role ? UPLOAD_DEAL_ROLES.has(membership.deal_role) : false;
}
