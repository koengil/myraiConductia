// The deal-discovery metrics (handoff 10), from one export and one answer key.
//
// Discovery, in two views of the same export (CANDIDATE_STATE_POLICY in
// tuning.ts):
//   post-rejection  the proposed and confirmed candidates, and their active links
//   pre-rejection   every candidate created, and every one of its links
// In each view, a candidate qualifies for a deal by name or party, dates and
// evidence (match.ts), and candidates and deals are then paired one-to-one
// (assign.ts):
//   precision      paired candidates / candidates
//   recall         paired deals / deals
//   fragmentation  deals two or more candidates qualify for / deals any candidate qualifies for
//   merge          qualifying candidates that hold two deals / qualifying candidates
// Precision and recall read the pairing; fragmentation and merge read the
// many-to-many qualifying relation, so a duplicate candidate counts once as a
// false positive and once as a fragment.
//
// Item assignment (evidence links against the key's items), counted over
// (item, deal) pairs:
//   predicted  a stored item's link to a candidate, read as the deal that
//              candidate is paired with (a link to an unpaired candidate is
//              always wrong)
//   gold       each deal an answer-key item lists
//   precision  correct predicted pairs / predicted pairs on labeled items
//              (and on unlabeled items too when the key's coverage is complete)
//   recall     correct pairs / gold pairs (post-rejection)
//
// Every gold pair that is not recovered lands in exactly one bucket, so a
// recall figure is never misread as a routing miss (phase 4 inputs):
//   routed_elsewhere      stored and linked, but not to a candidate of this deal
//   routed_fragment       stored and linked to a candidate that qualifies for
//                         this deal but is not the one paired with it
//   routed_unlinked       routed, linked to no candidate
//   attachment_only       read, unrouted, and the key says the evidence is
//                         only in a mail attachment (not read yet)
//   unrouted_late_thread  read, unrouted, in a conversation the tenant routed:
//                         read before the message that made the thread
//                         routable (phase 7's re-fetch should recover it)
//   unrouted_other        read, unrouted, anything else. This includes an
//                         alias learned after the item was read: no metadata
//                         tells that case from a rules miss
//   skipped               read and ledgered as skipped (not read into text), by reason
//   document_unresolved   a document the scorer cannot place: not stored, and
//                         the key gives no driveItemId to find it in the ledger
//   never_read            no ledger row of any decision: an ingestion miss
//
// Read, unrouted (its own headline line): the key's true-deal items that the
// worker read and ledgered as unrouted. Two recall ceilings bound what they
// hide: routing them (late thread and other) would raise item recall to at
// most routingCeiling; reading mail attachments as well, to at most
// attachmentCeiling.
//
// Checkpoint: the verdict's metrics against CHECKPOINT_TARGETS (tuning.ts,
// provisional until Storm confirms). Everything a rejection or a merge could
// improve is pre-rejection; discovery and item recall are post-rejection. A
// key whose coverage is partial gives no verdict (undetermined): its
// unlabeled items are invisible to the evidence gate and to item precision.
//
// Redaction (review item 11, second review): deal ids, Message-IDs and paths
// become HMAC digests under a key drawn at random for each score() call and
// never printed, so a guessed name or path cannot be confirmed against a
// scorecard, and two scorecards cannot be joined on their digests. Link
// methods and skip reasons are withheld.

import { createHash, createHmac, randomBytes } from 'node:crypto';

import {
  normalizeDocumentPath,
  normalizeMessageId,
  type AnswerKey,
  type KeyDeal,
  type KeyItem,
} from './answerKey.ts';
import { assignOneToOne, type Assignment } from './assign.ts';
import { byCodePoint, sortedBy } from './compare.ts';
import {
  validateRows,
  type DiscoveryExport,
  type ExportCandidate,
  type ExportItem,
  type ExportLedgerRow,
  type ExportLink,
} from './exportData.ts';
import { qualifyingDeals, type DealMatch, type Evidence } from './match.ts';
import { CANDIDATE_STATE_POLICY, CHECKPOINT_TARGETS, MATCH_TUNING, MERGE_TUNING } from './tuning.ts';

export const HARNESS_VERSION = '1.0.0';

/**
 * A short digest of every tuning constant, printed on the scorecard: two
 * scorecards with the same digest were decided by the same numbers.
 */
export const TUNING_DIGEST = createHash('sha256')
  .update(JSON.stringify({ MATCH_TUNING, MERGE_TUNING, CANDIDATE_STATE_POLICY, CHECKPOINT_TARGETS }))
  .digest('hex')
  .slice(0, 12);

export type Ratio = { num: number; den: number; value: number | null };

export const MISS_BUCKETS = [
  'routed_elsewhere',
  'routed_fragment',
  'routed_unlinked',
  'attachment_only',
  'unrouted_late_thread',
  'unrouted_other',
  'skipped',
  'document_unresolved',
  'never_read',
] as const;
export type MissBucket = (typeof MISS_BUCKETS)[number];

/** The miss buckets of an item the worker read and ledgered as unrouted. */
export const READ_UNROUTED_BUCKETS = ['attachment_only', 'unrouted_late_thread', 'unrouted_other'] as const;
export type ReadUnroutedBucket = (typeof READ_UNROUTED_BUCKETS)[number];
const READ_UNROUTED = new Set<string>(READ_UNROUTED_BUCKETS);

/** How each bucket reads on the scorecard, and the stage of the pipeline it points at. */
export const BUCKET_LABEL: Record<MissBucket, { label: string; stage: string }> = {
  routed_elsewhere: { label: 'Routed, to a candidate of another deal', stage: 'Clustering' },
  routed_fragment: { label: 'Routed, to a second candidate of this deal (a fragment)', stage: 'Clustering' },
  routed_unlinked: { label: 'Routed, linked to no candidate', stage: 'Clustering' },
  attachment_only: { label: 'Evidence only in a mail attachment, not read yet', stage: 'Needs attachment reading' },
  unrouted_late_thread: { label: 'Read, unrouted: late thread', stage: 'Routing (read order)' },
  unrouted_other: { label: 'Read, unrouted: other', stage: 'Routing' },
  skipped: { label: 'Read, skipped (not read into text), by reason below', stage: 'Out of scope today' },
  document_unresolved: { label: 'Document not placed: the key gives no driveItemId', stage: 'Key' },
  never_read: { label: 'Never read', stage: 'Ingestion' },
};

export type PairOutcome = {
  /** The item as the key names it: a Message-ID or a document path (a digest when redacted). */
  itemRef: string;
  kind: KeyItem['kind'];
  dealId: string;
  attachmentOnly: boolean;
  outcome: 'recovered' | MissBucket;
  skipReason: string | null;
};

export type DealRow = {
  id: string;
  name: string;
  /** The candidate paired with this deal (post-rejection), if any. */
  pairedCandidateId: string | null;
  /** Every post-rejection candidate that qualifies for this deal, paired or not. */
  qualifyingIds: string[];
  goldItems: number;
  recoveredItems: number;
};

export type MergeKind = 'qualifying' | 'evidence';

export type CandidateRow = {
  id: string;
  name: string;
  state: ExportCandidate['discoveryState'];
  /** Counted post-rejection. The row shows that view; a rejected or merged row shows the pre-rejection one. */
  scored: boolean;
  pairedDealId: string | null;
  /** The deal it is paired with in the pre-rejection view, the one the verdict reads. */
  pairedDealIdPreRejection: string | null;
  qualifying: DealMatch[];
  merge: MergeKind | null;
  evidenceItems: number;
  labeled: { correct: number; wrong: number; unlabeled: number };
  /** Deal id -> labeled evidence items of that deal. */
  evidenceDeals: Record<string, number>;
};

export type WorstError = {
  kind: 'missed_deal' | 'false_candidate' | 'fragmented_deal' | 'merged_candidate' | 'item_misses';
  title: string;
  weight: number;
  evidence: string[];
};

export type CheckpointMetric =
  | 'discoveryPrecision'
  | 'discoveryRecall'
  | 'itemPrecision'
  | 'itemRecall'
  | 'fragmentation'
  | 'merge';

export type CheckpointCheck = {
  metric: CheckpointMetric;
  label: string;
  basis: 'pre-rejection' | 'post-rejection';
  /** 'min': the value must be at least the target; 'max': at most. */
  bound: 'min' | 'max';
  target: number;
  value: Ratio;
  /** null only when discovery precision or recall has no data; any other n/a is a fail. */
  met: boolean | null;
};

export type Scorecard = {
  meta: {
    harnessVersion: string;
    /**
     * The harness's git commit, and whether evals/deal-discovery had
     * uncommitted changes. Both null when score() was called without
     * provenance: the scorecard then prints a warning, never a clean-looking commit.
     */
    harnessCommit: string | null;
    harnessDirty: boolean | null;
    tuningDigest: string;
    /** Names are withheld, deal ids and item identifiers are keyed digests, methods and skip reasons are withheld. */
    redacted: boolean;
    exportFormat: string;
    keyFormat: string;
    tenantId: string;
    exportedAt: string;
    itemCoverage: AnswerKey['itemCoverage'];
    keyDeals: number;
    keyItems: number;
  };
  discovery: {
    scoredCandidates: number;
    createdCandidates: number;
    excluded: { rejected: number; mergedInto: number };
    /** Post-rejection, one-to-one. */
    precision: Ratio;
    recall: Ratio;
    fragmentation: Ratio;
    merge: Ratio;
    /** Pre-rejection: every candidate created and every link of theirs. */
    preRejection: { precision: Ratio; recall: Ratio; fragmentation: Ratio; merge: Ratio };
    deals: DealRow[];
    candidates: CandidateRow[];
  };
  items: {
    /** Post-rejection. */
    precision: Ratio;
    /** Every link of every candidate created, whatever the state of either. */
    precisionPreRejection: Ratio;
    recall: Ratio;
    /** Recall over the pairs the pipeline reads today: attachment-only items and skipped items left out of both sides. */
    readableRecall: Ratio;
    predictedPairs: number;
    goldPairs: number;
    /** Routed items the key does not list (wrong when coverage is complete, else unlabeled). */
    routedNotInKey: number;
    misses: Record<MissBucket, number>;
    skippedByReason: Record<string, number>;
    attachmentOnly: { inKey: number; recovered: number };
    /** True-deal items read and ledgered unrouted, counted once per item. */
    readUnrouted: {
      items: number;
      /** Their share of the key's true-deal items (items with at least one deal). */
      share: Ratio;
      byBucket: Record<ReadUnroutedBucket, number>;
      /** (item, deal) pairs they account for. */
      pairs: number;
      /** Pairs a routing fix could recover (late thread and other). */
      routingFixablePairs: number;
      /** Pairs that need mail attachments to be read. */
      attachmentPairs: number;
      /** Item recall if every routing-fixable pair were recovered. */
      routingCeiling: Ratio;
      /** Item recall if, in addition, every attachment-only pair were recovered. */
      attachmentCeiling: Ratio;
    };
    outcomes: PairOutcome[];
  };
  checkpoint: {
    checks: CheckpointCheck[];
    /**
     * discovery_led when every target is met, seeded when any is missed;
     * undetermined for a partial key, or without discovery data.
     */
    verdict: 'discovery_led' | 'seeded' | 'undetermined';
    /** Why the verdict is undetermined; null when it is not. */
    undeterminedBecause: 'partial_key' | 'no_discovery_data' | null;
    coverage: AnswerKey['itemCoverage'];
    provisional: boolean;
    setBy: string;
  };
  ingestion: {
    sources: Record<string, number>;
    sourcesWithOwner: number;
    sourcesBackfilled: number;
    ledgerByDecision: Record<string, number>;
    storedItems: Record<string, number>;
    skippedByReason: Record<string, number>;
    candidatesByState: Record<string, number>;
    linksByMethodTier: Array<{ method: string; tier: string; active: number; rejected: number }>;
  };
  worstErrors: WorstError[];
};

export type ScoreOptions = {
  /** Withhold names, methods and skip reasons, and replace deal ids and item identifiers with keyed digests. */
  redact?: boolean;
  /** The harness's commit, printed on the scorecard (cli.ts reads it from git). Without it, the scorecard warns. */
  provenance?: { commit: string; dirty: boolean };
};

export function ratio(num: number, den: number): Ratio {
  return { num, den, value: den === 0 ? null : num / den };
}

function increment(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function sortedRecord(map: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(map).sort((a, b) => byCodePoint(a[0], b[0])));
}

/** The driveItem id inside a stored document's `<driveId>:<itemId>` key. */
function driveItemIdOf(item: ExportItem): string | null {
  if (!item.driveItemKey) return null;
  const at = item.driveItemKey.lastIndexOf(':');
  return at >= 0 ? item.driveItemKey.slice(at + 1) : null;
}

function basename(path: string): string {
  const at = path.lastIndexOf('/');
  return at >= 0 ? path.slice(at + 1) : path;
}

function keyIdentity(item: KeyItem): string {
  return item.kind === 'message'
    ? `message:${normalizeMessageId(item.internetMessageId)}`
    : `document:${normalizeDocumentPath(item.path)}`;
}

/**
 * How names and identifiers read on the scorecard: as they are, or redacted
 * (review item 11, second review). `dealId` maps a key deal id to the id the
 * scorecard shows; `dealLabel` takes that shown id.
 */
type Namer = {
  deal(deal: KeyDeal): string;
  dealId(id: string): string;
  dealLabel(shownId: string): string;
  candidate(candidate: ExportCandidate): string;
  keyRef(item: KeyItem): string;
  storedRef(item: ExportItem): string;
  method(method: string): string;
  skipReason(reason: string): string;
};

export const REDACTED = '(redacted)';

function namer(deals: KeyDeal[], redact: boolean): Namer {
  const nameOf = new Map(deals.map((d) => [d.id, d.name]));
  if (!redact) {
    return {
      deal: (d) => d.name,
      dealId: (id) => id,
      dealLabel: (id) => `${id} ${nameOf.get(id) ?? ''}`.trim(),
      candidate: (c) => c.proposedName,
      keyRef: (i) => (i.kind === 'message' ? i.internetMessageId : i.path),
      storedRef: (i) =>
        i.kind === 'message' ? (i.internetMessageId ?? i.id) : (i.drivePath ?? i.driveItemKey ?? i.id),
      method: (m) => m,
      skipReason: (r) => r,
    };
  }
  // A key drawn for this call only, never printed or stored. Within one
  // scorecard an item digests the same from the key and from the export, so
  // its references still line up; across scorecards nothing does.
  const runKey = randomBytes(32);
  const digest = (prefix: string, value: string) =>
    `${prefix}:${createHmac('sha256', runKey).update(`${prefix}\u0000${value}`).digest('hex').slice(0, 12)}`;
  const message = (id: string) => digest('msg', normalizeMessageId(id));
  const document = (path: string) => digest('doc', normalizeDocumentPath(path));
  return {
    deal: () => REDACTED,
    dealId: (id) => digest('deal', id),
    dealLabel: (id) => id,
    candidate: () => REDACTED,
    keyRef: (i) => (i.kind === 'message' ? message(i.internetMessageId) : document(i.path)),
    storedRef: (i) =>
      i.kind === 'message'
        ? i.internetMessageId
          ? message(i.internetMessageId)
          : i.id
        : i.drivePath
          ? document(i.drivePath)
          : i.driveItemKey
            ? digest('doc', i.driveItemKey)
            : i.id,
    method: () => REDACTED,
    skipReason: () => REDACTED,
  };
}

// ── Indexes ──────────────────────────────────────────────────────────────────

type Indexes = {
  messages: Map<string, ExportItem>;
  documentsByPath: Map<string, ExportItem>;
  documentsByName: Map<string, ExportItem[]>;
  documentsByDriveItemId: Map<string, ExportItem>;
  /** Normalized Message-ID -> every ledger row naming it, of any decision. */
  ledgerByMessageId: Map<string, ExportLedgerRow[]>;
  /** Provider item id -> every ledger row for it, in any source. */
  ledgerByProviderItemId: Map<string, ExportLedgerRow[]>;
  routedConversations: Set<string>;
};

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Built from inputs already in canonical order, so a collision resolves the same way every time. */
function buildIndexes(data: DiscoveryExport): Indexes {
  const messages = new Map<string, ExportItem>();
  const documentsByPath = new Map<string, ExportItem>();
  const documentsByName = new Map<string, ExportItem[]>();
  const documentsByDriveItemId = new Map<string, ExportItem>();
  const routedConversations = new Set<string>();
  for (const item of data.items) {
    if (item.kind === 'message') {
      if (item.internetMessageId) {
        const id = normalizeMessageId(item.internetMessageId);
        if (!messages.has(id)) messages.set(id, item);
      }
      if (item.conversationId) routedConversations.add(item.conversationId);
      continue;
    }
    if (item.drivePath) {
      const path = normalizeDocumentPath(item.drivePath);
      if (!documentsByPath.has(path)) documentsByPath.set(path, item);
      push(documentsByName, basename(path), item);
    }
    const driveItemId = driveItemIdOf(item);
    if (driveItemId && !documentsByDriveItemId.has(driveItemId)) documentsByDriveItemId.set(driveItemId, item);
  }

  const ledgerByMessageId = new Map<string, ExportLedgerRow[]>();
  const ledgerByProviderItemId = new Map<string, ExportLedgerRow[]>();
  for (const row of data.ledger) {
    if (row.internetMessageId) push(ledgerByMessageId, normalizeMessageId(row.internetMessageId), row);
    push(ledgerByProviderItemId, row.providerItemId, row);
  }
  return {
    messages,
    documentsByPath,
    documentsByName,
    documentsByDriveItemId,
    ledgerByMessageId,
    ledgerByProviderItemId,
    routedConversations,
  };
}

function storedItemFor(item: KeyItem, idx: Indexes): ExportItem | null {
  if (item.kind === 'message') return idx.messages.get(normalizeMessageId(item.internetMessageId)) ?? null;
  const path = normalizeDocumentPath(item.path);
  const byPath = idx.documentsByPath.get(path);
  if (byPath) return byPath;
  if (!path.includes('/')) {
    const byName = idx.documentsByName.get(path) ?? [];
    if (byName.length === 1) return byName[0];
  }
  if (item.driveItemId) return idx.documentsByDriveItemId.get(item.driveItemId) ?? null;
  return null;
}

function skipReasonOf(rows: ExportLedgerRow[]): string | null {
  const skipped = rows.filter((r) => r.decision === 'skipped').map((r) => r.skipReason ?? 'unknown');
  return skipped.length === 0 ? null : skipped.sort(byCodePoint)[0];
}

/** Where a gold pair of an item that was not stored was lost. Any ledger row, skipped included, means it was read. */
function unstoredBucket(item: KeyItem, idx: Indexes): { bucket: MissBucket; skipReason: string | null } {
  if (item.kind === 'message') {
    const rows = idx.ledgerByMessageId.get(normalizeMessageId(item.internetMessageId)) ?? [];
    if (rows.length === 0) return { bucket: 'never_read', skipReason: null };
    const unrouted = rows.filter((r) => r.decision === 'unrouted');
    if (unrouted.length > 0) {
      if (item.attachmentOnly) return { bucket: 'attachment_only', skipReason: null };
      const late = unrouted.some((r) => r.conversationId !== null && idx.routedConversations.has(r.conversationId));
      return { bucket: late ? 'unrouted_late_thread' : 'unrouted_other', skipReason: null };
    }
    const reason = skipReasonOf(rows);
    if (reason !== null) return { bucket: 'skipped', skipReason: reason };
    return { bucket: 'routed_unlinked', skipReason: null };
  }

  if (!item.driveItemId) return { bucket: 'document_unresolved', skipReason: null };
  const rows = idx.ledgerByProviderItemId.get(item.driveItemId) ?? [];
  const reason = skipReasonOf(rows);
  if (reason !== null) return { bucket: 'skipped', skipReason: reason };
  if (rows.some((r) => r.decision === 'unrouted')) return { bucket: 'unrouted_other', skipReason: null };
  if (rows.some((r) => r.decision === 'routed')) return { bucket: 'routed_unlinked', skipReason: null };
  return { bucket: 'never_read', skipReason: null };
}

// ── One view of discovery ────────────────────────────────────────────────────

type ViewContext = {
  deals: KeyDeal[];
  keyItemByStoredId: Map<string, KeyItem>;
  storedIds: Set<string>;
  coverage: AnswerKey['itemCoverage'];
};

type DiscoveryView = {
  candidates: ExportCandidate[];
  /** Candidate id -> its distinct linked stored item ids, sorted. */
  itemsOf: Map<string, string[]>;
  /** Stored item id -> the candidate ids it is linked to in this view. */
  candidatesOf: Map<string, string[]>;
  evidence: Map<string, Evidence & { unlabeled: number }>;
  qualifying: Map<string, DealMatch[]>;
  assignment: Assignment;
  mergeKind: Map<string, MergeKind>;
  precision: Ratio;
  recall: Ratio;
  fragmentation: Ratio;
  merge: Ratio;
};

function discoveryView(candidates: ExportCandidate[], links: ExportLink[], ctx: ViewContext): DiscoveryView {
  const ids = new Set(candidates.map((c) => c.id));
  const itemSets = new Map<string, Set<string>>();
  const candidateSets = new Map<string, Set<string>>();
  for (const link of links) {
    if (!link.candidateId || !ids.has(link.candidateId)) continue;
    const items = itemSets.get(link.candidateId) ?? new Set<string>();
    items.add(link.sourceItemId);
    itemSets.set(link.candidateId, items);
    const cands = candidateSets.get(link.sourceItemId) ?? new Set<string>();
    cands.add(link.candidateId);
    candidateSets.set(link.sourceItemId, cands);
  }
  const itemsOf = new Map([...itemSets].map(([id, set]) => [id, [...set].sort(byCodePoint)]));
  const candidatesOf = new Map([...candidateSets].map(([id, set]) => [id, [...set].sort(byCodePoint)]));

  const evidence = new Map<string, Evidence & { unlabeled: number }>();
  const qualifying = new Map<string, DealMatch[]>();
  for (const candidate of candidates) {
    const e = { labeled: 0, unlabeled: 0, byDeal: {} as Record<string, number> };
    for (const itemId of itemsOf.get(candidate.id) ?? []) {
      const keyItem = ctx.keyItemByStoredId.get(itemId);
      if (keyItem) {
        e.labeled += 1;
        for (const dealId of keyItem.dealIds) increment(e.byDeal, dealId);
      } else if (ctx.coverage === 'complete' && ctx.storedIds.has(itemId)) {
        // With complete coverage, a stored item the key does not list belongs to no deal.
        e.labeled += 1;
      } else {
        e.unlabeled += 1;
      }
    }
    e.byDeal = sortedRecord(e.byDeal);
    evidence.set(candidate.id, e);
    qualifying.set(candidate.id, qualifyingDeals(candidate, ctx.deals, e));
  }

  const assignment = assignOneToOne(qualifying);
  const mergeKind = new Map<string, MergeKind>();
  const qualifyingCandidates = candidates.filter((c) => qualifying.get(c.id)!.length > 0);
  for (const candidate of qualifyingCandidates) {
    if (qualifying.get(candidate.id)!.length >= 2) {
      mergeKind.set(candidate.id, 'qualifying');
      continue;
    }
    const e = evidence.get(candidate.id)!;
    const heavy = Object.values(e.byDeal).filter(
      (n) => n >= MERGE_TUNING.minItems && e.labeled > 0 && n / e.labeled >= MERGE_TUNING.minShare,
    );
    if (heavy.length >= 2) mergeKind.set(candidate.id, 'evidence');
  }

  const perDeal = new Map<string, number>();
  for (const matches of qualifying.values()) for (const m of matches) perDeal.set(m.dealId, (perDeal.get(m.dealId) ?? 0) + 1);
  const pairedDeals = new Set(assignment.values());
  return {
    candidates,
    itemsOf,
    candidatesOf,
    evidence,
    qualifying,
    assignment,
    mergeKind,
    precision: ratio(assignment.size, candidates.length),
    recall: ratio(pairedDeals.size, ctx.deals.length),
    fragmentation: ratio([...perDeal.values()].filter((n) => n >= 2).length, perDeal.size),
    merge: ratio(mergeKind.size, qualifyingCandidates.length),
  };
}

/** The deals a stored item is predicted to belong to in a view; a link to an unpaired candidate yields a placeholder. */
function predictedDeals(view: DiscoveryView, storedId: string): Set<string> {
  const out = new Set<string>();
  for (const candidateId of view.candidatesOf.get(storedId) ?? []) {
    out.add(view.assignment.get(candidateId) ?? `unpaired:${candidateId}`);
  }
  return out;
}

function itemPrecision(view: DiscoveryView, ctx: ViewContext): { predicted: number; correct: number; notInKey: number } {
  let predicted = 0;
  let correct = 0;
  let notInKey = 0;
  for (const storedId of [...view.candidatesOf.keys()].sort(byCodePoint)) {
    const deals = predictedDeals(view, storedId);
    const keyItem = ctx.keyItemByStoredId.get(storedId);
    if (!keyItem) {
      if (ctx.storedIds.has(storedId)) notInKey += 1;
      if (ctx.coverage === 'complete') predicted += deals.size;
      continue;
    }
    predicted += deals.size;
    for (const deal of deals) if (keyItem.dealIds.includes(deal)) correct += 1;
  }
  return { predicted, correct, notInKey };
}

// ── The scorecard ────────────────────────────────────────────────────────────

const SCORED_STATES = new Set<string>(CANDIDATE_STATE_POLICY.postRejection);
const CREATED_STATES = new Set<string>(CANDIDATE_STATE_POLICY.preRejection);

/** Every input in one canonical order, so the scorecard does not depend on the order rows arrive in (review item 10). */
function canonical(key: AnswerKey, data: DiscoveryExport): { key: AnswerKey; data: DiscoveryExport } {
  const ledgerKey = (r: ExportLedgerRow) =>
    [r.sourceId, r.providerItemId, r.recordedAt, r.runId, r.decision, r.internetMessageId ?? ''].join('\u0000');
  return {
    key: { ...key, deals: sortedBy(key.deals, (d) => d.id), items: sortedBy(key.items, keyIdentity) },
    data: {
      ...data,
      sources: sortedBy(data.sources, (s) => s.id),
      ledger: sortedBy(data.ledger, ledgerKey),
      items: sortedBy(data.items, (i) => i.id),
      provenance: sortedBy(data.provenance, (p) => `${p.sourceItemId}\u0000${p.sourceId}\u0000${p.providerItemId}`),
      candidates: sortedBy(data.candidates, (c) => c.id),
      links: sortedBy(data.links, (l) => l.id),
    },
  };
}

export function score(rawKey: AnswerKey, rawData: DiscoveryExport, options: ScoreOptions = {}): Scorecard {
  // The same row checks readExport makes, so no caller scores a row the views would skip.
  validateRows(rawData);
  const { key, data } = canonical(rawKey, rawData);
  const redact = options.redact ?? false;
  const names = namer(key.deals, redact);
  const idx = buildIndexes(data);

  // ── Key items <-> stored items ────────────────────────────────────────────
  const keyItemByStoredId = new Map<string, KeyItem>();
  const storedByKeyItem = new Map<KeyItem, ExportItem | null>();
  for (const item of key.items) {
    const stored = storedItemFor(item, idx);
    storedByKeyItem.set(item, stored);
    if (stored && !keyItemByStoredId.has(stored.id)) keyItemByStoredId.set(stored.id, item);
  }
  const ctx: ViewContext = {
    deals: key.deals,
    keyItemByStoredId,
    storedIds: new Set(data.items.map((i) => i.id)),
    coverage: key.itemCoverage,
  };

  // ── The two views ─────────────────────────────────────────────────────────
  const scored = data.candidates.filter((c) => SCORED_STATES.has(c.discoveryState));
  const scoredIds = new Set(scored.map((c) => c.id));
  const created = data.candidates.filter((c) => CREATED_STATES.has(c.discoveryState));
  const post = discoveryView(
    scored,
    data.links.filter((l) => l.state !== 'rejected'),
    ctx,
  );
  const pre = discoveryView(created, data.links, ctx);

  // ── Item precision ────────────────────────────────────────────────────────
  const postItems = itemPrecision(post, ctx);
  const preItems = itemPrecision(pre, ctx);

  // ── Item recall, with every miss in one bucket ────────────────────────────
  const outcomes: PairOutcome[] = [];
  const misses = Object.fromEntries(MISS_BUCKETS.map((b) => [b, 0])) as Record<MissBucket, number>;
  const skippedByReason: Record<string, number> = {};
  const attachmentOnly = { inKey: 0, recovered: 0 };
  for (const item of key.items) {
    const stored = storedByKeyItem.get(item) ?? null;
    const deals = stored ? predictedDeals(post, stored.id) : new Set<string>();
    const attachment = item.kind === 'message' && item.attachmentOnly;
    const itemRef = names.keyRef(item);
    for (const dealId of item.dealIds) {
      if (attachment) attachmentOnly.inKey += 1;
      const base = { itemRef, kind: item.kind, dealId: names.dealId(dealId), attachmentOnly: attachment };
      if (deals.has(dealId)) {
        if (attachment) attachmentOnly.recovered += 1;
        outcomes.push({ ...base, outcome: 'recovered', skipReason: null });
        continue;
      }
      let bucket: MissBucket;
      let skipReason: string | null = null;
      if (stored) {
        const linked = post.candidatesOf.get(stored.id) ?? [];
        const fragment = linked.some((c) => post.qualifying.get(c)!.some((m) => m.dealId === dealId));
        bucket = linked.length === 0 ? 'routed_unlinked' : fragment ? 'routed_fragment' : 'routed_elsewhere';
      } else {
        ({ bucket, skipReason } = unstoredBucket(item, idx));
      }
      misses[bucket] += 1;
      const shownReason = skipReason === null ? null : names.skipReason(skipReason);
      if (shownReason) increment(skippedByReason, shownReason);
      outcomes.push({ ...base, outcome: bucket, skipReason: shownReason });
    }
  }
  const goldPairs = outcomes.length;
  const recovered = outcomes.filter((o) => o.outcome === 'recovered').length;
  // Readable: both sides leave out attachment-only items (recovered or not) and skipped ones.
  const readable = outcomes.filter((o) => !o.attachmentOnly && o.outcome !== 'skipped');

  // Read, unrouted: once per true-deal item, whatever its number of deals.
  const trueDealRefs = new Set<string>();
  const readUnroutedByRef = new Map<string, ReadUnroutedBucket>();
  let readUnroutedPairs = 0;
  for (const o of outcomes) {
    const ref = `${o.kind}:${o.itemRef}`;
    trueDealRefs.add(ref);
    if (!READ_UNROUTED.has(o.outcome)) continue;
    readUnroutedPairs += 1;
    if (!readUnroutedByRef.has(ref)) readUnroutedByRef.set(ref, o.outcome as ReadUnroutedBucket);
  }
  const readUnroutedByBucket = Object.fromEntries(READ_UNROUTED_BUCKETS.map((b) => [b, 0])) as Record<
    ReadUnroutedBucket,
    number
  >;
  for (const bucket of readUnroutedByRef.values()) readUnroutedByBucket[bucket] += 1;
  const routingFixablePairs = misses.unrouted_late_thread + misses.unrouted_other;

  // ── Candidates ────────────────────────────────────────────────────────────
  const candidateRows: CandidateRow[] = data.candidates.map((candidate) => {
    const isScored = scoredIds.has(candidate.id);
    const view = isScored ? post : pre;
    const paired = view.assignment.get(candidate.id) ?? null;
    const e = view.evidence.get(candidate.id) ?? { labeled: 0, unlabeled: 0, byDeal: {} };
    const labeled = { correct: 0, wrong: 0, unlabeled: e.unlabeled };
    for (const itemId of view.itemsOf.get(candidate.id) ?? []) {
      const keyItem = keyItemByStoredId.get(itemId);
      if (keyItem) {
        if (paired && keyItem.dealIds.includes(paired)) labeled.correct += 1;
        else labeled.wrong += 1;
      } else if (key.itemCoverage === 'complete' && ctx.storedIds.has(itemId)) {
        labeled.wrong += 1;
      }
    }
    const preRejectionPair = pre.assignment.get(candidate.id) ?? null;
    return {
      id: candidate.id,
      name: names.candidate(candidate),
      state: candidate.discoveryState,
      scored: isScored,
      pairedDealId: paired === null ? null : names.dealId(paired),
      pairedDealIdPreRejection: preRejectionPair === null ? null : names.dealId(preRejectionPair),
      qualifying: (view.qualifying.get(candidate.id) ?? []).map((m) => ({ ...m, dealId: names.dealId(m.dealId) })),
      merge: view.mergeKind.get(candidate.id) ?? null,
      evidenceItems: (view.itemsOf.get(candidate.id) ?? []).length,
      labeled,
      evidenceDeals: sortedRecord(Object.fromEntries(Object.entries(e.byDeal).map(([id, n]) => [names.dealId(id), n]))),
    };
  });

  // ── Deals ─────────────────────────────────────────────────────────────────
  const pairedCandidateOf = new Map([...post.assignment].map(([c, d]) => [d, c]));
  const dealRows: DealRow[] = key.deals.map((deal) => {
    const shownId = names.dealId(deal.id);
    const dealOutcomes = outcomes.filter((o) => o.dealId === shownId);
    return {
      id: shownId,
      name: names.deal(deal),
      pairedCandidateId: pairedCandidateOf.get(deal.id) ?? null,
      qualifyingIds: scored.filter((c) => post.qualifying.get(c.id)!.some((m) => m.dealId === deal.id)).map((c) => c.id),
      goldItems: dealOutcomes.length,
      recoveredItems: dealOutcomes.filter((o) => o.outcome === 'recovered').length,
    };
  });

  // ── Ingestion ─────────────────────────────────────────────────────────────
  const sources: Record<string, number> = {};
  for (const s of data.sources) increment(sources, s.kind);
  const ledgerByDecision: Record<string, number> = {};
  const tenantSkips: Record<string, number> = {};
  for (const row of data.ledger) {
    increment(ledgerByDecision, row.decision);
    if (row.decision === 'skipped') increment(tenantSkips, names.skipReason(row.skipReason ?? 'unknown'));
  }
  const storedItems: Record<string, number> = {};
  for (const item of data.items) increment(storedItems, item.kind);
  const candidatesByState: Record<string, number> = {};
  for (const c of data.candidates) increment(candidatesByState, c.discoveryState);
  const linkTiers = new Map<string, { method: string; tier: string; active: number; rejected: number }>();
  for (const link of data.links) {
    const method = names.method(link.method);
    const k = `${method}\u0000${link.routeTier}`;
    const row = linkTiers.get(k) ?? { method, tier: link.routeTier, active: 0, rejected: 0 };
    if (link.state === 'rejected') row.rejected += 1;
    else row.active += 1;
    linkTiers.set(k, row);
  }

  const card: Scorecard = {
    meta: {
      harnessVersion: HARNESS_VERSION,
      harnessCommit: options.provenance?.commit ?? null,
      harnessDirty: options.provenance?.dirty ?? null,
      tuningDigest: TUNING_DIGEST,
      redacted: redact,
      exportFormat: data.manifest.format,
      keyFormat: key.format,
      tenantId: data.manifest.tenantId,
      exportedAt: data.manifest.exportedAt,
      itemCoverage: key.itemCoverage,
      keyDeals: key.deals.length,
      keyItems: key.items.length,
    },
    discovery: {
      scoredCandidates: scored.length,
      createdCandidates: created.length,
      excluded: {
        rejected: data.candidates.filter((c) => c.discoveryState === 'rejected').length,
        mergedInto: data.candidates.filter((c) => c.discoveryState === 'merged_into').length,
      },
      precision: post.precision,
      recall: post.recall,
      fragmentation: post.fragmentation,
      merge: post.merge,
      preRejection: { precision: pre.precision, recall: pre.recall, fragmentation: pre.fragmentation, merge: pre.merge },
      deals: dealRows,
      candidates: candidateRows,
    },
    items: {
      precision: ratio(postItems.correct, postItems.predicted),
      precisionPreRejection: ratio(preItems.correct, preItems.predicted),
      recall: ratio(recovered, goldPairs),
      readableRecall: ratio(readable.filter((o) => o.outcome === 'recovered').length, readable.length),
      predictedPairs: postItems.predicted,
      goldPairs,
      routedNotInKey: postItems.notInKey,
      misses,
      skippedByReason: sortedRecord(skippedByReason),
      attachmentOnly,
      readUnrouted: {
        items: readUnroutedByRef.size,
        share: ratio(readUnroutedByRef.size, trueDealRefs.size),
        byBucket: readUnroutedByBucket,
        pairs: readUnroutedPairs,
        routingFixablePairs,
        attachmentPairs: misses.attachment_only,
        routingCeiling: ratio(recovered + routingFixablePairs, goldPairs),
        attachmentCeiling: ratio(recovered + routingFixablePairs + misses.attachment_only, goldPairs),
      },
      outcomes,
    },
    checkpoint: checkpoint(
      {
        discoveryPrecision: pre.precision,
        discoveryRecall: post.recall,
        itemPrecision: ratio(preItems.correct, preItems.predicted),
        itemRecall: ratio(recovered, goldPairs),
        fragmentation: pre.fragmentation,
        merge: pre.merge,
      },
      key.itemCoverage,
    ),
    ingestion: {
      sources: sortedRecord(sources),
      sourcesWithOwner: data.sources.filter((s) => s.ownerAssigned).length,
      sourcesBackfilled: data.sources.filter((s) => s.backfillCompletedAt !== null).length,
      ledgerByDecision: sortedRecord(ledgerByDecision),
      storedItems: sortedRecord(storedItems),
      skippedByReason: sortedRecord(tenantSkips),
      candidatesByState: sortedRecord(candidatesByState),
      linksByMethodTier: [...linkTiers.values()].sort(
        (a, b) => byCodePoint(a.tier, b.tier) || byCodePoint(a.method, b.method),
      ),
    },
    worstErrors: [],
  };
  card.worstErrors = worstErrors(card, data, post, names);
  return card;
}

const CHECKS: Array<Omit<CheckpointCheck, 'value' | 'met'>> = [
  { metric: 'discoveryPrecision', label: 'Discovery precision', basis: 'pre-rejection', bound: 'min', target: CHECKPOINT_TARGETS.discoveryPrecision },
  { metric: 'discoveryRecall', label: 'Discovery recall', basis: 'post-rejection', bound: 'min', target: CHECKPOINT_TARGETS.discoveryRecall },
  { metric: 'itemPrecision', label: 'Item precision', basis: 'pre-rejection', bound: 'min', target: CHECKPOINT_TARGETS.itemPrecision },
  { metric: 'itemRecall', label: 'Item recall', basis: 'post-rejection', bound: 'min', target: CHECKPOINT_TARGETS.itemRecall },
  { metric: 'fragmentation', label: 'Fragmentation rate', basis: 'pre-rejection', bound: 'max', target: CHECKPOINT_TARGETS.fragmentation },
  { metric: 'merge', label: 'Merge rate', basis: 'pre-rejection', bound: 'max', target: CHECKPOINT_TARGETS.merge },
];

/**
 * The week-2 decision against the provisional targets. Every metric a
 * rejection or a merge could improve is taken pre-rejection; recall is
 * post-rejection, which rejection can only lower. An n/a (0/0) value fails,
 * except for discovery precision and recall, where it means there is nothing
 * to decide on. A partial key gives no verdict at all: the checks are still
 * shown, but unlabeled items are invisible to them (second review).
 */
export function checkpoint(values: Record<CheckpointMetric, Ratio>, coverage: AnswerKey['itemCoverage']): Scorecard['checkpoint'] {
  const checks: CheckpointCheck[] = CHECKS.map((c) => {
    const value = values[c.metric];
    const decidable = c.metric === 'discoveryPrecision' || c.metric === 'discoveryRecall';
    const met =
      value.value === null
        ? decidable
          ? null
          : false
        : c.bound === 'min'
          ? value.value >= c.target
          : value.value <= c.target;
    return { ...c, value, met };
  });
  const verdict =
    coverage !== 'complete'
      ? 'undetermined'
      : checks.some((c) => c.met === false)
        ? 'seeded'
        : checks.every((c) => c.met === true)
          ? 'discovery_led'
          : 'undetermined';
  return {
    checks,
    verdict,
    undeterminedBecause:
      verdict !== 'undetermined' ? null : coverage !== 'complete' ? 'partial_key' : 'no_discovery_data',
    coverage,
    provisional: CHECKPOINT_TARGETS.provisional,
    setBy: CHECKPOINT_TARGETS.setBy,
  };
}

// ── The five worst errors ────────────────────────────────────────────────────

const EVIDENCE_SHOWN = 5;

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function worstErrors(card: Scorecard, data: DiscoveryExport, post: DiscoveryView, names: Namer): WorstError[] {
  const errors: WorstError[] = [];
  const storedById = new Map(data.items.map((i) => [i.id, i]));
  const candidateById = new Map(data.candidates.map((c) => [c.id, c]));
  const candidateItems = (candidateId: string): string[] =>
    (post.itemsOf.get(candidateId) ?? [])
      .map((id) => storedById.get(id))
      .filter((i): i is ExportItem => i !== undefined)
      .map(names.storedRef)
      .sort(byCodePoint);
  const candidateLabel = (id: string) => {
    const name = names.candidate(candidateById.get(id)!);
    return name === REDACTED ? `Candidate ${shortId(id)}` : `Candidate "${name}" (${shortId(id)})`;
  };

  for (const deal of card.discovery.deals) {
    const dealOutcomes = card.items.outcomes.filter((o) => o.dealId === deal.id);
    if (deal.pairedCandidateId === null) {
      errors.push({
        kind: 'missed_deal',
        title: `${names.dealLabel(deal.id)} was not discovered`,
        weight: Math.max(1, deal.goldItems),
        evidence: dealOutcomes
          .map((o) => `${o.itemRef} (${o.outcome})`)
          .sort(byCodePoint)
          .slice(0, EVIDENCE_SHOWN),
      });
    }
    if (deal.qualifyingIds.length >= 2) {
      const sizes = deal.qualifyingIds
        .map((id) => ({ id, n: candidateItems(id).length }))
        .sort((a, b) => b.n - a.n || byCodePoint(a.id, b.id));
      errors.push({
        kind: 'fragmented_deal',
        title: `${names.dealLabel(deal.id)} is split across ${deal.qualifyingIds.length} candidates`,
        weight: Math.max(1, sizes.slice(1).reduce((sum, s) => sum + s.n, 0)),
        evidence: sizes.map((s) => `candidate ${shortId(s.id)} (${s.n} items)`),
      });
    }
    for (const bucket of MISS_BUCKETS) {
      const refs = dealOutcomes.filter((o) => o.outcome === bucket).map((o) => o.itemRef).sort(byCodePoint);
      if (refs.length === 0) continue;
      errors.push({
        kind: 'item_misses',
        title: `${names.dealLabel(deal.id)}: ${refs.length} ${refs.length === 1 ? 'item' : 'items'} lost as "${BUCKET_LABEL[bucket].label}"`,
        weight: refs.length,
        evidence: refs.slice(0, EVIDENCE_SHOWN),
      });
    }
  }

  for (const row of card.discovery.candidates) {
    if (!row.scored) continue;
    if (row.qualifying.length === 0) {
      errors.push({
        kind: 'false_candidate',
        title: `${candidateLabel(row.id)} matches no deal in the key`,
        weight: Math.max(1, row.evidenceItems),
        evidence: candidateItems(row.id).slice(0, EVIDENCE_SHOWN),
      });
    } else if (row.merge !== null) {
      const [first, ...rest] =
        row.merge === 'qualifying'
          ? row.qualifying.map((q) => q.dealId)
          : Object.entries(row.evidenceDeals)
              .sort((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0]))
              .map(([id]) => id);
      const weight = Object.entries(row.evidenceDeals)
        .filter(([id]) => id !== first)
        .reduce((sum, [, n]) => sum + n, 0);
      errors.push({
        kind: 'merged_candidate',
        title: `${candidateLabel(row.id)} holds ${names.dealLabel(first)} and ${rest.join(', ')}`,
        weight: Math.max(1, weight),
        evidence: candidateItems(row.id).slice(0, EVIDENCE_SHOWN),
      });
    }
  }

  const order: WorstError['kind'][] = ['missed_deal', 'merged_candidate', 'false_candidate', 'fragmented_deal', 'item_misses'];
  return errors
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        order.indexOf(a.kind) - order.indexOf(b.kind) ||
        byCodePoint(a.title, b.title) ||
        byCodePoint(a.evidence.join('\n'), b.evidence.join('\n')),
    )
    .slice(0, 5);
}
