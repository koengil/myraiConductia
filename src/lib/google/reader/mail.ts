// The Gmail ContentSource (#259, design R18 to R21, plan D5). It reads one
// mailbox as pages of Graph-shaped messages, thread by thread, oldest thread
// listing first, so the pipeline after the reader stays provider-neutral.
//
// Nothing here checks who may be read: src/lib/mailboxAccess/readers.ts wraps
// this source and asks the guard before every page. What this file owes the
// guard is the page bound (C1): at most MAX_GMAIL_REQUESTS_PER_PAGE Gmail
// requests between two yields, so a withdrawal stops the read within one page.
// A page therefore ends when the budget is spent, mid-thread if it must, and
// its checkpoint names the exact next request.
//
// A checkpoint names its position by ID (the next thread, the next message),
// never by count: a message or thread deleted before a resume shifts every
// position after it, and a deletion emits no messageAdded to recover a skipped
// item. An ID that is gone restarts its thread (or its listing page) from the
// top, and the ledger's keys absorb what is read again.

import { createHash } from 'node:crypto';

import { NEVER_FETCHED_POLICY_SKIP_REASONS, SKIP_REASON, SOURCE_KIND, type PolicySkipReason } from '@/lib/constants/discovery';
import {
  GMAIL_HISTORY_FIELDS,
  GMAIL_LABELS_FIELDS,
  GMAIL_THREAD_LIST_FIELDS,
  GMAIL_SYSTEM_LABEL_IDS,
  GMAIL_SENT_LABEL,
  GMAIL_THREAD_METADATA_QUERY,
} from '@/lib/constants/googleReader';
import { InvalidExclusionPolicyError, NoExclusionPolicyError } from '@/lib/discovery/exclusion/errors';
import { evaluateThread, inheritedVerdict, labelRuleHit } from '@/lib/discovery/exclusion/evaluate';
import {
  isUnavailable,
  type ExclusionContext,
  type ExclusionPolicy,
  type ThreadTaint,
  type Verdict,
} from '@/lib/discovery/exclusion/types';
import { CheckpointExpiredError } from '@/lib/discovery/source/checkpoint';
import type { SendRecipient } from '@/lib/constants/sendCensus';
import type { DealContacts } from '@/lib/discovery/sendCensus/types';
import type { ContentSource, MailMessage, SendFact, SkippedItem, SourceItemPage, SourceRow } from '@/lib/discovery/source/types';

import { GoogleHttpError, googleJson, type GoogleHttpOptions } from './http';
import { parseRaw, RawMessageTooLargeError, type ParsedMail } from './mime';
import { labelsOf, toPolicyInput, type GmailLabelNames, type GmailPolicySource } from './policyInput';
import { threadRecipient } from './sendCensus';
import { conversationIdOf } from './thread';
import { afterQuery, floorMsOf, inWindow, isWindowDate } from './window';

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
export const THREAD_PAGE_SIZE = 100;
/** C1: at most this many Gmail requests between two guard checks (a yielded page). */
export const MAX_GMAIL_REQUESTS_PER_PAGE = 25;
/** A page is also yielded after this many threads, so a checkpoint is never far behind. */
export const THREADS_PER_CHUNK = 10;
/** Never read drafts, junk, deleted mail or chat (#259). The tenant's exclusion policy (#263) decides the rest, on metadata, before any fetch. */
export const EXCLUDED_LABELS: ReadonlySet<string> = new Set(['DRAFT', 'SPAM', 'TRASH', 'CHAT']);
/** history.list page size, and the labels whose removal makes a message readable (R21). */
const HISTORY_PAGE_SIZE = 100;
const UNEXCLUDING_LABELS: ReadonlySet<string> = new Set(['SPAM', 'TRASH']);

export type GmailCheckpoint = {
  v: 1;
  kind: 'gmail-mail';
  phase: 'backfill' | 'delta';
  /** Captured before the first threads.list (R21). */
  startHistoryId: string | null;
  /**
   * The ingestion window this backfill reads from (#353): `YYYY-MM-DD`, UTC. Pinned from the source's backfill_since
   * on a backfill that starts from nothing, kept by every resume of it and carried into the delta checkpoint as the
   * start of what was covered. Absent or null: the whole mailbox (and every checkpoint stored before the window).
   */
  since?: string | null;
  /** The threads.list page being drained (the token that fetched it). */
  pageToken: string | null;
  /** The next unprocessed thread in that page, by id; null is the page's first (plan D5). */
  nextThreadId: string | null;
  /** The next unprocessed message in that thread, by id; null is the thread's first. */
  nextMessageId: string | null;
  /**
   * Read once, never written: what the first release stored in place of the two
   * ids, as counts. A stored checkpoint that still has them resumes by position.
   */
  threadOffset?: number;
  messageOffset?: number;
  /** At most one stale page-token restart per pass (R21), in a backfill's listing or a delta's history. */
  pageTokenRestarted: boolean;
  /** Delta: the pass's start id, kept until the final history page (R21). */
  historyId: string | null;
  /** Delta: the history page being drained (the token that fetched it). */
  historyPageToken: string | null;
};

export type GmailMailOptions = {
  /** The token scope is chosen per source (plan D2: readonly). */
  httpFor: (source: SourceRow) => Promise<GoogleHttpOptions>;
  /**
   * The tenant's exclusion policy for this pass (#263). Required, with no silent
   * default: a read with none, or with an unavailable one, throws before any
   * request. Every message is evaluated on its metadata, and the raw message is
   * fetched only when the verdict is pass.
   */
  exclusion: ExclusionContext;
  dealContacts?: DealContacts;
  /**
   * Whether a backfill from nothing pins the source's backfill_since (#353). Live reads do; the replay does not
   * (index.ts), because its corpora have fixed dates and its keys are exact query strings. Default: true.
   */
  honourWindow?: boolean;
};

type GmailHeader = { name: string; value: string };
type GmailMessageMeta = GmailPolicySource & {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: GmailHeader[] };
};

function newCheckpoint(): GmailCheckpoint {
  return {
    v: 1,
    kind: 'gmail-mail',
    phase: 'backfill',
    startHistoryId: null,
    pageToken: null,
    nextThreadId: null,
    nextMessageId: null,
    pageTokenRestarted: false,
    historyId: null,
    historyPageToken: null,
  };
}

export function serializeCheckpoint(checkpoint: GmailCheckpoint): string {
  return JSON.stringify(checkpoint);
}

/** A stored checkpoint, or a fresh one for null. Anything unreadable throws: a wrong resume point re-reads or skips mail. */
export function parseCheckpoint(raw: string | null): GmailCheckpoint {
  if (raw === null) return newCheckpoint();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('gmail reader: unreadable checkpoint');
  }
  const c = value as Partial<GmailCheckpoint> | null;
  const nonNegative = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  const stringOrNull = (s: unknown) => s === null || typeof s === 'string';
  // A checkpoint stored before ids has neither field; the offsets are the reverse.
  const absentOr = (check: (v: unknown) => boolean) => (v: unknown) => v === undefined || check(v);
  if (
    !c ||
    c.v !== 1 ||
    c.kind !== 'gmail-mail' ||
    (c.phase !== 'backfill' && c.phase !== 'delta') ||
    !stringOrNull(c.startHistoryId) ||
    !absentOr((s) => s === null || isWindowDate(s))(c.since) ||
    !stringOrNull(c.pageToken) ||
    !absentOr(stringOrNull)(c.nextThreadId) ||
    !absentOr(stringOrNull)(c.nextMessageId) ||
    !absentOr(nonNegative)(c.threadOffset) ||
    !absentOr(nonNegative)(c.messageOffset) ||
    typeof c.pageTokenRestarted !== 'boolean' ||
    !stringOrNull(c.historyId) ||
    !stringOrNull(c.historyPageToken)
  ) {
    throw new Error('gmail reader: unreadable checkpoint');
  }
  return { ...(c as GmailCheckpoint), nextThreadId: c.nextThreadId ?? null, nextMessageId: c.nextMessageId ?? null };
}

function headerMap(meta: GmailMessageMeta): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of meta.payload?.headers ?? []) out[h.name.toLowerCase()] = h.value;
  return out;
}

function isoOf(internalDate: string | undefined): string {
  const ms = Number(internalDate);
  return new Date(Number.isFinite(ms) && ms > 0 ? ms : 0).toISOString();
}

/** The message in the shape the pipeline reads (Graph's), or null when it has no Message-ID (dropped, like Graph's). */
export function toMailMessage(
  meta: GmailMessageMeta,
  parsed: ParsedMail,
  providerThreadId?: string,
): (MailMessage & { rawSha256: string }) | null {
  if (!parsed.messageId) return null;
  const received = isoOf(meta.internalDate);
  return {
    id: meta.id,
    ...(providerThreadId !== undefined ? { providerThreadId } : {}),
    internetMessageId: parsed.messageId,
    conversationId: conversationIdOf({
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
    }),
    subject: parsed.subject,
    sentDateTime: parsed.date && !Number.isNaN(Date.parse(parsed.date)) ? parsed.date : received,
    receivedDateTime: received,
    from: parsed.from ? { emailAddress: parsed.from } : null,
    toRecipients: parsed.to.map((address) => ({ emailAddress: address })),
    ccRecipients: parsed.cc.map((address) => ({ emailAddress: address })),
    body: parsed.body,
    hasAttachments: parsed.hasAttachments,
    // Extra field: the worker ignores it until #264 stores the original.
    rawSha256: parsed.rawSha256,
  };
}

type Requests = {
  call: <T>(url: string) => Promise<T>;
  /** The page budget is spent: yield before asking Gmail again. */
  due: () => boolean;
  reset: () => void;
};

/** Counts Gmail requests between two yields, so a page never exceeds the bound (C1). */
function requestBudget(http: GoogleHttpOptions): Requests {
  let requests = 0;
  return {
    call: <T>(url: string) => {
      requests += 1;
      return googleJson<T>(url, http);
    },
    due: () => requests >= MAX_GMAIL_REQUESTS_PER_PAGE,
    reset: () => {
      requests = 0;
    },
  };
}

/** Oldest first, and by id for the same instant, so the order is the same whichever way Gmail listed them. */
const byTimeThenId = (a: GmailMessageMeta, b: GmailMessageMeta) =>
  (Number(a.internalDate) || 0) - (Number(b.internalDate) || 0) || a.id.localeCompare(b.id);

const userOf = (source: SourceRow) => encodeURIComponent(source.address.trim().toLowerCase());
const isExcluded = (labelIds: string[] | undefined) => (labelIds ?? []).some((l) => EXCLUDED_LABELS.has(l));

/** The pass's policy, or a throw before any request: no silent default (#263, R1, R5). */
function policyOf(exclusion: ExclusionContext | undefined): ExclusionPolicy {
  if (!exclusion) throw new Error('gmail reader: a read needs the tenant exclusion policy');
  if (isUnavailable(exclusion.policy)) {
    throw exclusion.policy.unavailable === 'missing' ? new NoExclusionPolicyError() : new InvalidExclusionPolicyError();
  }
  return exclusion.policy;
}

/** The message's thread: its own, else the one its listing or history record named. None at all fails closed, before any fetch. */
function threadIdOf(meta: GmailMessageMeta, fallback: string | undefined): string {
  const id = meta.threadId || fallback;
  if (!id) throw new Error('gmail reader: metadata without a thread id');
  return id;
}

/**
 * The ledger's hash for a message that was never fetched, from provider metadata
 * only (the drive reader's pattern): no subject, so a short subject cannot be
 * recovered by brute force, and the bank, which holds the original, can recompute it.
 */
export function metadataHash(meta: GmailMessageMeta): string {
  const messageId = (headerMap(meta)['message-id'] ?? '').toLowerCase();
  return createHash('sha256').update(`gmail-message\n${meta.id}\n${meta.internalDate ?? ''}\n${messageId}`).digest('hex');
}

function skippedByPolicy(
  meta: GmailMessageMeta,
  providerThreadId: string,
  exclusion: { reason: PolicySkipReason; ruleId: string },
  version: number,
): SkippedItem {
  return {
    providerItemId: meta.id,
    providerThreadId,
    itemHash: metadataHash(meta),
    reason: exclusion.reason,
    policy: { version, ruleId: exclusion.ruleId },
  };
}

function sendFactOf(meta: GmailMessageMeta, recipient: SendRecipient | null): SendFact | undefined {
  if (!(meta.labelIds ?? []).includes(GMAIL_SENT_LABEL)) return undefined;
  const ms = Number(meta.internalDate);
  if (!meta.internalDate || !Number.isFinite(ms) || ms <= 0) return undefined;
  return { sentAt: new Date(ms).toISOString(), recipient };
}

function withSend<T extends object>(value: T, send: SendFact | undefined): T {
  return send ? { ...value, send } : value;
}

/** A label rule names a label that only labels.list can resolve to an id: anything but a built-in label. */
function needsLabelNames(policy: ExclusionPolicy): boolean {
  return policy.rules.some((rule) => rule.kind === 'label' && rule.names.some((name) => !GMAIL_SYSTEM_LABEL_IDS.has(name.trim().toUpperCase())));
}

/**
 * The mailbox's label names, from one labels.list per pass (counted in the page budget), asked for only when a
 * label rule names a user label: a policy without one, and the shared replays, make no such request.
 */
async function labelNamesFor(req: Requests, user: string, policy: ExclusionPolicy): Promise<GmailLabelNames | null> {
  if (!needsLabelNames(policy)) return null;
  const list = await req.call<{ labels?: Array<{ id?: string; name?: string }> }>(
    `${GMAIL_API}/users/${user}/labels?fields=${GMAIL_LABELS_FIELDS}`,
  );
  const names = new Map<string, string>();
  for (const label of list.labels ?? []) if (label.id && typeof label.name === 'string') names.set(label.id, label.name);
  return names;
}

/** What a message's read produced: its text, or the exclusion that discarded it after the fetch. At most one. */
type ReadOutcome = {
  message: MailMessage | null;
  skipped: SkippedItem | null;
  /** True when the after-fetch exclusion was a real label match, which alone may taint the thread (taintsOf). */
  matched?: boolean;
  /** The raw response came back, so its body crossed the wire: counted as fetched (#370 R2-M1). */
  retrieved?: true;
};
/** Nothing crossed the wire (a delta 404). */
const NOT_READ: ReadOutcome = Object.freeze({ message: null, skipped: null });
/** Nothing stored, but the body did cross the wire: a late built-in label, no raw, or over 25 MiB. Never mutate NOT_READ. */
const FETCHED_NOT_READ: ReadOutcome = Object.freeze({ message: null, skipped: null, retrieved: true });
/** The page's policy skips decided on metadata, before any content request: its `excluded` count (#370). */
const NEVER_FETCHED: ReadonlySet<string> = new Set<string>(NEVER_FETCHED_POLICY_SKIP_REASONS);

/**
 * One message's original, read into the pipeline's shape; no message when it is
 * not to be read (no body, too large, no Message-ID, a label added since the
 * listing, or gone when `skipMissing` and Gmail answers 404).
 *
 * A label added between the metadata read and this one is a residual window no
 * ordering of calls can close (R10): the body has already crossed. If a label
 * rule now matches, the raw string is dropped unparsed and nothing is stored,
 * and the message is ledgered as policy_excluded_after_fetch, so it is never
 * counted as an exclusion before the fetch.
 */
async function readMessage(
  req: Requests,
  user: string,
  meta: GmailMessageMeta,
  options: { skipMissing: boolean; policy: ExclusionPolicy; labelNames: GmailLabelNames | null; providerThreadId: string },
): Promise<ReadOutcome> {
  let full: GmailMessageMeta & { raw?: string };
  try {
    full = await req.call<GmailMessageMeta & { raw?: string }>(
      `${GMAIL_API}/users/${user}/messages/${encodeURIComponent(meta.id)}?format=raw`,
    );
  } catch (error) {
    // Nothing crossed; a thrown request is not counted either.
    if (options.skipMissing && error instanceof GoogleHttpError && error.status === 404) return NOT_READ;
    throw error;
  }
  // Every return from here on follows a raw response, so each one is fetched (#370 R2-M1).
  // A label may have changed since the listing: the raw response is the last word.
  if (isExcluded(full.labelIds)) return FETCHED_NOT_READ;
  const hit = labelRuleHit(options.policy, labelsOf(full.labelIds ?? [], options.labelNames));
  if (hit) {
    return {
      message: null,
      skipped: skippedByPolicy(
        meta,
        options.providerThreadId,
        { reason: SKIP_REASON.POLICY_EXCLUDED_AFTER_FETCH, ruleId: hit.ruleId },
        options.policy.version,
      ),
      matched: hit.matched,
      retrieved: true,
    };
  }
  if (!full.raw) return FETCHED_NOT_READ;
  let parsed: ParsedMail;
  try {
    parsed = await parseRaw(full.raw);
  } catch (error) {
    if (error instanceof RawMessageTooLargeError) return FETCHED_NOT_READ;
    throw error;
  }
  return { message: toMailMessage(meta, parsed, options.providerThreadId), skipped: null, retrieved: true };
}

/**
 * The conversations this pass knows to be tainted, thread id to the rule ids: the persisted taint the worker read for
 * the source, a copy that grows as the pass reads, so a taint set on one page holds on the next.
 */
type TaintMemory = Map<string, Set<string>>;

function taintMemoryOf(exclusion: ExclusionContext): TaintMemory {
  return new Map([...(exclusion.threadTaint ?? [])].map(([threadId, rules]) => [threadId, new Set(rules)]));
}

/** Records a taint once per (thread, rule) in the pass, and emits it for the page that is being built. */
function remember(memory: TaintMemory, emit: (taint: ThreadTaint) => void, taint: ThreadTaint): void {
  const rules = memory.get(taint.providerThreadId) ?? new Set<string>();
  if (rules.has(taint.ruleId)) return;
  rules.add(taint.ruleId);
  memory.set(taint.providerThreadId, rules);
  emit(taint);
}

/**
 * One conversation's verdicts, from its whole metadata, oldest message first (every message the thread holds, the
 * ones that carry a DRAFT, SPAM, TRASH or CHAT label included: a taint errs on the side of excluding). The taints the
 * thread's messages add are remembered and emitted, so later pages, and later passes, exclude the rest of it.
 */
function judgeThread(args: {
  policy: ExclusionPolicy;
  labelNames: GmailLabelNames | null;
  memory: TaintMemory;
  emit: (taint: ThreadTaint) => void;
  threadId: string;
  messages: GmailMessageMeta[];
}): Map<string, Verdict> {
  const { policy, labelNames, memory, emit, threadId, messages } = args;
  const evaluated = evaluateThread(
    policy,
    messages.map((meta) => toPolicyInput(meta, { labelNames })),
    memory.get(threadId) ?? new Set<string>(),
  );
  const verdicts = new Map<string, Verdict>();
  evaluated.forEach((result, index) => {
    verdicts.set(messages[index].id, result.verdict);
    for (const rule of result.newTaints) {
      remember(memory, emit, { providerThreadId: threadId, providerItemId: messages[index].id, ruleId: rule.id, policyVersion: policy.version });
    }
  });
  return verdicts;
}

/**
 * A message's verdict at the moment it is to be read: what the thread's evaluation said, unless the conversation has been
 * tainted since (a label found on a raw fetch earlier in this thread, R10), in which case it is inherited.
 */
function verdictNow(policy: ExclusionPolicy, memory: TaintMemory, threadId: string, judged: Verdict | undefined): Verdict {
  if (judged && judged.result === 'exclude') return judged;
  return inheritedVerdict(policy, memory.get(threadId));
}

/**
 * An after-fetch label match on a thread-scoped rule taints its conversation too, for the messages not yet read. A
 * label rule that could not be evaluated discards the message but taints nothing (taintsOf).
 */
function taintAfterFetch(args: {
  policy: ExclusionPolicy;
  memory: TaintMemory;
  emit: (taint: ThreadTaint) => void;
  threadId: string;
  read: ReadOutcome;
}): void {
  const { policy, memory, emit, threadId } = args;
  const skipped = args.read.skipped;
  if (!skipped?.policy || skipped.reason !== SKIP_REASON.POLICY_EXCLUDED_AFTER_FETCH || !args.read.matched) return;
  const rule = policy.rules.find((candidate) => candidate.id === skipped.policy!.ruleId);
  if (rule?.scope !== 'thread') return;
  remember(memory, emit, { providerThreadId: threadId, providerItemId: skipped.providerItemId, ruleId: rule.id, policyVersion: policy.version });
}

/**
 * A team inbox (#581) is read as the address the admin registered, so the mailbox that answers must be that address.
 * The Directory check says it is a user; this says the delegated token reads that user's own mailbox, not another
 * account an alias or a rename now points at. Asked at the start of every pass of a team source, backfill or delta
 * (audit item 11), with the one profile request the reader makes (which a replay records), so a change is caught on
 * the next pass rather than at the next Directory recheck. A person's mailbox is unchecked, as before. The message
 * names no address.
 */
function assertTeamProfile(source: SourceRow, profile: { emailAddress?: string }): void {
  if (source.teamMailboxId && profile.emailAddress?.trim().toLowerCase() !== source.address.trim().toLowerCase()) {
    throw new Error('gmail reader: team mailbox profile does not match the registered address');
  }
}

async function* backfillPages(
  source: SourceRow,
  checkpointRaw: string | null,
  options: GmailMailOptions,
): AsyncGenerator<SourceItemPage> {
  const cp = parseCheckpoint(checkpointRaw);
  // A finished backfill has nothing to read from the start (R21): the delta pass owns what follows.
  if (cp.phase === 'delta') return;
  // The window (#353) is pinned once, on a backfill from nothing; a resumed pass keeps the one it started with, so a
  // change to the source's column never mixes two listings' page tokens. No window lists the mailbox as before.
  const since =
    checkpointRaw === null ? (options.honourWindow !== false ? (source.backfillSince ?? null) : null) : (cp.since ?? null);
  const floorMs = floorMsOf(since);

  // Before any request, token mint or registration lookup: no policy, no read.
  const policy = policyOf(options.exclusion);
  const http = await options.httpFor(source);
  const user = userOf(source);
  const req = requestBudget(http);

  const memory = taintMemoryOf(options.exclusion);
  let items: MailMessage[] = [];
  let skipped: SkippedItem[] = [];
  let threadTaints: ThreadTaint[] = [];
  const emit = (taint: ThreadTaint) => threadTaints.push(taint);
  let fetched = 0;
  let threadsSinceYield = 0;
  let startHistoryId = cp.startHistoryId;
  let restarted = cp.pageTokenRestarted;
  const flush = (position: Partial<GmailCheckpoint>): SourceItemPage => {
    const page: SourceItemPage = {
      items,
      ...(skipped.length > 0 ? { skipped } : {}),
      ...(threadTaints.length > 0 ? { threadTaints } : {}),
      fetched,
      excluded: skipped.filter((s) => NEVER_FETCHED.has(s.reason)).length,
      nextCheckpoint: serializeCheckpoint({
        ...newCheckpoint(),
        startHistoryId,
        // Only when set, so an unwindowed checkpoint is byte for byte what it was before #353.
        ...(since !== null ? { since } : {}),
        pageTokenRestarted: restarted,
        ...position,
      }),
    };
    items = [];
    skipped = [];
    threadTaints = [];
    fetched = 0;
    req.reset();
    threadsSinceYield = 0;
    return page;
  };

  // R21: the history id is taken before the first threads.list, so anything
  // that arrives during the backfill is covered by the first delta pass.
  if (startHistoryId === null) {
    const profile = await req.call<{ historyId?: string; emailAddress?: string }>(`${GMAIL_API}/users/${user}/profile`);
    assertTeamProfile(source, profile);
    if (!profile.historyId) throw new Error('gmail reader: profile has no historyId');
    startHistoryId = profile.historyId;
  } else if (source.teamMailboxId) {
    // A resumed backfill of a team inbox asks again: the same profile request as a first backfill, so a replay serves it.
    assertTeamProfile(source, await req.call<{ emailAddress?: string }>(`${GMAIL_API}/users/${user}/profile`));
  }
  // Label rules name labels; the ids a message carries resolve through one labels.list for the pass.
  const labelNames = await labelNamesFor(req, user, policy);

  let pageToken = cp.pageToken;
  // Where to resume in the page the token fetches: by id, or (a checkpoint from before ids) by count.
  let resumeThreadId = cp.nextThreadId;
  let resumeMessageId = cp.nextMessageId;
  let resumeThreadOffset = cp.threadOffset ?? 0;
  let resumeMessageOffset = cp.messageOffset ?? 0;
  for (;;) {
    if (req.due()) yield flush({ pageToken, nextThreadId: resumeThreadId, nextMessageId: resumeMessageId });
    const listUrl =
      `${GMAIL_API}/users/${user}/threads?maxResults=${THREAD_PAGE_SIZE}&includeSpamTrash=false&fields=${GMAIL_THREAD_LIST_FIELDS}` +
      // The window's coarse filter (#353): only with a window, so an unwindowed listing (and every replay key) is unchanged.
      (floorMs !== null ? `&q=${encodeURIComponent(afterQuery(floorMs))}` : '') +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    let list: { threads?: Array<{ id: string }>; nextPageToken?: string };
    try {
      list = await req.call<{ threads?: Array<{ id: string }>; nextPageToken?: string }>(listUrl);
    } catch (error) {
      // R21: a page token Gmail no longer honours (400). The listing restarts from
      // the top, once per pass, keeping the start id; what was read again is
      // absorbed by the ledger's keys. A second 400, or any other, is an error.
      if (error instanceof GoogleHttpError && error.status === 400 && pageToken !== null && !restarted) {
        restarted = true;
        pageToken = null;
        resumeThreadId = null;
        resumeMessageId = null;
        resumeThreadOffset = 0;
        resumeMessageOffset = 0;
        continue;
      }
      throw error;
    }
    const threads = list.threads ?? [];
    const nextPageToken = list.nextPageToken ?? null;

    // The first thread to read in this page. A named thread the listing no longer
    // holds restarts the page (and its messages) from the top.
    let firstThread = 0;
    if (resumeThreadId !== null) {
      const at = threads.findIndex((thread) => thread.id === resumeThreadId);
      if (at >= 0) firstThread = at;
      else resumeMessageId = null;
    } else {
      firstThread = resumeThreadOffset;
    }
    resumeThreadId = null;
    resumeThreadOffset = 0;

    for (let t = firstThread; t < threads.length; t += 1) {
      if (req.due()) yield flush({ pageToken, nextThreadId: threads[t].id, nextMessageId: resumeMessageId });
      const thread = await req.call<{ messages?: GmailMessageMeta[] }>(
        `${GMAIL_API}/users/${user}/threads/${encodeURIComponent(threads[t].id)}?${GMAIL_THREAD_METADATA_QUERY}`,
      );
      // Oldest first, stably, so a resume at a message id lands on the same message.
      const messages = [...(thread.messages ?? [])].sort(
        (a, b) => (Number(a.internalDate) || 0) - (Number(b.internalDate) || 0),
      );
      // The message to resume at applies to the first thread only; one that is gone restarts the thread.
      let firstMessage = resumeMessageOffset;
      if (resumeMessageId !== null) {
        const at = messages.findIndex((message) => message.id === resumeMessageId);
        firstMessage = at >= 0 ? at : 0;
      }
      resumeMessageId = null;
      resumeMessageOffset = 0;
      // The policy runs on the whole conversation's metadata, before any message of it is fetched. A resume starts
      // mid-thread, but the thread is judged whole, so a taint set by a message already read still holds.
      const threadId = threads[t].id;
      const verdicts = judgeThread({ policy, labelNames, memory, emit, threadId, messages });
      const recipient = threadRecipient(messages, options.dealContacts);
      for (let m = firstMessage; m < messages.length; m += 1) {
        const meta = messages[m];
        const labelIds = meta.labelIds ?? [];
        if (isExcluded(labelIds)) continue;
        // Older than the window (#353): judged with its thread above, so its taint still holds, but never ledgered or
        // fetched raw. The listing's q is coarse; this is the exact floor.
        if (!inWindow(meta.internalDate, floorMs)) continue;
        const send = sendFactOf(meta, recipient);
        // An excluded message is ledgered and never fetched raw, and costs no request.
        const providerThreadId = threadIdOf(meta, threadId);
        const verdict = verdictNow(policy, memory, threadId, verdicts.get(meta.id));
        if (verdict.result === 'exclude') {
          skipped.push(withSend(skippedByPolicy(meta, providerThreadId, verdict, policy.version), send));
          continue;
        }
        if (req.due()) yield flush({ pageToken, nextThreadId: threads[t].id, nextMessageId: meta.id });
        const read = await readMessage(req, user, meta, { skipMissing: false, policy, labelNames, providerThreadId });
        if (read.retrieved) fetched += 1;
        if (read.message) items.push(withSend(read.message, send));
        if (read.skipped) {
          skipped.push(withSend(read.skipped, send));
          taintAfterFetch({ policy, memory, emit, threadId, read });
        }
      }
      threadsSinceYield += 1;

      const lastThread = t === threads.length - 1;
      if (lastThread && nextPageToken === null) break;
      if (threadsSinceYield >= THREADS_PER_CHUNK) {
        yield flush(lastThread ? { pageToken: nextPageToken } : { pageToken, nextThreadId: threads[t + 1].id });
      }
    }

    if (nextPageToken === null) {
      // The last chunk: the backfill is complete and the delta pass starts from the id taken first.
      yield flush({ phase: 'delta', historyId: startHistoryId, pageTokenRestarted: false });
      return;
    }
    pageToken = nextPageToken;
  }
}

type HistoryRecord = {
  messagesAdded?: Array<{ message?: { id?: string; threadId?: string } }>;
  labelsRemoved?: Array<{ message?: { id?: string; threadId?: string }; labelIds?: string[] }>;
};
type HistoryPage = { history?: HistoryRecord[]; nextPageToken?: string; historyId?: string };

/**
 * The ids a history page makes readable, in record order: every message added,
 * and a message that left SPAM or TRASH. Any other label change, and every
 * deletion, is ignored (a stored item is never removed on a Gmail delete).
 */
export function eligibleHistoryIds(page: HistoryPage): string[] {
  const ids = new Set<string>();
  for (const record of page.history ?? []) {
    for (const added of record.messagesAdded ?? []) if (added.message?.id) ids.add(added.message.id);
    for (const removed of record.labelsRemoved ?? []) {
      if (removed.message?.id && (removed.labelIds ?? []).some((l) => UNEXCLUDING_LABELS.has(l))) ids.add(removed.message.id);
    }
  }
  return [...ids];
}

/** The thread each message of a history page belongs to, as the page names it. */
function historyThreadIds(page: HistoryPage): Map<string, string> {
  const threads = new Map<string, string>();
  for (const record of page.history ?? []) {
    for (const entry of [...(record.messagesAdded ?? []), ...(record.labelsRemoved ?? [])]) {
      if (entry.message?.id && entry.message.threadId) threads.set(entry.message.id, entry.message.threadId);
    }
  }
  return threads;
}

function historyUrl(user: string, startHistoryId: string, pageToken: string | null): string {
  return (
    `${GMAIL_API}/users/${user}/history?historyTypes=messageAdded&historyTypes=labelRemoved` +
    `&maxResults=${HISTORY_PAGE_SIZE}&startHistoryId=${encodeURIComponent(startHistoryId)}&fields=${GMAIL_HISTORY_FIELDS}` +
    (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '')
  );
}

/**
 * The incremental pass (R21): history.list from the stored id, page by page.
 * The checkpoint keeps the pass's start id until the final history page, and
 * only then moves to the mailbox's current record, so a crash mid-pass reads
 * the pass again from its start and the ledger's keys absorb the repeats.
 * Within a job, `seen` reads a message that appears in several records once.
 */
async function* deltaPages(source: SourceRow, token: string, options: GmailMailOptions): AsyncGenerator<SourceItemPage> {
  const cp = parseCheckpoint(token);
  if (cp.phase !== 'delta' || !cp.historyId) throw new Error('gmail reader: unreadable checkpoint (not a delta checkpoint)');
  const startId = cp.historyId;

  // Before any request, token mint or registration lookup: no policy, no read.
  const policy = policyOf(options.exclusion);
  const http = await options.httpFor(source);
  const user = userOf(source);
  const req = requestBudget(http);

  // Every delta pass of a team inbox starts with the profile check: the same request as a backfill's, so a replay serves it.
  if (source.teamMailboxId) {
    assertTeamProfile(source, await req.call<{ emailAddress?: string }>(`${GMAIL_API}/users/${user}/profile`));
  }
  const labelNames = await labelNamesFor(req, user, policy);
  const memory = taintMemoryOf(options.exclusion);
  const seen = new Set<string>();
  let items: MailMessage[] = [];
  let skipped: SkippedItem[] = [];
  let threadTaints: ThreadTaint[] = [];
  const emit = (taint: ThreadTaint) => threadTaints.push(taint);
  let fetched = 0;
  let pageToken = cp.historyPageToken;
  let restarted = cp.pageTokenRestarted;
  const flush = (position: Partial<GmailCheckpoint>): SourceItemPage => {
    const page: SourceItemPage = {
      items,
      ...(skipped.length > 0 ? { skipped } : {}),
      ...(threadTaints.length > 0 ? { threadTaints } : {}),
      fetched,
      excluded: skipped.filter((s) => NEVER_FETCHED.has(s.reason)).length,
      nextCheckpoint: serializeCheckpoint({ ...cp, historyId: startId, pageTokenRestarted: restarted, ...position }),
    };
    items = [];
    skipped = [];
    threadTaints = [];
    fetched = 0;
    req.reset();
    return page;
  };

  for (;;) {
    if (req.due()) yield flush({ historyPageToken: pageToken });
    let page: HistoryPage;
    try {
      page = await req.call<HistoryPage>(historyUrl(user, startId, pageToken));
    } catch (error) {
      if (error instanceof GoogleHttpError) {
        // Gmail no longer holds the start id: a normal event, the worker re-syncs (R9).
        if (error.status === 404) throw new CheckpointExpiredError('google');
        // R21: a stale history page token restarts from the pass's start id, once.
        if (error.status === 400 && pageToken !== null && !restarted) {
          restarted = true;
          pageToken = null;
          continue;
        }
      }
      throw error;
    }

    // The conversations the page names, in the order it names them. The policy judges a message with the whole
    // conversation in view, so each is read once with threads.get (never messages.get on the reply alone, which would
    // miss an older message labelled since it was read). A message with no thread id on its record fails closed.
    const historyThreads = historyThreadIds(page);
    const wanted = new Map<string, Set<string>>();
    for (const id of eligibleHistoryIds(page).filter((candidate) => !seen.has(candidate))) {
      const threadId = historyThreads.get(id);
      if (!threadId) throw new Error('gmail reader: history record without a thread id');
      seen.add(id);
      wanted.set(threadId, (wanted.get(threadId) ?? new Set<string>()).add(id));
    }

    // Each conversation's metadata first, so the page reads oldest first (a reply is never read ahead of the message
    // it answers) and an excluded message is never fetched raw. A thread deleted since is skipped: no item, no skip,
    // no taint.
    const candidates: Array<{ meta: GmailMessageMeta; threadId: string; verdict: Verdict | undefined; recipient: SendRecipient | null }> = [];
    for (const [threadId, ids] of wanted) {
      if (req.due()) yield flush({ historyPageToken: pageToken });
      let thread: { messages?: GmailMessageMeta[] };
      try {
        thread = await req.call<{ messages?: GmailMessageMeta[] }>(
          `${GMAIL_API}/users/${user}/threads/${encodeURIComponent(threadId)}?${GMAIL_THREAD_METADATA_QUERY}`,
        );
      } catch (error) {
        if (error instanceof GoogleHttpError && error.status === 404) continue;
        throw error;
      }
      const messages = [...(thread.messages ?? [])].sort(byTimeThenId);
      const verdicts = judgeThread({ policy, labelNames, memory, emit, threadId, messages });
      const recipient = threadRecipient(messages, options.dealContacts);
      for (const meta of messages) {
        if (ids.has(meta.id)) candidates.push({ meta, threadId, verdict: verdicts.get(meta.id), recipient });
      }
    }
    candidates.sort((a, b) => byTimeThenId(a.meta, b.meta));
    for (const { meta, threadId, verdict: judged, recipient } of candidates) {
      const labelIds = meta.labelIds ?? [];
      if (isExcluded(labelIds)) continue;
      const send = sendFactOf(meta, recipient);
      const providerThreadId = threadIdOf(meta, threadId);
      const verdict = verdictNow(policy, memory, threadId, judged);
      if (verdict.result === 'exclude') {
        skipped.push(withSend(skippedByPolicy(meta, providerThreadId, verdict, policy.version), send));
        continue;
      }
      if (req.due()) yield flush({ historyPageToken: pageToken });
      const read = await readMessage(req, user, meta, { skipMissing: true, policy, labelNames, providerThreadId });
      if (read.retrieved) fetched += 1;
      if (read.message) items.push(withSend(read.message, send));
      if (read.skipped) {
        skipped.push(withSend(read.skipped, send));
        taintAfterFetch({ policy, memory, emit, threadId, read });
      }
    }

    if (page.nextPageToken) {
      pageToken = page.nextPageToken;
      yield flush({ historyPageToken: pageToken });
      continue;
    }
    // The final page only: advance to the mailbox's current record.
    yield flush({ historyId: page.historyId ?? startId, historyPageToken: null, pageTokenRestarted: false });
    return;
  }
}

export function createGmailMailContentSource(options: GmailMailOptions): ContentSource {
  return {
    kind: SOURCE_KIND.MAILBOX,
    backfill: (source, checkpoint) => backfillPages(source, checkpoint, options),
    delta: (source, token) => deltaPages(source, token, options),
  };
}
