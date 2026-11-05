// Firm routing rules (Q7): deterministic methods whose routes are `firm`
// whatever their score. Phase 3 has three:
//
//   codename             "Project <Name>" in the subject or the body, or
//                        "<Name>: topic" opening the subject (#622): see below
//   alias                the distinctive word of a known codename ("Falcon"),
//                        as a whole capitalized word, in the subject or body
//   thread_continuation  a message in the same conversation as a routed one,
//                        with the same subject once reply and forward prefixes
//                        are dropped. A subject change ends the thread, so a
//                        reply-all that drifts to another topic stays unrouted.
//
// Only the top of each message is read (quoted history is already dropped by
// the normalizer), so a reply cannot route on a thread it merely quotes. An
// item can route to more than one codename.
//
// The subject prefix ("Kestrel: lender feedback") is the weakest codename
// signal, so it is fenced (#622 review):
//   - it is counted per mailbox: a prefix becomes a codename for a content
//     source only when messages its firm people sent open at least
//     MIN_PREFIX_TOPICS different topics in that source's items. One banker's
//     mail never teaches another banker's mailbox (information barriers), and
//     an item read in several mailboxes routes on a prefix only if every one
//     of them promoted it. The evidence can span calls (`knownPrefixEvidence`:
//     the worker carries it page to page, #173 G-09): the prefix word itself,
//     and keyed digests (not plaintext) of its topics and senders;
//     routing only ever reads the per-source counts;
//   - a firm sender is a person: a firm-domain From (`internalDomains`) whose
//     local part is not an automated one (noreply, postmaster, ...), keyed
//     without "+tag". So newsletters, invoices, e-signature notices and other
//     outside senders cannot seed a prefix, and neither can firm automation.
//     A prefix needs MIN_PREFIX_SENDERS different firm people in the source,
//     or the source owner's own use on MIN_PREFIX_TOPICS topics of which one
//     subject is a reply ("Re:"). A Graph Sent Items page has a single sender,
//     which is why the owner counts. The reply test reads the subject only:
//     Graph gives no thread headers here, so a system sending as the mailbox
//     that writes a "Re:" subject passes it. Unmatched owners (send-as
//     aliases, a UPN that differs from the SMTP address) fall back to the
//     two-person test. Two firm service mailboxes, or a colleague forwarding
//     a system's notice, still count as two people. It never needs an outside
//     participant: internal-only deals are real deals. Without
//     `internalDomains` the rule is off;
//   - it routes only the subjects it opens. It never feeds the alias rule,
//     thread continuation or RoutingContext (`fromSubjectPrefix`), so it cannot
//     pull bodies or whole threads into storage, and its codename is the bare
//     word ("Kestrel"), which codenamesIn never reads back from a candidate;
//   - its confidence is below thread continuation.
// An outside sender gains nothing it lacked: "Project X" already routes, and
// this rule needs firm senders and returns no signal.
//
// The firm check trusts the From header, so it is only as strong as the tenant's
// DMARC and anti-spoofing: Exchange Online accepts unauthenticated Direct Send
// from any accepted-domain address unless RejectDirectSend is on. Forged firm
// mail can seed a label in every source that reads it (counting is per source,
// not per message), and there routes only subjects that carry the label, never
// bodies, threads or aliases.
//
// Alias and thread knowledge is confined by source (#173 G-09). A codename or a
// routed thread remembers the sources whose mail wrote the literal "Project
// <Name>" (`taughtIn`). Only that literal teaches: an alias or thread route adds
// no source, a prefix route adds none, so a refused route can never launder
// knowledge into another mailbox. An alias or thread route is made only if every
// source that observed the item allows it (`admit`): a shared source (a team or
// ownerless inbox) must itself have taught the key; a personal source needs some
// personal teacher, the pooling across personal mailboxes as built. The decision
// is per item, so a copy read in two sources that one side may not route is
// refused on both. `scope` is required: callers that want no confinement (the
// demo pipeline, tests) say 'unscoped'.

import { createHmac, randomBytes } from 'node:crypto';

import { ROUTE_METHOD, type RouteMethod } from '@/lib/constants/discovery';
import { isReplySubject, stripReplyPrefixes, type DedupedItem } from '@/lib/discovery/normalize';

export type FirmRoute = {
  /** Lowercased distinctive word: the grouping key ("falcon"). */
  codenameKey: string;
  /** As bankers write it ("Project Falcon"). */
  codename: string;
  method: RouteMethod;
  confidence: number;
  /** Set on a subject prefix route (#622): it never teaches the alias rule, a thread or the routing context. */
  fromSubjectPrefix?: true;
  /**
   * Set to false on a route a person's accept made durable (G-02b #173, `modelProposalRoute`): it routes the one message
   * it names and teaches nothing, so RoutingContext.learn skips it as it skips a subject prefix route.
   */
  teaches?: false;
};

/**
 * The route of a message a person accepted from a model proposal (G-02b #173, design R5). It is never made by
 * routeByFirmRules: the accept's commit and the routing context attach it to the exact messages that were accepted,
 * and only where the rules routed nothing. It has no codename, teaches no codename, thread or alias (`teaches: false`),
 * and its confidence is fixed: the model's number is not known where the route is rebuilt on a later pass, and the
 * ledger must not change between the commit and that pass.
 */
export function modelProposalRoute(): FirmRoute {
  return { codenameKey: '', codename: '', method: ROUTE_METHOD.MODEL_PROPOSAL, confidence: 1, teaches: false };
}

export type RoutedItem = DedupedItem & { routes: FirmRoute[] };

/** A codename, or a codename on a thread, with the sources whose mail wrote its literal "Project <Name>". */
export type Taught = { codename: string; taughtIn: ReadonlySet<string> };

/**
 * Which sources are shared (a team inbox or one with no owner), or 'unscoped' for no confinement. A source that is
 * not in `shared` is personal.
 */
export type RoutingScope = { shared: ReadonlySet<string> } | 'unscoped';

type MutableTaught = { codename: string; taughtIn: Set<string> };

/** Out-parameter of routeByFirmRules: numbers only. */
export type RouteCounts = { scopeBlocked: number };

/**
 * True if every source that observed the item allows a route taught in `taughtIn`. A shared source must be in
 * `taughtIn` itself; a personal source needs some teacher outside `shared`. Always true when unscoped.
 */
export function admit(item: DedupedItem, taughtIn: ReadonlySet<string>, scope: RoutingScope): boolean {
  if (scope === 'unscoped') return true;
  // An item no source observed has no source to allow it: `every` over nothing would admit it.
  if (item.observations.length === 0) return false;
  const personalTeacher = [...taughtIn].some((sourceId) => !scope.shared.has(sourceId));
  return item.observations.every(({ sourceId }) => (scope.shared.has(sourceId) ? taughtIn.has(sourceId) : personalTeacher));
}

/** Only a literal "Project <Name>" route adds sources to what a key or a thread has been taught in. */
export const addsSources = (route: FirmRoute): boolean => route.method === ROUTE_METHOD.CODENAME && !route.fromSubjectPrefix;

/** Confidence by method. Firm routes are deterministic; the number orders them, it is not calibrated. */
export const FIRM_ROUTE_CONFIDENCE = {
  CODENAME_SUBJECT: 0.95,
  CODENAME_BODY: 0.9,
  THREAD_CONTINUATION: 0.85,
  CODENAME_SUBJECT_PREFIX: 0.8,
  ALIAS: 0.75,
} as const;

/**
 * Words that follow "Project" in ordinary business English. A codename is a
 * proper noun that is not one of these.
 */
const NOT_A_CODENAME = new Set([
  'budget', 'charter', 'code', 'kickoff', 'lead', 'list', 'management', 'manager', 'managers',
  'meeting', 'name', 'names', 'office', 'overview', 'plan', 'planning', 'proposal', 'report',
  'review', 'schedule', 'scope', 'status', 'summary', 'team', 'timeline', 'tracker', 'update',
  'updates',
]);

const CODENAME_PATTERN = /\bProject\s+([A-Z][a-z]{2,})\b/g;

/**
 * Words that open subjects as a label, not a deal: notices, calendar replies,
 * workflow tags. A subject prefix is a codename only when it is none of these.
 */
const NOT_A_PREFIX_CODENAME = new Set([
  'accepted', 'action', 'agenda', 'alert', 'announcement', 'approved', 'automatic', 'booking',
  'canceled', 'cancelled', 'certificate', 'completed', 'confirmation', 'declined', 'delivery',
  'draft', 'external', 'feedback', 'final', 'fyi', 'important', 'intro', 'introduction', 'invitation',
  'invoice', 'minutes', 'note', 'notes', 'notice', 'order', 'payment', 'question', 'questions', 'read',
  'recap', 'receipt', 'rejected', 'reminder', 'request', 'security', 'survey', 'tentative', 'training',
  'undeliverable', 'updated', 'urgent', 'warning', 'webinar', 'weekly',
  // #653: labels the #626 review named (firm automation and everyday office prefixes)
  'approval', 'calendar', 'compliance', 'docusign', 'expense', 'hiring', 'holiday', 'lunch', 'missed',
  'offsite', 'reply', 'sent', 'shared', 'signed', 'thanks', 'ticket', 'timesheet', 'travel', 'voicemail',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december',
]);

/** Different topics a subject prefix must open in one mailbox, from firm senders, before it counts as a codename. */
export const MIN_PREFIX_TOPICS = 2;

/** Distinct firm people a prefix needs in one mailbox, unless its owner uses it on topics that include a reply. */
export const MIN_PREFIX_SENDERS = 2;

// Local parts that by convention mark a machine, not a person (RFC 2142, RFC 3834 and common practice).
// Compared after lowercasing, dropping "+tag" and removing ".", "-" and "_".
const AUTOMATED_LOCAL_PREFIXES = ['noreply', 'donotreply', 'mailerdaemon', 'bounce'];
const AUTOMATED_LOCAL_PARTS = new Set(['postmaster', 'notification', 'notifications', 'notify', 'alert', 'alerts']);

const SUBJECT_PREFIX_PATTERN = /^([A-Z][a-z]{2,}):\s+(\S.*)$/;

/** The "<Name>" of a subject that opens "<Name>: topic" once reply prefixes are dropped, with its topic. */
function subjectPrefix(subject: string): { key: string; word: string; topic: string } | null {
  const match = SUBJECT_PREFIX_PATTERN.exec(stripReplyPrefixes(subject));
  if (!match) return null;
  const key = match[1].toLowerCase();
  if (NOT_A_CODENAME.has(key) || NOT_A_PREFIX_CODENAME.has(key)) return null;
  return { key, word: match[1], topic: match[2].replace(/\s+/g, ' ').toLowerCase() };
}

/** Lowercased address with any "+tag" dropped from the local part: one person is one key. Dots are kept. */
function senderKey(address: string): string {
  const at = address.lastIndexOf('@');
  const lowered = address.toLowerCase();
  if (at < 0) return lowered;
  const local = lowered.slice(0, at);
  return `${local.split('+')[0] || local}${lowered.slice(at)}`;
}

function isAutomatedLocalPart(local: string): boolean {
  const normalized = local.replace(/[.\-_]/g, '');
  return AUTOMATED_LOCAL_PARTS.has(normalized) || AUTOMATED_LOCAL_PREFIXES.some((p) => normalized.startsWith(p));
}

/** senderKey(from) when a firm person sent it: a firm domain and a local part that is not automated. */
function firmHumanSender(item: DedupedItem['item'], internal: ReadonlySet<string>): string | null {
  const from = item.participants.find((p) => p.role === 'from')?.address;
  if (!from) return null;
  const key = senderKey(from);
  const at = key.lastIndexOf('@');
  if (at < 1 || !internal.has(key.slice(at + 1))) return null;
  return isAutomatedLocalPart(key.slice(0, at)) ? null : key;
}

/**
 * The evidence for one prefix in one source, as much as the bar needs and no more. Topics and senders are held as keyed
 * digests (`evidenceDigest`), not plaintext: a ledger outlives the page it was counted on (RoutingContext carries it
 * across pages, #173 G-09), and it also counts mail that routed nowhere, whose text is never kept (Q5). Each set keeps
 * at most EVIDENCE_KEPT distinct values, the most any threshold reads, and a promoted prefix keeps none: it stays
 * promoted. `word` is the prefix itself.
 */
export type PrefixEvidence = {
  word: string;
  promoted: boolean;
  seen: Set<string>;
  senders: Set<string>;
  /** Topics the source's owner opened with this prefix, and whether one of those subjects was a reply. */
  ownerTopics: Set<string>;
  ownerReplied: boolean;
};

/** sourceId -> prefix key -> its evidence in that source. Counted per source: one mailbox never promotes another's. */
export type PrefixLedger = Map<string, Map<string, PrefixEvidence>>;
type ReadonlyPrefixLedger = ReadonlyMap<string, ReadonlyMap<string, PrefixEvidence>>;

/** Distinct values a set keeps: no threshold reads more. */
const EVIDENCE_KEPT = Math.max(MIN_PREFIX_TOPICS, MIN_PREFIX_SENDERS);

/**
 * Prefix keys tracked per source in a ledger. A source past it adds no new key (its existing keys still gain evidence),
 * so a mailbox full of one-off "Word:" subjects cannot grow the ledger without bound. A new prefix can still promote
 * within one batch.
 */
export const MAX_PREFIX_KEYS_PER_SOURCE = 256;

/** A per-process key: the digests cannot be matched against guessed addresses or deal words, nor across processes. */
const EVIDENCE_KEY = randomBytes(32);

/** A short keyed digest of a topic or a sender key, scoped by source. A collision can only lower a count. */
function evidenceDigest(sourceId: string, value: string): string {
  return createHmac('sha256', EVIDENCE_KEY).update(`${sourceId}\u0000${value}`, 'utf8').digest('hex').slice(0, 16);
}

function meetsBar(seen: number, senders: number, ownerTopics: number, ownerReplied: boolean): boolean {
  const owned = ownerTopics >= MIN_PREFIX_TOPICS && ownerReplied;
  return seen >= MIN_PREFIX_TOPICS && (senders >= MIN_PREFIX_SENDERS || owned);
}

function keepOne(set: Set<string>, value: string): void {
  if (set.size < EVIDENCE_KEPT) set.add(value);
}

/** The distinct values of two small sets, counted. */
function unionSize(a: ReadonlySet<string> | undefined, b: ReadonlySet<string> | undefined): number {
  if (!a) return b?.size ?? 0;
  if (!b) return a.size;
  let n = a.size;
  for (const value of b) if (!a.has(value)) n += 1;
  return n;
}

/**
 * Adds the prefix evidence of `items` to `ledger`, per source that observed each item: the prefix, a digest of its
 * topic and of its firm sender, and whether the source's owner (`sourceOwners`: sourceId -> the mailbox's own
 * address) sent it, on a reply subject or not. Only firm people count. Nothing without `internalDomains`.
 */
export function notePrefixEvidence(
  ledger: PrefixLedger,
  items: ReadonlyArray<DedupedItem>,
  internalDomains: readonly string[] = [],
  sourceOwners: ReadonlyMap<string, string> = new Map(),
  maxKeysPerSource: number = MAX_PREFIX_KEYS_PER_SOURCE,
): PrefixLedger {
  const internal = new Set(internalDomains.map((d) => d.toLowerCase()));
  if (internal.size === 0) return ledger;
  const owners = new Map([...sourceOwners].map(([sourceId, address]) => [sourceId, senderKey(address)]));
  for (const { item, observations } of items) {
    const prefix = subjectPrefix(item.subject);
    const sender = prefix ? firmHumanSender(item, internal) : null;
    if (!prefix || !sender) continue;
    for (const { sourceId } of observations) {
      const bySource = ledger.get(sourceId) ?? new Map<string, PrefixEvidence>();
      let entry = bySource.get(prefix.key);
      if (!entry) {
        if (bySource.size >= maxKeysPerSource) continue;
        entry = { word: prefix.word, promoted: false, seen: new Set(), senders: new Set(), ownerTopics: new Set(), ownerReplied: false };
        bySource.set(prefix.key, entry);
        ledger.set(sourceId, bySource);
      }
      if (entry.promoted) continue;
      const topic = evidenceDigest(sourceId, prefix.topic);
      keepOne(entry.seen, topic);
      keepOne(entry.senders, evidenceDigest(sourceId, sender));
      // Per source: a message read in two mailboxes is owner evidence only in the one whose owner sent it.
      if (sender === owners.get(sourceId)) {
        keepOne(entry.ownerTopics, topic);
        if (isReplySubject(item.subject)) entry.ownerReplied = true;
      }
      if (meetsBar(entry.seen.size, entry.senders.size, entry.ownerTopics.size, entry.ownerReplied)) {
        entry.promoted = true;
        entry.seen.clear();
        entry.senders.clear();
        entry.ownerTopics.clear();
      }
    }
  }
  return ledger;
}

/**
 * The prefix word if `key` is promoted in `sourceId` on the carried evidence and this batch's together, read side by
 * side: neither ledger is copied or changed.
 */
function promotedWord(
  carried: ReadonlyPrefixLedger | undefined,
  batch: ReadonlyPrefixLedger,
  sourceId: string,
  key: string,
): string | undefined {
  const k = carried?.get(sourceId)?.get(key);
  const b = batch.get(sourceId)?.get(key);
  if (!k && !b) return undefined;
  const word = (k ?? b)!.word;
  if (k?.promoted || b?.promoted) return word;
  const ok = meetsBar(
    unionSize(k?.seen, b?.seen),
    unionSize(k?.senders, b?.senders),
    unionSize(k?.ownerTopics, b?.ownerTopics),
    Boolean(k?.ownerReplied || b?.ownerReplied),
  );
  return ok ? word : undefined;
}

/** Per source, the promoted prefixes of a ledger, mapped to the bare word ("Kestrel"). */
export function promotedPrefixes(ledger: ReadonlyPrefixLedger): Map<string, Map<string, string>> {
  const codenames = new Map<string, Map<string, string>>();
  for (const [sourceId, bySource] of ledger) {
    const promoted = new Map<string, string>();
    for (const [key, { word, promoted: isPromoted }] of bySource) if (isPromoted) promoted.set(key, word);
    if (promoted.size > 0) codenames.set(sourceId, promoted);
  }
  return codenames;
}

/**
 * Per content source: the subject prefixes promoted by the evidence in `items` alone: at least MIN_PREFIX_TOPICS
 * different topics from at least MIN_PREFIX_SENDERS different firm people, or from the source's owner on
 * MIN_PREFIX_TOPICS topics, one of them a reply subject. Empty without `internalDomains`; a source without an owner
 * entry needs two people.
 */
export function subjectPrefixCodenames(
  items: DedupedItem[],
  internalDomains: readonly string[] = [],
  sourceOwners: ReadonlyMap<string, string> = new Map(),
): Map<string, Map<string, string>> {
  return promotedPrefixes(notePrefixEvidence(new Map(), items, internalDomains, sourceOwners));
}

export function codenamesIn(text: string): Array<{ key: string; codename: string }> {
  const found = new Map<string, string>();
  for (const match of text.matchAll(CODENAME_PATTERN)) {
    const word = match[1];
    const key = word.toLowerCase();
    if (NOT_A_CODENAME.has(key) || found.has(key)) continue;
    found.set(key, `Project ${word}`);
  }
  return [...found].map(([key, codename]) => ({ key, codename }));
}

function containsWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${word}($|[^A-Za-z0-9])`).test(text);
}

function aliasWord(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** A thread's identity for continuation: the conversation and its prefix-free subject. */
export function threadKey(item: Pick<DedupedItem['item'], 'conversationId' | 'threadSubject'>): string | null {
  return item.conversationId ? `${item.conversationId}\u0000${item.threadSubject}` : null;
}

/** Routed threads seen outside this batch: threadKey -> codename key -> codename and where it was taught. */
export type KnownThreads = ReadonlyMap<string, ReadonlyMap<string, Taught>>;

/**
 * Routes each item on the firm rules. `knownCodenames` adds codenames seen
 * outside this batch (for example, existing candidates), so an alias can
 * match on a later read. `knownThreads` does the same for threads, so a reply
 * read on a later page (the worker routes one page at a time, phase 4)
 * continues a thread routed on an earlier one. A codename passed in without `taughtIn` has taught nowhere, so
 * it admits nothing when scoped.
 */
export function routeByFirmRules(
  items: DedupedItem[],
  options: {
    knownCodenames?: Array<{ key: string; codename: string; taughtIn?: ReadonlySet<string> }>;
    knownThreads?: KnownThreads;
    /** The firm's own domains; turns the subject prefix rule on (#622). */
    internalDomains?: readonly string[];
    /** sourceId -> the mailbox's own address. Enables the owner clause; without it a prefix needs two firm people. */
    sourceOwners?: ReadonlyMap<string, string>;
    /**
     * Prefix evidence counted before this batch, per source (RoutingContext carries it across pages). Read only: the
     * router adds this batch's evidence to a copy. Absent, a prefix is promoted on this batch's evidence alone.
     */
    knownPrefixEvidence?: ReadonlyMap<string, ReadonlyMap<string, PrefixEvidence>>;
    /**
     * Sources archived on disconnect or withdrawal, their records kept (#173 G-09 3b). They still observe, so they still
     * refuse: a shared one stays in `scope.shared` for `admit`, and every observer must promote a prefix. They no longer
     * teach a key or a thread, nor add prefix evidence. The strict side: an archived source can refuse, never open.
     */
    archived?: ReadonlySet<string>;
    /** Required: which sources are shared, or 'unscoped' for none. See `admit`. */
    scope: RoutingScope;
    /** Out-parameter: the routes a source scope refused. */
    counts?: RouteCounts;
  },
): RoutedItem[] {
  const { scope, counts } = options;
  const known = new Map<string, MutableTaught>();
  for (const { key, codename, taughtIn } of options.knownCodenames ?? []) {
    const entry = known.get(key) ?? { codename, taughtIn: new Set<string>() };
    entry.codename = codename;
    for (const sourceId of taughtIn ?? []) entry.taughtIn.add(sourceId);
    known.set(key, entry);
  }

  // 1. Codenames.
  // This batch's prefix evidence, read beside the carried ledger (never copied into it).
  const archived = options.archived ?? new Set<string>();
  const live = (observations: DedupedItem['observations']) => observations.filter((o) => !archived.has(o.sourceId));
  const batchEvidence = notePrefixEvidence(
    new Map(),
    archived.size === 0 ? items : items.map((entry) => ({ ...entry, observations: live(entry.observations) })),
    options.internalDomains,
    options.sourceOwners,
  );
  const routed: RoutedItem[] = items.map((deduped) => {
    const { subject, bodyText } = deduped.item;
    const routes: FirmRoute[] = [];
    for (const { key, codename } of codenamesIn(subject)) {
      routes.push({ codenameKey: key, codename, method: ROUTE_METHOD.CODENAME, confidence: FIRM_ROUTE_CONFIDENCE.CODENAME_SUBJECT });
    }
    for (const { key, codename } of codenamesIn(bodyText)) {
      if (routes.some((r) => r.codenameKey === key)) continue;
      routes.push({ codenameKey: key, codename, method: ROUTE_METHOD.CODENAME, confidence: FIRM_ROUTE_CONFIDENCE.CODENAME_BODY });
    }
    // The literal is the only teacher: every source that observed this item now holds the codename.
    for (const route of routes) {
      const entry = known.get(route.codenameKey) ?? { codename: route.codename, taughtIn: new Set<string>() };
      for (const { sourceId } of live(deduped.observations)) entry.taughtIn.add(sourceId);
      known.set(route.codenameKey, entry);
    }
    return { ...deduped, routes };
  });

  // 1b. Subject prefixes, promoted in every mailbox this item was read from (the barrier `admit` holds alias and
  //     thread routes to, #173 G-09). Not added to `known`.
  for (const entry of routed) {
    const prefix = subjectPrefix(entry.item.subject);
    if (!prefix || entry.routes.some((r) => r.codenameKey === prefix.key)) continue;
    const words = entry.observations.map((o) => promotedWord(options.knownPrefixEvidence, batchEvidence, o.sourceId, prefix.key));
    const word = words.every(Boolean) ? words[0] : undefined;
    if (!word) continue;
    entry.routes.push({
      codenameKey: prefix.key,
      // A codename known by "Project <Name>" keeps that spelling.
      codename: known.get(prefix.key)?.codename ?? word,
      method: ROUTE_METHOD.CODENAME,
      confidence: FIRM_ROUTE_CONFIDENCE.CODENAME_SUBJECT_PREFIX,
      fromSubjectPrefix: true,
    });
  }

  // 2. Aliases of every codename now known.
  for (const entry of routed) {
    const { subject, bodyText } = entry.item;
    for (const [key, { codename, taughtIn }] of known) {
      if (entry.routes.some((r) => r.codenameKey === key)) continue; // a prefix route also blocks a duplicate alias
      const word = aliasWord(key);
      if (!containsWord(subject, word) && !containsWord(bodyText, word)) continue;
      // The route would be made; a source that did not teach the key refuses it. A refused route teaches nothing.
      if (!admit(entry, taughtIn, scope)) {
        if (counts) counts.scopeBlocked += 1;
        continue;
      }
      entry.routes.push({ codenameKey: key, codename, method: ROUTE_METHOD.ALIAS, confidence: FIRM_ROUTE_CONFIDENCE.ALIAS });
    }
  }

  // 3. Thread continuation from the items routed so far, and threads routed
  //    before this batch.
  const threads = new Map<string, Map<string, MutableTaught>>();
  for (const [key, codenames] of options.knownThreads ?? []) {
    const copy = new Map<string, MutableTaught>();
    for (const [codenameKey, t] of codenames) copy.set(codenameKey, { codename: t.codename, taughtIn: new Set(t.taughtIn) });
    threads.set(key, copy);
  }
  for (const entry of routed) {
    const key = threadKey(entry.item);
    const teaching = entry.routes.filter((r) => !r.fromSubjectPrefix);
    if (!key || teaching.length === 0) continue;
    const codenames = threads.get(key) ?? new Map<string, MutableTaught>();
    for (const route of teaching) {
      const taught = codenames.get(route.codenameKey) ?? { codename: route.codename, taughtIn: new Set<string>() };
      taught.codename = route.codename;
      // A literal adds the sources that carry it. An alias route (it was admitted) adds none: the thread inherits
      // what the key was taught in, never more.
      if (addsSources(route)) for (const { sourceId } of live(entry.observations)) taught.taughtIn.add(sourceId);
      else for (const sourceId of known.get(route.codenameKey)?.taughtIn ?? []) taught.taughtIn.add(sourceId);
      codenames.set(route.codenameKey, taught);
    }
    threads.set(key, codenames);
  }
  for (const entry of routed) {
    if (entry.routes.length > 0) continue;
    const key = threadKey(entry.item);
    const codenames = key ? threads.get(key) : undefined;
    if (!codenames) continue;
    for (const [codenameKey, { codename, taughtIn }] of codenames) {
      if (!admit(entry, taughtIn, scope)) {
        if (counts) counts.scopeBlocked += 1;
        continue;
      }
      entry.routes.push({
        codenameKey,
        codename,
        method: ROUTE_METHOD.THREAD_CONTINUATION,
        confidence: FIRM_ROUTE_CONFIDENCE.THREAD_CONTINUATION,
      });
    }
  }

  return routed;
}
