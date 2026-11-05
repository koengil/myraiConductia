// The read side of Microsoft Graph for deal discovery (ADR-005). Only
// `src/lib/mailboxAccess/` imports this module (#262); no Next.js route
// acquires reader tokens or calls a ContentSource.
//
// A ContentSource serves one kind of source (a mailbox or a SharePoint site)
// as pages of Graph-shaped items. Phase 3 shipped the fixture implementation;
// phase 4 adds the live Graph ones (mail.ts, drive.ts) behind the same
// interface.

import type { MailMessage, MailRecipient } from '@/lib/discovery/source/types';

// The seam types (ContentSource, SourceRow, SourceItemPage, SkippedItem and the
// message shape) are provider-neutral and live in @/lib/discovery/source/types
// (#259, C4). They are re-exported here so the Graph reader keeps its names.
export type { ContentSource, SkippedItem, SourceItemPage, SourceRow } from '@/lib/discovery/source/types';

/** Graph's emailAddress wrapper, as on from / toRecipients / ccRecipients. */
export type GraphRecipient = MailRecipient;

/**
 * The subset of Graph's message resource the worker reads
 * (GET /users/{id}/mailFolders/{id}/messages/delta, $select'ed). The shape is
 * the seam's MailMessage: the Gmail reader maps into the same one.
 */
export type GraphMessage = MailMessage;

/**
 * A SharePoint document read into text (drive.ts). The text comes from the
 * sandboxed extractor; the bytes are never stored (Q5).
 */
export type GraphDocument = {
  /** `<driveId>:<itemId>`: the document's identity across reads. */
  driveItemKey: string;
  /** The driveItem id, as the ledger records it. */
  providerItemId: string;
  name: string;
  /** Folder path inside the library, then the name. */
  drivePath: string;
  lastModifiedDateTime: string | null;
  /** Authors, from createdBy / lastModifiedBy where Graph gives an address. */
  authors: Array<{ address: string; name: string | null }>;
  text: string;
  /** Graph's content tag: changes when the content does. */
  cTag: string | null;
};

/**
 * Whether a Graph reader's pass has read every folder or library to its
 * deltaLink (`complete`), or a job stopped part-way (`running`).
 */
export type DeltaCycle = 'running' | 'complete';

export function isDeltaCycle(value: unknown): value is DeltaCycle {
  return value === 'running' || value === 'complete';
}

export function cycleOf(states: Array<{ done: boolean }>): DeltaCycle {
  return states.every((state) => state.done) ? 'complete' : 'running';
}
