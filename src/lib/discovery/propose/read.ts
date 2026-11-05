// Demo-only (#460): the read side of the deal proposal step, for the /discovery
// section. Delete this folder when #459 lands.
//
// Like src/lib/discovery/api.ts, it takes the caller's user-scoped client
// (requireApiUserScoped), so RLS alone decides what comes back: the owner of
// the mailbox a message was read from sees that message's 'deal' row, and
// nobody else sees any. Archived rows are skipped. It imports nothing from the model gateway.
//
// Dismissals (G-02a, #173) are read the same way: their policy is the source
// owner's (20261023120100). A row is covered when a live dismissal on the row's
// own source, of its current key, lists the row's id: the link the dismiss RPC
// writes from the rows it read. The reader applies that link and no clock, so a
// dismissal never hides a row of another source (a team inbox's row of the same
// key, say) or a row its owner never saw.
//
// A group is actionable (Promote, Dismiss) only when every row it shows comes
// from a personal mailbox the caller owns, asked of app_owns_mailbox_source on
// the caller's session: the dismiss RPC's owner guard, so the UI never offers
// what the RPC refuses. A team inbox has no owner, so its groups stay closed
// until TH1-3 decides team triage.
//
// An actionable `m:` group also carries where its accept stands (G-02b, #173): the owner's own requests, read under
// the owner's RLS on discovery_model_proposal_accepts. A request still being read is `pending`; with none live, the
// newest failed one is `failed` with its fixed code. A done one has re-keyed its rows to `c:`, so no `m:` group
// shows it.
//
// A `c:` group also carries its origin (G-02b): `model_proposal` when its candidate is one an accepted model proposal
// made, or the survivor of a merge of one (candidateOrigins, the definer batch read; the cluster key never reaches
// this file), else `rules`. A candidate the definer gives no answer for carries none (null), never `rules`. The list
// words a row differently for each, and never says "also found by the codename rules" of a deal the model made or of
// one whose origin is not known.

import type { SupabaseClient } from '@supabase/supabase-js';

import { PROPOSAL_OUTCOME } from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';

import { candidateOrigins } from '../origin';
import {
  ACCEPT_FAILURE_CODES,
  groupProposals,
  type AcceptFailureCode,
  type ModelProposalAccept,
  type ModelProposalGroup,
  type ModelProposalRow,
} from './group';

export type { ModelProposalGroup } from './group';

// id, content_source_id and tenant_id feed the covered link and the owner check only, and never leave the server
// (groupProposals does not carry them).
const COLUMNS =
  'id, message_key, outcome, deal_key, deal_name, candidate_id, phase, sent_at, party_domains, content_source_id, ' +
  'tenant_id';
const DISMISSAL_COLUMNS = 'content_source_id, deal_key, proposal_ids';
// The accept's own columns for the list: never the snapshot (message keys, hashes) or the claim.
const ACCEPT_COLUMNS = 'deal_key, state, email_count, failure_code, requested_at';
/** The states in which the source's job still has to read the emails. */
const LIVE_ACCEPT_STATES = ['pending', 'running', 'storing', 'stored'] as const;

/** A proposal row as this reader selects it: the grouped columns plus its id, source and tenant. */
type ReadRow = ModelProposalRow & { id: string; content_source_id: string; tenant_id: string };
/** A live dismissal as this reader selects it. */
export type ModelProposalDismissal = { content_source_id: string; deal_key: string; proposal_ids: string[] };

/**
 * Rows asked for per read. PostgREST caps a response (max_rows, 1,000 by default), and a hosted project may cap it
 * lower, so the reader moves on by the rows it got and stops only on an empty page (review on #512).
 */
export const PAGE_SIZE = 1000;
/** Candidate ids per visibility read, so a long list never builds an overlong query string. */
const ID_CHUNK = 100;

const candidateOf = (dealKey: string) => (dealKey.startsWith('c:') ? dealKey.slice('c:'.length) : null);

const linkOf = (source: string, dealKey: string, id: string) => `${source}|${dealKey}|${id}`;

/** The links of the live dismissals: one entry per (source, key, proposal id) a dismissal lists. */
export function coveredLinks(dismissals: readonly ModelProposalDismissal[]): Set<string> {
  const links = new Set<string>();
  for (const d of dismissals) for (const id of d.proposal_ids ?? []) links.add(linkOf(d.content_source_id, d.deal_key, id));
  return links;
}

/**
 * The covered rule of 20261023120100: a live dismissal on the row's source, of the row's current key, lists the
 * row's id.
 */
export function isCovered(
  row: { id: string; content_source_id: string; deal_key: string | null },
  links: ReadonlySet<string>,
): boolean {
  return row.deal_key !== null && links.has(linkOf(row.content_source_id, row.deal_key, row.id));
}

/** An accept request as this reader selects it. */
type AcceptRow = { deal_key: string; state: string; email_count: number; failure_code: string | null; requested_at: string };

/**
 * One accept state per `m:` deal key: `pending` (the emails of every live request, summed) while any request is
 * live, else `failed` with the code of the newest failed one. A code the list does not know reads as `error`.
 */
export function acceptStates(rows: readonly AcceptRow[]): Map<string, ModelProposalAccept> {
  const requested = new Map<string, number>();
  const failed = new Map<string, { at: string; code: AcceptFailureCode }>();
  for (const row of rows) {
    if ((LIVE_ACCEPT_STATES as readonly string[]).includes(row.state)) {
      requested.set(row.deal_key, (requested.get(row.deal_key) ?? 0) + Number(row.email_count));
    } else if (row.state === 'failed' && row.requested_at >= (failed.get(row.deal_key)?.at ?? '')) {
      const known = (ACCEPT_FAILURE_CODES as readonly string[]).includes(row.failure_code ?? '');
      failed.set(row.deal_key, { at: row.requested_at, code: known ? (row.failure_code as AcceptFailureCode) : 'error' });
    }
  }
  const states = new Map<string, ModelProposalAccept>();
  for (const [key, { code }] of failed) states.set(key, { state: 'failed', code });
  for (const [key, count] of requested) states.set(key, { state: 'pending', requested: count });
  return states;
}

type Page = { data: unknown; error: { message: string } | null };

/** Every row of a read, page by page, moving on by the rows each page returned and stopping on an empty one. */
async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<Page>,
  pageSize: number,
): Promise<{ ok: true; rows: T[] } | { ok: false; error: string }> {
  const rows: T[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) return { ok: false, error: error.message };
    const got = (data ?? []) as T[];
    if (got.length === 0) return { ok: true, rows };
    rows.push(...got);
    from += got.length;
  }
}

/**
 * The deal keys whose rows all come from a personal mailbox `userId` owns: one app_owns_mailbox_source call per
 * distinct source, in parallel, on the caller's session. Without a userId nothing is actionable.
 */
async function ownedKeys(
  db: SupabaseClient,
  rows: readonly ReadRow[],
  userId: string | undefined,
): Promise<{ ok: true; keys: Set<string> } | { ok: false; error: string }> {
  if (!userId) return { ok: true, keys: new Set() };
  const sources = [...new Map(rows.map((r) => [r.content_source_id, r.tenant_id]))];
  // A caller reads a handful of mailboxes, so one call each, in parallel.
  const answers = await Promise.all(
    sources.map(([source, tenant]) =>
      db.rpc('app_owns_mailbox_source', { p_source: source, p_tenant: tenant, p_user: userId }),
    ),
  );
  const owned = new Set<string>();
  for (const [i, { data, error }] of answers.entries()) {
    if (error) return { ok: false, error: error.message };
    if (data === true) owned.add(sources[i][0]);
  }
  const keys = new Set<string>();
  const foreign = new Set<string>();
  for (const r of rows) {
    if (r.deal_key === null) continue;
    (owned.has(r.content_source_id) ? keys : foreign).add(r.deal_key);
  }
  for (const key of foreign) keys.delete(key);
  return { ok: true, keys };
}

/**
 * The model-proposed deals the caller may see, grouped by deal, without the rows the caller dismissed. A group that
 * names a rules-found candidate is returned only while the caller can see that candidate: otherwise its name and
 * key never leave the server, and the section never links to a page that would 404. `dismissedCount` is the number
 * of such deals with at least one dismissed row, a count only: no dismissed key or name leaves the server.
 * `userId` is the caller's own id (auth.uid()); a group is `actionable` only when it is given and every row the
 * group shows is on a personal mailbox the caller owns.
 */
export async function listModelProposals(
  db: SupabaseClient,
  opts: { pageSize?: number; userId?: string } = {},
): Promise<{ ok: true; proposals: ModelProposalGroup[]; dismissedCount: number } | { ok: false; error: string }> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const read = await readAll<ReadRow>(
    (from, to) =>
      db
        .from(TABLE.DISCOVERY_MODEL_PROPOSALS)
        .select(COLUMNS)
        .eq('outcome', PROPOSAL_OUTCOME.DEAL)
        // An archived row's candidate was deleted, rejected or merged (review #509-3): kept, never shown.
        .is('archived_at', null)
        .order('id')
        .range(from, to),
    pageSize,
  );
  if (!read.ok) return read;
  const rows = read.rows;
  if (rows.length === 0) return { ok: true, proposals: [], dismissedCount: 0 };

  // Live dismissals only: a restored one covers nothing.
  const dismissals = await readAll<ModelProposalDismissal>(
    (from, to) =>
      db
        .from(TABLE.DISCOVERY_MODEL_PROPOSAL_DISMISSALS)
        .select(DISMISSAL_COLUMNS)
        .is('restored_at', null)
        .order('id')
        .range(from, to),
    pageSize,
  );
  if (!dismissals.ok) return dismissals;
  const links = coveredLinks(dismissals.rows);
  const open: ReadRow[] = [];
  const covered: ReadRow[] = [];
  for (const row of rows) (isCovered(row, links) ? covered : open).push(row);

  const ids = [...new Set(rows.flatMap((r) => (r.deal_key ? candidateOf(r.deal_key) ?? [] : [])))];
  const seen = new Set<string>();
  const promoted = new Set<string>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const visible = await db
      .from(TABLE.DEAL_CANDIDATES)
      .select('id, promoted_deal_id')
      .in('id', ids.slice(i, i + ID_CHUNK));
    if (visible.error) return { ok: false, error: visible.error.message };
    for (const row of (visible.data ?? []) as Array<{ id: string; promoted_deal_id: string | null }>) {
      seen.add(row.id);
      if (row.promoted_deal_id !== null) promoted.add(row.id);
    }
  }
  // The origin of each visible `c:` group's candidate, by the merge-ancestry rule of candidateOrigin (a model: candidate
  // merged into a rules survivor makes the survivor's deal model-origin). Read in SQL, so no cluster key reaches this
  // file. A failed read fails the list, like every other read here. `unknown` (the database would not answer) is not
  // `rules`: the group carries no origin, and the row words nothing about where its deal came from.
  const shownIds = [...new Set(open.flatMap((r) => (r.deal_key ? candidateOf(r.deal_key) ?? [] : [])))].filter((id) =>
    seen.has(id),
  );
  const modelOrigin = new Set<string>();
  const originUnknown = new Set<string>();
  if (shownIds.length > 0) {
    const origins = await candidateOrigins(db, shownIds);
    if (!origins.ok) return origins;
    for (const [id, origin] of origins.origins) {
      if (origin === 'model_proposal') modelOrigin.add(id);
      else if (origin === 'unknown') originUnknown.add(id);
    }
  }
  const actionable = await ownedKeys(db, open, opts.userId);
  if (!actionable.ok) return actionable;
  // Only the owner's actionable `m:` keys have an accept to show; no such key, no read.
  const mKeys = [...actionable.keys].filter((key) => key.startsWith('m:'));
  let accepts = new Map<string, ModelProposalAccept>();
  if (mKeys.length > 0) {
    const asked = await readAll<AcceptRow>(
      (from, to) =>
        db
          .from(TABLE.DISCOVERY_MODEL_PROPOSAL_ACCEPTS)
          .select(ACCEPT_COLUMNS)
          .in('state', [...LIVE_ACCEPT_STATES, 'failed'])
          .order('id')
          .range(from, to),
      pageSize,
    );
    if (!asked.ok) return asked;
    accepts = acceptStates(asked.rows);
  }
  const shown = (g: ModelProposalGroup) => {
    const id = candidateOf(g.dealKey);
    return id === null || seen.has(id);
  };
  return {
    ok: true,
    proposals: groupProposals(open, promoted, actionable.keys, accepts, modelOrigin, originUnknown).filter(shown),
    dismissedCount: groupProposals(covered).filter(shown).length,
  };
}
