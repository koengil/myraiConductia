import type { SupabaseClient } from '@supabase/supabase-js';
import {
  COMPANY_ROLE,
  DEAL_ROLE,
  FIRM_ROLE,
  INTERNAL_ASSIGNABLE_DEAL_ROLES,
} from '@/lib/constants/roles';
import { COMPANY_TYPE, PARTY_ROLE } from '@/lib/constants/companies';
import type { DocumentSubject } from '@/lib/api/v1/documentAccess';
import { canManageCompanyMembers, userCanInvite } from '@/lib/api/v1/access';

/**
 * Is this invitation proposal actually sendable, and if so what seat does it
 * resolve to? (plan-v5 §5.)
 *
 * One path, three callers: smart lookup, the perimeter preview, and the send
 * route. The preview must never describe access for a proposal that could not
 * be sent — otherwise "what they'll see" is a fiction, and worse, a probe.
 *
 * Order is load-bearing:
 *
 *   1. TENANT COHERENCE, FIRST AND UNCONDITIONAL. `userCanInvite` opens with
 *      `if (actor.firm_role === ADMIN) return true` before any tenant check
 *      (access.ts). Calling it first would let a firm admin hand us another
 *      tenant's companyId and read document counts back out of the preview —
 *      the cross-tenant reach closed by #116/#141/#144, reopened through a new
 *      door. So tenancy is settled here before authority is consulted.
 *   2. `userCanInvite` — necessary, NOT sufficient. Its own docblock says shape
 *      constraints are enforced by the route.
 *   3. Company-role authority, mirroring invites/route.ts exactly.
 *   4. Deal-role shape, party-derived for external companies.
 *   5. Phase bounds.
 *
 * The resolved subject is returned only on `ok: true`, and only this module
 * builds one, so a caller cannot compute a perimeter for a proposal that was
 * never proven feasible.
 */

/** Seats an internal (bank-company) invitee may take. `md` is never invitable. */
export const INTERNAL_PROPOSAL_DEAL_ROLES: string[] = [...INTERNAL_ASSIGNABLE_DEAL_ROLES];

/** Seats an external invitee may take. */
export const EXTERNAL_PROPOSAL_DEAL_ROLES: string[] = [DEAL_ROLE.SELLER, DEAL_ROLE.BUYER];

/** Party roles that put a company on the sell side. */
const SELLER_PARTY_ROLES: string[] = [PARTY_ROLE.TARGET, PARTY_ROLE.CO_SELLER];

export type Proposal = {
  /** Already normalized by `normalizeInviteEmail`. Not used for authorization. */
  email: string;
  companyId: string;
  companyRole: string;
  dealId: string | null;
  dealRole: string | null;
  phase: number;
};

export type FeasibilityDenial =
  /** Authority or tenancy says no. Opaque to the caller by design. */
  | { ok: false; reason: 'forbidden' }
  /** The proposal is malformed or self-contradictory. */
  | { ok: false; reason: 'invalid' }
  /** A member would create an active company with no director. */
  | { ok: false; reason: 'company_requires_director' }
  /** A read failed. Never conflated with "denied" or with "nothing found". */
  | { ok: false; reason: 'unavailable' };

export type Feasibility =
  | {
      ok: true;
      subject: DocumentSubject;
      isExternalCompany: boolean;
      companyRole: string;
      dealRole: string | null;
      phase: number;
    }
  | FeasibilityDenial;

const FORBIDDEN: FeasibilityDenial = { ok: false, reason: 'forbidden' };
const INVALID: FeasibilityDenial = { ok: false, reason: 'invalid' };
const COMPANY_REQUIRES_DIRECTOR: FeasibilityDenial = {
  ok: false,
  reason: 'company_requires_director',
};
const UNAVAILABLE: FeasibilityDenial = { ok: false, reason: 'unavailable' };

/**
 * Invitation composition needs the users-table director invariant before it
 * promises a Member seat that acceptance would later reject.
 * `null` is unreadable, never "no director".
 */
export async function companyHasActiveDirector(
  admin: SupabaseClient,
  companyId: string,
): Promise<boolean | null> {
  const { data, error } = await admin
    .from('users')
    .select('id')
    .eq('company_id', companyId)
    .eq('status', 'active')
    .eq('company_role', COMPANY_ROLE.DIRECTOR)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return Boolean(data);
}

export async function assessProposal(
  admin: SupabaseClient,
  actorId: string,
  proposal: Proposal,
): Promise<Feasibility> {
  // --- 1. Tenant coherence, before any authority predicate ------------------
  const { data: actor, error: actorError } = await admin
    .from('users')
    .select('tenant_id, firm_role, is_external, company_id, company_role')
    .eq('id', actorId)
    .maybeSingle();
  if (actorError) return UNAVAILABLE;
  if (!actor) return FORBIDDEN;

  const { data: company, error: companyError } = await admin
    .from('companies')
    .select('tenant_id, type')
    .eq('id', proposal.companyId)
    .maybeSingle();
  if (companyError) return UNAVAILABLE;
  // A company that does not exist and a company in another tenant are the same
  // answer on purpose: neither confirms the other's existence to a prober.
  if (!company || company.tenant_id !== actor.tenant_id) return FORBIDDEN;

  if (proposal.dealId) {
    const { data: deal, error: dealError } = await admin
      .from('deals')
      .select('tenant_id')
      .eq('id', proposal.dealId)
      .maybeSingle();
    if (dealError) return UNAVAILABLE;
    if (!deal || deal.tenant_id !== actor.tenant_id) return FORBIDDEN;
  }

  // --- 2. Invitation authority: necessary, not sufficient -------------------
  let permitted: boolean;
  try {
    permitted = await userCanInvite(admin, actorId, {
      companyId: proposal.companyId,
      dealId: proposal.dealId,
    });
  } catch {
    return UNAVAILABLE;
  }
  if (!permitted) return FORBIDDEN;

  // --- 3. Company role, mirroring invites/route.ts --------------------------
  // Coercion keys on the ACTOR being external, never on the target company.
  // An authorized internal actor may still explicitly invite a Director; only
  // an external actor is pinned to Member.
  const actorIsExternal =
    Boolean(actor.is_external) && actor.firm_role !== FIRM_ROLE.ADMIN;
  const companyRole = actorIsExternal ? COMPANY_ROLE.MEMBER : proposal.companyRole;

  if (companyRole !== COMPANY_ROLE.DIRECTOR && companyRole !== COMPANY_ROLE.MEMBER) {
    return INVALID;
  }
  if (companyRole === COMPANY_ROLE.DIRECTOR) {
    // A director invite is a company-management act. `canManageCompanyMembers`
    // is admin-within-tenant OR director of that same company. Permission to
    // send member invitations does not grant authority to create a director.
    let canManage: boolean;
    try {
      canManage = await canManageCompanyMembers(admin, actorId, proposal.companyId);
    } catch {
      return UNAVAILABLE;
    }
    if (!canManage) return FORBIDDEN;
  }

  // --- 4. Deal-role shape ---------------------------------------------------
  const isExternalCompany = company.type !== COMPANY_TYPE.BANK;
  let dealRole: string | null = null;

  if (proposal.dealId) {
    if (!proposal.dealRole) return INVALID;
    if (isExternalCompany) {
      if (!EXTERNAL_PROPOSAL_DEAL_ROLES.includes(proposal.dealRole)) return INVALID;
      const { data: party, error: partyError } = await admin
        .from('deal_parties')
        .select('party_role')
        .eq('deal_id', proposal.dealId)
        .eq('company_id', proposal.companyId)
        .maybeSingle();
      if (partyError) return UNAVAILABLE;
      if (!party) return INVALID;
      const expected = SELLER_PARTY_ROLES.includes(party.party_role)
        ? DEAL_ROLE.SELLER
        : DEAL_ROLE.BUYER;
      if (proposal.dealRole !== expected) return INVALID;
      dealRole = expected;
    } else {
      if (!INTERNAL_PROPOSAL_DEAL_ROLES.includes(proposal.dealRole)) return INVALID;
      dealRole = proposal.dealRole;
    }
  } else if (proposal.dealRole) {
    // A deal role without a deal is meaningless; the invites table enforces the
    // same pairing with a CHECK constraint.
    return INVALID;
  }

  // --- 5. Phase -------------------------------------------------------------
  if (!Number.isInteger(proposal.phase) || proposal.phase < 0) return INVALID;
  // Phase gates external users only. An internal seat is phase 0 by definition,
  // so a nonzero request is coerced rather than honoured or rejected.
  const phase = isExternalCompany ? proposal.phase : 0;

  if (companyRole === COMPANY_ROLE.MEMBER) {
    const hasDirector = await companyHasActiveDirector(admin, proposal.companyId);
    if (hasDirector === null) return UNAVAILABLE;
    if (!hasDirector) return COMPANY_REQUIRES_DIRECTOR;
  }

  return {
    ok: true,
    subject: {
      isExternal: isExternalCompany,
      // An invitation creates a company member or director, never a firm
      // overseer, so a proposed subject never carries oversight.
      hasOversight: false,
      dealRole,
      phase,
    },
    isExternalCompany,
    companyRole,
    dealRole,
    phase,
  };
}
