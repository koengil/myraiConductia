import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { jsonError, requireApiUser, resolveDealRef } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { inviteDealHidden } from '@/lib/api/v1/dealNotVisible';
import {
  canManageCompanyMembers,
  userCanManageInvite,
  canManageDealMembers,
  userIsDealMd,
} from '@/lib/api/v1/access';
import {
  classifyInviteDomain,
  inviteEmailDomain,
  normalizeInviteEmail,
} from '@/lib/api/v1/inviteDomain';
import { COMPANY_ROLE, DEAL_ROLE, resolvePreferredDealRole } from '@/lib/constants/roles';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import { hasCompanyPermissionChecked } from '@/lib/api/v1/companyAccess';
import { PARTY_ROLE } from '@/lib/constants/companies';
import { companyHasActiveDirector } from '@/lib/api/v1/proposalFeasibility';

/**
 * POST /api/v1/invites/lookup — the smart lookup behind the invitation card.
 *
 * Everything here is a PROPOSAL. This route creates no company, no invitation
 * and no access (criterion A8), and returns no secret of any kind (A11).
 *
 * The hard part is not the matching, it is the scoping. Authority to COMPOSE an
 * invitation is not authority to interrogate the platform's user base, so every
 * fact this route can state is gated separately from the act of asking:
 *
 *   - Candidate companies are the ones this actor could actually invite into
 *     (§7.1). Matching against anything wider would let an external director
 *     learn another party's verified domain by typing an address.
 *   - "Already a platform user" is disclosed only within the actor's existing
 *     visibility (A17), "already holds a seat" only to an actor over this deal's
 *     membership (A18), "already invited" only to an actor over that invitation.
 *   - A condition that cannot be disclosed contributes NOTHING: no element, no
 *     placeholder, no reordering. `warnings` is a flat, fixed-order array for
 *     exactly this reason. A shape like `checks: { existingUser: 'not_permitted' }`
 *     would satisfy the letter of the scoping rule and defeat it entirely, by
 *     letting an unauthorized actor distinguish "exists but hidden from you"
 *     from "unknown" (A19).
 *
 * The response for a hidden fact must be byte-identical to the response for an
 * address nobody has ever seen.
 */

export const WARNING = {
  PERSONAL_DOMAIN: 'personal_domain',
  DOMAIN_MISMATCH: 'domain_mismatch',
  UNVERIFIED_DOMAIN: 'unverified_domain',
  EXISTING_PLATFORM_USER: 'existing_platform_user',
  EXISTING_DEAL_SEAT: 'existing_deal_seat',
  PENDING_INVITATION: 'pending_invitation',
} as const;

/** Fixed order. Suppression removes an element; it never reorders the rest. */
const WARNING_ORDER: string[] = [
  WARNING.PERSONAL_DOMAIN,
  WARNING.DOMAIN_MISMATCH,
  WARNING.UNVERIFIED_DOMAIN,
  WARNING.EXISTING_PLATFORM_USER,
  WARNING.EXISTING_DEAL_SEAT,
  WARNING.PENDING_INVITATION,
];

const SELLER_PARTY_ROLES: string[] = [PARTY_ROLE.TARGET, PARTY_ROLE.CO_SELLER];
const NO_ROW = '00000000-0000-0000-0000-000000000000';

type LookupBody = {
  email?: string;
  /** Deal code or id, when the invitation is being composed on a deal. */
  dealId?: string | null;
  /**
   * The company selected on the form, when one is. A domain mismatch is a
   * claim about the SELECTED company, so it cannot be decided against whichever
   * candidate happens to match (criterion A5(b)).
   */
  companyId?: string | null;
};

type ActorProfile = {
  tenant_id: string;
  firm_role: string | null;
  is_external: boolean;
  company_id: string | null;
  company_role: string | null;
};

/**
 * The companies this actor could actually invite into, which is the only set
 * their typing may be matched against (§7.1). Mirrors userCanInvite's tiers.
 * Returns null on a read failure, never a partial set.
 */
async function candidateCompanyIds(
  admin: SupabaseClient,
  actorId: string,
  actor: ActorProfile,
  dealId: string | null,
): Promise<string[] | null> {
  if (actor.firm_role === 'admin') {
    const { data, error } = await admin
      .from('companies')
      .select('id')
      .eq('tenant_id', actor.tenant_id);
    if (error) return null;
    return ((data ?? []) as { id: string }[]).map((row) => row.id);
  }

  if (actor.is_external) {
    // An external director grows their own team, and only onto a deal their own
    // company is a party to. Without a deal they have no candidate at all.
    if (actor.company_role !== COMPANY_ROLE.DIRECTOR || !actor.company_id || !dealId) return [];
    const { data, error } = await admin
      .from('deal_parties')
      .select('company_id')
      .eq('deal_id', dealId)
      .eq('company_id', actor.company_id)
      .maybeSingle();
    if (error) return null;
    return data ? [actor.company_id] : [];
  }

  if (dealId) {
    let permitted: boolean;
    try {
      permitted = await canManageDealMembers(admin, actorId, dealId);
    } catch {
      return null;
    }
    if (!permitted) return [];
    const [{ data: deal, error: dealError }, { data: parties, error: partiesError }] =
      await Promise.all([
        admin.from('deals').select('bank_id').eq('id', dealId).maybeSingle(),
        admin.from('deal_parties').select('company_id').eq('deal_id', dealId),
      ]);
    if (dealError || partiesError) return null;
    const ids = ((parties ?? []) as { company_id: string }[]).map((row) => row.company_id);
    if (deal?.bank_id) ids.push(deal.bank_id);
    return [...new Set(ids)];
  }

  // No deal in context: the authoritative company permission catalogue owns
  // invitation authority, including admin/director roots and role/direct
  // grants. A readable denial is an empty candidate set; a failed permission
  // read makes the whole lookup unavailable rather than returning partial data.
  if (!actor.company_id) return [];
  const permitted = await hasCompanyPermissionChecked(
    admin,
    actorId,
    actor.company_id,
    COMPANY_PERMISSION.INVITES_SEND,
  );
  if (permitted === 'unreadable') return null;
  return permitted ? [actor.company_id] : [];
}

/** "acme-capital.com" -> "Acme Capital". A label to confirm, never a company. */
function proposeCompanyLabel(domain: string): string {
  const stem = domain.split('.').slice(0, -1).join(' ') || domain;
  return stem
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export async function POST(request: Request) {
  const gate = await requireFlag('platform_onboarding');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  let body: LookupBody;
  try {
    body = (await request.json()) as LookupBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const email = normalizeInviteEmail(body.email ?? '');
  if (!email) return jsonError('A valid email is required', 400);
  const domain = inviteEmailDomain(email);

  let dealId: string | null = null;
  if (body.dealId) {
    const deal = await resolveDealRef(auth.admin, body.dealId);
    if (!deal) return jsonError('Deal not found', 404);
    // Before candidateCompanyIds: another firm's admin would otherwise get a
    // full lookup for a real deal and a 404 for a made-up one (D65). The gate's
    // reads do not depend on the email, so the no-oracle property for invitees
    // below is untouched.
    const hidden = await inviteDealHidden(auth.admin, auth.user, deal.id);
    if (hidden) return hidden;
    dealId = deal.id;
  }

  const { data: actor, error: actorError } = await auth.admin
    .from('users')
    .select('tenant_id, firm_role, is_external, company_id, company_role')
    .eq('id', auth.user.id)
    .maybeSingle();
  // A failed read is never a partial answer: no match, no warning, no
  // recommendation, and no pre-fill downstream (criterion A16).
  if (actorError) return jsonError('Lookup is unavailable', 503);
  if (!actor) return jsonError('Forbidden', 403);

  const candidates = await candidateCompanyIds(
    auth.admin,
    auth.user.id,
    actor as ActorProfile,
    dealId,
  );
  if (candidates === null) return jsonError('Lookup is unavailable', 503);

  // An actor with no candidate company has no composition authority here, so
  // there is nothing to look up and nothing to disclose.
  if (candidates.length === 0) {
    return NextResponse.json({
      normalizedEmail: email,
      domain,
      companyMatch: null,
      proposedCompany: null,
      warnings: [],
      recommendation: null,
      companyRolePolicy: null,
    });
  }

  const { data: domainRows, error: domainError } = await auth.admin
    .from('company_verified_domains')
    .select('company_id, domain')
    .in('company_id', candidates);
  if (domainError) return jsonError('Lookup is unavailable', 503);

  const rows = (domainRows ?? []) as { company_id: string; domain: string }[];
  const owns = (row: { domain: string }) =>
    row.domain === domain || domain.endsWith(`.${row.domain}`);

  // With a company selected, the question is whether THIS address belongs to
  // THAT company. Without one — the first keystroke, before any choice — the
  // question is which candidate company it belongs to, if any.
  const selected =
    typeof body.companyId === 'string' && candidates.includes(body.companyId)
      ? body.companyId
      : null;
  const searchable = selected ? rows.filter((row) => row.company_id === selected) : rows;
  const matchRow = searchable.find(owns);

  let companyMatch: { companyId: string; companyName: string; companyType: string } | null = null;
  if (matchRow) {
    const { data: company, error: companyError } = await auth.admin
      .from('companies')
      .select('id, name, type')
      .eq('id', matchRow.company_id)
      .maybeSingle();
    if (companyError) return jsonError('Lookup is unavailable', 503);
    if (company) {
      companyMatch = {
        companyId: company.id,
        companyName: company.name,
        companyType: company.type,
      };
    }
  }

  const selectedDomains = selected ? searchable.map((row) => row.domain) : null;

  // The selected or disclosed company is already inside the actor's candidate
  // invitation envelope. Returning its role options therefore reveals no new
  // company. The policy prevents a Member invitation that the DB director
  // invariant would reject only after the recipient completed onboarding.
  const policyCompanyId = selected ?? companyMatch?.companyId ?? null;
  let companyRolePolicy: {
    companyId: string;
    memberAllowed: boolean;
    directorAllowed: boolean;
    requiresDirector: boolean;
  } | null = null;
  if (policyCompanyId) {
    const hasActiveDirector = await companyHasActiveDirector(auth.admin, policyCompanyId);
    if (hasActiveDirector === null) return jsonError('Lookup is unavailable', 503);
    let directorAllowed: boolean;
    try {
      directorAllowed = await canManageCompanyMembers(
        auth.admin,
        auth.user.id,
        policyCompanyId,
      );
    } catch {
      return jsonError('Lookup is unavailable', 503);
    }
    companyRolePolicy = {
      companyId: policyCompanyId,
      memberAllowed: hasActiveDirector,
      directorAllowed,
      requiresDirector: !hasActiveDirector,
    };
  }

  const classification = classifyInviteDomain(
    email,
    selectedDomains ?? rows.map((row) => row.domain),
  );

  const found = new Set<string>();
  if (classification === 'personal') found.add(WARNING.PERSONAL_DOMAIN);
  else if (classification === 'mismatch') found.add(WARNING.DOMAIN_MISMATCH);
  else if (classification === 'unverified') found.add(WARNING.UNVERIFIED_DOMAIN);

  // --- Scoped disclosures ---------------------------------------------------
  //
  // A19 is about what an unauthorized actor can INFER, and the work a request
  // does is inferable. If an existing user triggered an extra membership read
  // and an unknown address did not, the timing difference would answer the
  // question the response refuses to answer.
  //
  // So the schedule is fixed: the same queries run, and the same authority
  // predicates are evaluated, whether or not any row exists. Existence changes
  // only what is CONCLUDED, never what is DONE. NO_ROW matches nothing, which
  // keeps the shape of the query identical when there is nothing to look up.
  const { data: existingUser, error: userError } = await auth.admin
    .from('users')
    .select('id, company_id, tenant_id, preferred_deal_role')
    .eq('email', email)
    .maybeSingle();
  if (userError) return jsonError('Lookup is unavailable', 503);

  const subjectId = existingUser?.id ?? NO_ROW;

  const { data: seat, error: seatError } = dealId
    ? await auth.admin
        .from('deal_memberships')
        .select('user_id')
        .eq('deal_id', dealId)
        .eq('user_id', subjectId)
        .maybeSingle()
    : { data: null, error: null };
  if (seatError) return jsonError('Lookup is unavailable', 503);

  // Evaluated unconditionally: these are facts about the ACTOR, so asking is
  // never itself a disclosure, and asking every time removes the tell.
  let overDealMembership = false;
  let isDealMd = false;
  if (dealId) {
    try {
      overDealMembership = await canManageDealMembers(auth.admin, auth.user.id, dealId);
      isDealMd = await userIsDealMd(auth.admin, auth.user.id, dealId);
    } catch {
      return jsonError('Lookup is unavailable', 503);
    }
  }

  let mayDisclose = false;
  if (existingUser) {
    // A17's three branches, each requiring explicit tenant equality. A firm
    // overseer's reach is tenant-wide, never cross-tenant (#116/#141/#144).
    const sameTenant = existingUser.tenant_id === actor.tenant_id;
    const sharesCompany =
      Boolean(actor.company_id) && existingUser.company_id === actor.company_id;
    const isOverseer = actor.firm_role === 'cco' || actor.firm_role === 'admin';
    mayDisclose =
      sameTenant && (sharesCompany || isOverseer || (Boolean(seat) && overDealMembership));
    if (mayDisclose) found.add(WARNING.EXISTING_PLATFORM_USER);

    // A18: the seat fact is gated on authority over THIS deal's membership.
    if (seat && (overDealMembership || isDealMd)) found.add(WARNING.EXISTING_DEAL_SEAT);
  }

  const { data: pending, error: pendingError } = await auth.admin
    .from('invites')
    .select('id, company_id, deal_id')
    .eq('email', email)
    .eq('status', 'pending')
    .maybeSingle();
  if (pendingError) return jsonError('Lookup is unavailable', 503);

  // Asked every time, whether or not an invitation exists, and asked about the
  // invitation actually being disclosed rather than some other resource that
  // is safe to ask about (A6).
  //
  // Earlier rounds tried to make this indistinguishable from the outside, by
  // evaluating both invitation shapes here and letting the real one select the
  // answer. That equalized the response and the number of evaluations but not
  // the work: the arguments are the hidden row's own company and deal, so the
  // queries inside the predicate still varied with them, and an address with
  // no invitation stopped sooner than one whose invitation the actor may not
  // see. Answering "no such row" faster than "a row you cannot see" is the
  // distinction A19 exists to prevent.
  //
  // It is fixed where it belongs: `userCanManageInvite` now reads
  // unconditionally and decides in memory, so its schedule is the same four
  // reads for any argument. One call, real shape, constant work. Tenant
  // coherence lives in the predicate too, so an admin of another firm is not
  // told about this invitation at all.
  let mayManage = false;
  try {
    mayManage = await userCanManageInvite(auth.admin, auth.user.id, {
      companyId: pending?.company_id ?? NO_ROW,
      dealId: pending?.deal_id ?? null,
    });
  } catch {
    return jsonError('Lookup is unavailable', 503);
  }

  if (pending && mayManage) found.add(WARNING.PENDING_INVITATION);

  // --- Recommendation (A7) --------------------------------------------------
  let recommendation: {
    dealRole: string;
    companyRole: string;
    phase: number;
    reasons: { dealRole: string; phase: string };
  } | null = null;

  if (companyMatch) {
    const isBank = companyMatch.companyType === 'bank';
    if (isBank) {
      // Gate 0's case. A bank seat has no party relationship to derive from and
      // no phase to raise: phase gates external users only. A disclosable
      // colleague's preference proposes the initial role but grants nothing.
      const preferred =
        mayDisclose && existingUser?.company_id === companyMatch.companyId
          ? resolvePreferredDealRole(existingUser.preferred_deal_role)
          : null;
      recommendation = {
        dealRole: preferred ?? DEAL_ROLE.DEAL_TEAM,
        companyRole: COMPANY_ROLE.MEMBER,
        phase: 0,
        reasons: {
          dealRole: preferred ? 'employee_default' : 'bank_internal_seat',
          phase: 'phase_not_applicable_internal',
        },
      };
    } else if (dealId) {
      const { data: party, error: partyError } = await auth.admin
        .from('deal_parties')
        .select('party_role')
        .eq('deal_id', dealId)
        .eq('company_id', companyMatch.companyId)
        .maybeSingle();
      if (partyError) return jsonError('Lookup is unavailable', 503);
      if (party) {
        recommendation = {
          dealRole: SELLER_PARTY_ROLES.includes(party.party_role)
            ? DEAL_ROLE.SELLER
            : DEAL_ROLE.BUYER,
          companyRole: companyRolePolicy?.requiresDirector
            ? COMPANY_ROLE.DIRECTOR
            : COMPANY_ROLE.MEMBER,
          phase: 0,
          reasons: { dealRole: 'party_derived', phase: 'least_privilege_start' },
        };
      }
    }
  }

  return NextResponse.json({
    normalizedEmail: email,
    domain,
    companyMatch: companyMatch
      ? { companyId: companyMatch.companyId, companyName: companyMatch.companyName }
      : null,
    proposedCompany: companyMatch ? null : { label: proposeCompanyLabel(domain) },
    warnings: WARNING_ORDER.filter((id) => found.has(id)).map((id) => ({ id })),
    recommendation,
    companyRolePolicy,
  });
}
