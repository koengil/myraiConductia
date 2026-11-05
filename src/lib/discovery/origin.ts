// Where a proposed deal or a deal came from, and what the model proposed for it (G-02b #173, R7 and R14).
//
// A candidate is model-origin when its cluster key starts with `model:` (an accepted model proposal), or when it is the
// survivor that such a candidate was merged into, however many merges deep: a merge must not launder AI-found evidence
// out of the station rule. A deal is model-origin when any candidate promoted to it is.
//
// The answer is read in SQL (20261023140400_discovery_origin_read.sql), not from the candidate rows: the candidates'
// own RLS hides a model candidate from a deal member or overseer who is not the finder, and a merged-away model
// candidate from a viewer who cannot see it, and reading under RLS made both look like `rules` (a one-click Move with
// no pop-up, against the owner's rule that every model-origin deal gets the pop-up). The definers answer for a caller
// who can see the candidate or sits on (or oversees) its deal, and return only the enum: the cluster key is read in the
// database and never reaches this file.
//
// Fail closed. The answer gates a safety guard, so a read that fails, or a candidate or deal the definer would not
// answer for, is an error (`ok: false`) or `unknown`, never `rules`. Only an explicit `rules` from the database is rules.

import type { SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '@/lib/constants/tables';
import { MVP_DEAL_RAIL, stepDisplayNumber } from '@/lib/rail/dealRail';

import type { ProposalPhase } from './propose/group';

export type Origin = 'model_proposal' | 'rules';

/** What a batch answers for one candidate: the origin, or `unknown` when the database gave no answer. Never `rules` by default. */
export type OriginOrUnknown = Origin | 'unknown';

export type OriginResult = { ok: true; origin: Origin } | { ok: false; error: string };

export type OriginsResult = { ok: true; origins: Map<string, OriginOrUnknown> } | { ok: false; error: string };

/** What the owner accepted: the station the model proposed, and how many of the deal's emails it placed there. */
export type ModelProposal = {
  /** The newest finished request of the accept. */
  requestId: string;
  stepId: string;
  phase: ProposalPhase;
  /** Emails the model placed in the proposed phase, and all the emails it grouped under the deal. */
  placed: number;
  of: number;
};

export type ModelProposalResult = { ok: true; proposal: ModelProposal | null } | { ok: false; error: string };

/** The definer refuses a larger array (22023); a longer list is asked in chunks of this size. */
const ORIGIN_BATCH = 200;

const isOrigin = (value: unknown): value is Origin => value === 'model_proposal' || value === 'rules';

/**
 * The origin of each candidate the caller may know about, in one definer call per 200 ids. Every id asked about is in
 * the map: the origin the database gave, else `unknown` (a candidate it would not answer for, or an answer that is not
 * one of the two words). A failed call fails the whole read.
 */
export async function candidateOrigins(db: SupabaseClient, candidateIds: readonly string[]): Promise<OriginsResult> {
  const ids = [...new Set(candidateIds.filter((id) => typeof id === 'string' && id.length > 0))];
  const origins = new Map<string, OriginOrUnknown>(ids.map((id) => [id, 'unknown']));
  for (let at = 0; at < ids.length; at += ORIGIN_BATCH) {
    const { data, error } = await db.rpc('discovery_candidate_origins', {
      p_candidate_ids: ids.slice(at, at + ORIGIN_BATCH),
    });
    if (error) return { ok: false, error: error.message };
    for (const row of (data ?? []) as Array<{ candidate_id?: unknown; origin?: unknown }>) {
      if (typeof row.candidate_id === 'string' && origins.has(row.candidate_id) && isOrigin(row.origin)) {
        origins.set(row.candidate_id, row.origin);
      }
    }
  }
  return { ok: true, origins };
}

/**
 * The origin of one proposed deal the page already showed. A candidate the database gives no answer for is an error,
 * not `rules`: the caller saw it, so a missing answer is a fault to surface.
 */
export async function candidateOrigin(db: SupabaseClient, candidateId: string): Promise<OriginResult> {
  const result = await candidateOrigins(db, [candidateId]);
  if (!result.ok) return result;
  const origin = result.origins.get(candidateId);
  return isOrigin(origin) ? { ok: true, origin } : { ok: false, error: 'origin_unavailable' };
}

/**
 * The origin of a promoted deal: model-origin when any candidate promoted to it is. The caller found the deal, so a
 * null from the definer (it would not answer) is an error, not `rules`.
 */
export async function dealOrigin(db: SupabaseClient, dealId: string): Promise<OriginResult> {
  const { data, error } = await db.rpc('discovery_deal_origin', { p_deal_id: dealId });
  if (error) return { ok: false, error: error.message };
  return isOrigin(data) ? { ok: true, origin: data } : { ok: false, error: 'origin_unavailable' };
}

type AcceptRow = {
  id: string;
  operation_id: string;
  proposed_step_id: string;
  proposed_phase: string;
  placed_count: number;
  email_count: number;
};

/**
 * What the owner last accepted for this candidate: the newest finished accept, its counts summed over every source it
 * read. Read under the owner's RLS on the requests, so anyone else gets null, as does a step the rail no longer has.
 * Two reads: the newest finished request names the operation, then all of that operation's finished requests for the
 * candidate are summed, however many sources it covered.
 */
export async function latestModelProposal(db: SupabaseClient, candidateId: string): Promise<ModelProposalResult> {
  const newest = await db
    .from(TABLE.DISCOVERY_MODEL_PROPOSAL_ACCEPTS)
    .select('id, operation_id, proposed_step_id, proposed_phase, placed_count, email_count')
    .eq('candidate_id', candidateId)
    .eq('state', 'done')
    .order('finished_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1);
  if (newest.error) return { ok: false, error: newest.error.message };
  const latest = ((newest.data ?? []) as AcceptRow[])[0];
  if (!latest) return { ok: true, proposal: null };
  if (!/^phase-[1-5]$/.test(latest.proposed_phase) || stepDisplayNumber(latest.proposed_step_id, MVP_DEAL_RAIL) === 0) {
    return { ok: true, proposal: null };
  }

  const sameOperation = await db
    .from(TABLE.DISCOVERY_MODEL_PROPOSAL_ACCEPTS)
    .select('id, placed_count, email_count')
    .eq('candidate_id', candidateId)
    .eq('state', 'done')
    .eq('operation_id', latest.operation_id);
  if (sameOperation.error) return { ok: false, error: sameOperation.error.message };
  const found = (sameOperation.data ?? []) as Array<Pick<AcceptRow, 'placed_count' | 'email_count'>>;
  // The newest request is itself in its operation; an empty answer would be a race with a purge, so count it alone.
  const rows = found.length > 0 ? found : [latest];
  return {
    ok: true,
    proposal: {
      requestId: latest.id,
      stepId: latest.proposed_step_id,
      phase: latest.proposed_phase as ProposalPhase,
      placed: rows.reduce((sum, row) => sum + Number(row.placed_count), 0),
      of: rows.reduce((sum, row) => sum + Number(row.email_count), 0),
    },
  };
}
