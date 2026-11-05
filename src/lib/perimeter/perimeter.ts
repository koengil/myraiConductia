import type { SupabaseClient } from '@supabase/supabase-js';
import { ALLOWED_DESTINATIONS, type DestinationId } from '@/lib/perspective/access';
import { COMPANY_ROLE } from '@/lib/constants/roles';
import { DOCUMENT_CLASSIFICATION, DOCUMENT_ROOM, type DocumentRoom } from '@/lib/constants/documents';
import {
  getDocumentViewer,
  parseDocumentRoom,
  userCanSeeDocument,
  userCanUploadDocument,
  type DocumentSubject,
} from '@/lib/api/v1/documentAccess';
import { assessProposal, type Proposal } from '@/lib/api/v1/proposalFeasibility';
import { userCanInviteChecked, userIsDealMd } from '@/lib/api/v1/access';

/**
 * The access perimeter: what a seat can reach (plan-v5 §3).
 *
 * ONE decision path, three uses. The preview asks these questions about a seat
 * that does not exist yet; the welcome brief asks them about a real viewer.
 * Both run `userCanSeeDocument` / `userCanUploadDocument` — the same predicates
 * the document routes enforce with — so "what they'll see" cannot drift from
 * what they actually see. That is criterion B2 held by construction rather than
 * by two implementations agreeing to behave.
 *
 * THE EXPORT SURFACE IS THE SECURITY BOUNDARY. `computePerimeterInternal` takes
 * a bare `DocumentSubject`, and a `DocumentSubject` is an ordinary structural
 * type any caller could invent. So it is not exported, and it lives in this
 * module rather than behind an index barrel — a barrel would have to export it
 * to re-export it, which is no boundary at all. The only ways in are the three
 * entry points below, and each builds its subject from its own authorization
 * check. There is no exported function that accepts a subject, so there is
 * nothing to forge.
 */

export type PerimeterRoomCount = {
  room: DocumentRoom;
  count: number;
};

export type Perimeter = {
  /** Destinations this seat reaches in the shell. */
  destinations: DestinationId[];
  /** Documents this seat can open right now. Survivors only. */
  documents: {
    total: number;
    /** Per-room counts, computed from survivors, so a room the seat cannot
     *  reach never appears — not even as a zero. */
    rooms: PerimeterRoomCount[];
  };
  capabilities: {
    canUploadToDataRoom: boolean;
    canInviteTeammate: boolean;
  };
  /** Denials that hold at every phase, stated as facts rather than counts. */
  invariants: string[];
};

export const PERIMETER_INVARIANT = {
  EXTERNAL_NEVER_INTERNAL_ROOM: 'external_never_internal_room',
  EXTERNAL_NEVER_MNPI: 'external_never_mnpi',
} as const;

export type PerimeterFailure =
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'company_requires_director' }
  | { ok: false; reason: 'unavailable' }
  | { ok: false; reason: 'phase_downgrade' };

export type PerimeterResult = { ok: true; perimeter: Perimeter } | PerimeterFailure;

/** Only the policy fields. Titles, uploaders and storage ids are never read,
 *  so they cannot leak into a response (criterion B6). */
type DocumentGateRow = {
  room: unknown;
  classification: number;
  min_phase: number;
};

type PerimeterContext = {
  /**
   * Whether this seat may invite a teammate, ALREADY DECIDED by the caller from
   * real invitation authority.
   *
   * Not a role name for the core to interpret. An external director may only
   * grow their roster on a deal their company is a party to, so deriving this
   * from `companyRole === 'director'` would offer an action the send route
   * refuses — the brief would be teaching the invitee something untrue about
   * their own seat (criteria C6, C8).
   */
  canInviteTeammate: boolean;
};

/**
 * Pure. No IO, so previewing cannot write an audit row or confer a grant
 * (criterion B9) — that holds by construction, not by remembering.
 */
function computePerimeterInternal(
  subject: DocumentSubject,
  gates: { room: DocumentRoom; classification: number; min_phase: number }[],
  ctx: PerimeterContext,
): Perimeter {
  const visible = gates.filter((gate) => userCanSeeDocument(subject, gate));

  const rooms: PerimeterRoomCount[] = [];
  for (const gate of visible) {
    const existing = rooms.find((entry) => entry.room === gate.room);
    if (existing) existing.count += 1;
    else rooms.push({ room: gate.room, count: 1 });
  }

  const destinations = subject.isExternal
    ? [...ALLOWED_DESTINATIONS.external]
    : // Internal seats reach the internal shell. Nav gating is presentation,
      // not the security boundary (ADR-0009); the walls above are.
      [...ALLOWED_DESTINATIONS.storm];

  const invariants = subject.isExternal
    ? [
        PERIMETER_INVARIANT.EXTERNAL_NEVER_INTERNAL_ROOM,
        PERIMETER_INVARIANT.EXTERNAL_NEVER_MNPI,
      ]
    : [];

  return {
    destinations,
    documents: { total: visible.length, rooms },
    capabilities: {
      // "Can they upload anything at all", asked of the real upload predicate
      // at the lowest classification rather than guessed from the role name.
      canUploadToDataRoom: userCanUploadDocument(
        subject,
        DOCUMENT_ROOM.DEAL,
        DOCUMENT_CLASSIFICATION.PUBLIC,
      ),
      canInviteTeammate: ctx.canInviteTeammate,
    },
    invariants,
  };
}

/**
 * Read the policy fields for a deal's documents.
 *
 * A row whose room is not one of the known rooms makes the WHOLE result
 * unavailable. `userCanSeeDocument` only special-cases the internal room, so an
 * unrecognized value would fall through its walls and read as visible; the
 * database CHECK makes such a row impossible, and this keeps that a fact rather
 * than an assumption (cr-plan-v3 5.3).
 */
async function loadGates(
  admin: SupabaseClient,
  dealId: string,
): Promise<{ room: DocumentRoom; classification: number; min_phase: number }[] | null> {
  const { data, error } = await admin
    .from('documents')
    .select('room, classification, min_phase')
    .eq('deal_id', dealId);
  if (error) return null;

  const gates: { room: DocumentRoom; classification: number; min_phase: number }[] = [];
  for (const row of (data ?? []) as DocumentGateRow[]) {
    const room = parseDocumentRoom(row.room);
    if (!room) return null;
    gates.push({ room, classification: row.classification, min_phase: row.min_phase });
  }
  return gates;
}

/**
 * The perimeter an invitation proposal would confer.
 *
 * Authorized by `assessProposal`, which decides both whether the actor may send
 * this invitation at all and what seat it resolves to. A proposal that could
 * not be sent yields no perimeter, so the preview cannot be used to probe.
 */
export async function perimeterForProposal(
  admin: SupabaseClient,
  actorId: string,
  proposal: Proposal,
): Promise<PerimeterResult> {
  const feasibility = await assessProposal(admin, actorId, proposal);
  if (!feasibility.ok) return feasibility;

  // Gate 0 composes invitations before the deal exists. There is no document
  // set to report yet, and saying so is honest; inventing one is not.
  const gates = proposal.dealId ? await loadGates(admin, proposal.dealId) : [];
  if (!gates) return { ok: false, reason: 'unavailable' };

  return {
    ok: true,
    perimeter: computePerimeterInternal(feasibility.subject, gates, {
      // The invitee has no user row to ask about, so the rule is evaluated
      // rather than looked up. The party relationship is not assumed: for an
      // external company with a deal in context, assessProposal only returns
      // ok after finding the deal_parties row, so reaching here proves it.
      canInviteTeammate:
        feasibility.isExternalCompany &&
        feasibility.companyRole === COMPANY_ROLE.DIRECTOR &&
        proposal.dealId !== null,
    }),
  };
}

/**
 * The perimeter an existing member would hold at a proposed phase.
 *
 * Authorized by the same predicate that guards the real phase raise, and
 * refuses a downgrade for the same reason it does: disclosure is monotonic.
 */
export async function perimeterForMember(
  admin: SupabaseClient,
  actorId: string,
  dealId: string,
  userId: string,
  phase: number,
): Promise<PerimeterResult> {
  if (!Number.isInteger(phase) || phase < 0) return { ok: false, reason: 'invalid' };

  let permitted: boolean;
  try {
    permitted = await userIsDealMd(admin, actorId, dealId);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (!permitted) return { ok: false, reason: 'forbidden' };

  const subject = await getDocumentViewer(admin, userId, dealId);
  if (!subject) return { ok: false, reason: 'forbidden' };
  if (phase < subject.phase) return { ok: false, reason: 'phase_downgrade' };

  const { data: profile, error: profileError } = await admin
    .from('users')
    .select('company_role, company_id')
    .eq('id', userId)
    .maybeSingle();
  if (profileError) return { ok: false, reason: 'unavailable' };

  const gates = await loadGates(admin, dealId);
  if (!gates) return { ok: false, reason: 'unavailable' };

  const canInvite = await realInvitationAuthority(admin, userId, profile?.company_id ?? null, dealId);
  if (canInvite === null) return { ok: false, reason: 'unavailable' };

  return {
    ok: true,
    perimeter: computePerimeterInternal({ ...subject, phase }, gates, {
      canInviteTeammate: canInvite,
    }),
  };
}

/**
 * Real invitation authority for a real user, through the same predicate the
 * send route uses. Returns null when it cannot be determined, which callers
 * turn into an unavailable perimeter rather than a confident "no": an offered
 * action the seat lacks and a withheld action it holds are both lies.
 */
async function realInvitationAuthority(
  admin: SupabaseClient,
  userId: string,
  companyId: string | null,
  dealId: string,
): Promise<boolean | null> {
  // No company on the profile is a real answer: there is no roster to grow.
  if (!companyId) return false;
  try {
    const verdict = await userCanInviteChecked(admin, userId, { companyId, dealId });
    // A read that failed is not "no authority". Offering nothing and offering
    // the wrong thing are both lies; the honest output is that we could not
    // tell, which the caller renders as unavailable.
    return verdict === 'unreadable' ? null : verdict;
  } catch {
    return null;
  }
}

/**
 * The perimeter a real, seated viewer holds right now — the welcome brief's
 * reading. Recomputed on every render, so a phase raise or a new release shows
 * up without anything being invalidated (criteria C1, C3).
 */
export async function perimeterForViewer(
  admin: SupabaseClient,
  userId: string,
  dealId: string,
): Promise<PerimeterResult> {
  const subject = await getDocumentViewer(admin, userId, dealId);
  if (!subject) return { ok: false, reason: 'forbidden' };

  const { data: profile, error: profileError } = await admin
    .from('users')
    .select('company_role, company_id')
    .eq('id', userId)
    .maybeSingle();
  if (profileError) return { ok: false, reason: 'unavailable' };

  const gates = await loadGates(admin, dealId);
  if (!gates) return { ok: false, reason: 'unavailable' };

  const canInvite = await realInvitationAuthority(admin, userId, profile?.company_id ?? null, dealId);
  if (canInvite === null) return { ok: false, reason: 'unavailable' };

  return {
    ok: true,
    perimeter: computePerimeterInternal(subject, gates, {
      canInviteTeammate: canInvite,
    }),
  };
}
