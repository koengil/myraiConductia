// The reader seam, provider-neutral (#259 design R2, plan D6 and C4). A
// ContentSource serves one kind of source (a mailbox or a SharePoint site) as
// pages of items, and every reader behind it (Graph fixture, live Graph,
// Gmail, the Gmail replay) yields the same shapes, so normalization, routing,
// clustering and persistence never learn which provider a message came from.
//
// Type-only, so the reader fence lets it be imported from anywhere: the worker
// names the seam here, never through a reader module. The Graph reader keeps
// its own names as re-exports (src/lib/graph/reader/types.ts).

import type { MailboxProvider, PolicySkipReason, SkipReason, SourceKind } from '@/lib/constants/discovery';
import type { SendRecipient } from '@/lib/constants/sendCensus';
import type { ThreadTaint } from '@/lib/discovery/exclusion/types';
import type { GraphDocument } from '@/lib/graph/reader/types';

/** An address as the pipeline reads it. The wrapper is Graph's `emailAddress` shape, which the Gmail reader maps into. */
export type MailRecipient = {
  emailAddress: { name?: string | null; address: string };
};

/** Per-mailbox sent metadata, never an address or content. */
export type SendFact = { sentAt: string; recipient: SendRecipient | null };

/**
 * A message as the pipeline reads it: the subset of Graph's message resource
 * (GET /users/{id}/mailFolders/{id}/messages/delta, $select'ed) that
 * `normalizeMessage` uses. The Gmail reader builds the same shape from RFC 5322
 * headers, so a message read through either provider normalizes identically.
 */
export type MailMessage = {
  /** The provider's own item id: opaque, per mailbox, and the ledger's key with the source. */
  id: string;
  /**
   * The provider's thread id (Gmail's threadId): per mailbox, metadata and never content. The ledger records it on
   * every row, so one join on (source, thread) shows a tainted thread's earlier reads. Graph leaves it unset.
   */
  providerThreadId?: string;
  internetMessageId: string;
  conversationId: string | null;
  subject: string | null;
  sentDateTime: string | null;
  receivedDateTime?: string | null;
  from: MailRecipient | null;
  toRecipients: MailRecipient[];
  ccRecipients: MailRecipient[];
  body: { contentType: 'html' | 'text'; content: string };
  hasAttachments?: boolean;
  /** sha256 of the original bytes, when the reader had them. In memory only: the worker ignores it until #264 stores the original. */
  rawSha256?: string;
  send?: SendFact;
};

/**
 * An item the reader saw but did not read into text; ledgered with its reason.
 * A policy skip (#263) is the variant where the rule, the policy version and the
 * provider thread id are all required: the ledger's shape check refuses one
 * without them, and the thread id is the cross-pass taint key. Its hash is
 * computed from provider metadata only, never content.
 */
export type SkippedItem = {
  providerItemId: string;
  /** Stable for the same content: the ledger's item_hash. */
  itemHash: string;
  send?: SendFact;
} & (
  | { reason: Exclude<SkipReason, PolicySkipReason>; providerThreadId?: string; policy?: undefined }
  | { reason: PolicySkipReason; providerThreadId: string; policy: { version: number; ruleId: string } }
);

/** The content_sources row a ContentSource reads. */
export type SourceRow = {
  id: string;
  tenantId: string;
  kind: SourceKind;
  /** content_sources.provider: which provider's registration and reader serve this source. */
  provider: MailboxProvider;
  address: string;
  ownerUserId: string | null;
  deltaCheckpoint: string | null;
  /**
   * content_sources.backfill_since (#353): the first day (`YYYY-MM-DD`, UTC) a first read takes mail from; null or
   * absent reads the whole mailbox. Only the Gmail reader honours it, and only on a backfill that starts from nothing.
   */
  backfillSince?: string | null;
  /**
   * content_sources.team_mailbox_id (#581): the admin-managed team inbox registration this source belongs to; null or
   * absent for a person's mailbox. A team source has no owner (ownerUserId is null) and is checked against the
   * Google Directory before it is read.
   */
  teamMailboxId?: string | null;
};

/**
 * One page of items and the checkpoint that resumes after it. The worker
 * persists `nextCheckpoint` after each page, so a restart continues from the
 * last page it finished and reads nothing twice.
 */
export type SourceItemPage = {
  /** Messages (a mailbox source). */
  items: MailMessage[];
  /** Documents read into text (a SharePoint site source). */
  documents?: GraphDocument[];
  /** Documents ledgered without text: images, unsupported types, failures. */
  skipped?: SkippedItem[];
  /**
   * The conversations a thread-scoped exclusion rule newly tainted in this page (#263). Written with the page,
   * insert-only, before its checkpoint, and read back by the worker for every later pass.
   */
  threadTaints?: ThreadTaint[];
  /**
   * Counts, never ids (#344 R12 and gate G2, the worker's per-job line; #370's pass record). `fetched`: provider objects whose body crossed
   * the wire in this page, whatever the reader then did with it (stored, excluded after the fetch, or dropped);
   * metadata, a 404, a thrown request or a download that stopped in flight do not count (#370 R2-M1).
   * `excluded`: messages the exclusion policy (#263) excluded before any content request; never also fetched.
   * Unset reads as 0.
   */
  fetched?: number;
  excluded?: number;
  nextCheckpoint: string | null;
};

/** Public identifiers of the registration a reader authenticated with, raw; the worker normalizes them (#370). */
export type ReaderRegistrationRef = { clientId: string | null; certThumbprint: string | null };

export interface ContentSource {
  kind: SourceKind;
  /** Reads the source from the start, or from `checkpoint` when a backfill was interrupted. */
  backfill(source: SourceRow, checkpoint: string | null): AsyncIterable<SourceItemPage>;
  /** Reads what changed since a delta token from an earlier completed read. */
  delta(source: SourceRow, token: string): AsyncIterable<SourceItemPage>;
  /** The registration this reader authenticates with, once resolved; null for a fixture or a replay. Raw. */
  registration?(): ReaderRegistrationRef | null;
}
