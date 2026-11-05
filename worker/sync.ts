// The classification pipeline, one page at a time (phase 4). Part of the
// classification zone: no model is reachable from here (ESLint fence).
//
//   syncSource(source)                        one pg-boss job per source
//     for each page from the source's checkpoint:
//       normalize + route the page             phase 3's code, with the routing
//                                              context carried across pages
//       skipIndexed: drop what this mailbox already processed and routed (#461)
//       persistItems: items, text, provenance, ledger, message index
//       screen the messages the ledger saw first (counts only)
//       content_sources.delta_checkpoint = the page's nextCheckpoint
//   discoverTenant(tenant)                    after the tenant's syncs
//       re-route the tenant's stored items, cluster, persistCandidates
//
// Resume. The checkpoint is written only after the page's rows are, so a
// restart continues after the last page that is fully stored and the reader
// is never asked for an earlier page again. If the process dies between the
// two writes, that one page is read again and its upserts change nothing.
//
// Routing across pages. Phase 3 routed a whole run at once; a page now routes
// with a RoutingContext: the codenames and routed threads of every item
// stored before it (loaded from the database at the start, then grown page by
// page), each with the sources that taught it, so a shared inbox and a person's
// mailbox never route on each other's names (#173 G-09; `admit` in firmRules.ts).
// A reply continues a thread routed on an earlier page, and an alias
// matches a codename first seen earlier. The reverse direction is a known
// limit: an item read BEFORE the item that makes it routable (a reply ahead
// of the message that names the codename, which Graph's delta order allows)
// is ledgered unrouted and its text is not kept (Q5), so it is not recovered.
// Clustering is unaffected: discoverTenant re-routes and clusters everything
// stored, as the phase 3 batch did.
//
// Accept (G-02b #173). A person's accept of a model proposal re-reads a mailbox for a handful of named messages: the
// `accept` option reads like a re-read and keeps, in memory, only the messages whose key and content hash the accept
// names. It writes nothing while it reads (no items, ledger, index, skip, taint or checkpoint, and it never teaches the
// routing context); the caller commits what it buffered (worker/accept.ts, commitAccepted) once it has recorded
// what it is about to store. A message the rules route on their own is left to the normal pass, never buffered.
//
// Expiry (#259 phase 3, R9 and R21). A delta pass whose cursor the provider no
// longer holds (CheckpointExpiredError) is a normal event, not a failure: the
// source is reset to a fresh backfill, and the ledger's keys make the re-read
// duplicate-free. It halts instead when the reset would loop (see
// handleExpiry), with a fixed, content-free last_error.

import type { SupabaseClient } from '@supabase/supabase-js';

import { HISTORY_WINDOW_EXCEEDED, HISTORY_WINDOW_HALT_DAYS, SOURCE_ITEM_KIND, SOURCE_KIND } from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';
import { clusterCandidates } from '@/lib/discovery/discover/cluster';
import {
  dedupeObservations,
  documentKey,
  normalizeDocument,
  normalizeMessage,
  normalizeSubject,
  type Collision,
  type DedupedItem,
  type Observation,
  type Participant,
} from '@/lib/discovery/normalize';
import {
  isSourceArchivedRefusal,
  messageKey,
  persistCandidates,
  persistItems,
  skipIndexed,
  SourceArchivedError,
  type CandidateResult,
} from '@/lib/discovery/persist';
import {
  addsSources,
  codenamesIn,
  modelProposalRoute,
  notePrefixEvidence,
  routeByFirmRules,
  threadKey,
  type PrefixLedger,
  type RouteCounts,
  type RoutedItem,
  type RoutingScope,
} from '@/lib/discovery/route/firmRules';
import { forwardedBlock } from '@/lib/compliance/forwardedBlock';
import { screenIncomingMessage, screeningTally, type IncomingScreenResult } from '@/lib/compliance/screenIncoming';
// Demo-only (#460): the proposal step's type. This file never imports the model gateway (fence B); the step comes
// in built, from classify-once --propose.
import type { PassOutcome, ProposeStep } from '@/lib/discovery/propose/step';
import { isCheckpointExpired } from '@/lib/discovery/source/checkpoint';
import type { ContentSource, MailMessage, SourceRow } from '@/lib/discovery/source/types';
import { errorCodeOf } from '@/lib/errors/upstream';
import { GraphHttpError } from '@/lib/graph/http';
import { MailboxAccessRefusedError } from '@/lib/mailboxAccess/guard';

import { emptyCounts, type PassCounts } from './passRecord';

const PAGE = 1000;
/** Pages per sync job; a longer backfill queues its own continuation. */
export const SYNC_MAX_PAGES = 200;
const IN_CHUNK = 200;

function fail(step: string, error: { message: string; code?: string } | null): void {
  if (isSourceArchivedRefusal(error)) throw new SourceArchivedError();
  if (error) throw new Error(`discovery sync: ${step} failed (${errorCodeOf(error)})`);
}

function inChunks<T>(values: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) out.push(values.slice(i, i + IN_CHUNK));
  return out;
}

// ── Stored items ─────────────────────────────────────────────────────────────

type StoredItemRow = {
  id: string;
  kind: string;
  internet_message_id: string | null;
  drive_item_key: string | null;
  drive_path: string | null;
  conversation_id: string | null;
  subject: string | null;
  sent_at: string | null;
  participants: Participant[] | null;
  content_hash: string;
};

export type StoredItems = {
  items: DedupedItem[];
  /** Stored item id by item key (internetMessageId, or a document's drive: key). */
  itemIds: Map<string, string>;
};

/** Every item the tenant has stored, with its text and every source it was seen in. */
export async function loadStoredItems(db: SupabaseClient, tenantId: string): Promise<StoredItems> {
  const rows: StoredItemRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(TABLE.SOURCE_ITEMS)
      .select(
        'id, kind, internet_message_id, drive_item_key, drive_path, conversation_id, subject, sent_at, participants, content_hash',
      )
      .eq('tenant_id', tenantId)
      .order('id')
      .range(from, from + PAGE - 1);
    fail('source_items read', error);
    rows.push(...((data ?? []) as StoredItemRow[]));
    if (!data || data.length < PAGE) break;
  }

  const ids = rows.map((row) => row.id);
  const texts = new Map<string, string>();
  const observations = new Map<string, Array<{ sourceId: string; providerItemId: string }>>();
  for (const chunk of inChunks(ids)) {
    const { data: textRows, error: textError } = await db
      .from(TABLE.SOURCE_ITEM_TEXTS)
      .select('source_item_id, body_text')
      .in('source_item_id', chunk);
    fail('source_item_texts read', textError);
    for (const row of (textRows ?? []) as Array<{ source_item_id: string; body_text: string }>) {
      texts.set(row.source_item_id, row.body_text);
    }
    const { data: sourceRows, error: sourceError } = await db
      .from(TABLE.SOURCE_ITEM_SOURCES)
      .select('source_item_id, content_source_id, provider_item_id')
      .in('source_item_id', chunk)
      .order('observed_at');
    fail('source_item_sources read', sourceError);
    for (const row of (sourceRows ?? []) as Array<{
      source_item_id: string;
      content_source_id: string;
      provider_item_id: string;
    }>) {
      const list = observations.get(row.source_item_id) ?? [];
      list.push({ sourceId: row.content_source_id, providerItemId: row.provider_item_id });
      observations.set(row.source_item_id, list);
    }
  }

  const itemIds = new Map<string, string>();
  const items: DedupedItem[] = [];
  for (const row of rows) {
    const isDocument = row.kind === SOURCE_ITEM_KIND.DOCUMENT;
    const key = isDocument ? (row.drive_item_key ? documentKey(row.drive_item_key) : null) : row.internet_message_id;
    if (!key) continue;
    itemIds.set(key, row.id);
    const subject = row.subject ?? '';
    items.push({
      item: {
        internetMessageId: key,
        conversationId: row.conversation_id,
        subject,
        threadSubject: normalizeSubject(subject),
        sentAt: row.sent_at,
        participants: Array.isArray(row.participants) ? row.participants : [],
        bodyText: texts.get(row.id) ?? '',
        contentHash: row.content_hash,
        ...(isDocument
          ? { kind: 'document' as const, driveItemKey: row.drive_item_key ?? undefined, drivePath: row.drive_path ?? undefined }
          : {}),
      },
      observations: observations.get(row.id) ?? [],
    });
  }
  return { items, itemIds };
}

async function candidateCodenames(db: SupabaseClient, tenantId: string): Promise<Array<{ key: string; codename: string }>> {
  const { data, error } = await db
    .from(TABLE.DEAL_CANDIDATES)
    .select('codename_guess')
    .eq('tenant_id', tenantId)
    .not('codename_guess', 'is', null);
  fail('candidate read', error);
  return ((data ?? []) as Array<{ codename_guess: string }>).flatMap((row) => codenamesIn(row.codename_guess));
}

// ── Routing context ──────────────────────────────────────────────────────────

/** A codename, or a codename on a thread, with the sources whose mail wrote its literal "Project <Name>". */
type Learned = { codename: string; taughtIn: Set<string> };

/**
 * What earlier pages (and earlier runs) teach the router: codenames and routed threads, each with the sources that
 * taught it (#173 G-09). Only a literal "Project <Name>" route adds sources; an alias or thread route adds none (a
 * thread it extends inherits what the key was taught in), and a subject prefix route teaches nothing at all (#622).
 * `scope` is the source scope every route made with this context is held to. A bare `new RoutingContext()` is
 * 'unscoped' (the tests that do not care); the worker builds its context only through loadRoutingContext, which sets
 * the tenant's real scope, and a static pin (worker-scope-pins.test.ts) holds it to that.
 */
export class RoutingContext {
  readonly codenames = new Map<string, Learned>();
  readonly threads = new Map<string, Map<string, Learned>>();
  /** The firm's own domains: the subject prefix rule counts only firm senders, and is off without them (#622). */
  internalDomains: string[] = [];
  scope: RoutingScope = 'unscoped';
  /**
   * G-02b (#173): per source, the message keys (sha256 of the Internet message id) a person's accept made durable. Exact
   * messages only: they route the one message, in the one source, and teach nothing (see withModelRoutes).
   */
  readonly modelKeys = new Map<string, Set<string>>();

  addModelKeys(sourceId: string, keys: Iterable<string>): void {
    const known = this.modelKeys.get(sourceId) ?? new Set<string>();
    for (const key of keys) known.add(key);
    if (known.size > 0) this.modelKeys.set(sourceId, known);
  }

  /**
   * The durable half of an accept: a message the rules routed nothing for, read from a source where a person accepted
   * it, keeps its `model_proposal` route, so a later pass does not flip it back to unrouted. A message the rules route
   * keeps the rules' routes. Documents and messages seen in another source too are left alone.
   */
  withModelRoutes(sourceId: string, routed: RoutedItem[]): RoutedItem[] {
    const keys = this.modelKeys.get(sourceId);
    if (!keys) return routed;
    return routed.map((entry) =>
      entry.routes.length === 0 &&
      entry.item.kind !== SOURCE_ITEM_KIND.DOCUMENT &&
      entry.observations.length > 0 &&
      entry.observations.every((o) => o.sourceId === sourceId) &&
      keys.has(messageKey(entry.item.internetMessageId))
        ? { ...entry, routes: [modelProposalRoute()] }
        : entry,
    );
  }

  /**
   * Subject prefix evidence per source, from every item routed so far, stored or unrouted, but never a collision the
   * store refused (#173 G-09): a prefix's two topics and two senders may fall on different pages. The prefix word and
   * keyed digests of topics and senders, with counts (firmRules.ts `PrefixEvidence`); bounded per source; held in
   * memory for this context's life, never written, logged or counted.
   */
  readonly prefixEvidence: PrefixLedger = new Map();
  /**
   * Sources archived on disconnect or withdrawal, records kept (#173 G-09 3b): they still refuse (they stay observers,
   * and a shared one stays shared) but never teach a key or a thread, nor add prefix evidence. See routingInputs.
   */
  archived: ReadonlySet<string> = new Set();

  /** Knows the codename without any provenance: it admits nothing on a scoped route until a literal teaches it. */
  addCodename(key: string, codename: string): void {
    if (!this.codenames.has(key)) this.codenames.set(key, { codename, taughtIn: new Set() });
  }

  learn(routed: RoutedItem[]): void {
    // A subject prefix route teaches nothing: it stays in its own mailbox and never reaches bodies (#622). Nor does an
    // accepted model proposal's route (`teaches: false`, G-02b #173): no codename, thread or alias comes from it.
    const teachingOf = (entry: RoutedItem) => entry.routes.filter((route) => !route.fromSubjectPrefix && route.teaches !== false);
    // Literals first, so every key this batch teaches holds its sources before a thread inherits them.
    for (const entry of routed) {
      for (const route of teachingOf(entry)) {
        this.addCodename(route.codenameKey, route.codename);
        if (!addsSources(route)) continue;
        const known = this.codenames.get(route.codenameKey)!;
        for (const { sourceId } of entry.observations) if (!this.archived.has(sourceId)) known.taughtIn.add(sourceId);
      }
    }
    for (const entry of routed) {
      const teaching = teachingOf(entry);
      if (teaching.length === 0) continue;
      const key = threadKey(entry.item);
      if (!key) continue;
      const codenames = this.threads.get(key) ?? new Map<string, Learned>();
      for (const route of teaching) {
        const taught = codenames.get(route.codenameKey) ?? { codename: route.codename, taughtIn: new Set<string>() };
        taught.codename = route.codename;
        const from = addsSources(route)
          ? entry.observations.map((o) => o.sourceId).filter((sourceId) => !this.archived.has(sourceId))
          : [...(this.codenames.get(route.codenameKey)?.taughtIn ?? [])];
        for (const sourceId of from) taught.taughtIn.add(sourceId);
        codenames.set(route.codenameKey, taught);
      }
      this.threads.set(key, codenames);
    }
  }

  options() {
    return {
      knownCodenames: [...this.codenames].map(([key, { codename, taughtIn }]) => ({ key, codename, taughtIn })),
      knownThreads: this.threads,
      knownPrefixEvidence: this.prefixEvidence,
      internalDomains: this.internalDomains,
      scope: this.scope,
      archived: this.archived,
    };
  }

  /**
   * Adds the prefix evidence of items the router saw, routed or not, so a later page can promote a prefix whose
   * evidence this page started. `sourceOwners` is sourceId -> the mailbox's own address (the owner clause, #653).
   */
  notePrefixes(items: ReadonlyArray<DedupedItem>, sourceOwners: ReadonlyMap<string, string>): void {
    const live =
      this.archived.size === 0
        ? items
        : items.map((entry) => ({ ...entry, observations: entry.observations.filter((o) => !this.archived.has(o.sourceId)) }));
    notePrefixEvidence(this.prefixEvidence, live, this.internalDomains, sourceOwners);
  }
}

/**
 * The bootstrap, pure: a context from what the tenant already stored. The candidates' codenames are known without
 * provenance, so they admit nothing when scoped; the stored items' own literals teach, as they did when they were read.
 * With `firm`, the stored items also seed the subject prefix evidence: across runs, only stored mail is evidence,
 * because mail that routed nowhere keeps nothing (Q5).
 */
export function contextFromStored(
  items: DedupedItem[],
  known: Array<{ key: string; codename: string }>,
  scope: RoutingScope,
  firm?: { internalDomains: string[]; sourceOwners: ReadonlyMap<string, string>; archived?: ReadonlySet<string> },
): RoutingContext {
  const context = new RoutingContext();
  context.scope = scope;
  context.archived = firm?.archived ?? new Set();
  for (const { key, codename } of known) context.addCodename(key, codename);
  context.learn(routeByFirmRules(items, { knownCodenames: known, scope, archived: context.archived }));
  if (firm) {
    context.internalDomains = firm.internalDomains;
    context.notePrefixes(items, firm.sourceOwners);
  }
  return context;
}

/** A finished accept's write-ahead keys, with its source: the messages it may have stored (G-02b #173). */
export type DoneAccept = { sourceId: string; keys: readonly string[] };

/**
 * Pure: the accepted messages that are still held, by source. Of a done accept's write-ahead keys, only those whose
 * stored item this source still holds: the finish purged the holder row of every key it did not link, so a purged
 * message is never routed durably (it would be stored again).
 */
export function heldAcceptedKeys(items: readonly DedupedItem[], accepts: readonly DoneAccept[]): Map<string, Set<string>> {
  const bySource = new Map<string, Set<string>>();
  for (const { sourceId, keys } of accepts) {
    const wanted = new Set(keys);
    for (const { item, observations } of items) {
      if (item.kind === SOURCE_ITEM_KIND.DOCUMENT || !observations.some((o) => o.sourceId === sourceId)) continue;
      const key = messageKey(item.internetMessageId);
      if (!wanted.has(key)) continue;
      const held = bySource.get(sourceId) ?? new Set<string>();
      held.add(key);
      bySource.set(sourceId, held);
    }
  }
  return bySource;
}

async function doneAccepts(db: SupabaseClient, tenantId: string): Promise<DoneAccept[]> {
  const out: DoneAccept[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(TABLE.DISCOVERY_MODEL_PROPOSAL_ACCEPTS)
      .select('content_source_id, storing_keys')
      .eq('tenant_id', tenantId)
      .eq('state', 'done')
      .order('id')
      .range(from, from + PAGE - 1);
    fail('model proposal accepts read', error);
    const rows = (data ?? []) as Array<{ content_source_id: string; storing_keys: string[] | null }>;
    for (const row of rows) out.push({ sourceId: row.content_source_id, keys: row.storing_keys ?? [] });
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * The context of everything the tenant stored before this run: its candidates' codenames and its routed items, and the
 * messages a person's accept made durable (G-02b #173), which keep their non-teaching `model_proposal` route.
 */
export async function loadRoutingContext(db: SupabaseClient, tenantId: string): Promise<RoutingContext> {
  const sources = await firmSources(db, tenantId);
  const known = await candidateCodenames(db, tenantId);
  const { items } = await loadStoredItems(db, tenantId);
  const { internalDomains, sourceOwners, shared, archived } = routingInputs(sources);
  const context = contextFromStored(items, known, { shared }, { internalDomains, sourceOwners, archived });
  for (const [sourceId, keys] of heldAcceptedKeys(items, await doneAccepts(db, tenantId))) context.addModelKeys(sourceId, keys);
  return context;
}

// ── Sync one source ──────────────────────────────────────────────────────────

export type SyncSource = SourceRow & {
  backfillCompletedAt: string | null;
  /** When the current or last backfill began; kept after it completes (expiry bookkeeping). */
  backfillStartedAt?: string | null;
  /** Consecutive resets whose expiry came right after a backfill. */
  historyExpiryStreak?: number;
  /** When the last sync finished. Equal to backfillCompletedAt until a delta pass completes. */
  lastSyncedAt?: string | null;
  /**
   * G-01 (#173): a team inbox's firm company, read by runOnce only when a firm is approved for team proposals. Absent
   * for a person's mailbox and whenever no firm is approved, which keeps a team inbox out of the proposal step.
   */
  teamFirmCompanyId?: string | null;
};

export type SyncOptions = {
  source: SyncSource;
  reader: ContentSource;
  runId: string;
  context: RoutingContext;
  /** Checked after every page; false stops the sync there (discovery_worker_enabled off). */
  shouldContinue?: () => Promise<boolean>;
  /** Stop after this many pages, so one job stays short; the caller queues the rest. */
  maxPages?: number;
  /** The attempt's counts (#370), written in place so a throw mid-pass still reports what was done. */
  counts?: PassCounts;
  /**
   * A full re-read (#460, classify-once --recount): the source is read from the start on a copy whose checkpoint is
   * null, and nothing of its resume state or health is written (delta_checkpoint, checkpoint_updated_at,
   * backfill_started_at, backfill_completed_at, last_synced_at, last_error). The serve loop owns those, so it resumes
   * from what it left whether the re-read completes, fails or is killed. Items, the ledger and the pass record are
   * written as on any pass: they are idempotent upserts. The message index's skip rule (#461) is off for it, so
   * every message the reader returns is routed, stored and counted again, unchanged mail included; a `propose` run
   * is a re-read too (see `skipsIndexed` in syncSource).
   */
  reread?: boolean;
  /** What the pass read and how it routed (#460), written in place like counts so a stop mid-pass still reports it. */
  read?: ReadTally;
  /**
   * Demo-only (#460, classify-once --propose; delete with #459): each page's messages go to this step in
   * memory, after the page is stored, and never rest anywhere. A propose run is always a re-read (above), so it moves
   * no checkpoint whether it completes, fails or is killed. A team inbox, or a source with no owner, is re-read like
   * any other but never handed to the step (ADR-0026 exclusion 4), unless the inbox's firm company is in the step's
   * teamFirms: both halves of the team_proposals switch (G-01 #173).
   */
  propose?: ProposeStep;
  /**
   * G-02b (#173): a keyed read for a person's accept of a model proposal. Implies `reread`, so it moves no resume state
   * and writes no health. Of every page it keeps, in memory, the messages `accept.keys` names with the content hash
   * accepted, and returns them uncommitted in `result.accepted`. It stores, ledgers, indexes and learns nothing, and it
   * records no skip or taint (the regular sync still does). It is exclusive with `propose`, `maxPages` is ignored in
   * favour of `accept.pageBudget`, and the caller commits the buffer (worker/accept.ts).
   */
  accept?: AcceptRead;
};

export type AcceptRead = {
  /** The accepted messages: message key (sha256 of the Internet message id) to the content hashes accepted for it. */
  keys: ReadonlyMap<string, ReadonlySet<string>>;
  /** The first day (`YYYY-MM-DD`, UTC) to read from, never earlier than the source's own window. Gmail honours it. */
  windowFrom?: string;
  /** Stop after this many pages; what was found is returned (`stop: 'budget'`). */
  pageBudget: number;
  /** Called after every page that is buffered: the caller renews its lease here. A throw ends the read. */
  onPage?: () => Promise<void>;
};

/**
 * What an accept read kept, in memory (G-02b #173). Counts leave it; the message keys and text never do: nothing here
 * is logged, and nothing is written until the caller commits it.
 */
export type AcceptBuffer = {
  /** The keyed, hash-matching messages with no route yet, one entry per message key, with every sighting read. */
  items: Map<string, RoutedItem>;
  /** Sightings of an accepted message that collided with another of the same id in their page (ledgered as skipped). */
  collisions: Collision[];
  /** Each kept message's screen tags by Internet message id, for the message index. */
  tags: Map<string, string[]>;
  /** The accepted keys the read has found with their accepted hash: the early stop's progress. */
  seen: Set<string>;
  /** Accepted messages seen only with a different content hash than accepted: changed since the proposal. */
  changed: number;
  /** Accepted messages the rules routed on their own: left to the normal pass, never buffered. */
  leftToRules: number;
  /** Why the read ended: it ran out of mail, saw every key, spent the budget, or was told to pause. */
  stop: 'end' | 'all_seen' | 'budget' | 'paused' | null;
};

export function emptyAcceptBuffer(): AcceptBuffer {
  return { items: new Map(), collisions: [], tags: new Map(), seen: new Set(), changed: 0, leftToRules: 0, stop: null };
}

/** The later of two `YYYY-MM-DD` days; a missing or malformed one yields the other. */
function laterDay(a: string | null | undefined, b: string | undefined): string | null {
  const ok = (day: string | null | undefined): day is string => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day);
  if (ok(a) && ok(b)) return a >= b ? a : b;
  return ok(b) ? b : (a ?? null);
}

/**
 * Keeps, of a page's sightings, those the accept names with the hash it accepted. The filter runs BEFORE the dedupe, so
 * an unaccepted copy of a Message-ID that comes first cannot take the id from the accepted copy (the first sighting of
 * an id is the one dedupe keeps). A key is seen only when its accepted hash was found: a key whose copies all carry
 * other hashes stays unseen, so the read goes on looking for it, and counts once as changed (`changedOnly` holds those
 * keys across pages; `buffer.changed` is its size less the keys seen since). Documents are never accepted.
 *
 * Collisions are the page's own full dedupe (what the normal pass would ledger, `pageCollisions`), kept only for an
 * accepted key and never for a sighting that is itself kept here, so no provider item gets both a route and a skip row.
 */
function keepAccepted(
  accept: AcceptRead,
  buffer: AcceptBuffer,
  changedOnly: Set<string>,
  observations: readonly Observation[],
  pageCollisions: readonly Collision[],
): { items: DedupedItem[]; collisions: Collision[] } {
  const matching: Observation[] = [];
  for (const observation of observations) {
    if (observation.item.kind === SOURCE_ITEM_KIND.DOCUMENT) continue;
    const key = messageKey(observation.item.internetMessageId);
    const hashes = accept.keys.get(key);
    if (!hashes) continue;
    if (hashes.has(observation.item.contentHash)) {
      matching.push(observation);
      buffer.seen.add(key);
    } else {
      changedOnly.add(key);
    }
  }
  const { items } = dedupeObservations(matching);
  for (const key of buffer.seen) changedOnly.delete(key);
  buffer.changed = changedOnly.size;
  const keptSightings = new Set(items.flatMap((entry) => entry.observations.map((o) => `${o.sourceId}\u0000${o.providerItemId}`)));
  return {
    items,
    collisions: pageCollisions.filter(
      (c) => accept.keys.has(messageKey(c.key)) && !keptSightings.has(`${c.sourceId}\u0000${c.providerItemId}`),
    ),
  };
}

/** Adds the page's kept messages that no rule routed to the buffer; a message already buffered gains its new sightings. */
function bufferAccepted(
  buffer: AcceptBuffer,
  routed: readonly RoutedItem[],
  tags: ReadonlyMap<string, readonly string[]>,
  collisions: readonly Collision[],
): void {
  for (const entry of routed) {
    if (entry.routes.length > 0) {
      buffer.leftToRules += 1;
      continue;
    }
    const key = messageKey(entry.item.internetMessageId);
    const held = buffer.items.get(key);
    if (held) {
      for (const o of entry.observations) {
        if (!held.observations.some((h) => h.sourceId === o.sourceId && h.providerItemId === o.providerItemId)) {
          held.observations.push(o);
        }
      }
    } else {
      buffer.items.set(key, { ...entry, observations: [...entry.observations], routes: [] });
    }
    const entryTags = tags.get(entry.item.internetMessageId);
    if (entryTags) buffer.tags.set(entry.item.internetMessageId, [...entryTags]);
  }
  buffer.collisions.push(...collisions);
}

/**
 * What routing decided for the sightings a pass read (#460): the same unit as itemsRead, split so that
 * routed + unrouted + skipped + collisions === itemsRead. Counts only; the codename keys come from mail text, so they
 * stay in memory and only their number is ever printed.
 */
export type RoutingTally = {
  /** Sightings of items a rule routed and the page stored (ledgered routed). */
  routed: number;
  /** Sightings of items no rule routed (ledgered unrouted; their text is not kept). */
  unrouted: number;
  /** Items the reader skipped (policy exclusions and its other skips). */
  skipped: number;
  /** Id collisions, within the page or with a stored item (ledgered skipped, id_collision). */
  collisions: number;
  /** Distinct codename keys among the stored routed items. In memory only, never logged. */
  codenameKeys: Set<string>;
  /** Alias and thread routes a source scope refused (#173 G-09). A count: it is outside the partition above. */
  scopeBlocked: number;
};

export function emptyRoutingTally(): RoutingTally {
  return { routed: 0, unrouted: 0, skipped: 0, collisions: 0, codenameKeys: new Set(), scopeBlocked: 0 };
}

/** The pass's itemsRead and its routing split, kept together so they always add up (#460). */
export type ReadTally = { itemsRead: number; routing: RoutingTally };

export function emptyReadTally(): ReadTally {
  return { itemsRead: 0, routing: emptyRoutingTally() };
}

/**
 * Adds one page to the tally. A routed item whose id collided with a stored one is not stored: its sightings are
 * among persistItems' collisions, so it is counted there and not as routed.
 */
function tallyPage(
  tally: RoutingTally,
  routed: readonly RoutedItem[],
  stored: { storedKeys: readonly string[]; collisions: readonly unknown[] },
  skipped: number,
): void {
  const storedKeys = new Set(stored.storedKeys);
  for (const entry of routed) {
    if (entry.routes.length === 0) {
      tally.unrouted += entry.observations.length;
    } else if (storedKeys.has(entry.item.internetMessageId)) {
      tally.routed += entry.observations.length;
      // A model_proposal route has no codename: it adds none to the count.
      for (const route of entry.routes.filter((r) => r.teaches !== false)) tally.codenameKeys.add(route.codenameKey);
    }
  }
  tally.skipped += skipped;
  tally.collisions += stored.collisions.length;
}

export type SyncResult = {
  /**
   * `reset`: the incremental cursor expired and the source will backfill again;
   * the caller queues the next job. `halted`: it expired in a way a reset would
   * only repeat; nothing more is queued.
   */
  status: 'complete' | 'paused' | 'page_limit' | 'reset' | 'halted';
  mode: 'backfill' | 'delta';
  pages: number;
  itemsRead: number;
  storedKeys: Set<string>;
  /** At least one checkpoint write succeeded in this attempt; a reset's cleared checkpoint shows in status, not here. */
  checkpointAdvanced: boolean;
  /**
   * Incoming-mail screening (plan v5 W3): messages the send-time rules read on
   * each page, each once (the first time the ledger sees it), and how many they
   * flag. Counts only: no content, nothing stored,
   * until the data plane holds results (ADR-0017, #264). Rules only (#270).
   */
  screening: { screened: number; flagged: number };
  /**
   * Counts, never ids, summed from the reader's pages as they arrive (#344 R12 / gate G2, #370 R2-M1): bodies that
   * crossed the wire (content retrieved), and messages the exclusion policy (#263) excluded before any content
   * request. An excluded message is never also fetched. A reader that does not count adds 0.
   */
  fetched: number;
  excluded: number;
  /**
   * Sightings skipped because this mailbox already indexed them under the same digest and rules version (#461).
   * Outside itemsRead and outside #460's routed + unrouted + skipped + collisions partition: a skipped sighting is
   * counted here and nowhere else.
   */
  unchanged: number;
  /** What routing decided for the sightings itemsRead counts (#460). */
  routing: RoutingTally;
  /** The pass read the whole source: a backfill from a null checkpoint that completed (#460). */
  fullRead: boolean;
  /** An accept read's buffer (G-02b #173), filled in place, so it is on every return of the read; absent otherwise. */
  accepted?: AcceptBuffer;
};

/** A reader's page count, or 0 when it is unset or not a non-negative integer. */
const countOf = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0);

/** The fixed last_error codes of a failure that is not a Graph response. */
export const SYNC_ERROR = {
  CHECKPOINT: 'Checkpoint unreadable',
  DATABASE: 'Database error',
  /** Google's token endpoint refused the delegation (e.g. unauthorized_client): an admin fixes it in the Workspace console. */
  DELEGATION: 'Google delegation refused',
  /** Google's token endpoint failed without refusing (a 5xx or another status): not the admin's to fix; the job retries. */
  TOKEN_UNAVAILABLE: 'Google token endpoint unavailable',
  /** A provider or credential call outlived its deadline (src/lib/google/reader/{credentials,http,token}.ts); the job retries. */
  TIMEOUT: 'Request timed out',
  /** A live tenant with no exclusion policy version: one audited write (even an empty policy) connects it (#263). */
  NO_EXCLUSION_POLICY: 'No exclusion policy',
  /** The tenant's current exclusion policy fails validation, so nothing is read under it. */
  INVALID_EXCLUSION_POLICY: 'Exclusion policy invalid',
  WORKER: 'Worker error',
} as const;

/**
 * A one-line, content-free description of a failure, for content_sources.last_error,
 * which admins read through the health RPC (Q19). Graph's status and code pass
 * through; any other message is reduced to a fixed code, since a database or
 * extractor message can quote values from the data.
 */
export function errorSummary(error: unknown): string {
  if (error instanceof GraphHttpError) {
    return `Graph ${error.status}${error.code ? ` ${error.code}` : ''}${error.throttled ? ' (throttled)' : ''}`;
  }
  // Matched by name, not by class: the worker may not import the Google reader (fence).
  // GoogleHttpError carries a status and Google's machine reason only, never a body.
  if (error instanceof Error && error.name === 'GoogleHttpError') {
    const { status, reason } = error as Error & { status?: number; reason?: string | null };
    return `Google ${status ?? ''}${reason ? ` ${reason}` : ''}`.trim();
  }
  // A refused delegation (400/401/403, the same gate the reader pass record uses for delegation_refused,
  // worker/passRecord.ts) is the admin's to fix, so it is named; any other status is an outage. Its reason and any body
  // stay out.
  if (error instanceof Error && error.name === 'GoogleTokenError') {
    const { status } = error as Error & { status?: number };
    return status === 400 || status === 401 || status === 403 ? SYNC_ERROR.DELEGATION : SYNC_ERROR.TOKEN_UNAVAILABLE;
  }
  // AbortSignal.timeout and boundedCallerToken reject with a DOMException named TimeoutError; matched by name only.
  if ((error as { name?: unknown } | null)?.name === 'TimeoutError') return SYNC_ERROR.TIMEOUT;
  // Neither carries rule content, so the admin sees the code and nothing of the policy.
  if (error instanceof Error && error.name === 'NoExclusionPolicyError') return SYNC_ERROR.NO_EXCLUSION_POLICY;
  if (error instanceof Error && error.name === 'InvalidExclusionPolicyError') return SYNC_ERROR.INVALID_EXCLUSION_POLICY;
  const message = error instanceof Error ? error.message : '';
  if (/^graph (mail|drive) reader: the checkpoint /.test(message)) return SYNC_ERROR.CHECKPOINT;
  if (/^gmail reader: unreadable checkpoint/.test(message)) return SYNC_ERROR.CHECKPOINT;
  if (/^discovery (persist|sync): /.test(message)) return SYNC_ERROR.DATABASE;
  return SYNC_ERROR.WORKER;
}

async function updateSource(db: SupabaseClient, sourceId: string, patch: Record<string, unknown>, step: string): Promise<void> {
  const { error } = await db.from(TABLE.CONTENT_SOURCES).update(patch).eq('id', sourceId);
  fail(step, error);
}

/**
 * The first read's claim (#353, audit r1 item 1), for GuardedReaderContext.claimFirstRead: marks the read started and
 * returns the window the database holds, in one statement. discovery_set_mailbox_source_window() locks the row and
 * refuses once backfill_started_at is set, so an admin's change either lands before the claim and is read, or is
 * refused; it can never be audited while the reader reads another date. An archived source matches no row and gets no
 * write (#262), and the read stops as an archived one. syncSource still writes its own start with the first checkpoint.
 */
export function firstReadClaim(db: SupabaseClient, source: { id: string; tenantId: string }): () => Promise<string | null> {
  return async () => {
    const { data, error } = await db
      .from(TABLE.CONTENT_SOURCES)
      .update({ backfill_started_at: new Date().toISOString() })
      .eq('id', source.id)
      .eq('tenant_id', source.tenantId)
      .is('archived_at', null)
      .select('backfill_since');
    fail('first read claim', error);
    const row = (data as Array<{ backfill_since: string | null }> | null)?.[0];
    if (!row) throw new SourceArchivedError();
    return row.backfill_since;
  };
}

function daysBetween(from: string | null | undefined, to: string | null | undefined): number {
  if (!from || !to) return 0;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms > 0 ? ms / 86_400_000 : 0;
}

/**
 * The expired cursor is the first one since the backfill: no delta pass has
 * completed since it, so the last sync is the backfill's own completion (the
 * two are written with one timestamp).
 */
function justCompletedBackfill(source: SyncSource): boolean {
  if (!source.backfillCompletedAt || !source.lastSyncedAt) return false;
  return Date.parse(source.lastSyncedAt) === Date.parse(source.backfillCompletedAt);
}

/**
 * The provider dropped a delta cursor (R9, R21). Reset the source to a fresh
 * backfill, keeping backfill_started_at, and count the reset when it followed a
 * backfill directly. Halt instead, with a fixed code, when a reset would only
 * repeat:
 *   - the last backfill took longer than the provider's history window allows
 *     (HISTORY_WINDOW_HALT_DAYS), so a new one cannot catch up either; or
 *   - two backfills in a row were each followed by an expired cursor.
 * A successful delta pass zeroes the streak.
 */
async function handleExpiry(db: SupabaseClient, source: SyncSource, result: SyncResult): Promise<SyncResult> {
  const streak = (source.historyExpiryStreak ?? 0) + (justCompletedBackfill(source) ? 1 : 0);
  const backfillDays = daysBetween(source.backfillStartedAt, source.backfillCompletedAt);
  const now = new Date().toISOString();
  if (backfillDays > HISTORY_WINDOW_HALT_DAYS || streak >= 2) {
    await updateSource(
      db,
      source.id,
      { last_error: HISTORY_WINDOW_EXCEEDED, last_error_at: now, history_expiry_streak: streak },
      'expiry halt',
    );
    source.historyExpiryStreak = streak;
    return { ...result, status: 'halted' };
  }
  await updateSource(
    db,
    source.id,
    { delta_checkpoint: null, backfill_completed_at: null, history_expiry_streak: streak, last_error: null, last_error_at: null },
    'expiry reset',
  );
  source.deltaCheckpoint = null;
  source.backfillCompletedAt = null;
  source.historyExpiryStreak = streak;
  return { ...result, status: 'reset' };
}

/**
 * Incoming-mail screening of one page (plan v5 W3): the send-time rules on each
 * message, including the block a forward carries (read apart from
 * normalization). Observe-only: it stores nothing, so it must never stall
 * ingestion (Martin's review of PR #405). Each message is screened on its own,
 * so one that fails is counted as unscreened and the rest still count; the
 * failures are reported on a content-free warn line (source id and a count).
 * A repeated Message-ID keeps its first sighting's forwarded block, the same
 * sighting dedupe keeps (Guillermo's review of PR #416). It returns each
 * message's result, so the caller counts only the items persistItems saw first
 * (a message is counted once), and each message's tags for the message index
 * (#461): the kinds of its reasons, never the terms.
 */
function screenPage(
  sourceId: string,
  raw: readonly MailMessage[],
  items: readonly DedupedItem[],
): { results: Map<string, IncomingScreenResult>; tags: Map<string, string[]> } {
  let failed = 0;
  const forwarded = new Map<string, string>();
  const seen = new Set<string>();
  for (const message of raw) {
    const id = (message.internetMessageId ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try {
      const block = forwardedBlock(message);
      if (block) forwarded.set(id, block);
    } catch {
      // Screened without its forwarded block; normalization never had it either.
    }
  }
  const results = new Map<string, IncomingScreenResult>();
  const tags = new Map<string, string[]>();
  for (const { item } of items) {
    if (item.kind === 'document') continue;
    try {
      const result = screenIncomingMessage(item, forwarded.get(item.internetMessageId));
      results.set(item.internetMessageId, result);
      tags.set(item.internetMessageId, screenTags(result.reasons));
    } catch {
      failed += 1;
    }
  }
  if (failed > 0) console.warn(JSON.stringify({ evt: 'screen_failed', source: sourceId, count: failed }));
  return { results, tags };
}

const TAG_KINDS: ReadonlySet<string> = new Set(['mnpi', 'promissory']);

/** A screen's reasons ("mnpi: walk-away") as index tags: the kind before the colon, never the matched term. */
export function screenTags(reasons: readonly string[]): string[] {
  return [...new Set(reasons.map((reason) => reason.split(':', 1)[0].trim()).filter((kind) => TAG_KINDS.has(kind)))].sort();
}

/**
 * Who the proposal step may read: a person's own mailbox, or a team inbox of a firm approved in both halves. A first
 * filter only: the step asks SQL about every source it is handed before any model call, and SQL decides from the
 * source row whether it is a team inbox (review F7).
 */
function proposeHandOff(step: ProposeStep | undefined, source: SyncSource): ProposeStep | undefined {
  if (!step) return undefined;
  if (!source.teamMailboxId) return source.ownerUserId ? step : undefined;
  return source.teamFirmCompanyId && step.teamFirms.has(source.teamFirmCompanyId) ? step : undefined;
}

/**
 * How a read that threw ended, for the pass the proposal step may hold on the source. An expired delta cursor resets
 * the source, which is no failure: the read stopped part way, as a pause does (review F10).
 */
export function passOutcomeOfError(error: unknown, mode: SyncResult['mode']): PassOutcome {
  if (mode === 'delta' && isCheckpointExpired(error)) return 'paused';
  if (error instanceof SourceArchivedError) return 'archived';
  if (error instanceof MailboxAccessRefusedError) return 'refused';
  return 'error';
}

export async function syncSource(db: SupabaseClient, options: SyncOptions): Promise<SyncResult> {
  const { reader, runId, context } = options;
  // A re-read starts from nothing on a copy: the caller's row keeps its checkpoint, in memory and in the database.
  const accept = options.accept;
  if (accept && options.propose) throw new Error('discovery sync: an accept read and a proposal run are exclusive');
  const reread = options.reread === true || options.propose !== undefined || accept !== undefined;
  // ADR-0026 exclusion 4: the proposal step reads a person's own mailbox only. A team inbox, or a source with no
  // owner, is read and routed as usual but never handed to the step, so none of its text reaches a model. The one
  // exception is a team inbox whose firm company is in the step's teamFirms (G-01 #173): the reviewed TS list and a
  // live team_proposals row, both, worked out before the step was built. SQL checks them again at every pass.
  const propose = proposeHandOff(options.propose, options.source);
  if (options.propose && !propose) options.propose.noteSkipped(options.source.id);
  // An accept read narrows the copy's window to the day its earliest message was sent, never past the source's own
  // (backfillSince is read from the copy by the reader and written nowhere: a re-read claims nothing, readOneSource).
  const source: SyncSource = reread
    ? {
        ...options.source,
        deltaCheckpoint: null,
        backfillCompletedAt: null,
        ...(accept ? { backfillSince: laterDay(options.source.backfillSince, accept.windowFrom) } : {}),
      }
    : options.source;
  const mode: SyncResult['mode'] = source.backfillCompletedAt && source.deltaCheckpoint ? 'delta' : 'backfill';
  const fromNothing = mode === 'backfill' && source.deltaCheckpoint === null;
  const counts = options.counts ?? emptyCounts();
  const read = options.read ?? emptyReadTally();
  const result: SyncResult = {
    status: 'complete',
    mode,
    pages: 0,
    itemsRead: 0,
    storedKeys: new Set(),
    screening: { screened: 0, flagged: 0 },
    checkpointAdvanced: false,
    fetched: 0,
    excluded: 0,
    unchanged: 0,
    routing: read.routing,
    fullRead: false,
  };
  if (accept) result.accepted = emptyAcceptBuffer();
  // The accepted keys whose only copies read so far carry another hash: counted once as changed (see keepAccepted).
  const acceptChangedOnly = new Set<string>();

  // A backfill that starts from nothing is timed from here (R21); a resumed one keeps its start.
  // The start is written with the first progress the source records (its first checkpoint, or
  // the completion), never on its own: a source archived before its first page is stored gets
  // no write at all (#262: late writes to an archived source are refused).
  let startedAt: string | null = mode === 'backfill' && source.deltaCheckpoint === null ? new Date().toISOString() : null;
  const withStart = <T extends Record<string, unknown>>(patch: T): T => {
    if (startedAt === null) return patch;
    const stamped = { ...patch, backfill_started_at: startedAt, send_census_from: null };
    source.backfillStartedAt = startedAt;
    startedAt = null;
    return stamped;
  };

  // The skip applies only to a pass that cannot be a recount of the mailbox: a delta pass, which `mode` makes only
  // when the backfill is complete AND the pass starts from a stored checkpoint. That excludes the initial backfill,
  // a resumed backfill, an expired-cursor re-backfill (handleExpiry clears delta_checkpoint and
  // backfill_completed_at) and a halted-source restart (discovery_restart_mailbox_source clears both too). A
  // re-read never skips, and a `--propose` run is a re-read (`reread` above), so it never skips either. A pass that
  // re-reads the mailbox must see, route and count every message, skipped-before or not.
  const skipsIndexed = mode === 'delta' && !reread;

  const pages =
    mode === 'delta' ? reader.delta(source, source.deltaCheckpoint!) : reader.backfill(source, source.deltaCheckpoint);

  // How the read ended, for the proposal step's pass on this source (G-01 #173).
  let proposeOutcome: PassOutcome = 'complete';
  try {
    for await (const page of pages) {
      // Counted on arrival, before the page is persisted: what was read is reported even if storing it fails.
      result.fetched += countOf(page.fetched);
      result.excluded += countOf(page.excluded);
      counts.fetched = result.fetched;
      counts.excluded = result.excluded;
      const observations: Observation[] = [
        ...page.items.map((message) => ({
          sourceId: source.id,
          providerItemId: message.id,
          ...(message.providerThreadId !== undefined ? { providerThreadId: message.providerThreadId } : {}),
          ...(message.send ? { send: message.send } : {}),
          item: normalizeMessage(message),
        })),
        ...(page.documents ?? []).map((document) => ({
          sourceId: source.id,
          providerItemId: document.providerItemId,
          item: normalizeDocument(document),
        })),
      ];
      const { items: deduped, collisions: pageCollisions } = dedupeObservations(observations);
      // An accept read keeps the named messages and nothing else of the page (G-02b): the rest is dropped in memory.
      const keyed =
        accept && result.accepted ? keepAccepted(accept, result.accepted, acceptChangedOnly, observations, pageCollisions) : null;
      const collisions = keyed ? keyed.collisions : pageCollisions;
      // The skip rule (#461, design entry 20): what this mailbox already processed and routed under the same digest
      // and rules is not routed or stored again. Counted as `unchanged` only (never ids); the checkpoint still
      // advances below.
      const { items, unchanged } = keyed
        ? { items: keyed.items, unchanged: 0 }
        : skipsIndexed
          ? await skipIndexed(db, { tenantId: source.tenantId, sourceId: source.id }, deduped)
          : { items: deduped, unchanged: 0 };
      // Screened before the store, so each message's tags reach the message index (#461); counted below. An accept
      // read screens only the messages it kept.
      const keptIds = keyed ? new Set(items.map((entry) => entry.item.internetMessageId)) : null;
      const screen = screenPage(
        source.id,
        keptIds ? page.items.filter((message) => keptIds.has((message.internetMessageId ?? '').trim())) : page.items,
        items,
      );
      // The page is one mailbox, so its owner is this source's address (the owner clause of the prefix rule, #653).
      // The context carries the scope and what each key was taught in, so a page refuses a route another source taught.
      const blocked: RouteCounts = { scopeBlocked: 0 };
      const owner = new Map([[source.id, source.address]]);
      const ruled = routeByFirmRules(items, { ...context.options(), sourceOwners: owner, counts: blocked });
      // A message a person accepted keeps its non-teaching route where the rules route nothing (G-02b #173). An accept
      // read itself sees the rules' routes only: the message it is about to commit is not yet durable.
      const routed = accept ? ruled : context.withModelRoutes(source.id, ruled);
      // Accept (G-02b #173): buffer what no rule routed, write and learn nothing, and stop when it has what it came
      // for. Whatever the rules route is left to the normal pass, so a model route never overwrites a rules route.
      // Learning includes prefix evidence: this branch never calls context.learn or context.notePrefixes. The routing
      // above only reads the evidence earlier runs left (knownPrefixEvidence is read-only).
      if (accept && result.accepted) {
        const buffer = result.accepted;
        bufferAccepted(buffer, routed, screen.tags, collisions);
        result.pages += 1;
        counts.pages = result.pages;
        if (accept.onPage) await accept.onPage();
        if (buffer.seen.size >= accept.keys.size) {
          buffer.stop = 'all_seen';
          return result;
        }
        if (result.pages >= accept.pageBudget) {
          buffer.stop = 'budget';
          result.status = 'page_limit';
          return result;
        }
        if (options.shouldContinue && !(await options.shouldContinue())) {
          buffer.stop = 'paused';
          result.status = 'paused';
          return result;
        }
        continue;
      }
      const stored = await persistItems(db, {
        tenantId: source.tenantId,
        runId,
        routed,
        skipped: (page.skipped ?? []).map((s) => ({ sourceId: source.id, ...s })),
        collisions,
        threadTaints: (page.threadTaints ?? []).map((taint) => ({ sourceId: source.id, ...taint })),
        tags: screen.tags,
      });
      // Counted once the ledger has the page, and only what it had not seen
      // before: a restart, a re-backfill or a delta overlap counts nothing twice.
      const firstSeen = new Set(stored.firstSeenKeys);
      const tally = screeningTally([...screen.results].filter(([key]) => firstSeen.has(key)).map(([, result]) => result));
      // Stored is stored: counted before the checkpoint write, so a checkpoint failure still reports it (#370 R1-M3).
      for (const key of stored.storedKeys) result.storedKeys.add(key);
      counts.stored = result.storedKeys.size;
      // Learn only from what was stored: a message that collided with a
      // stored id must not steer the routing of the pages after it.
      const storedKeys = new Set(stored.storedKeys);
      context.learn(routed.filter((entry) => storedKeys.has(entry.item.internetMessageId)));
      // Prefix evidence for the pages after this one (keyed digests only): every item the router saw that was stored
      // or routed nowhere. A routed item the store refused as a collision (its id is held by other content) adds none.
      context.notePrefixes(
        routed.filter((entry) => entry.routes.length === 0 || storedKeys.has(entry.item.internetMessageId)),
        owner,
      );
      // Read is read: counted with its routing split before the checkpoint write, so the two always add up.
      tallyPage(result.routing, routed, stored, page.skipped?.length ?? 0);
      result.routing.scopeBlocked += blocked.scopeBlocked;
      result.itemsRead += stored.itemsRead;
      read.itemsRead = result.itemsRead;
      // Demo-only (#460): the page's messages as this page read them. The step asks only those no rule routed; the
      // routed ones name their deals' parties for the prompt (#623). A document carries `kind`; a message leaves it
      // unset (normalize/index.ts), so a `kind === 'message'` test would pass nothing.
      if (propose) {
        await propose.run(
          routed.filter((entry) => entry.item.kind !== 'document'),
          { sourceId: source.id, runId },
        );
      }

      // The resume point, only once the page is stored. A re-read leaves the source's own resume point alone.
      if (page.nextCheckpoint !== null && !reread) {
        await updateSource(
          db,
          source.id,
          withStart({ delta_checkpoint: page.nextCheckpoint, checkpoint_updated_at: new Date().toISOString() }),
          'checkpoint update',
        );
        source.deltaCheckpoint = page.nextCheckpoint;
        result.checkpointAdvanced = counts.checkpointAdvanced = true;
      }

      result.pages += 1;
      // A skipped sighting is not in itemsRead (the sightings the pass processed), so #460's routed + unrouted +
      // skipped + collisions === itemsRead holds. It counts in unchanged.
      result.unchanged += unchanged;
      result.screening.screened += tally.screened;
      result.screening.flagged += tally.flagged;
      counts.pages = result.pages;

      if (options.maxPages && result.pages >= options.maxPages) {
        result.status = 'page_limit';
        proposeOutcome = 'page_limit';
        return result;
      }
      if (options.shouldContinue && !(await options.shouldContinue())) {
        result.status = 'paused';
        proposeOutcome = 'paused';
        return result;
      }
    }
  } catch (error) {
    proposeOutcome = passOutcomeOfError(error, mode);
    // The incremental cursor is gone: reset the source (or halt it), never a failure.
    if (mode === 'delta' && isCheckpointExpired(error)) return handleExpiry(db, source, result);
    // A guard refusal (#262) is the allowlist working, not a failed sync: the
    // caller reports it, and the source keeps its checkpoint for when access returns.
    // A source archived while this page was in flight is no failure of the sync either
    // (the caller skips it), and the database would refuse an error record on it anyway.
    // A re-read records no error on the source either: its health is the serve loop's.
    const refused =
      (error instanceof MailboxAccessRefusedError && error.reason !== 'no_capability') || error instanceof SourceArchivedError;
    if (!refused && !reread) {
      await updateSource(
        db,
        source.id,
        { last_error: errorSummary(error), last_error_at: new Date().toISOString() },
        'error record',
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    // A team inbox's pass is closed on every exit, with how the read ended (the step's own stop or refusal wins).
    // A failed close is swallowed: the lease lapses and the next run's sweep records the pass as unclosed.
    if (propose) await propose.endSource({ sourceId: source.id, runId }, proposeOutcome).catch(() => undefined);
  }

  if (!reread) {
    const now = new Date().toISOString();
    await updateSource(
      db,
      source.id,
      withStart({
        last_synced_at: now,
        last_error: null,
        last_error_at: null,
        ...(mode === 'backfill' ? { backfill_completed_at: now } : { history_expiry_streak: 0 }),
      }),
      'sync completion',
    );
  }
  // An accept read of a narrowed window is not a full read of the source.
  result.fullRead = fromNothing && !accept;
  if (result.accepted) result.accepted.stop = 'end';
  return result;
}

// ── Discover one tenant ──────────────────────────────────────────────────────

function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  return at > 0 ? address.slice(at + 1).toLowerCase() : null;
}

export type FirmSource = {
  id: string;
  address: string;
  kind: string;
  team_mailbox_id: string | null;
  owner_user_id: string | null;
  /** Set when the source was disconnected or withdrawn and archived (its records may be kept). */
  archived_at?: string | null;
};

/** Rows per read of the tenant's sources: at or under PostgREST's max_rows, so every page is a full answer. */
export const FIRM_SOURCES_PAGE = 1000;

/**
 * The tenant's configured sources: the one read behind its firm domains, its mailbox owners and its shared sources.
 * Read page by page and checked against the exact count: a team inbox missed by a short read would be taken for a
 * person's mailbox and route on names it never taught (#173 G-09, audit G5). Anything short of the whole set throws,
 * so the run stops rather than route with a partial scope.
 */
export async function firmSources(db: SupabaseClient, tenantId: string): Promise<FirmSource[]> {
  const all: FirmSource[] = [];
  let expected: number | null = null;
  for (let from = 0; ; from += FIRM_SOURCES_PAGE) {
    const { data, error, count } = await db
      .from(TABLE.CONTENT_SOURCES)
      .select('id, address, kind, team_mailbox_id, owner_user_id, archived_at', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('id')
      .range(from, from + FIRM_SOURCES_PAGE - 1);
    fail('content source read', error);
    if (typeof count !== 'number') throw new Error('discovery sync: content source read failed (no count)');
    expected ??= count;
    const rows = (data ?? []) as FirmSource[];
    all.push(...rows);
    if (rows.length < FIRM_SOURCES_PAGE) break;
  }
  if (all.length !== expected) throw new Error('discovery sync: content source read failed (incomplete)');
  return all;
}

/**
 * What routing needs from the tenant's mailboxes: the firm's own domains (never a party; lowercased), each mailbox's
 * own address by source id, the owner of what that mailbox holds (#653), and the shared sources, a team inbox or a
 * mailbox with no owner. That includes a mailbox whose owner user was deleted (owner_user_id is set null): it becomes
 * shared, the stricter side. A SharePoint site has no owner by design and is not a mailbox: it is admitted as a
 * person's source, so its alias and thread routing stays as it was before the scope (audit G4). Every other source
 * is a person's. See `admit` (#173 G-09).
 */
export function firmRouting(sources: ReadonlyArray<FirmSource>): {
  internalDomains: string[];
  sourceOwners: Map<string, string>;
  shared: Set<string>;
} {
  return {
    internalDomains: sources.map((s) => domainOf(s.address)).filter((domain): domain is string => domain !== null),
    sourceOwners: new Map(sources.map((s) => [s.id, s.address.toLowerCase()])),
    shared: new Set(
      sources
        .filter((s) => s.team_mailbox_id || (!s.owner_user_id && s.kind !== SOURCE_KIND.SHAREPOINT_SITE))
        .map((s) => s.id),
    ),
  };
}

/**
 * The routing inputs from the tenant's sources (#173 G-09 3b, audit P1, review of #738). A source disconnected or
 * withdrawn under content_on_disconnect = 'keep' is archived with its records kept. It stays an observer and, if it
 * was shared, stays shared, so `admit` and the every-observer prefix rule still let it refuse an item it holds: an
 * archived team inbox never lifts its barrier. It no longer teaches a key or a thread, nor adds prefix evidence
 * (`archived`). Its archive address names no firm domain and no mailbox owner.
 */
export function routingInputs(sources: ReadonlyArray<FirmSource>): ReturnType<typeof firmRouting> & {
  archived: Set<string>;
} {
  const { internalDomains, sourceOwners } = firmRouting(sources.filter((s) => !s.archived_at));
  return {
    internalDomains,
    sourceOwners,
    shared: firmRouting(sources).shared,
    archived: new Set(sources.filter((s) => s.archived_at).map((s) => s.id)),
  };
}

/**
 * Discovery's route, pure: the stored items re-routed together. The candidates' codenames carry no provenance, so only
 * the stored items' own literals teach. Returns what the scope refused, as a count.
 */
export function routeStored(
  items: DedupedItem[],
  options: Omit<Parameters<typeof routeByFirmRules>[1], 'counts'>,
): { routed: RoutedItem[]; counts: RouteCounts } {
  const counts: RouteCounts = { scopeBlocked: 0 };
  return { routed: routeByFirmRules(items, { ...options, counts }), counts };
}

/**
 * Clusters everything the tenant has stored into candidates, as phase 3's
 * batch did over one run: re-route the stored items together (so every
 * codename, alias and thread among them is known), cluster the routed ones,
 * and upsert the candidates in one transaction.
 */
export async function discoverTenant(
  db: SupabaseClient,
  options: { tenantId: string; runId: string },
): Promise<CandidateResult[]> {
  const { items, itemIds } = await loadStoredItems(db, options.tenantId);
  const { internalDomains, sourceOwners, shared, archived } = routingInputs(await firmSources(db, options.tenantId));
  // Per mailbox and firm senders only: the subject prefix rule never pools mailboxes (#622). Alias and thread routes
  // are held to the sources that taught them (#173 G-09).
  const { routed } = routeStored(items, {
    knownCodenames: await candidateCodenames(db, options.tenantId),
    internalDomains,
    sourceOwners,
    scope: { shared },
    archived,
  });
  const groups = clusterCandidates(
    routed.filter((entry) => entry.routes.length > 0),
    { internalDomains },
  );
  const candidates = await persistCandidates(db, { tenantId: options.tenantId, runId: options.runId, groups, itemIds });
  // The message index's candidate and deal links follow the evidence just written (#461).
  const { error } = await db.rpc('discovery_message_index_link', { p_tenant: options.tenantId });
  fail('discovery_message_index_link', error);
  return candidates;
}
