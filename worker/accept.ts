// The commit half of a person's accept of a model proposal (G-02b #173). Part of the classification zone: no model is
// reachable from here (ESLint fence).
//
// syncSource's accept mode reads the source and returns the messages the accept named, in memory (worker/sync.ts,
// AcceptBuffer). Nothing is stored by the read. commitAccepted stores them, with the one route an accept makes:
// `model_proposal`, non-teaching (it adds no codename, thread or alias; RoutingContext.learn skips it). The job
// (slice 3b) records the keys it is about to store BEFORE it calls this, so a crash after the write leaves a request
// that knows what to purge; this file knows nothing of requests, tokens or leases.
//
// It writes exactly what persistItems writes for a routed message: the item, its text, this source's provenance, the
// ledger row (unrouted to routed/model_proposal) and the message index row, plus the ledger row of an accepted key's
// id collision. It passes no skip and no thread taint: the regular sync records those, and a taint that did not commit
// with its policy skip would break the exclusion rule (persist.ts).
//
// acceptStep (slice 3b) is the job's driver: it runs at the end of a source's SYNC job, claims the source's due requests
// with a per-attempt claim token (the reader pass id, see AcceptStepDeps.token), serves them all with ONE guarded read,
// and takes each through the ledger partition, the write-ahead (storing), the commit, the candidate upsert and the
// finish. Every definer takes the token and does nothing unless it matches, so a duplicate or superseded job is
// harmless. The reader and the guard are handed in (worker/classify.ts owns them), so this file never reads a mailbox
// itself and never imports a reader.
//
// The ledger partition (before the write-ahead): this source's own routing_ledger decides what an accept may do with
// each found message, never a re-run of the rules on the page it was read in (that page is truncated to the accepted
// messages, so a rule that needs its neighbours would look unrouted):
//   routed by a rules method   left to the rules: not stored, not linked.
//   routed by model_proposal   an earlier accept (or a crashed attempt of this one) already stored it: linked only. It
//                              is never persisted again and never put in the write-ahead, so no purge can reach it.
//   not routed in this source  the only keys that go in the write-ahead, and the only ones persisted: exactly the
//                              keys discovery_mark_model_proposal_accept_storing returns.
//
// Never log what is committed: the buffer holds subjects, bodies and addresses. The step logs nothing itself; the
// caller prints ids and counts.

import type { SupabaseClient } from '@supabase/supabase-js';

import { ROUTE_METHOD, ROUTING_DECISION } from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';
import { partyNameFromDomain } from '@/lib/discovery/discover/cluster';
import { messageKey, persistItems, type PersistItemsResult } from '@/lib/discovery/persist';
import { modelProposalRoute, type RoutedItem } from '@/lib/discovery/route/firmRules';
import { errorCodeOf } from '@/lib/errors/upstream';

import type { AcceptBuffer, AcceptRead, SyncSource } from './sync';

/**
 * The accept read's input from a request's live keys (the rows of discovery_model_proposal_accept_live_keys): message
 * key to the content hashes accepted for it. A message may be live under more than one hash.
 */
export function acceptKeys(rows: ReadonlyArray<{ message_key: string; item_hash: string }>): AcceptRead['keys'] {
  const keys = new Map<string, Set<string>>();
  for (const { message_key, item_hash } of rows) {
    const hashes = keys.get(message_key) ?? new Set<string>();
    hashes.add(item_hash);
    keys.set(message_key, hashes);
  }
  return keys;
}

/**
 * Stores what an accept read buffered, routed `model_proposal` and teaching nothing. An empty buffer writes nothing.
 * Idempotent: persistItems upserts every row on a stable key, so a retry after a crash changes nothing.
 */
export async function commitAccepted(
  db: SupabaseClient,
  input: { tenantId: string; runId: string; buffer: AcceptBuffer },
): Promise<PersistItemsResult | null> {
  const { tenantId, runId, buffer } = input;
  if (buffer.items.size === 0 && buffer.collisions.length === 0) return null;
  const routed: RoutedItem[] = [...buffer.items.values()].map((entry) => ({ ...entry, routes: [modelProposalRoute()] }));
  return persistItems(db, {
    tenantId,
    runId,
    routed,
    skipped: [],
    collisions: buffer.collisions,
    threadTaints: [],
    tags: buffer.tags,
  });
}

// ── The job's step ───────────────────────────────────────────────────────────

/** How long a claim lasts: longer than the SYNC job's own expiry (3,600 s), renewed at every page (design R4). */
export const ACCEPT_LEASE = '75 minutes';
/** How long a request may wait unclaimed before the tick fails it. */
export const ACCEPT_MAX_AGE = '24 hours';

/** The failure codes discovery_finish_model_proposal_accept takes. */
type AcceptFailure = 'none_readable' | 'source_unavailable' | 'candidate_closed' | 'error';

/** A request row as discovery_claim_model_proposal_accepts returns it: only what this step reads. */
export type AcceptRequest = {
  id: string;
  tenant_id: string;
  content_source_id: string;
  deal_key: string;
  proposal_ids: string[];
  message_keys: string[];
  item_hashes: string[];
  cluster_key: string;
  /** The state after the claim: a pending request is 'running'. */
  state: 'running' | 'storing' | 'stored';
  storing_keys: string[] | null;
};

/** A row of discovery_model_proposal_accept_live_keys. */
type LiveKey = { message_key: string; item_hash: string; sent_at: string | null };

/** What the injected read returns: the buffer, or "the guard or the source said no" (nothing was read past that). */
export type AcceptReadResult = { status: 'read'; buffer: AcceptBuffer } | { status: 'unavailable' };

export type AcceptStepDeps = {
  db: SupabaseClient;
  source: SyncSource;
  /**
   * The claim token, unique per ATTEMPT: worker/classify.ts passes the reader pass id, which beginPass draws fresh for
   * every sync() call. The pg-boss job id is not enough: a retry of a job keeps its id, so a stale first attempt that
   * is still alive would pass every token check as if it were the retry once the lease lapsed and the retry claimed.
   */
  token: string;
  /**
   * Called with a request id and the error when serving that one request failed. The step goes on with the source's
   * other requests; the failed one keeps its claim and recovers through the lease. The caller prints the id and a
   * code only, never the message.
   */
  onRequestError?: (requestId: string, error: unknown) => void;
  /** The reader pass's run id, written on the ledger rows and the candidate. */
  runId: string;
  /**
   * The one guarded read (worker/classify.ts: readOneSource with the accept option). A refusal or a skip is
   * `unavailable`; any other failure throws.
   */
  read: (accept: AcceptRead) => Promise<AcceptReadResult>;
  /**
   * Asks the mailbox guard (#262) and the exclusion policy (#338) about this source WITHOUT reading it: the stored
   * resume has no read of its own, so this is its re-check. False is a refusal.
   */
  admitted: () => Promise<boolean>;
  /** Pages one read may take (the job's page budget). */
  pageBudget: number;
  lease?: string;
};

/** Counts only: how many requests this job claimed and how many it finished (done or failed). */
export type AcceptStepResult = { claimed: number; finished: number };

/** Every request this job held was taken over by another claim: stop writing for them. */
class AcceptLeaseLost extends Error {
  constructor() {
    super('discovery sync: accept lease lost');
    this.name = 'AcceptLeaseLost';
  }
}

/** Calls a service definer. The failure carries the SQLSTATE and nothing else: a message can quote a value. */
async function call<T>(db: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`discovery sync: accept ${name} failed (${errorCodeOf(error)})`);
  return data as T;
}

function chunked<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** The day before the earliest `sent_at`, `YYYY-MM-DD` in UTC; none when any message has no date to bound it by. */
export function windowFromOf(rows: ReadonlyArray<{ sent_at: string | null }>): string | undefined {
  let earliest = Number.POSITIVE_INFINITY;
  for (const { sent_at } of rows) {
    const ms = sent_at === null ? Number.NaN : Date.parse(sent_at);
    if (!Number.isFinite(ms)) return undefined;
    earliest = Math.min(earliest, ms);
  }
  if (!Number.isFinite(earliest)) return undefined;
  return new Date(earliest - 86_400_000).toISOString().slice(0, 10);
}

/** The part of a buffer that belongs to one request: its own messages, their tags and their collisions. */
function bufferOf(buffer: AcceptBuffer, keys: ReadonlySet<string>): AcceptBuffer {
  const items = new Map([...buffer.items].filter(([key]) => keys.has(key)));
  const ids = new Set([...items.values()].map((entry) => entry.item.internetMessageId));
  return {
    items,
    collisions: buffer.collisions.filter((c) => keys.has(messageKey(c.key))),
    tags: new Map([...buffer.tags].filter(([id]) => ids.has(id))),
    seen: new Set(keys),
    changed: 0,
    leftToRules: 0,
    stop: buffer.stop,
  };
}

/** The request's own messages the read found: live for it, and with a content hash it accepted. */
function foundFor(buffer: AcceptBuffer, live: readonly LiveKey[]): Set<string> {
  const hashes = new Map<string, Set<string>>();
  for (const { message_key, item_hash } of live) {
    const set = hashes.get(message_key) ?? new Set<string>();
    set.add(item_hash);
    hashes.set(message_key, set);
  }
  const found = new Set<string>();
  for (const [key, entry] of buffer.items) {
    if (hashes.get(key)?.has(entry.item.contentHash)) found.add(key);
  }
  return found;
}

/**
 * How this source's ledger has routed the given provider items: provider item id to the method, for the rows whose
 * decision is 'routed' (an item with no such row is absent). Read through the service client; it selects the provider
 * id, the decision and the method, and nothing from the mail. A Graph provider id is long and these travel in the URL.
 */
async function routedMethods(
  db: SupabaseClient,
  sourceId: string,
  providerIds: readonly string[],
): Promise<Map<string, string | null>> {
  const wanted = new Set(providerIds);
  const methods = new Map<string, string | null>();
  for (const batch of chunked([...wanted], 20)) {
    const { data, error } = await db
      .from(TABLE.ROUTING_LEDGER)
      .select('provider_item_id, decision, method')
      .eq('source_id', sourceId)
      .eq('decision', ROUTING_DECISION.ROUTED)
      .in('provider_item_id', batch);
    if (error) throw new Error(`discovery sync: accept ledger read failed (${errorCodeOf(error)})`);
    for (const row of (data ?? []) as Array<{ provider_item_id: string; decision: string; method: string | null }>) {
      if (wanted.has(row.provider_item_id) && row.decision === ROUTING_DECISION.ROUTED) {
        methods.set(row.provider_item_id, row.method);
      }
    }
  }
  return methods;
}

/** What the ledger lets an accept do with the keys its read found. */
type Partition = {
  /** Not routed in this source: written ahead, and persisted if the write-ahead returns them. */
  fresh: Set<string>;
  /** Routed `model_proposal` here already: linked to the candidate, never persisted or written ahead. */
  linkOnly: Set<string>;
  // Keys routed by a rules method are in neither set: the rules own them.
};

/**
 * Splits the found keys by this source's routing_ledger rows for the provider items the read buffered them under. Any
 * rules route on a key wins (it is left to the rules); else any `model_proposal` route makes it link-only; else it is
 * fresh. The mail is not consulted.
 */
async function partitionByLedger(
  db: SupabaseClient,
  source: SyncSource,
  buffer: AcceptBuffer,
  found: ReadonlySet<string>,
): Promise<Partition> {
  const providerIdsOf = new Map<string, string[]>();
  for (const key of found) {
    const entry = buffer.items.get(key);
    providerIdsOf.set(
      key,
      (entry?.observations ?? []).filter((o) => o.sourceId === source.id).map((o) => o.providerItemId),
    );
  }
  const methods = await routedMethods(db, source.id, [...providerIdsOf.values()].flat());
  const partition: Partition = { fresh: new Set(), linkOnly: new Set() };
  for (const [key, ids] of providerIdsOf) {
    const routed = ids.filter((id) => methods.has(id)).map((id) => methods.get(id));
    if (routed.length === 0) partition.fresh.add(key);
    else if (routed.every((method) => method === ROUTE_METHOD.MODEL_PROPOSAL)) partition.linkOnly.add(key);
  }
  return partition;
}

/**
 * The stored items this source holds for the given message keys, and the keys they belong to, found without the mail:
 * the message index names the provider ids the source read each message under, the ledger keeps only those routed
 * `model_proposal` (a rules-routed message the source holds is never an accept's to link), and the holder rows name
 * the items. Used for the link-only keys of a fresh serve and for the stored resume, which has no read of its own; a
 * fresh commit has the ids of what it stored from persistItems.
 */
async function heldItems(
  db: SupabaseClient,
  req: AcceptRequest,
  keys: readonly string[],
): Promise<{ itemIds: string[]; keys: Set<string> }> {
  const wanted = new Set(keys);
  const keyOfProviderId = new Map<string, string>();
  for (const batch of chunked([...wanted], 50)) {
    const { data, error } = await db
      .from(TABLE.DISCOVERY_MESSAGE_INDEX)
      .select('message_key, provider_item_ids')
      .eq('tenant_id', req.tenant_id)
      .eq('content_source_id', req.content_source_id)
      .in('message_key', batch);
    if (error) throw new Error(`discovery sync: accept index read failed (${errorCodeOf(error)})`);
    for (const row of (data ?? []) as Array<{ message_key: string; provider_item_ids: string[] | null }>) {
      if (!wanted.has(row.message_key)) continue;
      for (const id of row.provider_item_ids ?? []) keyOfProviderId.set(id, row.message_key);
    }
  }
  const methods = await routedMethods(db, req.content_source_id, [...keyOfProviderId.keys()]);
  const modelRouted = new Set([...keyOfProviderId.keys()].filter((id) => methods.get(id) === ROUTE_METHOD.MODEL_PROPOSAL));
  const itemIds = new Set<string>();
  const heldKeys = new Set<string>();
  for (const batch of chunked([...modelRouted], 20)) {
    const { data, error } = await db
      .from(TABLE.SOURCE_ITEM_SOURCES)
      .select('source_item_id, provider_item_id')
      .eq('content_source_id', req.content_source_id)
      .in('provider_item_id', batch);
    if (error) throw new Error(`discovery sync: accept holder read failed (${errorCodeOf(error)})`);
    for (const row of (data ?? []) as Array<{ source_item_id: string; provider_item_id: string }>) {
      if (!modelRouted.has(row.provider_item_id)) continue;
      itemIds.add(row.source_item_id);
      heldKeys.add(keyOfProviderId.get(row.provider_item_id)!);
    }
  }
  return { itemIds: [...itemIds], keys: heldKeys };
}

type ProposalRow = {
  id: string;
  message_key: string;
  item_hash: string;
  deal_name: string | null;
  party_domains: string[] | null;
  sent_at: string | null;
};

/**
 * What the candidate is called and who it concerns, from the request's own proposal rows for the messages it stored:
 * the commonest name (ties: the first alphabetically), the parties' domains, and the first and last send dates. The
 * name and domains come from mail and go to the database only; this file never prints them.
 */
async function groupOf(db: SupabaseClient, req: AcceptRequest, keys: ReadonlySet<string>) {
  const { data, error } = await db
    .from(TABLE.DISCOVERY_MODEL_PROPOSALS)
    .select('id, message_key, item_hash, deal_name, party_domains, sent_at')
    .eq('tenant_id', req.tenant_id)
    .eq('content_source_id', req.content_source_id)
    .eq('deal_key', req.deal_key)
    .eq('outcome', 'deal')
    .is('archived_at', null);
  if (error) throw new Error(`discovery sync: accept proposal read failed (${errorCodeOf(error)})`);
  const accepted = new Map(req.proposal_ids.map((id, i) => [id, req.item_hashes[i]]));
  const rows = ((data ?? []) as ProposalRow[]).filter(
    (row) => accepted.get(row.id) === row.item_hash && keys.has(row.message_key) && row.deal_name,
  );
  if (rows.length === 0) return null;

  const names = new Map<string, number>();
  const domains = new Map<string, number>();
  const times: number[] = [];
  for (const row of rows) {
    names.set(row.deal_name!, (names.get(row.deal_name!) ?? 0) + 1);
    for (const domain of new Set(row.party_domains ?? [])) domains.set(domain, (domains.get(domain) ?? 0) + 1);
    const ms = row.sent_at ? Date.parse(row.sent_at) : Number.NaN;
    if (Number.isFinite(ms)) times.push(ms);
  }
  const name = [...names].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  const parties = [...domains]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([domain]) => ({ name: partyNameFromDomain(domain), domain }));
  return {
    name,
    parties,
    firstSeenAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    lastSeenAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

/**
 * Serves every due accept request of one source, inside its SYNC job (design R4, R6). Returns counts only.
 *
 *   claim        pending requests, and live ones whose lease ran out (the fourth claim of a request fails it there)
 *   stored       resumed without a read: the guard is asked again, then upsert and finish
 *   the rest     live keys (nothing live: failed none_readable), then ONE guarded read for all of them
 *   refused      each request finishes failed source_unavailable, which purges what a crashed attempt stored
 *   per request  ledger partition, write-ahead (storing) of the unrouted keys, renew, commit of the keys the write-ahead
 *                returned, stored, candidate upsert (persisted and link-only items), finish
 *
 * Each request is served in its own try/catch (AcceptStepDeps.onRequestError): a failure ends that request's step and
 * not the source's other requests; its claim runs out and the next job takes it again.
 *
 * A request this job no longer holds (a definer answers false) is left alone. A read that was paused (the flags went
 * off, or pg-boss gave up on the job) commits nothing: the lease runs out and the next job claims the request again.
 * Any other failure throws and leaves the claim to expire.
 */
export async function acceptStep(deps: AcceptStepDeps): Promise<AcceptStepResult> {
  const { db, source, token } = deps;
  const lease = deps.lease ?? ACCEPT_LEASE;
  const tally: AcceptStepResult = { claimed: 0, finished: 0 };

  const claimed =
    (await call<AcceptRequest[] | null>(db, 'discovery_claim_model_proposal_accepts', {
      p_source: source.id,
      p_token: token,
      p_lease: lease,
    })) ?? [];
  tally.claimed = claimed.length;
  if (claimed.length === 0) return tally;

  const finish = async (req: AcceptRequest, candidate: string | null, failure: AcceptFailure | null) => {
    const finished = await call<boolean>(db, 'discovery_finish_model_proposal_accept', {
      p_request: req.id,
      p_token: token,
      p_candidate: candidate,
      p_failure: failure,
    });
    if (finished) tally.finished += 1;
  };

  /**
   * Serves one request's step. A failure is the request's alone: it is reported, the source's other requests go on, and
   * the failed one keeps its claim until the lease runs out (the next job claims it again).
   */
  const guarded = async (req: AcceptRequest, serve: () => Promise<void>) => {
    try {
      await serve();
    } catch (error) {
      deps.onRequestError?.(req.id, error);
    }
  };

  /**
   * The candidate, then the finish: the same steps for a fresh serve and for a stored resume. A fresh serve passes the
   * found keys (the group's name and parties come from all of them) and the item ids to link: the ones it persisted and
   * the link-only ones. The stored resume passes neither: it takes the held items routed `model_proposal` for the
   * request's snapshot, which covers what a crashed attempt stored and what an earlier accept already held.
   */
  const link = async (req: AcceptRequest, found: ReadonlySet<string> | undefined, itemIds: readonly string[] | undefined) => {
    let keys = found;
    let items = itemIds;
    if (!items) {
      const held = await heldItems(db, req, [...new Set(req.message_keys)]);
      items = held.itemIds;
      keys = held.keys;
    }
    const group = items.length > 0 && keys ? await groupOf(db, req, keys) : null;
    if (!group) {
      await finish(req, null, 'none_readable');
      return;
    }
    // codenameGuess is null on purpose: nothing a model proposed feeds candidateCodenames (design R6).
    const route = modelProposalRoute();
    const upserted = await call<Array<{ clusterKey: string; candidateId: string }> | null>(db, 'discovery_upsert_candidates', {
      p_tenant_id: req.tenant_id,
      p_run_id: deps.runId,
      p_groups: [
        {
          clusterKey: req.cluster_key,
          proposedName: group.name,
          codenameGuess: null,
          parties: group.parties,
          firstSeenAt: group.firstSeenAt,
          lastSeenAt: group.lastSeenAt,
          confidence: route.confidence,
          links: items.map((sourceItemId) => ({
            sourceItemId,
            method: ROUTE_METHOD.MODEL_PROPOSAL,
            confidence: route.confidence,
          })),
        },
      ],
    });
    const candidate = (upserted ?? []).find((row) => row.clusterKey === req.cluster_key)?.candidateId ?? null;
    await finish(req, candidate, candidate ? null : 'error');
  };

  // 1. A stored request resumes without a read, after the guard and the exclusion policy are asked again.
  const stored = claimed.filter((req) => req.state === 'stored');
  if (stored.length > 0) {
    if (await deps.admitted()) {
      for (const req of stored) await guarded(req, () => link(req, undefined, undefined));
    } else {
      for (const req of stored) await guarded(req, () => finish(req, null, 'source_unavailable'));
    }
  }

  // 2. The rest read: what each may still read (a storing request only what it may already have stored).
  const live = new Map<string, LiveKey[]>();
  for (const req of claimed.filter((r) => r.state !== 'stored')) {
    await guarded(req, async () => {
      const rows =
        (await call<LiveKey[] | null>(db, 'discovery_model_proposal_accept_live_keys', { p_request: req.id, p_token: token })) ??
        [];
      if (rows.length === 0) await finish(req, null, 'none_readable');
      else live.set(req.id, rows);
    });
  }
  const reading = claimed.filter((req) => live.has(req.id));
  if (reading.length === 0) return tally;

  // 3. One guarded read serves them all; every page renews the lease of the requests this job still holds.
  const held = new Set(reading.map((req) => req.id));
  const every = [...live.values()].flat();
  let result: AcceptReadResult;
  try {
    result = await deps.read({
      keys: acceptKeys(every),
      windowFrom: windowFromOf(every),
      pageBudget: deps.pageBudget,
      onPage: async () => {
        for (const id of [...held]) {
          const renewed = await call<boolean>(db, 'discovery_renew_model_proposal_accept', {
            p_request: id,
            p_token: token,
            p_lease: lease,
          });
          if (!renewed) held.delete(id);
        }
        if (held.size === 0) throw new AcceptLeaseLost();
      },
    });
  } catch (error) {
    if (error instanceof AcceptLeaseLost) return tally;
    throw error;
  }

  if (result.status === 'unavailable') {
    for (const req of reading) await guarded(req, () => finish(req, null, 'source_unavailable'));
    return tally;
  }
  // Paused: the flags went off, or pg-boss gave up on this job. Commit nothing; the lease runs out.
  if (result.buffer.stop === 'paused') return tally;

  // 4. Each request commits only its own messages, partitioned by the ledger and written ahead first. One request's
  //    failure (a write-ahead refusing a key that stopped being live, a dropped connection) leaves the others to go on.
  for (const req of reading) {
    if (!held.has(req.id)) continue;
    await guarded(req, async () => {
      const found = foundFor(result.buffer, live.get(req.id)!);
      if (found.size === 0) {
        await finish(req, null, 'none_readable');
        return;
      }
      const { fresh, linkOnly } = await partitionByLedger(db, source, result.buffer, found);
      const itemIds = new Set<string>();
      if (linkOnly.size > 0) for (const id of (await heldItems(db, req, [...linkOnly])).itemIds) itemIds.add(id);

      if (fresh.size > 0) {
        // The write-ahead returns the keys this request may persist (the ones the source does not hold). Null: the
        // token was lost, so this job stops writing for the request. An empty array is valid: nothing to persist.
        const marked = await call<string[] | null>(db, 'discovery_mark_model_proposal_accept_storing', {
          p_request: req.id,
          p_token: token,
          p_keys: [...fresh].sort(),
        });
        if (marked === null) return;
        const persist = new Set(marked.filter((key) => fresh.has(key)));
        if (persist.size > 0) {
          // The lease is checked right before the write: a request this job lost during a long read or a slow earlier
          // request must not be written for. The window that remains is the commit itself (several calls, no token
          // check on the tables it writes): a stalled attempt that passes this check and then stalls can still land
          // text, holder and ledger rows after another job finished and purged the request. Closing it needs a
          // database-side holder check; until then the rows are text no request accounts for, which the orphan
          // collector deletes only once no source holds them.
          const renewed = await call<boolean>(db, 'discovery_renew_model_proposal_accept', {
            p_request: req.id,
            p_token: token,
            p_lease: lease,
          });
          if (!renewed) {
            held.delete(req.id);
            return;
          }
          const persisted = await commitAccepted(db, {
            tenantId: source.tenantId,
            runId: deps.runId,
            buffer: bufferOf(result.buffer, persist),
          });
          for (const id of persisted?.itemIds.values() ?? []) itemIds.add(id);
        }
        const isStored = await call<boolean>(db, 'discovery_mark_model_proposal_accept_stored', { p_request: req.id, p_token: token });
        if (!isStored) return;
      }
      // The group's name and parties come from every key the read found, the rules-routed ones included.
      await link(req, found, [...itemIds]);
    });
  }
  return tally;
}
