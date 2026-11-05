// The classification worker's writer. Runs with the service role and never
// serves a user request (ADR-006). Every write is an upsert keyed on a stable
// identity, so re-running over the same mail changes nothing:
//
//   source_items         (tenant_id, internet_message_id) for a message,
//                        (tenant_id, drive_item_key) for a document
//   source_item_texts    source_item_id
//   source_item_sources  (source_item_id, content_source_id)
//   routing_ledger       (source_id, provider_item_id)
//   discovery_thread_taints  (source_id, provider_thread_id, rule_id), insert-only
//   discovery_message_index  (tenant_id, content_source_id, message_key), through
//                        discovery_message_index_record (#461): no content
//   deal_candidates      (tenant_id, cluster_key), with its links, visibility
//                        and discovery.candidate_proposed audit row in one
//                        transaction (discovery_upsert_candidates)
//
// Only deal-routed items are stored (Q5). Everything read gets a ledger row:
// a hash and a decision, never content.
//
// A message's Internet message id is written by its sender, so it is not
// trusted as identity on its own. A message is inserted, never updated: when
// the tenant already holds a message under the same id with a different
// content hash, the one stored first keeps the id and the newcomer is
// ledgered as skipped (id_collision) with how far the two differ. Its mailbox
// never becomes an owner of the stored text, and the stored text is never
// overwritten. The same holds within a page (dedupeObservations).
//
// Phase 4 splits the write in two, because the worker now reads one page at a
// time and must checkpoint after each: persistItems stores a page's items and
// ledger rows, and persistCandidates writes the candidates once the tenant's
// stored items are clustered (worker/sync.ts). persistRun keeps phase 3's
// one-shot shape on top of both.

import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  POLICY_SKIP_REASONS,
  ROUTING_DECISION,
  SKIP_REASON,
  SOURCE_ITEM_KIND,
  type RouteMethod,
  type RoutingDecision,
  type SkipReason,
} from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';
import type { SendRecipient } from '@/lib/constants/sendCensus';
import type { CandidateGroup } from '@/lib/discovery/discover/cluster';
import type { ExclusionPolicy, ThreadTaint } from '@/lib/discovery/exclusion/types';
import { collisionMetrics, type Collision, type DedupedItem } from '@/lib/discovery/normalize';
import type { RoutedItem } from '@/lib/discovery/route/firmRules';
import { indexDigester } from '@/lib/discovery/indexDigest';
import { DISCOVERY_RULES_VERSION } from '@/lib/discovery/rulesVersion';
import type { SendFact, SkippedItem } from '@/lib/discovery/source/types';
import { dbFailure, errorCodeOf } from '@/lib/errors/upstream';

const CHUNK = 500;

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

export type LedgerRow = {
  source_id: string;
  provider_item_id: string;
  item_hash: string;
  decision: RoutingDecision;
  method: RouteMethod | null;
  confidence: number | null;
  skip_reason: SkipReason | null;
  /** An unrouted message's thread identifiers; null on every other row. */
  conversation_id: string | null;
  internet_message_id: string | null;
  /** An id collision's cosine similarity and length ratio to the stored item; null on every other row. */
  collision_similarity: number | null;
  collision_length_ratio: number | null;
  /**
   * The provider's thread id (Gmail's): on every row of a Gmail message, routed, unrouted or skipped, so a join on
   * (source_id, provider_thread_id) shows a tainted thread's earlier reads. Required on a policy skip. Metadata, never
   * content; null for Graph.
   */
  provider_thread_id: string | null;
  /** A policy skip's policy version and rule id; null on every other row. */
  policy_version: number | null;
  exclusion_rule: string | null;
  sent_at: string | null;
  sent_recipient: SendRecipient | null;
  run_id: string;
};

const sentOf = (send: SendFact | undefined) => ({ sent_at: send?.sentAt ?? null, sent_recipient: send?.recipient ?? null });

const NO_COLLISION = { collision_similarity: null, collision_length_ratio: null } as const;
const NO_POLICY = { policy_version: null, exclusion_rule: null } as const;

/**
 * One ledger row per sighting, routed or not. An unrouted message keeps its
 * conversation and Internet message ids (identifiers, never text): routing is
 * forward only, so a reply read before the message naming the codename stays
 * unrouted, and these let the eval count it apart from a true miss.
 */
export function ledgerRows(routed: RoutedItem[], runId: string): LedgerRow[] {
  return routed.flatMap((entry) => {
    const best = [...entry.routes].sort((a, b) => b.confidence - a.confidence)[0];
    const threadIds = !best && !isDocument(entry);
    return entry.observations.map((o) => ({
      source_id: o.sourceId,
      provider_item_id: o.providerItemId,
      item_hash: entry.item.contentHash,
      decision: best ? ROUTING_DECISION.ROUTED : ROUTING_DECISION.UNROUTED,
      method: best?.method ?? null,
      confidence: best?.confidence ?? null,
      skip_reason: null,
      conversation_id: threadIds ? entry.item.conversationId : null,
      internet_message_id: threadIds ? entry.item.internetMessageId : null,
      ...NO_COLLISION,
      ...NO_POLICY,
      provider_thread_id: o.providerThreadId ?? null,
      ...sentOf(o.send),
      run_id: runId,
    }));
  });
}

/** A document or message the reader did not read into text, ledgered as skipped (a policy skip carries its rule, version and thread id). */
export type SkippedSighting = SkippedItem & { sourceId: string };

/**
 * conversation_id and internet_message_id stay null on a skipped row, a policy
 * skip's included; its provider_thread_id does not (it is the taint key).
 */
export function skippedLedgerRows(skipped: SkippedSighting[], runId: string): LedgerRow[] {
  return skipped.map((s) => ({
    source_id: s.sourceId,
    provider_item_id: s.providerItemId,
    item_hash: s.itemHash,
    decision: ROUTING_DECISION.SKIPPED,
    method: null,
    confidence: null,
    skip_reason: s.reason,
    conversation_id: null,
    internet_message_id: null,
    ...NO_COLLISION,
    provider_thread_id: s.providerThreadId ?? null,
    policy_version: s.policy?.version ?? null,
    exclusion_rule: s.policy?.ruleId ?? null,
    ...sentOf(s.send),
    run_id: runId,
  }));
}

/** A sighting that collided with a stored item's id, ledgered as skipped with its distance to it. */
export function collisionLedgerRows(collisions: Collision[], runId: string): LedgerRow[] {
  return collisions.map((c) => ({
    source_id: c.sourceId,
    provider_item_id: c.providerItemId,
    item_hash: c.itemHash,
    decision: ROUTING_DECISION.SKIPPED,
    method: null,
    confidence: null,
    skip_reason: SKIP_REASON.ID_COLLISION,
    conversation_id: null,
    internet_message_id: null,
    collision_similarity: c.similarity,
    collision_length_ratio: c.lengthRatio,
    ...NO_POLICY,
    provider_thread_id: c.providerThreadId ?? null,
    ...sentOf(c.send),
    run_id: runId,
  }));
}

export type PersistItemsInput = {
  tenantId: string;
  runId: string;
  /** Every item read, routed or not. */
  routed: RoutedItem[];
  skipped?: SkippedSighting[];
  /** Sightings that collided with an item earlier in the page (dedupeObservations). */
  collisions?: Collision[];
  /** The threads a thread-scoped exclusion rule newly tainted in this page (insert-only). */
  threadTaints?: ThreadTaintSighting[];
  /**
   * Each screened message's tags (rule kinds, never a term), by Internet message id (#461). Every message here,
   * routed or not, is indexed once it is ledgered; one absent (its screen failed) is not, so it is processed again.
   */
  tags?: ReadonlyMap<string, readonly string[]>;
};

/** A taint with the source whose mailbox held the thread (a thread id is per mailbox). */
export type ThreadTaintSighting = ThreadTaint & { sourceId: string };

export type PersistItemsResult = {
  itemsRead: number;
  /** The keys (internetMessageId, or a document's drive: key) of the items stored. */
  storedKeys: string[];
  /** Stored item id by key. */
  itemIds: Map<string, string>;
  /** Every id collision ledgered, from the page and against the store. */
  collisions: Collision[];
  /**
   * The keys of the page's items read for the first time: at least one of their sightings had no ledger row before
   * this call. An item whose sightings are all already ledgered was read before (a restart, a re-backfill, a delta
   * overlap). Where the write cannot tell, the item counts as first seen.
   */
  firstSeenKeys: string[];
};

/**
 * The page's write reached a source that was archived while it was in flight (mailbox_consent_grant archived it, or a
 * merge emptied it), or deleted (its owner's consent ended, #461): the database refuses a provenance link to either,
 * and a checkpoint write to an archived one, with `source_archived` (P0001; audit round 4, Codex 3). It is that page's
 * refusal, not a failed sync: nothing of the page is attached to the source, and the caller skips the source. The
 * page's items that no mailbox holds are deleted by the worker's backstop.
 */
export class SourceArchivedError extends Error {
  constructor() {
    super('discovery: the source was archived while its page was in flight; the page was not stored for it');
    this.name = 'SourceArchivedError';
  }
}

/** True for the database's refusal of a write to an archived source (and for nothing else). */
export function isSourceArchivedRefusal(error: { message: string; code?: string } | null): boolean {
  return error !== null && error.code === 'P0001' && error.message === 'source_archived';
}

function fail(step: string, error: { message: string; code?: string } | null): void {
  if (isSourceArchivedRefusal(error)) throw new SourceArchivedError();
  if (error) throw new Error(`discovery persist: ${step} failed (${errorCodeOf(error)})`);
}

/**
 * The ledger and taint writes carry the source as a foreign key and no archived guard. A page with no routed item
 * writes no provenance, so when a purge deletes its source mid-page the key refuses the write (23503) instead of the
 * provenance trigger's source_archived. That is the same refusal (#519 review). Only the source key maps: any other
 * error, and a 23503 on any other key, is still a failure.
 */
function failSourceKeyed(step: string, error: { message: string; code?: string } | null): void {
  if (error?.code === '23503' && /_source_id_fkey/.test(error.message)) throw new SourceArchivedError();
  fail(step, error);
}

function isDocument(entry: RoutedItem): boolean {
  return entry.item.kind === SOURCE_ITEM_KIND.DOCUMENT;
}

/** Stores the deal-routed items of a page, their text and provenance, and ledgers every sighting. */
export async function persistItems(db: SupabaseClient, input: PersistItemsInput): Promise<PersistItemsResult> {
  const { tenantId, runId, routed } = input;
  const routedItems = routed.filter((entry) => entry.routes.length > 0);
  const messages = routedItems.filter((entry) => !isDocument(entry));
  const documents = routedItems.filter(isDocument);

  // 1. Metadata of deal-routed items. A message is inserted and never updated;
  //    the row that holds its id afterwards decides whether it is this
  //    message (same content hash) or a collision.
  const itemIds = new Map<string, string>();
  const collisions: Collision[] = [...(input.collisions ?? [])];
  const collided = new Set<RoutedItem>();
  for (const batch of chunks(messages)) {
    const { error } = await db
      .from(TABLE.SOURCE_ITEMS)
      .upsert(
        batch.map(({ item }) => ({
          tenant_id: tenantId,
          kind: SOURCE_ITEM_KIND.MESSAGE,
          subject: item.subject,
          participants: item.participants,
          sent_at: item.sentAt,
          internet_message_id: item.internetMessageId,
          conversation_id: item.conversationId,
          content_hash: item.contentHash,
        })),
        { onConflict: 'tenant_id,internet_message_id', ignoreDuplicates: true },
      );
    fail('source_items insert', error);

    const { data, error: readError } = await db
      .from(TABLE.SOURCE_ITEMS)
      .select('id, internet_message_id, subject, content_hash')
      .eq('tenant_id', tenantId)
      .in('internet_message_id', batch.map(({ item }) => item.internetMessageId));
    fail('source_items read back', readError);
    const held = new Map(
      ((data ?? []) as Array<{ id: string; internet_message_id: string; subject: string | null; content_hash: string }>).map(
        (row) => [row.internet_message_id, row],
      ),
    );
    const mismatched: Array<{ entry: RoutedItem; heldId: string; heldSubject: string }> = [];
    for (const entry of batch) {
      const row = held.get(entry.item.internetMessageId);
      if (!row) throw new Error('discovery persist: no stored item for a batch entry');
      if (row.content_hash === entry.item.contentHash) itemIds.set(row.internet_message_id, row.id);
      else mismatched.push({ entry, heldId: row.id, heldSubject: row.subject ?? '' });
    }
    if (mismatched.length > 0) {
      const { data: textRows, error: textReadError } = await db
        .from(TABLE.SOURCE_ITEM_TEXTS)
        .select('source_item_id, body_text')
        .in('source_item_id', mismatched.map((m) => m.heldId));
      fail('source_item_texts read', textReadError);
      const heldText = new Map(
        ((textRows ?? []) as Array<{ source_item_id: string; body_text: string }>).map((row) => [row.source_item_id, row.body_text]),
      );
      for (const { entry, heldId, heldSubject } of mismatched) {
        collided.add(entry);
        const metrics = collisionMetrics({ subject: heldSubject, bodyText: heldText.get(heldId) ?? '' }, entry.item);
        for (const o of entry.observations) {
          collisions.push({
            sourceId: o.sourceId,
            providerItemId: o.providerItemId,
            ...(o.providerThreadId !== undefined ? { providerThreadId: o.providerThreadId } : {}),
            ...(o.send ? { send: o.send } : {}),
            key: entry.item.internetMessageId,
            itemHash: entry.item.contentHash,
            ...metrics,
          });
        }
      }
    }
  }
  for (const batch of chunks(documents)) {
    const keyByDriveItem = new Map(batch.map(({ item }) => [item.driveItemKey!, item.internetMessageId]));
    const { data, error } = await db
      .from(TABLE.SOURCE_ITEMS)
      .upsert(
        batch.map(({ item }) => ({
          tenant_id: tenantId,
          kind: SOURCE_ITEM_KIND.DOCUMENT,
          subject: item.subject,
          participants: item.participants,
          sent_at: item.sentAt,
          drive_item_key: item.driveItemKey,
          drive_path: item.drivePath ?? null,
          content_hash: item.contentHash,
        })),
        { onConflict: 'tenant_id,drive_item_key' },
      )
      .select('id, drive_item_key');
    fail('source_items document upsert', error);
    for (const row of (data ?? []) as Array<{ id: string; drive_item_key: string }>) {
      const key = keyByDriveItem.get(row.drive_item_key);
      if (key) itemIds.set(key, row.id);
    }
  }

  const itemId = (key: string): string => {
    const id = itemIds.get(key);
    if (!id) throw new Error('discovery persist: no stored item for an item key');
    return id;
  };

  const stored = routedItems.filter((entry) => !collided.has(entry));

  // 2. Their text, and 3. every source each was seen in.
  for (const batch of chunks(stored)) {
    const { error: textError } = await db.from(TABLE.SOURCE_ITEM_TEXTS).upsert(
      batch.map(({ item }) => ({ source_item_id: itemId(item.internetMessageId), body_text: item.bodyText })),
      { onConflict: 'source_item_id' },
    );
    fail('source_item_texts upsert', textError);

    const { error: sourceError } = await db.from(TABLE.SOURCE_ITEM_SOURCES).upsert(
      batch.flatMap(({ item, observations }) =>
        observations.map((o) => ({
          source_item_id: itemId(item.internetMessageId),
          content_source_id: o.sourceId,
          provider_item_id: o.providerItemId,
        })),
      ),
      { onConflict: 'source_item_id,content_source_id', ignoreDuplicates: true },
    );
    fail('source_item_sources upsert', sourceError);
  }

  // 4. The ledger: every sighting, every skipped document, and every
  //    collision (in place of the routed row its sighting would have had).
  //    Graph can list one item twice in a page, and one upsert may not touch
  //    the same row twice, so each (source, provider item) keeps its last row.
  const byKey = new Map<string, LedgerRow>();
  for (const row of [
    ...ledgerRows(routed.filter((entry) => !collided.has(entry)), runId),
    ...skippedLedgerRows(input.skipped ?? [], runId),
    ...collisionLedgerRows(collisions, runId),
  ]) {
    byKey.set(`${row.source_id}\u0000${row.provider_item_id}`, row);
  }
  //    A policy skip never replaces a row that records a read or a fetch (routed,
  //    unrouted, id_collision, policy_excluded_after_fetch): a skip must not hide
  //    that text is held (an expired cursor re-backfills the mailbox under whatever
  //    policy is current). Every policy reason goes through
  //    discovery_ledger_record_policy_skips, which writes a new row, and over an
  //    existing one refreshes only an earlier never-fetched skip. So an
  //    after-fetch row (the message was fetched) may replace a never-fetched skip,
  //    which is the truthful direction, but never a routed or unrouted row.
  //    Everything else keeps the plain upsert.
  const policyReasons: readonly string[] = POLICY_SKIP_REASONS;
  const isPolicySkip = (row: LedgerRow) => row.skip_reason !== null && policyReasons.includes(row.skip_reason);
  const ledger = [...byKey.values()].filter((row) => !isPolicySkip(row));
  const policySkips = [...byKey.values()].filter(isPolicySkip);
  //    Insert first, so the database says which sightings are new: an insert
  //    that skips conflicts returns only the rows it wrote, and of two writers
  //    racing on one key exactly one gets it back. The rows already held are
  //    then upserted as before. A reply without rows says nothing, so every
  //    row of it is upserted and counts as new.
  const ledgerKey = (row: { source_id: string; provider_item_id: string }) => `${row.source_id}\u0000${row.provider_item_id}`;
  const heldBefore = new Set<string>();
  for (const batch of chunks(ledger)) {
    const { data, error } = await db
      .from(TABLE.ROUTING_LEDGER)
      .upsert(batch, { onConflict: 'source_id,provider_item_id', ignoreDuplicates: true })
      .select('source_id, provider_item_id');
    failSourceKeyed('routing_ledger insert', error);
    const inserted = data ? new Set((data as Array<{ source_id: string; provider_item_id: string }>).map(ledgerKey)) : null;
    const held = inserted ? batch.filter((row) => !inserted.has(ledgerKey(row))) : batch;
    if (held.length === 0) continue;
    if (inserted) for (const row of held) heldBefore.add(ledgerKey(row));
    const { error: updateError } = await db
      .from(TABLE.ROUTING_LEDGER)
      .upsert(held, { onConflict: 'source_id,provider_item_id' });
    failSourceKeyed('routing_ledger upsert', updateError);
  }
  //    The page's thread taints ride in the same call as its policy skips, one
  //    transaction, long before the checkpoint: a taint never commits without the
  //    skip that carried it, nor the skip without its taint (a lost taint could let
  //    a later reply through). One call per page, not chunked, so the two cannot
  //    split; a page is bounded by the reader's page size. The function inserts
  //    taints insert-only: the first provenance of a (source, thread, rule) stays.
  const taints = (input.threadTaints ?? []).map((taint) => ({
    source_id: taint.sourceId,
    provider_thread_id: taint.providerThreadId,
    rule_id: taint.ruleId,
    policy_version: taint.policyVersion,
    provider_item_id: taint.providerItemId,
    run_id: runId,
  }));
  if (policySkips.length > 0 || taints.length > 0) {
    const { error } = await db.rpc('discovery_ledger_record_policy_skips', { p_rows: policySkips, p_taints: taints });
    failSourceKeyed('discovery_ledger_record_policy_skips', error);
  }

  // 5. The message index (#461, design entry 19): one row per message of the mailbox read and screened on the
  //    page, routed or not, after its ledger row. Identifiers, the digest (keyed per tenant, indexDigest.ts), tags and
  //    the rules version: no content.
  //    A collision, a policy skip or a document is not indexed. One call per source (a page has one). Each sighting
  //    is sent with its provider id; the function collapses sightings that share a Message-ID (a copied message has
  //    a provider id of its own) into one row holding all of them. A message always has a usable Message-ID here:
  //    normalizeMessage refuses one without, so none is sent without it (the function skips a blank one anyway).
  const index = new Map<string, Array<Record<string, unknown>>>();
  let digestOf: ((contentHash: string) => string) | undefined;
  for (const entry of routed) {
    const tags = input.tags?.get(entry.item.internetMessageId);
    if (!tags || collided.has(entry) || isDocument(entry)) continue;
    for (const o of entry.observations) {
      const rows = index.get(o.sourceId) ?? [];
      rows.push({
        provider_item_id: o.providerItemId,
        internet_message_id: entry.item.internetMessageId,
        sent_at: entry.item.sentAt,
        content_digest: (digestOf ??= indexDigester(tenantId))(entry.item.contentHash),
        tags,
        rules_version: DISCOVERY_RULES_VERSION,
      });
      index.set(o.sourceId, rows);
    }
  }
  for (const [sourceId, rows] of index) {
    const { error } = await db.rpc('discovery_message_index_record', { p_tenant: tenantId, p_source: sourceId, p_rows: rows });
    fail('discovery_message_index_record', error);
  }

  return {
    itemsRead:
      routed.reduce((sum, entry) => sum + entry.observations.length, 0) +
      (input.skipped?.length ?? 0) +
      (input.collisions?.length ?? 0),
    storedKeys: stored.map((entry) => entry.item.internetMessageId),
    itemIds,
    collisions,
    firstSeenKeys: routed
      .filter((entry) => entry.observations.some((o) => !heldBefore.has(`${o.sourceId}\u0000${o.providerItemId}`)))
      .map((entry) => entry.item.internetMessageId),
  };
}

/** Message keys per index read: 64 hex characters each, and they travel in the URL. */
const INDEX_READ = 50;

/**
 * The message index's key for an Internet message id: the sha256 hex of the trimmed id, the same value
 * discovery_message_index_record writes (encode(sha256(convert_to(btrim(id), 'UTF8')), 'hex'); the id is already
 * trimmed by normalizeMessage, so the two trims agree). #460's messageKey() is the same function.
 */
export function messageKey(internetMessageId: string): string {
  return createHash('sha256').update(internetMessageId.trim(), 'utf8').digest('hex');
}

/**
 * The skip rule (#461, design entry 20): drops from a page's items every sighting this mailbox already processed
 * and routed, so it is not routed, stored or ledgered again. A sighting is skipped only when the mailbox's index
 * row for the message (by message key, not provider id) is linked to a candidate or a deal, has the same content
 * digest and DISCOVERY_RULES_VERSION, and already holds this sighting's provider id. An unrouted message is never
 * skipped: routing also depends on the codenames and threads known now, which a later read may know better, so it
 * is routed again. A copy under a new provider id is processed once, which records its id. An item left with no
 * sighting is dropped. Documents are never indexed and always kept. Returns how many sightings were dropped: a
 * count, never ids. Whether the rule applies to a pass at all is the caller's call (worker/sync.ts: only a delta pass
 * of a completed backfill that is not a re-read); this function only applies it to the page it is given.
 */
export async function skipIndexed(
  db: SupabaseClient,
  ids: { tenantId: string; sourceId: string },
  items: DedupedItem[],
): Promise<{ items: DedupedItem[]; unchanged: number }> {
  const keys = [
    ...new Set(items.flatMap((entry) => (entry.item.kind === SOURCE_ITEM_KIND.DOCUMENT ? [] : [messageKey(entry.item.internetMessageId)]))),
  ];
  type IndexRead = {
    message_key: string;
    content_digest: string;
    rules_version: string;
    provider_item_ids: string[];
    candidate_id: string | null;
    deal_id: string | null;
  };
  const indexed = new Map<string, IndexRead>();
  for (let i = 0; i < keys.length; i += INDEX_READ) {
    const { data, error } = await db
      .from(TABLE.DISCOVERY_MESSAGE_INDEX)
      .select('message_key, content_digest, rules_version, provider_item_ids, candidate_id, deal_id')
      .eq('tenant_id', ids.tenantId)
      .eq('content_source_id', ids.sourceId)
      .in('message_key', keys.slice(i, i + INDEX_READ));
    fail('discovery_message_index read', error);
    for (const row of (data ?? []) as IndexRead[]) indexed.set(row.message_key, row);
  }
  let unchanged = 0;
  let digestOf: ((contentHash: string) => string) | undefined;
  const kept = items.flatMap((entry) => {
    if (entry.item.kind === SOURCE_ITEM_KIND.DOCUMENT) return [entry];
    const row = indexed.get(messageKey(entry.item.internetMessageId));
    const done =
      row !== undefined &&
      (row.candidate_id !== null || row.deal_id !== null) &&
      row.content_digest === (digestOf ??= indexDigester(ids.tenantId))(entry.item.contentHash) &&
      row.rules_version === DISCOVERY_RULES_VERSION;
    const fresh = done ? entry.observations.filter((o) => !row.provider_item_ids.includes(o.providerItemId)) : entry.observations;
    unchanged += entry.observations.length - fresh.length;
    return fresh.length > 0 ? [{ ...entry, observations: fresh }] : [];
  });
  return { items: kept, unchanged };
}

/** Taints are read this many rows to a request (the service client's 1,000-row limit), in primary-key order. */
const TAINT_PAGE = 1000;

/**
 * The conversations of one source that a thread-scoped rule of the current policy has excluded, by thread id to the
 * rule ids (#263). The worker reads it once per source, right before the reader is built, and the reader never
 * touches the database. Only the current version's thread-scoped rules count, so narrowing a rule to message scope,
 * or removing it, stops its old taints from applying forward. A rule id names one condition forever (the database
 * refuses a changed condition), so a kept taint was produced by the condition the rule still holds. Rule order and the
 * version that recorded a taint play no part.
 */
export async function readThreadTaint(
  db: SupabaseClient,
  sourceId: string,
  policy: ExclusionPolicy,
): Promise<Map<string, Set<string>>> {
  const taint = new Map<string, Set<string>>();
  const threadRules = new Set(policy.rules.filter((rule) => rule.scope === 'thread').map((rule) => rule.id));
  if (threadRules.size === 0) return taint;
  for (let from = 0; ; from += TAINT_PAGE) {
    const { data, error } = await db
      .from(TABLE.DISCOVERY_THREAD_TAINTS)
      .select('provider_thread_id, rule_id')
      .eq('source_id', sourceId)
      .order('provider_thread_id')
      .order('rule_id')
      .range(from, from + TAINT_PAGE - 1);
    if (error) throw dbFailure('discovery persist: discovery_thread_taints read', error);
    const rows = (data ?? []) as Array<{ provider_thread_id: string; rule_id: string }>;
    for (const row of rows) {
      if (!threadRules.has(row.rule_id)) continue;
      const rules = taint.get(row.provider_thread_id) ?? new Set<string>();
      rules.add(row.rule_id);
      taint.set(row.provider_thread_id, rules);
    }
    if (rows.length < TAINT_PAGE) break;
  }
  return taint;
}

export type CandidateResult = { clusterKey: string; candidateId: string; created: boolean };

/** Candidates, links, visibility and audit, in one transaction (discovery_upsert_candidates). */
export async function persistCandidates(
  db: SupabaseClient,
  input: { tenantId: string; runId: string; groups: CandidateGroup[]; itemIds: ReadonlyMap<string, string> },
): Promise<CandidateResult[]> {
  const itemId = (key: string): string => {
    const id = input.itemIds.get(key);
    if (!id) throw new Error('discovery persist: no stored item for a candidate item');
    return id;
  };
  const payload = input.groups.map((group) => ({
    clusterKey: group.clusterKey,
    proposedName: group.proposedName,
    codenameGuess: group.codenameGuess,
    parties: group.parties,
    firstSeenAt: group.firstSeenAt,
    lastSeenAt: group.lastSeenAt,
    confidence: group.confidence,
    links: group.links.map((link) => ({
      sourceItemId: itemId(link.internetMessageId),
      method: link.method,
      confidence: link.confidence,
    })),
  }));
  const { data, error } = await db.rpc('discovery_upsert_candidates', {
    p_tenant_id: input.tenantId,
    p_run_id: input.runId,
    p_groups: payload,
  });
  fail('discovery_upsert_candidates', error);
  return (data ?? []) as CandidateResult[];
}

export type PersistInput = {
  tenantId: string;
  runId: string;
  /** Every item read in the run, routed or not. */
  routed: RoutedItem[];
  groups: CandidateGroup[];
};

export type PersistResult = {
  itemsRead: number;
  itemsStored: number;
  candidates: CandidateResult[];
};

/** Phase 3's one-shot write: a run's items, then its candidates. */
export async function persistRun(db: SupabaseClient, input: PersistInput): Promise<PersistResult> {
  const items = await persistItems(db, { tenantId: input.tenantId, runId: input.runId, routed: input.routed });
  const candidates = await persistCandidates(db, {
    tenantId: input.tenantId,
    runId: input.runId,
    groups: input.groups,
    itemIds: items.itemIds,
  });
  return { itemsRead: items.itemsRead, itemsStored: items.storedKeys.length, candidates };
}
