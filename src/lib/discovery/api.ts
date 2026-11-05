// Route helpers for /api/v1/discovery/*. Every function here takes the
// caller's user-scoped client (requireApiUserScoped), so what comes back is
// exactly what RLS lets that user see: no filter in this file grants or
// narrows access. A candidate the caller cannot see is simply absent.

import type { SupabaseClient } from '@supabase/supabase-js';

import type { AuditActorType, DiscoveryAuditAction } from '@/lib/constants/audit';
import {
  DISCOVERY_STATE,
  SOURCE_HEALTH_STATES,
  SOURCE_ITEM_KIND,
  TEAM_MAILBOX_AUDIT_DEFAULT_LIMIT,
  TEAM_MAILBOX_AUDIT_VIEWS,
  type CheckpointState,
  type CorrectionAction,
  type DelegationStatus,
  type DiscoveryState,
  type DriftStatus,
  type MailboxProvider,
  type ReaderHealthState,
  type ReaderPassGroup,
  type ReaderPassStatus,
  type RegistrationStatus,
  type SourceHealthState,
  type SourceKind,
  type SourceStatus,
  type TeamMailboxCheckError,
  type TeamMailboxCheckReason,
  type TeamMailboxCheckStatus,
} from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';
import { MAX_REPLY_PARTICIPANTS, MESSAGE_ID_RX } from '@/lib/email/messageId';
import type { EvidenceSuggestion } from '@/lib/deals/evidenceSuggestion';
import { logServerEvent, type LineFor } from '@/lib/log';
import { MVP_DEAL_RAIL, orderedSteps, stepDisplayNumber, totalSteps } from '@/lib/rail/dealRail';

import { excerptAround } from './excerpt';
import { MILESTONE_LABEL, type MilestoneType } from './milestones';
import {
  candidateOrigin,
  dealOrigin,
  latestModelProposal,
  type ModelProposal,
  type Origin,
} from './origin';

export type { ModelProposal, Origin } from './origin';

import { isMissingFunction } from './missingFunction';
import { preferredAssessment } from './preferredAssessment';

/**
 * stage_assessments rows per page. PostgREST caps a response at max_rows (1000, and a hosted project may cap it lower),
 * so the reader moves on by the rows it got and stops only on an empty page.
 */
const ASSESSMENT_PAGE = 1000;

/**
 * Every stage_assessments row the caller reads for the given candidates or deal, page by page by id (keyset), so a
 * long history never hides a stream's latest row from preferredAssessment, which reads all of them in any order
 * (audit S8). The same `{ data, error }` shape a single read answers.
 */
async function readAssessments<T extends { id: string }>(
  db: SupabaseClient,
  columns: string,
  by: { candidateIds: string[] } | { dealId: string },
): Promise<{ data: T[]; error: null } | { data: null; error: { message: string; code?: string } }> {
  const rows: T[] = [];
  for (let after: string | null = null; ; ) {
    let query = db.from(TABLE.STAGE_ASSESSMENTS).select(columns);
    query = 'dealId' in by ? query.eq('deal_id', by.dealId) : query.in('candidate_id', by.candidateIds);
    if (after) query = query.gt('id', after);
    const { data, error } = await query.order('id').limit(ASSESSMENT_PAGE);
    if (error) return { data: null, error: { message: error.message, code: error.code } };
    const page = (data ?? []) as unknown as T[];
    if (page.length === 0) return { data: rows, error: null };
    rows.push(...page);
    after = page[page.length - 1].id;
  }
}

export type CandidateParty = { name: string; domain: string };

/** One row of the /discovery list. */
export type CandidateSummary = {
  id: string;
  name: string;
  codename: string | null;
  parties: CandidateParty[];
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  /** Evidence items the caller can see: their own, and colleagues' firm or confirmed routes. */
  evidenceCount: number;
  /** Of those, the items from the caller's own mailboxes and sites. */
  ownEvidenceCount: number;
  /** The preferred stage assessment's step (preferredAssessment.ts), or null when none has been made or it named no milestone. */
  station: { station: number | null; title: string } | null;
};

/** The suggested step of a candidate, from its preferred assessment (the stage engine, never a model). */
export type CandidateStation = {
  stepId: string;
  station: number | null;
  total: number;
  title: string;
  lifecycle: string | null;
  reason: string;
  confidence: number;
  flags: string[];
  asOf: string;
};

export type CandidateMilestone = {
  id: string;
  type: MilestoneType;
  label: string;
  occurredAt: string;
  sourceItemId: string;
  /** True when the caller's own mailbox holds the item (they can read its text). */
  own: boolean;
  /** True when the caller reads the item only as a member of a team inbox that holds it, not from a mailbox of their own. */
  team: boolean;
};

export type CandidateEvidence = {
  sourceItemId: string;
  subject: string;
  sentAt: string | null;
  own: boolean;
  /** As on CandidateMilestone: the caller reads it through a team inbox, not their own mailbox. */
  team: boolean;
  /** The cited sentence with its surroundings; only for the caller's own mail. */
  excerpt: { text: string; highlight: [number, number] } | null;
};

/** One live email link of a candidate, as the caller may see it: what the split and reassign dialogs offer. */
export type CandidateItem = {
  linkId: string;
  sourceItemId: string;
  subject: string;
  sentAt: string | null;
  own: boolean;
};

/** One entry of the decision history: what a person did, when, why, and the value before. */
export type CandidateDecision = {
  id: string;
  /** The candidate the decision was recorded on (a merge is recorded on the candidate that was merged). */
  candidateId: string;
  action: CorrectionAction;
  /** The person's name when the caller may read it, else "A colleague". */
  actorName: string;
  own: boolean;
  at: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
};

/** The MD's step for a proposed deal, which the evidence's suggestion never replaces. */
export type CandidateOverride = {
  stepId: string;
  station: number | null;
  title: string;
  reason: string | null;
};

/**
 * Whether the caller may correct this candidate, from discovery_correction_authority. The reason is
 * candidate_state when the candidate itself no longer allows it (rejected, merged, or, for the actions
 * that end a proposal, promoted).
 */
export type CandidateCanAct = { ok: true } | { ok: false; reason: 'no_authority' | 'candidate_state' };

export type CandidateDetail = Omit<CandidateSummary, 'station'> & {
  state: DiscoveryState;
  station: CandidateStation | null;
  milestones: CandidateMilestone[];
  evidence: CandidateEvidence[];
  /** Every live email link the caller can see, not only the cited ones; empty when a link has no readable email. */
  items: CandidateItem[];
  decisions: CandidateDecision[];
  override: CandidateOverride | null;
  canAct: CandidateCanAct;
  /**
   * The same question for the actions that end the proposal (promote, reject, merge). A promoted candidate
   * keeps canAct (rename, step, split, move) but not this.
   */
  canResolve: CandidateCanAct;
  /** Set when this candidate was merged into another; the name is null when the caller cannot see the survivor. */
  mergedInto: { id: string; name: string | null } | null;
  /** Whether the model found this deal (an accepted model proposal, or a survivor of one). Never the cluster key itself. */
  origin: Origin;
  /**
   * The station the model proposed when its owner accepted the proposal, and how many emails it placed there. Null for
   * everyone but the mailbox's owner (the requests are owner-only under RLS), and when nothing was accepted.
   */
  modelProposal: ModelProposal | null;
};

type CandidateRow = {
  id: string;
  proposed_name: string;
  codename_guess: string | null;
  parties: unknown;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

function partiesFrom(value: unknown): CandidateParty[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { name, domain } = entry as Record<string, unknown>;
    if (typeof domain !== 'string') return [];
    return [{ name: typeof name === 'string' && name ? name : domain, domain }];
  });
}

export async function listCandidates(
  db: SupabaseClient,
  userId: string,
): Promise<{ ok: true; candidates: CandidateSummary[] } | { ok: false; error: string }> {
  const { data: rows, error } = await db
    .from(TABLE.DEAL_CANDIDATES)
    .select('id, proposed_name, codename_guess, parties, first_seen_at, last_seen_at')
    .eq('discovery_state', DISCOVERY_STATE.PROPOSED)
    .order('last_seen_at', { ascending: false, nullsFirst: false })
    .order('id');
  if (error) return { ok: false, error: error.message };
  const candidates = (rows ?? []) as CandidateRow[];
  if (candidates.length === 0) return { ok: true, candidates: [] };

  const ids = candidates.map((row) => row.id);
  const [links, own, assessments] = await Promise.all([
    db.from(TABLE.EVIDENCE_LINKS).select('candidate_id, source_item_id, state').in('candidate_id', ids),
    db
      .from(TABLE.CANDIDATE_VISIBILITY)
      .select('candidate_id, source_item_count')
      .in('candidate_id', ids)
      .eq('person_id', userId),
    readAssessments<{ id: string }>(db, 'id, candidate_id, step_id, team_mailbox_id, as_of', { candidateIds: ids }),
  ]);
  if (links.error) return { ok: false, error: links.error.message };
  if (own.error) return { ok: false, error: own.error.message };
  if (assessments.error) return { ok: false, error: assessments.error.message };

  // Each candidate's preferred assessment among the rows the caller reads (preferredAssessment.ts).
  type ListAssessment = { id: string; candidate_id: string; step_id: string | null; team_mailbox_id?: string | null; as_of: string };
  const byCandidate = new Map<string, ListAssessment[]>();
  for (const row of (assessments.data ?? []) as ListAssessment[]) {
    byCandidate.set(row.candidate_id, [...(byCandidate.get(row.candidate_id) ?? []), row]);
  }
  const latestStep = new Map<string, string | null>(
    [...byCandidate].map(([candidateId, rows]) => [candidateId, preferredAssessment(rows)?.step_id ?? null]),
  );

  const evidence = new Map<string, Set<string>>();
  for (const link of (links.data ?? []) as Array<{ candidate_id: string; source_item_id: string; state?: string }>) {
    if (link.state === 'rejected') continue; // a person moved this email elsewhere; its owner can still read the row
    const items = evidence.get(link.candidate_id) ?? new Set<string>();
    items.add(link.source_item_id);
    evidence.set(link.candidate_id, items);
  }
  const ownCount = new Map<string, number>(
    ((own.data ?? []) as Array<{ candidate_id: string; source_item_count: number }>).map((row) => [
      row.candidate_id,
      row.source_item_count,
    ]),
  );

  return {
    ok: true,
    candidates: candidates.map((row) => ({
      id: row.id,
      name: row.proposed_name,
      codename: row.codename_guess,
      parties: partiesFrom(row.parties),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      evidenceCount: evidence.get(row.id)?.size ?? 0,
      ownEvidenceCount: ownCount.get(row.id) ?? 0,
      station: summaryStation(latestStep.get(row.id) ?? null),
    })),
  };
}

const CORRECTION_COLUMNS = 'id, candidate_id, actor_id, action, before, after, reason, created_at';

type CorrectionRow = {
  id: string;
  candidate_id: string;
  actor_id: string;
  action: CorrectionAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
};

/** Names of the people who made decisions, as far as RLS lets the caller read them (their own row, and a director's company). */
async function readActorNames(
  db: SupabaseClient,
  actorIds: string[],
): Promise<{ ok: true; names: Map<string, string> } | { ok: false; error: string }> {
  const names = new Map<string, string>();
  if (actorIds.length === 0) return { ok: true, names };
  const { data, error } = await db.from(TABLE.USERS).select('id, display_name, full_name').in('id', actorIds);
  if (error) return { ok: false, error: error.message };
  for (const u of (data ?? []) as Array<{ id: string; display_name: string | null; full_name: string | null }>) {
    const name = (u.display_name ?? u.full_name ?? '').trim();
    if (name) names.set(u.id, name);
  }
  return { ok: true, names };
}

function railStep(stepId: string) {
  return orderedSteps(MVP_DEAL_RAIL).find((step) => step.id === stepId);
}

/** The list line for a step id: its step on the current rail and its title. Null for no step, or one the rail no longer has. */
function summaryStation(stepId: string | null): CandidateSummary['station'] {
  if (!stepId) return null;
  const step = railStep(stepId);
  if (!step) return null;
  return { station: stepDisplayNumber(stepId, MVP_DEAL_RAIL) || null, title: step.title };
}

type AssessmentRow = {
  id?: string;
  step_id: string | null;
  team_mailbox_id?: string | null;
  lifecycle_suggestion: string | null;
  reason_text: string;
  evidence_event_ids: string[];
  confidence: number | string;
  flags: string[];
  as_of: string;
};

type EventRow = {
  id: string;
  source_item_id: string;
  type: MilestoneType;
  occurred_at: string;
  span_start: number;
  span_end: number;
  extractor_version: string;
  created_at: string;
};

/** The rule before 20261023130400, kept for a database that has not run it yet: each item's newest extractor version. */
function newestVersionEvents(all: EventRow[]): EventRow[] {
  const newest = new Map<string, EventRow>();
  for (const e of all) {
    const seen = newest.get(e.source_item_id);
    if (!seen || e.created_at > seen.created_at) newest.set(e.source_item_id, e);
  }
  return all.filter((e) => e.extractor_version === newest.get(e.source_item_id)?.extractor_version);
}

/**
 * One proposed deal in full, as the caller may see it: its step and the
 * reason for it, the milestones found in mail the caller can see, and the
 * evidence cited, with an excerpt only from the caller's own mail. Everything
 * is an RLS read on the caller's client: a candidate they cannot see is absent
 * (detail null), a colleague's mail arrives as metadata, and text exists for
 * the items the caller owns alone (source_item_texts returns no other row).
 */
/** Rows per keyset page: PostgREST's max_rows (1000), so a short page means the last one. */
const DETAIL_PAGE = 1000;
/** Item ids per read in the detail: a GET's `in (...)` filter stays a few KB (#743). */
const DETAIL_ITEM_BATCH = 100;

type DetailRead<T> = { data: T[]; error: null } | { data: null; error: { message: string; code?: string } };
type DetailResponse = { data: unknown; error: { message: string; code?: string } | null };

/** Every row of a read that can pass max_rows: `read(after)` answers the rows after `key`, ordered by it, a page at most. */
async function readPaged<T>(key: string, read: (after: string | null) => PromiseLike<DetailResponse>): Promise<DetailRead<T>> {
  const rows: T[] = [];
  for (let after: string | null = null; ; ) {
    const { data, error } = await read(after);
    if (error) return { data: null, error };
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < DETAIL_PAGE) return { data: rows, error: null };
    after = String((page[page.length - 1] as Record<string, unknown>)[key]);
  }
}

/** One read per DETAIL_ITEM_BATCH item ids, in turn, joined; the first error stops it. */
async function readItemBatches<T>(
  itemIds: string[],
  read: (ids: string[]) => PromiseLike<DetailResponse>,
): Promise<DetailRead<T>> {
  const rows: T[] = [];
  for (let i = 0; i < itemIds.length; i += DETAIL_ITEM_BATCH) {
    const { data, error } = await read(itemIds.slice(i, i + DETAIL_ITEM_BATCH));
    if (error) return { data: null, error };
    rows.push(...((data ?? []) as T[]));
  }
  return { data: rows, error: null };
}

// A failed read, with its code for the route's log line (a SQLSTATE or PostgREST code, never the message).
function failed(error: { message: string; code?: string | null }): { ok: false; error: string; code?: string } {
  return { ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) };
}

export async function getCandidateDetail(
  db: SupabaseClient,
  userId: string,
  candidateId: string,
): Promise<{ ok: true; detail: CandidateDetail | null } | { ok: false; error: string; code?: string }> {
  const found = await db
    .from(TABLE.DEAL_CANDIDATES)
    .select(
      'id, proposed_name, codename_guess, parties, first_seen_at, last_seen_at, discovery_state, merged_into_id, station_override_step_id, station_override_correction_id',
    )
    .eq('id', candidateId)
    .maybeSingle();
  if (found.error) return failed(found.error);
  if (!found.data) return { ok: true, detail: null };
  const row = found.data as CandidateRow & {
    discovery_state: DiscoveryState;
    merged_into_id: string | null;
    station_override_step_id: string | null;
    station_override_correction_id: string | null;
  };

  const [links, own, assessed, authority, ending, decided, mergedIn, splitFrom, reassignedIn, survivor, origin, proposal] = await Promise.all([
    // By key, past max_rows: a candidate can hold thousands of links (#743).
    readPaged<{ id: string; source_item_id: string; state?: string }>('id', (after) => {
      const query = db.from(TABLE.EVIDENCE_LINKS).select('id, source_item_id, state').eq('candidate_id', candidateId);
      return (after === null ? query : query.gt('id', after)).order('id').limit(DETAIL_PAGE);
    }),
    db
      .from(TABLE.CANDIDATE_VISIBILITY)
      .select('source_item_count')
      .eq('candidate_id', candidateId)
      .eq('person_id', userId)
      .maybeSingle(),
    // Every row the caller reads, so the preferred one can be picked (preferredAssessment.ts).
    readAssessments<{ id: string }>(
      db,
      'id, step_id, team_mailbox_id, lifecycle_suggestion, reason_text, evidence_event_ids, confidence, flags, as_of',
      { candidateIds: [candidateId] },
    ),
    db.rpc('discovery_correction_authority', { p_candidate: candidateId }),
    // Promote, reject and merge share one rule (a proposed candidate that has no deal), so one call answers for all three.
    db.rpc('discovery_correction_authority', { p_candidate: candidateId, p_action: 'promote' }),
    // The decisions recorded on this candidate, and the merges, splits and reassigns of others into it: all read under RLS.
    db
      .from(TABLE.CORRECTIONS)
      .select(CORRECTION_COLUMNS)
      .eq('candidate_id', candidateId),
    db
      .from(TABLE.CORRECTIONS)
      .select(CORRECTION_COLUMNS)
      .eq('action', 'merge')
      .contains('after', { survivorId: candidateId }),
    db
      .from(TABLE.CORRECTIONS)
      .select(CORRECTION_COLUMNS)
      .eq('action', 'split')
      .contains('after', { newCandidateId: candidateId }),
    db
      .from(TABLE.CORRECTIONS)
      .select(CORRECTION_COLUMNS)
      .eq('action', 'reassign')
      .contains('after', { targetCandidateId: candidateId }),
    row.merged_into_id
      ? db.from(TABLE.DEAL_CANDIDATES).select('id, proposed_name').eq('id', row.merged_into_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    candidateOrigin(db, candidateId),
    latestModelProposal(db, candidateId),
  ]);
  if (links.error) return failed(links.error);
  if (own.error) return failed(own.error);
  if (assessed.error) return failed(assessed.error);
  if (authority.error) return failed(authority.error);
  if (ending.error) return failed(ending.error);
  if (decided.error) return failed(decided.error);
  if (mergedIn.error) return failed(mergedIn.error);
  if (splitFrom.error) return failed(splitFrom.error);
  if (reassignedIn.error) return failed(reassignedIn.error);
  if (survivor.error) return failed(survivor.error);
  if (!origin.ok) return origin;
  if (!proposal.ok) return proposal;

  const correctionRows = new Map<string, CorrectionRow>();
  for (const r of [
    ...((decided.data ?? []) as CorrectionRow[]),
    ...((mergedIn.data ?? []) as CorrectionRow[]),
    ...((splitFrom.data ?? []) as CorrectionRow[]),
    ...((reassignedIn.data ?? []) as CorrectionRow[]),
  ]) {
    correctionRows.set(r.id, r);
  }
  const actorNames = await readActorNames(db, [...new Set([...correctionRows.values()].map((r) => r.actor_id))]);
  if (!actorNames.ok) return actorNames;
  const decisions: CandidateDecision[] = [...correctionRows.values()]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map((r) => ({
      id: r.id,
      candidateId: r.candidate_id,
      action: r.action,
      actorName: actorNames.names.get(r.actor_id) ?? (r.actor_id === userId ? 'You' : 'A colleague'),
      own: r.actor_id === userId,
      at: r.created_at,
      before: r.before,
      after: r.after,
      reason: r.reason,
    }));
  const canOf = (answer: string | null | undefined): CandidateCanAct =>
    answer === null || answer === undefined
      ? { ok: true }
      : { ok: false, reason: answer === 'candidate_state' ? 'candidate_state' : 'no_authority' };
  const canAct = canOf(authority.data);
  const canResolve = canOf(ending.data);
  const overrideStep = row.station_override_step_id ? railStep(row.station_override_step_id) : undefined;
  const override: CandidateOverride | null =
    row.station_override_step_id && overrideStep
      ? {
          stepId: row.station_override_step_id,
          station: stepDisplayNumber(row.station_override_step_id, MVP_DEAL_RAIL) || null,
          title: overrideStep.title,
          reason: correctionRows.get(row.station_override_correction_id ?? '')?.reason ?? null,
        }
      : null;
  const survivorRow = survivor.data as { id: string; proposed_name: string } | null;
  const mergedInto = row.merged_into_id ? { id: row.merged_into_id, name: survivorRow?.proposed_name ?? null } : null;

  // A link a person moved elsewhere (a split or reassign) is rejected; its owner can still read the row, but it is no longer evidence here.
  const liveLinks = ((links.data ?? []) as Array<{ id?: string; source_item_id: string; state?: string }>).filter(
    (l) => l.state !== 'rejected',
  );
  const itemIds = [...new Set(liveLinks.map((l) => l.source_item_id))];
  // Every read by item id goes DETAIL_ITEM_BATCH ids at a time: as a GET filter, ~2,000 ids passed the
  // request-line limit and the gateway answered 414 (#743); as an RPC argument, a batch keeps each call short.
  // The reads that can answer several rows per item are paged by key within a batch, past max_rows.
  const [items, texts, events, currentEvents, teamAccess] = itemIds.length
    ? await Promise.all([
        // The subject is owner-only in the database (20261017100000): the definer answers it for the
        // caller's own items and null for a colleague's, on the same rows the source_items policy admits.
        readItemBatches(itemIds, (ids) => db.rpc('discovery_item_metadata', { p_items: ids })),
        // RLS returns the caller's own rows only, so having a text row is what "own" means.
        readItemBatches(itemIds, (ids) =>
          db.from(TABLE.SOURCE_ITEM_TEXTS).select('source_item_id, body_text').in('source_item_id', ids),
        ),
        readItemBatches(itemIds, (ids) =>
          readPaged('id', (after) => {
            const query = db
              .from(TABLE.MILESTONE_EVENTS)
              .select('id, source_item_id, type, occurred_at, span_start, span_end, extractor_version, created_at')
              .in('source_item_id', ids);
            return (after === null ? query : query.gt('id', after)).order('id').limit(DETAIL_PAGE);
          }),
        ),
        // Which of those events are current, by the one rule the stage engine also uses (20261023130400): the
        // latest ok model call for the item's current content decides, even when it found nothing. Ids only.
        readItemBatches(itemIds, (ids) =>
          readPaged('event_id', (after) => {
            const query = db.rpc('discovery_item_current_events', { p_item_ids: ids });
            return (after === null ? query : query.gt('event_id', after)).order('event_id').limit(DETAIL_PAGE);
          }),
        ),
        // Which of them the caller reads only as a member of a team inbox (20261023130500), so team mail is labelled
        // as such rather than as the caller's own mailbox. Ids and a flag only.
        readItemBatches(itemIds, (ids) => db.rpc('discovery_item_team_access', { p_item_ids: ids })),
      ])
    : [null, null, null, null, null];
  // The app can run ahead of 20261023130400 (supabase/AGENTS.md): without the rule's read, the old newest-version
  // rule picks the current events, as before that migration.
  const legacyEvents = isMissingFunction(currentEvents?.error);
  // Likewise 20261023130500: without the team read, no item is labelled team mail, as before that migration. Any
  // other team-read error labels none either: the label is provenance, not access (RLS already chose the rows), so
  // it never fails the detail. Its code is logged, never its message.
  const legacyTeam = isMissingFunction(teamAccess?.error);
  if (teamAccess?.error && !legacyTeam) {
    logServerEvent({
      evt: 'request_error',
      routeType: 'route',
      method: 'GET',
      errorClass: 'db',
      sqlstate: teamAccess.error.code as LineFor<'request_error'>['sqlstate'],
    });
  }
  for (const result of [items, texts, events, ...(legacyEvents ? [] : [currentEvents])]) {
    if (result?.error) return failed(result.error);
  }
  const teamItems = new Set(
    ((teamAccess?.data ?? []) as Array<{ item_id: string; team: boolean }>)
      .filter((r) => r.team === true)
      .map((r) => r.item_id),
  );

  const itemById = new Map(
    ((items?.data ?? []) as Array<{ id: string; subject: string | null; sent_at: string | null }>).map((i) => [i.id, i]),
  );
  const bodyById = new Map(
    ((texts?.data ?? []) as Array<{ source_item_id: string; body_text: string }>).map((t) => [t.source_item_id, t.body_text]),
  );

  // Only the current events: an older prompt's or model's events never mix in, and an item whose latest answer
  // found nothing shows nothing.
  const currentIds = new Set(((currentEvents?.data ?? []) as Array<{ event_id: string }>).map((r) => r.event_id));
  const allEvents = (events?.data ?? []) as EventRow[];
  const current = legacyEvents ? newestVersionEvents(allEvents) : allEvents.filter((e) => currentIds.has(e.id));

  // One timeline row per milestone and day, naming the caller's own mail as its source when it has one, then team
  // mail they read as a member, then a colleague's.
  const timeline = new Map<string, CandidateMilestone>();
  const standing = (m: { own: boolean; team: boolean }) => (m.own ? (m.team ? 1 : 2) : 0);
  for (const e of [...current].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id))) {
    const key = `${e.type}:${e.occurred_at}`;
    const mine = { own: bodyById.has(e.source_item_id), team: teamItems.has(e.source_item_id) };
    const seen = timeline.get(key);
    if (seen && standing(seen) >= standing(mine)) continue;
    const label = MILESTONE_LABEL[e.type];
    timeline.set(key, {
      id: e.id,
      type: e.type,
      label: label.charAt(0).toUpperCase() + label.slice(1),
      occurredAt: e.occurred_at,
      sourceItemId: e.source_item_id,
      ...mine,
    });
  }

  // The preferred assessment among the rows the caller reads: a team inbox's when one names a step, else the shared one.
  const assessment = preferredAssessment((assessed.data ?? []) as AssessmentRow[]);
  const step = assessment?.step_id ? railStep(assessment.step_id) : undefined;
  const station: CandidateStation | null =
    assessment && assessment.step_id && step
      ? {
          stepId: assessment.step_id,
          station: stepDisplayNumber(assessment.step_id, MVP_DEAL_RAIL) || null,
          total: totalSteps(MVP_DEAL_RAIL),
          title: step.title,
          lifecycle: assessment.lifecycle_suggestion,
          reason: assessment.reason_text,
          confidence: Number(assessment.confidence),
          flags: assessment.flags ?? [],
          asOf: assessment.as_of,
        }
      : null;

  // The evidence is the mail of the events the assessment cited, oldest first.
  const cited = new Set(assessment?.evidence_event_ids ?? []);
  const citedEvents = current
    .filter((e) => cited.has(e.id))
    .sort((a, b) => a.span_start - b.span_start);
  const evidence: CandidateEvidence[] = [];
  for (const itemId of new Set(citedEvents.map((e) => e.source_item_id))) {
    const item = itemById.get(itemId);
    if (!item) continue;
    const body = bodyById.get(itemId);
    const first = citedEvents.find((e) => e.source_item_id === itemId)!;
    evidence.push({
      sourceItemId: itemId,
      subject: item.subject ?? '',
      sentAt: item.sent_at,
      own: body !== undefined,
      team: teamItems.has(itemId),
      excerpt: body === undefined ? null : excerptAround(body, first.span_start, first.span_end),
    });
  }
  evidence.sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? '') || a.sourceItemId.localeCompare(b.sourceItemId));

  const linkItems: CandidateItem[] = liveLinks
    .flatMap((link) => {
      const item = itemById.get(link.source_item_id);
      if (!link.id || !item) return [];
      return [
        {
          linkId: link.id,
          sourceItemId: link.source_item_id,
          subject: item.subject ?? '',
          sentAt: item.sent_at,
          own: bodyById.has(link.source_item_id),
        },
      ];
    })
    .sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? '') || a.linkId.localeCompare(b.linkId));

  return {
    ok: true,
    detail: {
      id: row.id,
      name: row.proposed_name,
      codename: row.codename_guess,
      parties: partiesFrom(row.parties),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      evidenceCount: itemIds.length,
      ownEvidenceCount: (own.data as { source_item_count: number } | null)?.source_item_count ?? 0,
      state: row.discovery_state,
      station,
      milestones: [...timeline.values()],
      evidence,
      items: linkItems,
      decisions,
      override,
      canAct,
      canResolve,
      mergedInto,
      origin: origin.origin,
      modelProposal: proposal.proposal,
    },
  };
}

// ── Corrections (phase 7) ────────────────────────────────────────────────────
// Each wrapper calls one definer RPC with the caller's own client. The RPC takes
// the actor from auth.uid() and checks tenant, visibility and deal-create
// authority itself; the zone rule keeps every RPC name in this file.

export type CorrectionResult = { ok: true; correctionId: string } | { ok: false; code?: string; message?: string };

async function correct(
  call: PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>,
): Promise<CorrectionResult> {
  const { data, error } = await call;
  if (error) return { ok: false, code: error.code, message: error.message };
  return { ok: true, correctionId: String(data) };
}

export function renameCandidate(db: SupabaseClient, candidateId: string, name: string, reason?: string | null) {
  return correct(
    db.rpc('discovery_rename_candidate', { p_candidate: candidateId, p_name: name, p_reason: reason ?? null }),
  );
}

export function rejectCandidate(db: SupabaseClient, candidateId: string, reason: string) {
  return correct(db.rpc('discovery_reject_candidate', { p_candidate: candidateId, p_reason: reason }));
}

export function setStation(db: SupabaseClient, candidateId: string, stepId: string, reason: string) {
  return correct(
    db.rpc('discovery_set_station', { p_candidate: candidateId, p_step_id: stepId, p_reason: reason }),
  );
}

export function mergeCandidates(db: SupabaseClient, mergedId: string, survivorId: string, reason: string) {
  return correct(
    db.rpc('discovery_merge_candidates', { p_merged: mergedId, p_survivor: survivorId, p_reason: reason }),
  );
}

/** Split: the chosen emails move to a new proposed deal. The RPC leaves at least one email behind. */
export function splitCandidate(db: SupabaseClient, candidateId: string, itemIds: string[], name: string, reason: string) {
  return correct(
    db.rpc('discovery_split_candidate', {
      p_candidate: candidateId,
      p_source_item_ids: itemIds,
      p_name: name,
      p_reason: reason,
    }),
  );
}

/**
 * Reassign: one email's link moves to another proposed deal. The RPC finds the
 * source from the link, so the path's candidate is checked here, under RLS: a
 * link that is not this candidate's is simply not found.
 */
export async function reassignLink(
  db: SupabaseClient,
  candidateId: string,
  linkId: string,
  targetCandidateId: string,
  reason: string,
): Promise<CorrectionResult> {
  const { data, error } = await db.from(TABLE.EVIDENCE_LINKS).select('candidate_id').eq('id', linkId).maybeSingle();
  if (error) return { ok: false, code: error.code, message: error.message };
  if (!data || (data as { candidate_id: string | null }).candidate_id !== candidateId) return { ok: false, code: 'P0002' };
  return correct(
    db.rpc('discovery_reassign_link', { p_link: linkId, p_target_candidate: targetCandidateId, p_reason: reason }),
  );
}

/**
 * One error map for the correction routes: a SQLSTATE in, a status and a message
 * out. The RPC's own message is read only to tell the few refusals that share a
 * SQLSTATE apart; it is never returned.
 */
export function correctionErrorStatus(code?: string, message?: string): { status: number; error: string } {
  if (code === '42501' && message === 'owner_not_seated') {
    return { status: 403, error: "Only the deal team's own mail can join this deal" };
  }
  if (code === '22023') {
    if (message === 'nothing_left') return { status: 400, error: 'Leave at least one email on this proposed deal' };
    if (message === 'not_visible_result') {
      return { status: 400, error: 'Choose emails you can open, so the new proposed deal is yours to see' };
    }
    if (message === 'link_not_live') return { status: 409, error: 'One of these emails has already moved' };
  }
  switch (code) {
    case '42501': return { status: 403, error: 'Needs deal-create authority' };
    case 'P0002': return { status: 404, error: 'Proposed deal not found' };
    case '55000': return { status: 409, error: 'This proposed deal can no longer be changed' };
    case '55P03': return { status: 409, error: 'Discovery is updating this deal. Try again in a moment.' };
    case '22023': return { status: 400, error: 'Check the fields and try again' };
    default:      return { status: 500, error: 'The change could not be saved' };
  }
}

// ── The rail's evidence marker (phase 9) ─────────────────────────────────────
// Reads and the one write the rail marker needs. The deal is found by its code
// under RLS, so a caller who is not seated on it (or an overseer of it) gets
// nothing; the assessments and the dismissal are read under the deal-scoped
// branches of 20261002220000.

/** The deal id for a code, as far as RLS lets the caller read the deal. */
export async function findDealIdByCode(
  db: SupabaseClient,
  dealCode: string,
): Promise<{ ok: true; dealId: string | null } | { ok: false; error: string }> {
  const { data, error } = await db.from(TABLE.DEALS).select('id').eq('code', dealCode).maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, dealId: (data as { id: string } | null)?.id ?? null };
}

/**
 * The preferred stage assessment of a promoted deal (preferredAssessment.ts), for
 * the rail marker: the step the evidence suggests, the reason, how many emails
 * stand behind it, and whether the MD dismissed this very assessment. Null when
 * the deal has none or the caller cannot read it. The evidence count is the
 * emails the caller can see among the cited events, else the number of events cited.
 */
export async function getEvidenceSuggestion(
  db: SupabaseClient,
  dealCode: string,
): Promise<{ ok: true; suggestion: EvidenceSuggestion | null; origin: Origin } | { ok: false; error: string }> {
  const deal = await findDealIdByCode(db, dealCode);
  if (!deal.ok) return deal;
  // A deal the caller cannot read answers like one that does not exist: no suggestion, and the ordinary origin.
  if (!deal.dealId) return { ok: true, suggestion: null, origin: 'rules' };

  const origin = await dealOrigin(db, deal.dealId);
  if (!origin.ok) return origin;

  const assessed = await readAssessments<{ id: string }>(
    db,
    'id, step_id, team_mailbox_id, reason_text, evidence_event_ids, flags, as_of',
    { dealId: deal.dealId },
  );
  if (assessed.error) return { ok: false, error: assessed.error.message };
  const row = preferredAssessment(
    (assessed.data ?? []) as Array<{
      id: string;
      step_id: string | null;
      team_mailbox_id?: string | null;
      reason_text: string;
      evidence_event_ids: string[];
      flags: string[];
      as_of: string;
    }>,
  );
  if (!row || !row.step_id) return { ok: true, suggestion: null, origin: origin.origin };

  const cited = row.evidence_event_ids ?? [];
  const [dismissals, events] = await Promise.all([
    db
      .from(TABLE.CORRECTIONS)
      .select('id')
      .eq('deal_id', deal.dealId)
      .eq('action', 'dismiss_suggestion')
      .contains('after', { assessmentId: row.id })
      .limit(1),
    cited.length
      ? db.from(TABLE.MILESTONE_EVENTS).select('source_item_id').in('id', cited)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (dismissals.error) return { ok: false, error: dismissals.error.message };
  if (events.error) return { ok: false, error: events.error.message };
  const seen = new Set(((events.data ?? []) as Array<{ source_item_id: string }>).map((e) => e.source_item_id));

  return {
    ok: true,
    origin: origin.origin,
    suggestion: {
      assessmentId: row.id,
      stepId: row.step_id,
      reason: row.reason_text,
      evidenceCount: seen.size > 0 ? seen.size : cited.length,
      asOf: row.as_of,
      dismissed: (dismissals.data ?? []).length > 0,
      flags: row.flags ?? [],
    },
  };
}

/** The MD dismisses an assessment's marker, with a reason. The RPC refuses anyone who is not the deal's MD. */
export function dismissSuggestion(db: SupabaseClient, dealId: string, assessmentId: string, reason: string) {
  return correct(
    db.rpc('discovery_dismiss_suggestion', { p_deal_id: dealId, p_assessment_id: assessmentId, p_reason: reason }),
  );
}

export function dismissErrorStatus(code?: string): { status: number; error: string } {
  switch (code) {
    case '42501': return { status: 403, error: 'Only the deal MD can dismiss this suggestion' };
    case 'P0002': return { status: 404, error: 'Suggestion not found' };
    case '55P03': return { status: 409, error: 'Discovery is updating this deal. Try again in a moment.' };
    case '22023': return { status: 400, error: 'Give a reason to dismiss' };
    default:      return { status: 500, error: 'The suggestion could not be dismissed' };
  }
}

// ── Model proposal dismissal (G-02a, #173; demo only like the proposals, #460) ─
// The source owner hides the proposal rows of one deal key that exist now. The
// RPC acts on auth.uid(), takes the tenant's discovery lock, and answers P0002 to
// anyone who is not the owner of a personal source holding a live row of the key.
// The key is a slug of a mail-derived name: it is passed to the RPC and nowhere
// else, and only the SQLSTATE of a refusal comes back from here.

export type ModelProposalDismissResult =
  | { ok: true; dismissed: number; operationId: string | null }
  | { ok: false; code?: string };

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Dismiss the caller's proposal rows of `dealKey`. `dismissed` is 0, and `operationId` null, when every row was
 * already dismissed; otherwise `operationId` is the content-free reference the owner quotes to ask for a restore.
 */
export async function dismissModelProposal(db: SupabaseClient, dealKey: string): Promise<ModelProposalDismissResult> {
  const { data, error } = await db.rpc('discovery_dismiss_model_proposal', { p_deal_key: dealKey });
  if (error) return { ok: false, code: error.code };
  const answer = (data ?? {}) as { dismissed?: unknown; operationId?: unknown };
  const dismissed = Number(answer.dismissed ?? 0);
  const operationId = typeof answer.operationId === 'string' && UUID_RX.test(answer.operationId) ? answer.operationId : null;
  return { ok: true, dismissed: Number.isInteger(dismissed) && dismissed > 0 ? dismissed : 0, operationId };
}

/** The dismiss route's error map: fixed texts only, never the database's message or the key. */
export function modelProposalDismissErrorStatus(code?: string): { status: number; error: string } {
  switch (code) {
    case 'P0002': return { status: 404, error: 'Proposal not found' };
    case '55P03': return { status: 409, error: 'Try again in a moment' };
    case '42501': return { status: 401, error: 'Unauthorized' };
    case '22023': return { status: 400, error: 'Check the fields and try again' };
    default:      return { status: 500, error: 'Could not dismiss the proposal' };
  }
}

// ── Model proposal accept (G-02b, #173; demo only like the proposals, #460) ──
// The source owner asks for an `m:` deal's emails to be read again through the guard and kept as evidence of a
// proposed deal with no station. The RPC (discovery_accept_model_proposal) acts on auth.uid() under the tenant lock
// and only records the request: the source's SYNC job does the reading. The key is a slug of a mail-derived name: it
// is passed to the RPC and nowhere else, and only the SQLSTATE of a refusal comes back from here.

export type ModelProposalAcceptResult =
  | { ok: true; operationId: string; requestCount: number }
  | { ok: false; code?: string };

/**
 * Ask for the accept of `dealKey` with the station the model proposed (`proposedStepId`, which must belong to the
 * highest phase of the live rows). `requestCount` is the requests recorded now: 0, with the same `operationId`, when
 * every source already had one live (a repeat, a second tab).
 */
export async function acceptModelProposal(
  db: SupabaseClient,
  dealKey: string,
  proposedStepId: string,
): Promise<ModelProposalAcceptResult> {
  const { data, error } = await db.rpc('discovery_accept_model_proposal', {
    p_deal_key: dealKey,
    p_proposed_step_id: proposedStepId,
  });
  if (error) {
    // A well-formed step that is no longer the group's canonical station: the proposal changed since the list was read
    // (its highest phase moved). The RPC's message is a fixed word, never the key, so it is safe to branch on.
    if (error.code === '22023' && error.message === 'invalid_proposed_step') return { ok: false, code: 'proposal_changed' };
    return { ok: false, code: error.code };
  }
  const answer = (Array.isArray(data) ? data[0] : data) as { operation_id?: unknown; request_count?: unknown } | null;
  const operationId = answer?.operation_id;
  if (typeof operationId !== 'string' || !UUID_RX.test(operationId)) return { ok: false };
  const count = Number(answer?.request_count ?? 0);
  return { ok: true, operationId, requestCount: Number.isInteger(count) && count > 0 ? count : 0 };
}

/**
 * The accept route's error map: fixed texts only, never the database's message or the key. 55000 (the deal this
 * proposal became is no longer open) is the one refusal that also carries a `code`, so a client can tell it from the
 * other 409, the lock timeout. `proposal_changed` (the station the list showed is no longer the group's, because the
 * proposal moved phase) is a 409 with its own code too, so the dialog can say so and refresh the list.
 */
export function modelProposalAcceptErrorStatus(code?: string): { status: number; error: string; code?: string } {
  switch (code) {
    case 'P0002': return { status: 404, error: 'Proposal not found' };
    case '55P03': return { status: 409, error: 'Try again in a moment' };
    case '55000': return { status: 409, error: 'This proposal can no longer be accepted', code: 'candidate_closed' };
    case 'proposal_changed': return { status: 409, error: 'This proposal changed. Review it again.', code: 'proposal_changed' };
    case '42501': return { status: 403, error: 'Needs deal-create authority' };
    case '22023': return { status: 400, error: 'Check the fields and try again' };
    default:      return { status: 500, error: 'Could not accept the proposal' };
  }
}

// ── Deal email (the Deal Folder's read-only view of linked mail) ─────────────
// The messages discovery linked to a promoted deal, as the caller may read them.
// Every read is RLS on the caller's own client: the deal is found under
// deals_select, the candidates, links and items under their discovery policies,
// and "own" is the presence of the caller's source_item_texts row. Redaction is
// done here, on the server, so a colleague's subject and sender never leave it.

/** One linked message. subject and sender are null unless the caller's own mailbox holds the message. */
export interface DealEmailItem {
  sourceItemId: string;
  /** 'YYYY-MM-DD', the day only. */
  sentDay: string | null;
  fromDomain: string | null;
  /** Own mail only: the sender's display name, else the address. */
  sender: string | null;
  /** Own mail only. */
  subject: string | null;
  /** RLS returned a source_item_texts row for the caller (only the id is selected, never the body). */
  own: boolean;
  /**
   * The caller's own connected mailbox holds it, so its thread opens (readDealThread). False for a colleague's
   * message and for a team inbox item the caller reads as a member (PR #614): those show, but do not open.
   */
  opensThread: boolean;
}

/** The most messages one response carries. */
export const DEAL_EMAIL_LIMIT = 200;

/** Ids per `in (...)` read, so a deal with a long mail history stays inside the request-line limit. */
const DEAL_EMAIL_ID_BATCH = 100;

/** Evidence links per page; below PostgREST's max_rows (1000), so a short page means the last one. */
const DEAL_EMAIL_LINK_PAGE = 500;

/**
 * Which of `ids` came from the caller's own connected mailbox, with its address (discovery_own_mailbox_items,
 * 20261021141000). A team inbox item the caller reads as a member (PR #614) is owned but never in it.
 */
async function ownMailboxItems(
  db: SupabaseClient,
  ids: string[],
): Promise<{ ok: true; addressOf: Map<string, string> } | { ok: false }> {
  const addressOf = new Map<string, string>();
  for (let i = 0; i < ids.length; i += DEAL_EMAIL_ID_BATCH) {
    const mine = await db.rpc('discovery_own_mailbox_items', { p_items: ids.slice(i, i + DEAL_EMAIL_ID_BATCH) });
    if (mine.error) return { ok: false };
    for (const row of (mine.data ?? []) as Array<{ id: string; mailbox_address: string }>) {
      addressOf.set(row.id, row.mailbox_address);
    }
  }
  return { ok: true, addressOf };
}

/** A discovery_item_metadata row: subject and participants are null unless the caller owns the item. */
type DealEmailItemRow = {
  id: string;
  kind: string;
  sent_at: string | null;
  own: boolean;
  subject: string | null;
  participants: unknown;
  sender_domain: string | null;
};

function fromParticipant(participants: unknown): { address: string; name: string | null } | null {
  if (!Array.isArray(participants)) return null;
  for (const entry of participants) {
    if (!entry || typeof entry !== 'object') continue;
    const { role, address, name } = entry as Record<string, unknown>;
    if (role !== 'from' || typeof address !== 'string' || !address) continue;
    return { address, name: typeof name === 'string' && name.trim() ? name.trim() : null };
  }
  return null;
}

/**
 * The source items linked to a deal: the non-rejected evidence of every candidate promoted to it, read under the
 * caller's RLS. Paged: PostgREST caps one response at max_rows (1000), and the links come back in no date order,
 * so an unpaged read could silently drop the newest mail of a deal with a long history. By key, not by offset:
 * RLS judges every row an offset skips, so offset pages cost the sum of their ends (~7,000 policy checks for
 * 2,000 links, #581); after the last id, each row is judged once.
 */
async function dealLinkedItemIds(db: SupabaseClient, dealId: string): Promise<{ ok: true; ids: Set<string> } | { ok: false }> {
  const linked = new Set<string>();
  const candidates = await db.from(TABLE.DEAL_CANDIDATES).select('id').eq('promoted_deal_id', dealId);
  if (candidates.error) return { ok: false };
  const candidateIds = ((candidates.data ?? []) as Array<{ id: string }>).map((row) => row.id);
  if (candidateIds.length === 0) return { ok: true, ids: linked };

  for (let after: string | null = null; ; ) {
    let query = db
      .from(TABLE.EVIDENCE_LINKS)
      .select('id, source_item_id')
      .in('candidate_id', candidateIds)
      .neq('state', 'rejected');
    if (after !== null) query = query.gt('id', after);
    const links = await query.order('id').limit(DEAL_EMAIL_LINK_PAGE);
    if (links.error) return { ok: false };
    const page = (links.data ?? []) as Array<{ id: string; source_item_id: string }>;
    for (const row of page) linked.add(row.source_item_id);
    if (page.length < DEAL_EMAIL_LINK_PAGE) break;
    after = page[page.length - 1].id;
  }
  return { ok: true, ids: linked };
}

/**
 * The linked email of a deal, newest first, capped at DEAL_EMAIL_LIMIT. The deal
 * is found by its code under RLS, so an unknown deal and a deal the caller is not
 * seated on both answer an empty list (no existence oracle). Linked means the
 * non-rejected evidence of every candidate promoted to the deal. Site documents
 * share source_items and are not email, so only messages are read.
 */
export async function listDealEmail(
  db: SupabaseClient,
  dealCode: string,
): Promise<{ ok: true; items: DealEmailItem[]; truncated: boolean } | { ok: false }> {
  const empty = { ok: true as const, items: [], truncated: false };
  const deal = await findDealIdByCode(db, dealCode);
  if (!deal.ok) return { ok: false };
  if (!deal.dealId) return empty;

  const linked = await dealLinkedItemIds(db, deal.dealId);
  if (!linked.ok) return { ok: false };
  const itemIds = [...linked.ids];
  if (itemIds.length === 0) return empty;

  // Subject and participants are owner-only in the database (20261017100000): the definer answers them
  // for the caller's own items and null for a colleague's, with the sender's domain for every row the
  // source_items policy admits. Its `own` is app_owns_item, the predicate source_item_texts reads by.
  const rows: DealEmailItemRow[] = [];
  for (let i = 0; i < itemIds.length; i += DEAL_EMAIL_ID_BATCH) {
    const items = await db.rpc('discovery_item_metadata', { p_items: itemIds.slice(i, i + DEAL_EMAIL_ID_BATCH) });
    if (items.error) return { ok: false };
    rows.push(...((items.data ?? []) as DealEmailItemRow[]).filter((row) => row.kind === SOURCE_ITEM_KIND.MESSAGE));
  }

  // Newest first, undated last, then by id so the order is stable; the cap is applied after the merge.
  rows.sort(
    (a, b) =>
      (a.sent_at === null ? 1 : 0) - (b.sent_at === null ? 1 : 0) ||
      (b.sent_at ?? '').localeCompare(a.sent_at ?? '') ||
      a.id.localeCompare(b.id),
  );
  const truncated = rows.length > DEAL_EMAIL_LIMIT;
  const shown = rows.slice(0, DEAL_EMAIL_LIMIT);
  const mailbox = await ownMailboxItems(
    db,
    shown.filter((row) => row.own === true).map((row) => row.id),
  );
  if (!mailbox.ok) return { ok: false };

  return {
    ok: true,
    truncated,
    items: shown.map((row) => {
      const own = row.own === true;
      const from = own ? fromParticipant(row.participants) : null;
      return {
        sourceItemId: row.id,
        sentDay: row.sent_at ? row.sent_at.slice(0, 10) : null,
        fromDomain: row.sender_domain ?? null,
        sender: own && from ? (from.name ?? from.address) : null,
        subject: own ? (row.subject ?? '') : null,
        own,
        opensThread: own && mailbox.addressOf.has(row.id),
      };
    }),
  };
}

// ── Deal thread (#339): read a linked conversation from the caller's own mailbox ──
// The thread is the deal-linked messages that share the opened message's
// conversation_id (the RFC 5322 References root, src/lib/google/reader/thread.ts)
// and that the caller owns. Every read is RLS on the caller's own client: the
// subject and participants through discovery_item_metadata (null unless own),
// the body through source_item_texts (app_owns_item). A colleague's message in
// the same conversation is left out, so nothing here is wider than the list.
// The stored body is the top of each message with quoted history dropped, which
// is what a thread view wants. Mail the #263 policy excluded was never stored.

/** One address on a thread message. */
export interface DealThreadAddress {
  address: string;
  name: string | null;
}

/** One message of a deal thread, oldest first. Only the caller's own messages appear. */
export interface DealThreadMessage {
  sourceItemId: string;
  /** ISO timestamp, or null when the message carried no usable date. */
  sentAt: string | null;
  from: DealThreadAddress | null;
  to: DealThreadAddress[];
  cc: DealThreadAddress[];
  subject: string;
  /** The top of the message, quoted history dropped (source_item_texts.body_text). */
  body: string;
  /** The RFC 5322 Message-ID, for a reply's In-Reply-To and References. */
  internetMessageId: string | null;
  /** The sender is the caller (one of selfAddresses): a reply goes to this message's recipients instead. */
  fromSelf: boolean;
}

export interface DealThread {
  /** The References root a reply carries first, or null when the message stands alone. */
  conversationId: string | null;
  messages: DealThreadMessage[];
}

/** The most messages one thread response carries; a longer thread keeps its newest. */
export const DEAL_THREAD_LIMIT = 50;

type ThreadItemRow = { id: string; conversation_id: string | null; internet_message_id: string | null };

/** source_items rows per conversation page; below PostgREST's max_rows (1000), so a short page means the last one. */
const DEAL_THREAD_PAGE = 500;

function addressesOf(participants: unknown, role: 'to' | 'cc'): DealThreadAddress[] {
  if (!Array.isArray(participants)) return [];
  const out: DealThreadAddress[] = [];
  for (const entry of participants) {
    if (!entry || typeof entry !== 'object') continue;
    const { role: r, address, name } = entry as Record<string, unknown>;
    if (r !== role || typeof address !== 'string' || !address) continue;
    out.push({ address, name: typeof name === 'string' && name.trim() ? name.trim() : null });
  }
  return out;
}

/**
 * The thread a deal-linked message belongs to, from the caller's own mailbox. Null when the deal is unknown or
 * unseen, the message is not linked to it, or the caller does not own the message: the three answer alike, so the
 * route cannot be used to learn which messages exist.
 */
export async function readDealThread(
  db: SupabaseClient,
  dealCode: string,
  sourceItemId: string,
  selfAddresses: string[] = [],
): Promise<{ ok: true; thread: DealThread | null; participants?: string[] } | { ok: false }> {
  const none = { ok: true as const, thread: null };
  const deal = await findDealIdByCode(db, dealCode);
  if (!deal.ok) return { ok: false };
  if (!deal.dealId) return none;

  const linked = await dealLinkedItemIds(db, deal.dealId);
  if (!linked.ok) return { ok: false };
  if (!linked.ids.has(sourceItemId)) return none;

  const opened = await db
    .from(TABLE.SOURCE_ITEMS)
    .select('id, conversation_id, internet_message_id')
    .eq('id', sourceItemId)
    .maybeSingle();
  if (opened.error) return { ok: false };
  const openedRow = opened.data as ThreadItemRow | null;
  if (!openedRow) return none;

  // The conversation's other messages, kept only where they are linked to this deal too.
  let members: ThreadItemRow[] = [openedRow];
  if (openedRow.conversation_id) {
    // Paged: a widely copied conversation can hold more rows the caller may see than one response carries.
    const same: ThreadItemRow[] = [];
    for (let from = 0; ; from += DEAL_THREAD_PAGE) {
      const page = await db
        .from(TABLE.SOURCE_ITEMS)
        .select('id, conversation_id, internet_message_id')
        .eq('conversation_id', openedRow.conversation_id)
        .order('id')
        .range(from, from + DEAL_THREAD_PAGE - 1);
      if (page.error) return { ok: false };
      const rows = (page.data ?? []) as ThreadItemRow[];
      same.push(...rows);
      if (rows.length < DEAL_THREAD_PAGE) break;
    }
    members = same.filter((row) => linked.ids.has(row.id));
    if (!members.some((row) => row.id === sourceItemId)) members.push(openedRow);
  }

  const metadata: DealEmailItemRow[] = [];
  const memberIds = members.map((row) => row.id);
  for (let i = 0; i < memberIds.length; i += DEAL_EMAIL_ID_BATCH) {
    const items = await db.rpc('discovery_item_metadata', { p_items: memberIds.slice(i, i + DEAL_EMAIL_ID_BATCH) });
    if (items.error) return { ok: false };
    metadata.push(...((items.data ?? []) as DealEmailItemRow[]));
  }
  const owned = metadata.filter((row) => row.own === true && row.kind === SOURCE_ITEM_KIND.MESSAGE);
  if (!owned.some((row) => row.id === sourceItemId)) return none;

  // Only mail from the caller's own connected mailbox. A team inbox member owns the team's items too (PR #614), but a
  // reply from a personal address into a team conversation needs its own decision (Martín's review of PR #650, N2),
  // so team items stay out of the thread and its reply. The mailbox address also marks the caller's own sends, where
  // it differs from the sign-in address (an alias).
  const mailbox = await ownMailboxItems(
    db,
    owned.map((row) => row.id),
  );
  if (!mailbox.ok) return { ok: false };
  const mailboxOf = mailbox.addressOf;
  const own = owned.filter((row) => mailboxOf.has(row.id));
  if (!own.some((row) => row.id === sourceItemId)) return none;
  const self = new Set([...selfAddresses, ...mailboxOf.values()].map((a) => a.trim().toLowerCase()).filter(Boolean));

  // The people a reply may address and still thread: everyone on any of the caller's own messages of the
  // conversation (not only the newest shown, nor only those with a stored body), and the caller's own addresses,
  // so a self-copy keeps the threading. Capped at MAX_REPLY_PARTICIPANTS; anyone past it counts as outside, and
  // the reply then goes out unthreaded, which is the safe side.
  const everyone = new Set(self);
  for (const row of own) {
    for (const a of [fromParticipant(row.participants), ...addressesOf(row.participants, 'to'), ...addressesOf(row.participants, 'cc')]) {
      const address = a?.address.trim().toLowerCase();
      if (address) everyone.add(address);
    }
  }
  const participants = [...everyone].slice(0, MAX_REPLY_PARTICIPANTS);

  // Oldest first, an undated message counted as the oldest, so it never stands as the newest a reply answers;
  // the newest DEAL_THREAD_LIMIT are kept.
  own.sort(
    (a, b) =>
      (a.sent_at === null ? 0 : 1) - (b.sent_at === null ? 0 : 1) ||
      (a.sent_at ?? '').localeCompare(b.sent_at ?? '') ||
      a.id.localeCompare(b.id),
  );
  const shown = own.slice(-DEAL_THREAD_LIMIT);

  const texts = await db
    .from(TABLE.SOURCE_ITEM_TEXTS)
    .select('source_item_id, body_text')
    .in(
      'source_item_id',
      shown.map((row) => row.id),
    );
  if (texts.error) return { ok: false };
  const bodyOf = new Map(
    ((texts.data ?? []) as Array<{ source_item_id: string; body_text: string }>).map((t) => [t.source_item_id, t.body_text]),
  );
  // A message whose body was never stored (extraction pending or failed) cannot be shown: opening it finds nothing.
  if (!bodyOf.has(sourceItemId) && shown.some((row) => row.id === sourceItemId)) return none;
  const messageIdOf = new Map(members.map((row) => [row.id, row.internet_message_id]));

  return {
    ok: true,
    participants,
    thread: {
      conversationId: openedRow.conversation_id,
      messages: shown
        // RLS answers a body for owned items only; a row without one is not shown rather than shown empty.
        .filter((row) => bodyOf.has(row.id))
        .map((row) => ({
          sourceItemId: row.id,
          sentAt: row.sent_at,
          from: fromParticipant(row.participants),
          to: addressesOf(row.participants, 'to'),
          cc: addressesOf(row.participants, 'cc'),
          subject: row.subject ?? '',
          body: bodyOf.get(row.id) ?? '',
          internetMessageId: messageIdOf.get(row.id) ?? null,
          fromSelf: self.has(fromParticipant(row.participants)?.address.toLowerCase() ?? ''),
        })),
    },
  };
}

/** The most message ids a reply's References carries; a longer chain keeps its root and its newest. */
export const MAX_REPLY_REFERENCES = 50;

/**
 * The threading headers of a reply to the newest message of a thread, built on the server from the thread the
 * caller may read (never from caller-supplied text). References starts at the conversation's root, as RFC 5322
 * section 3.6.4 asks, even when the root message is not one the caller holds; the root is the reader's lowercased
 * References root, which threads by id where the original was lowercase and is otherwise ignored. Null when the
 * newest message has no usable Message-ID: the reply then goes out as a new message.
 */
export function replyThreading(thread: DealThread): { inReplyTo: string; references: string[] } | null {
  const last = thread.messages.at(-1);
  if (!last?.internetMessageId || !MESSAGE_ID_RX.test(last.internetMessageId)) return null;
  const ids = [
    ...new Set(thread.messages.map((m) => m.internetMessageId).filter((id): id is string => !!id && MESSAGE_ID_RX.test(id))),
  ];
  const root = thread.conversationId?.startsWith('rfc822:') ? thread.conversationId.slice('rfc822:'.length) : null;
  const chain =
    root && MESSAGE_ID_RX.test(root) && !ids.some((id) => id.toLowerCase() === root) ? [root, ...ids] : ids;
  const references =
    chain.length > MAX_REPLY_REFERENCES ? [chain[0], ...chain.slice(-(MAX_REPLY_REFERENCES - 1))] : chain;
  return { inReplyTo: last.internetMessageId, references };
}

// ── Gmail status and admin pause/resume (#259, phase 4) ──────────────────────
// Opting in is #262's mailbox_consent_grant (the "Connect my mailbox" button); it
// creates the Google source. These two functions run one security definer RPC
// each under the caller's session. The RPC acts on auth.uid(), so nothing here
// widens access, and no reply carries mail or message text: an address, a group
// name, a domain and two flags. The /profile card declares the same wire shape
// locally: it may import nothing from src/lib/discovery (tests/agent-surfaces.test.ts).

/** discovery_google_mailbox_status(): the caller's own Google mailbox source, after opt-in. */
export type GoogleMailboxStatus =
  | { connected: false }
  | {
      connected: true;
      address: string;
      /** The bank-owned ingest group the member must be in, and its Workspace domain. */
      group: string | null;
      domain: string | null;
      /** A firm admin paused the source. */
      paused: boolean;
      /** The guard last refused this address because the member is not in the ingest group. */
      waitingForGroup: boolean;
      /**
       * First-sync status of the caller's own source (#341): its ingestion health state, when the first full read
       * finished, the last successful sync, and whether Google refused the delegation. Null (or false) when an older
       * database omits them.
       */
      state: SourceHealthState | null;
      backfillCompletedAt: string | null;
      lastSyncedAt: string | null;
      delegationRefused: boolean;
    };

type RpcError = { code?: string; message: string };

/** The exact 42501 code and message pair the RPCs raise; anything else is not that refusal. */
function refusedWith(error: RpcError, message: string): boolean {
  return error.code === '42501' && error.message === message;
}

export async function readGoogleMailboxStatus(
  db: SupabaseClient,
): Promise<{ ok: true; status: GoogleMailboxStatus } | { ok: false }> {
  const { data, error } = await db.rpc('discovery_google_mailbox_status');
  if (error || !data) return { ok: false };
  const raw = data as Record<string, unknown>;
  if (raw.connected !== true) return { ok: true, status: { connected: false } };
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    ok: true,
    status: {
      connected: true,
      address: typeof raw.address === 'string' ? raw.address : '',
      group: text(raw.group),
      domain: text(raw.domain),
      paused: raw.paused === true,
      waitingForGroup: raw.waitingForGroup === true,
      state: SOURCE_HEALTH_STATES.includes(raw.state as SourceHealthState) ? (raw.state as SourceHealthState) : null,
      backfillCompletedAt: text(raw.backfillCompletedAt),
      lastSyncedAt: text(raw.lastSyncedAt),
      delegationRefused: raw.delegationRefused === true,
    },
  };
}

export type MailboxSourceStatusResult =
  | { ok: true; id: string; status: 'active' | 'paused'; changed: boolean }
  | { ok: false; reason: 'not_available' | 'invalid' | 'error' };

/** A firm admin pauses or resumes a Google mailbox source. Pausing never deletes; an archived source is refused. */
export async function setMailboxSourceStatus(
  db: SupabaseClient,
  sourceId: string,
  status: 'active' | 'paused',
): Promise<MailboxSourceStatusResult> {
  const { data, error } = await db.rpc('discovery_set_mailbox_source_status', {
    p_source_id: sourceId,
    p_status: status,
  });
  if (error) {
    if (refusedWith(error, 'not_available')) return { ok: false, reason: 'not_available' };
    if (error.code === '22023') return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'error' };
  }
  return { ok: true, ...(data as { id: string; status: 'active' | 'paused'; changed: boolean }) };
}

export type RestartMailboxSourceResult = { ok: true; id: string } | { ok: false; reason: 'not_available' | 'error' };

/** A firm admin restarts a halted mailbox source: the next tick reads it again from the start. */
export async function restartMailboxSource(db: SupabaseClient, sourceId: string): Promise<RestartMailboxSourceResult> {
  const { data, error } = await db.rpc('discovery_restart_mailbox_source', { p_source_id: sourceId });
  if (error) return { ok: false, reason: refusedWith(error, 'not_available') ? 'not_available' : 'error' };
  return { ok: true, id: (data as { id: string }).id };
}

// ── Team inboxes (#581, phase 3) ─────────────────────────────────────────────
// A firm admin registers a shared mailbox (deals@) for discovery. Each function runs one security
// definer RPC under the caller's session; the RPC acts on auth.uid() and answers 42501 to anyone who is
// not the firm's admin. Nothing here carries mail: an address, ids, a check state and a window.

/** What connecting returns, and the part of a list entry that does not change between reads. */
export type TeamMailboxRegistration = {
  id: string;
  /** The inbox address, lower-cased. */
  address: string;
  provider: 'google';
  connectedAt: string;
  /** The Google Directory check: pending until the worker's first check, then verified or refused. */
  checkStatus: TeamMailboxCheckStatus;
  /** Why a refused check refused; null unless refused. */
  checkReason: TeamMailboxCheckReason | null;
  checkedAt: string | null;
  /** The one source the registration owns, and the day its first read starts from. */
  sourceId: string | null;
  backfillSince: string | null;
};

/** A colleague a firm admin can let read a team inbox: an active, internal, seated person who is not a firm admin. */
export type TeamMailboxPerson = {
  userId: string;
  name: string;
  email: string;
};

/** A person the admin has let read the inbox. */
export type TeamMailboxMember = TeamMailboxPerson & {
  addedAt: string;
};

/** One entry of discovery_team_mailboxes(): the registration plus the state the admin card shows. */
export type TeamMailbox = TeamMailboxRegistration & {
  /** A transient failure of the latest check; never changes checkStatus. */
  lastCheckError: TeamMailboxCheckError | null;
  /** The source's status, `paused` when an admin paused it. */
  sourceStatus: SourceStatus | null;
  /** Its source holds no mail, verified or not: Remove is open. */
  removable: boolean;
  /**
   * Why the worker's last read was refused (a MAILBOX_REFUSAL_REASON code), or null once a read is allowed. The card
   * names not_in_provider_group: a Ready inbox that is not a direct member of the ingest group is never read.
   */
  readRefusal?: string | null;
  /** The open members, oldest first. A member promoted to admin since stays listed until removed. */
  members: TeamMailboxMember[];
  /** Everyone who could be a member of this inbox, members included: the card offers `eligible` minus `members`. */
  eligible: TeamMailboxPerson[];
};

export type ConnectTeamMailboxInput = {
  address: string;
  attestationVersion: number;
  /** First-read window, `YYYY-MM-DD`, within the last 730 days. The default is the ingestion window's. */
  backfillSince?: string | null;
};

/** The refusals connect names, each with its HTTP status in the route. Anything else is `error`. */
export type ConnectTeamMailboxFailure =
  | 'not_eligible'
  | 'discovery_disabled'
  | 'person_address'
  | 'provider_unresolved'
  | 'provider_unsupported'
  | 'out_of_range'
  | 'invalid_address'
  | 'attestation_required'
  | 'error';

export type ConnectTeamMailboxResult =
  | { ok: true; created: boolean; teamMailbox: TeamMailboxRegistration }
  | { ok: false; reason: ConnectTeamMailboxFailure };

const CONNECT_REFUSALS: Record<string, { code: string; reason: ConnectTeamMailboxFailure }> = {
  not_eligible: { code: '42501', reason: 'not_eligible' },
  discovery_disabled: { code: 'P0001', reason: 'discovery_disabled' },
  person_address: { code: '23505', reason: 'person_address' },
  provider_unresolved: { code: '22023', reason: 'provider_unresolved' },
  provider_unsupported: { code: '22023', reason: 'provider_unsupported' },
  out_of_range: { code: '22023', reason: 'out_of_range' },
  invalid_address: { code: '22023', reason: 'invalid_address' },
  attestation_required: { code: '22023', reason: 'attestation_required' },
};

/** A firm admin connects a team inbox. An open registration of the address comes back as it is (`created: false`). */
export async function connectTeamMailbox(
  db: SupabaseClient,
  input: ConnectTeamMailboxInput,
): Promise<ConnectTeamMailboxResult> {
  const { data, error } = await db.rpc('discovery_connect_team_mailbox', {
    p_address: input.address,
    p_attestation_version: input.attestationVersion,
    p_backfill_since: input.backfillSince ?? null,
  });
  if (error) {
    // The exact code and message pair the RPC raises; anything else is not a refusal it names.
    const refusal = Object.prototype.hasOwnProperty.call(CONNECT_REFUSALS, error.message)
      ? CONNECT_REFUSALS[error.message]
      : undefined;
    return { ok: false, reason: refusal && refusal.code === error.code ? refusal.reason : 'error' };
  }
  const result = data as { created?: unknown; teamMailbox?: TeamMailboxRegistration } | null;
  if (!result?.teamMailbox) return { ok: false, reason: 'error' };
  return { ok: true, created: result.created === true, teamMailbox: result.teamMailbox };
}

export type ListTeamMailboxesResult =
  | { ok: true; teamMailboxes: TeamMailbox[] }
  | { ok: false; reason: 'not_available' | 'error' };

/** The firm's open team inboxes, for its admin. Anyone else is `not_available`. */
export async function listTeamMailboxes(db: SupabaseClient): Promise<ListTeamMailboxesResult> {
  const { data, error } = await db.rpc('discovery_team_mailboxes');
  if (error) return { ok: false, reason: refusedWith(error, 'not_available') ? 'not_available' : 'error' };
  if (!Array.isArray(data)) return { ok: false, reason: 'error' };
  return { ok: true, teamMailboxes: data as TeamMailbox[] };
}

export type RemoveTeamMailboxResult =
  | { ok: true }
  | { ok: false; reason: 'not_available' | 'not_removable' | 'error' };

/** A firm admin removes a team inbox whose source holds no mail. Its source is archived. */
export async function removeTeamMailbox(db: SupabaseClient, teamMailboxId: string): Promise<RemoveTeamMailboxResult> {
  const { error } = await db.rpc('discovery_remove_team_mailbox', { p_id: teamMailboxId });
  if (!error) return { ok: true };
  if (refusedWith(error, 'not_available')) return { ok: false, reason: 'not_available' };
  if (error.code === '55000' && error.message === 'not_removable') return { ok: false, reason: 'not_removable' };
  return { ok: false, reason: 'error' };
}

export type AddTeamMailboxMemberResult =
  | { ok: true; created: boolean; member: TeamMailboxMember }
  | { ok: false; reason: 'not_available' | 'not_eligible_member' | 'error' };

/**
 * A firm admin lets a colleague read a team inbox. Adding someone who already is a member changes nothing
 * (`created: false`). The person must be an active, internal colleague seated in the firm who is not a firm admin.
 * What a member then sees is decided by the visibility rules in SQL, not here.
 */
export async function addTeamMailboxMember(
  db: SupabaseClient,
  teamMailboxId: string,
  userId: string,
): Promise<AddTeamMailboxMemberResult> {
  const { data, error } = await db.rpc('discovery_add_team_mailbox_member', { p_id: teamMailboxId, p_user: userId });
  if (error) {
    if (refusedWith(error, 'not_available')) return { ok: false, reason: 'not_available' };
    if (error.code === '22023' && error.message === 'not_eligible_member') {
      return { ok: false, reason: 'not_eligible_member' };
    }
    return { ok: false, reason: 'error' };
  }
  const result = data as { added?: unknown; member?: TeamMailboxMember } | null;
  if (!result?.member) return { ok: false, reason: 'error' };
  return { ok: true, created: result.added === true, member: result.member };
}

export type RemoveTeamMailboxMemberResult =
  | { ok: true; removed: boolean }
  | { ok: false; reason: 'not_available' | 'error' };

/** A firm admin closes a person's membership of a team inbox. Removing a non-member changes nothing (`removed: false`). */
export async function removeTeamMailboxMember(
  db: SupabaseClient,
  teamMailboxId: string,
  userId: string,
): Promise<RemoveTeamMailboxMemberResult> {
  const { data, error } = await db.rpc('discovery_remove_team_mailbox_member', { p_id: teamMailboxId, p_user: userId });
  if (error) return { ok: false, reason: refusedWith(error, 'not_available') ? 'not_available' : 'error' };
  const result = data as { removed?: unknown } | null;
  if (result === null || typeof result.removed !== 'boolean') return { ok: false, reason: 'error' };
  return { ok: true, removed: result.removed };
}

// ── Team inbox audit trail (#173 G-03) ───────────────────────────────────────
// The firm's admin and CCO read the audit rows of their own firm company's team inboxes through one security definer
// RPC bound to auth.uid() (20261023100300_team_mailbox_audit_read.sql; G-01's AI passes and capability switches added
// in 20261023110400_team_mailbox_audit_proposals.sql). It answers 42501 to anyone else, and to a
// firm that holds no team inbox. Rows carry ids, fixed codes, counts and user names only; the inbox address is in
// `inboxes`, from the registry, and only while the registration is open.

export type TeamMailboxAuditView = (typeof TEAM_MAILBOX_AUDIT_VIEWS)[number];

/** One of the firm's team inboxes, open or closed. A closed one has no address (shown as "Removed inbox"). */
export type TeamMailboxAuditInbox = {
  id: string;
  address: string | null;
  open: boolean;
};

/** The detail keys the RPC lets through, each only when well formed; every other key of the audit row is dropped. */
export type TeamMailboxAuditDetail = {
  teamMailboxId?: string;
  sourceId?: string;
  status?: string;
  reason?: string;
  purpose?: string;
  provider?: string;
  change?: string;
  /** A window_set's old and new first-read day, YYYY-MM-DD. */
  from?: string;
  to?: string;
  /** A finished reader pass's counts. */
  fetched?: number;
  stored?: number;
  excluded?: number;
  /** A proposed candidate's evidence count. */
  evidenceCount?: number;
  /** An AI proposal pass over a team inbox (G-01): its path (recorded, synthetic, verified) and how it ended. */
  path?: string;
  outcome?: string;
  /** A finished AI pass's counts: messages asked, and the answers (deal, not a deal, unreadable) and failed calls. */
  asked?: number;
  deal?: number;
  notDeal?: number;
  invalid?: number;
  failed?: number;
  /** A rule detector pass over a team inbox (G-07): the messages the run examined, and the milestones it found. */
  items?: number;
  events?: number;
  /** An owner's capability switch for the firm company (G-01): which capability, and whether it is now on. */
  capability?: string;
  on?: boolean;
  /**
   * A Google group drift row: whether one of the caller's own inboxes is missing from the group, extra in it, or
   * both (one missing and another extra).
   */
  thisInbox?: 'missing' | 'extra' | 'both';
};

export type TeamMailboxAuditRow = {
  id: string;
  ts: string;
  action: DiscoveryAuditAction;
  actorType: AuditActorType;
  /** The acting user's name; null for a service row, or a name that would carry an address. */
  actorName: string | null;
  /** A service row's identity when it is code-shaped (`discovery-worker`), else null. */
  serviceIdentity: string | null;
  /** The person a member_added or member_removed row is about. */
  subjectName: string | null;
  /** The inbox the row is about; null for a firm event (Google ingest-group drift, or an owner's capability switch for the firm company). */
  inboxId: string | null;
  detail: TeamMailboxAuditDetail;
};

/** The keyset of the next, older page: the oldest row of this one. Microsecond `ts`, passed back unchanged. */
export type TeamMailboxAuditCursor = { ts: string; id: string };

export type TeamMailboxAuditPage = {
  inboxes: TeamMailboxAuditInbox[];
  rows: TeamMailboxAuditRow[];
  next: TeamMailboxAuditCursor | null;
};

export type ListTeamMailboxAuditResult =
  | { ok: true; page: TeamMailboxAuditPage }
  | { ok: false; reason: 'not_available' | 'bad_request' | 'error' };

const isCursor = (value: unknown): value is TeamMailboxAuditCursor =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as TeamMailboxAuditCursor).ts === 'string' &&
  typeof (value as TeamMailboxAuditCursor).id === 'string';

/**
 * One page of the firm's team inbox audit trail, newest first. `before` is the previous page's `next`; `limit` is
 * clamped to 1..200 by the RPC. `not_available` is the RPC's 42501 (not the firm's active, internal admin or CCO, or a
 * firm with no team inbox); `bad_request` its 22023 (an unknown view, or half a cursor).
 */
export async function listTeamMailboxAudit(
  db: SupabaseClient,
  opts: { view: TeamMailboxAuditView; before?: TeamMailboxAuditCursor | null; limit?: number },
): Promise<ListTeamMailboxAuditResult> {
  const { data, error } = await db.rpc('discovery_team_mailbox_audit', {
    p_view: opts.view,
    p_before_ts: opts.before?.ts ?? null,
    p_before_id: opts.before?.id ?? null,
    p_limit: opts.limit ?? TEAM_MAILBOX_AUDIT_DEFAULT_LIMIT,
  });
  if (error) {
    if (refusedWith(error, 'not_available')) return { ok: false, reason: 'not_available' };
    if (error.code === '22023' && (error.message === 'bad_view' || error.message === 'bad_cursor')) {
      return { ok: false, reason: 'bad_request' };
    }
    return { ok: false, reason: 'error' };
  }
  const page = data as { inboxes?: unknown; rows?: unknown; next?: unknown } | null;
  if (!page || !Array.isArray(page.inboxes) || !Array.isArray(page.rows)) return { ok: false, reason: 'error' };
  const next: TeamMailboxAuditCursor | null | undefined =
    page.next === null ? null : isCursor(page.next) ? page.next : undefined;
  if (next === undefined) return { ok: false, reason: 'error' };
  return {
    ok: true,
    page: { inboxes: page.inboxes as TeamMailboxAuditInbox[], rows: page.rows as TeamMailboxAuditRow[], next },
  };
}

export type SetMailboxSourceWindowResult =
  | { ok: true; id: string; backfillSince: string; changed: boolean }
  | { ok: false; reason: 'not_available' | 'out_of_range' | 'window_locked' | 'error' };

/**
 * A firm admin sets how far back a Gmail mailbox's first read goes (#353), before that read starts. `since` is a UTC
 * calendar date, 'YYYY-MM-DD'. Every real change is audited in the RPC; a repeat answers changed false.
 */
export async function setMailboxSourceWindow(
  db: SupabaseClient,
  sourceId: string,
  since: string,
): Promise<SetMailboxSourceWindowResult> {
  const { data, error } = await db.rpc('discovery_set_mailbox_source_window', { p_source_id: sourceId, p_since: since });
  if (error) {
    if (refusedWith(error, 'not_available')) return { ok: false, reason: 'not_available' };
    if (error.code === '22023' && error.message === 'out_of_range') return { ok: false, reason: 'out_of_range' };
    if (error.code === '55000' && error.message === 'window_locked') return { ok: false, reason: 'window_locked' };
    return { ok: false, reason: 'error' };
  }
  return { ok: true, ...(data as { id: string; backfillSince: string; changed: boolean }) };
}

// ── Ingestion health (phase 4) ───────────────────────────────────────────────

/**
 * The newest reader pass of a source (#370): its outcome, its times by the worker's clock, and its counts. Never the
 * registration, the worker, a job or a run id: those stay in audit_log for an operator.
 */
export type ReaderPassHealth = {
  /** `in_progress`: no end yet, started under the discovery.sync expiry ago; `no_end_recorded` after it. */
  state: 'ended' | 'in_progress' | 'no_end_recorded';
  /** Null until the pass has ended. */
  group: ReaderPassGroup | null;
  status: ReaderPassStatus | null;
  reason: string | null;
  startedAt: string;
  endedAt: string | null;
  pages: number;
  fetched: number;
  excluded: number;
  stored: number;
  checkpointAdvanced: boolean;
};

/** The reader passes started in the last 24 hours, by outcome group, and their counts. */
export type ReaderPassTotals = {
  passes: number;
  completed: number;
  continued: number;
  stopped: number;
  refused: number;
  failed: number;
  noEndRecorded: number;
  fetched: number;
  excluded: number;
  stored: number;
};

/** One content source as discovery_ingestion_health() reports it: sync state and counts, no content. */
export type IngestionSourceHealth = {
  id: string;
  kind: SourceKind;
  /** The reader that serves the source. */
  provider: MailboxProvider;
  address: string;
  status: SourceStatus;
  /** An orphaned source #262 archived: paused for good, never resumable. */
  archived: boolean;
  ownerAssigned: boolean;
  checkpointState: CheckpointState;
  /**
   * The ingestion window (#353): the first day (UTC, 'YYYY-MM-DD') of mail the source's first read takes, null for
   * the whole mailbox. Google mailboxes only; null for Microsoft, whose reader does not honour it yet. Absent from an
   * older database.
   */
  backfillSince?: string | null;
  /**
   * Reading has started (a checkpoint, a started or a completed backfill), so the window can no longer be set: the
   * set-window RPC's own refusal predicate, not checkpointState. Absent from an older database.
   */
  windowLocked?: boolean;
  backfillCompletedAt: string | null;
  checkpointUpdatedAt: string | null;
  /** Seconds since the resume point last moved, or null before the first page. */
  checkpointAgeSeconds: number | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /**
   * Why the guard would refuse the source now, while it is active and not archived, else null: the database's
   * live verdict first, then the worker's provider-group refusal. Any SourceRefusalReason; render unknown ones gracefully.
   */
  waitingFor: string | null;
  itemsLedgered: number;
  itemsRouted: number;
  /** Every skipped row, the policy's exclusions included: itemsExcluded is a subset of it. */
  itemsSkipped: number;
  /** Rows the exclusion policy skipped, under every policy version it has had (a historical count). Absent from an older database. */
  itemsExcluded?: number;
  /** The source's newest reader pass (#370). Absent from an older database; null before the source's first pass. */
  latestPass?: ReaderPassHealth | null;
  /** One state for the card (reader liveness); absent from an older database. */
  state?: SourceHealthState;
  /** The source's newest pass row (start or end) by server time, and its age; null before its first pass. */
  lastPassAt?: string | null;
  lastPassAgeSeconds?: number | null;
  /** The newer of lastPassAt and the source's progress mark (reader liveness): what the reader line ages. */
  lastActivityAt?: string | null;
  lastActivityAgeSeconds?: number | null;
  /**
   * The latest pass is unfinished and live by the state's own rule (its last progress mark or start within the
   * liveness window). The card's pass badge reads this, not latestPass.state's 3600 s in_progress. Absent from an
   * older database.
   */
  latestPassLive?: boolean;
};

/** One provider's reader registration. Delegation is Google's: null for Microsoft, and null until a token has been minted. */
export type ReaderRegistrationHealth = {
  provider: MailboxProvider;
  status: RegistrationStatus;
  consentedAt: string | null;
  delegationStatus: DelegationStatus | null;
  delegationCheckedAt: string | null;
};

/** Provider allowlist group drift: counts only. Addresses stay in discovery_allowlist_health(). */
export type AllowlistHealth = {
  provider: MailboxProvider;
  status: DriftStatus;
  missingCount: number;
  extraCount: number;
  checkedAt: string | null;
};

/**
 * Is the firm's mail being read: from readable sources' pass rows and both switches, no heartbeat table.
 * `active`: the worker is at work but no readable mailbox reads Reading or Up to date (all waiting, failing or stale).
 */
export type ReaderHealth = {
  enabled: boolean;
  lastActiveAt: string | null;
  lastActiveAgeSeconds: number | null;
  state: ReaderHealthState;
};

export type IngestionHealth = {
  /** The Graph registration, kept for one release: `registrations` is the per-provider list. */
  registration: { status: RegistrationStatus; consentedAt: string | null } | null;
  registrations: ReaderRegistrationHealth[];
  allowlist: AllowlistHealth[];
  sources: IngestionSourceHealth[];
  /** Absent from an older database; null in the no-registration shape. */
  reader?: ReaderHealth | null;
  /** The caller is the firm's admin and may pause or resume a source; the control room only reads. */
  viewerCanManageSources: boolean;
  /** Reconciliation is deferred (F4): the only value is `not_built`, which is never a clean state. */
  reconciliation: 'not_built';
  /**
   * The tenant's current exclusion policy version, or null when none was ever written. A separate fact from
   * itemsExcluded, which counts every version: never render the two as one. Absent from an older database.
   */
  policyVersion?: number | null;
  totals: {
    sources: number;
    itemsLedgered: number;
    itemsRouted: number;
    itemsSkipped: number;
    itemsExcluded?: number;
    itemsStored: number;
    candidatesProposed: number;
    /** Reader passes started in the last 24 hours (#370). Absent from an older database. */
    passesLast24h?: ReaderPassTotals | null;
  };
};

/**
 * The tenant's ingestion health, for a firm admin or the control room. The
 * RPC decides who may call it from auth.uid() and answers 42501 to anyone
 * else, which is reported here as not_visible so the route can 404.
 */
export async function readIngestionHealth(
  db: SupabaseClient,
): Promise<{ ok: true; health: IngestionHealth } | { ok: false; error: 'not_visible' | 'failed' }> {
  const { data, error } = await db.rpc('discovery_ingestion_health');
  if (error) return { ok: false, error: error.code === '42501' ? 'not_visible' : 'failed' };
  if (!data || typeof data !== 'object') return { ok: false, error: 'failed' };
  return { ok: true, health: data as IngestionHealth };
}
