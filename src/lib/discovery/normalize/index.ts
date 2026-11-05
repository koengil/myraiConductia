import { createHash } from 'node:crypto';

import type { MailMessage, MailRecipient } from '@/lib/discovery/source/types';
import type { SendFact } from '@/lib/discovery/source/types';
import type { GraphDocument } from '@/lib/graph/reader';
import { collisionMetrics } from './similarity';
import { bodyText, normalizeSubject } from './text';

export { collisionMetrics, cosineSimilarity, lengthRatio, type CollisionMetrics } from './similarity';
export { bodyText, htmlToText, isReplySubject, normalizeSubject, stripQuotedHistory, stripReplyPrefixes } from './text';

export type ParticipantRole = 'from' | 'to' | 'cc';

export type Participant = {
  role: ParticipantRole;
  address: string;
  name: string | null;
};

/**
 * One message or document as the router and the store see it, independent of
 * the source it came from.
 */
export type NormalizedItem = {
  /**
   * The item's identity across sources. A message's RFC 5322 Message-ID; for a
   * SharePoint document, `drive:<driveId>:<itemId>` (see documentKey), which is
   * never stored as internet_message_id: the store keys documents on
   * source_items.drive_item_key instead.
   */
  internetMessageId: string;
  conversationId: string | null;
  subject: string;
  /** For thread continuation: reply and forward prefixes dropped, lowercased. */
  threadSubject: string;
  sentAt: string | null;
  participants: Participant[];
  bodyText: string;
  contentHash: string;
  /** Absent for messages (phase 3 shape). */
  kind?: 'message' | 'document';
  driveItemKey?: string;
  drivePath?: string;
};

/** One sighting of an item in one content source. */
export type Observation = {
  sourceId: string;
  providerItemId: string;
  /** The provider's thread id, when it has one (Gmail): ledgered on the row, metadata only. */
  providerThreadId?: string;
  send?: SendFact;
  item: NormalizedItem;
};

type Sighting = { sourceId: string; providerItemId: string; providerThreadId?: string; send?: SendFact };

/** An item seen in one or more sources, deduplicated by internet_message_id and content hash. */
export type DedupedItem = {
  item: NormalizedItem;
  observations: Sighting[];
};

function participant(role: ParticipantRole, recipient: MailRecipient | null): Participant | null {
  const address = recipient?.emailAddress?.address?.trim().toLowerCase();
  if (!address) return null;
  const name = recipient?.emailAddress?.name?.trim() || null;
  return { role, address, name };
}

/** Sender, then To, then Cc, each address once (the first role wins). */
export function participantsOf(message: MailMessage): Participant[] {
  const all = [
    participant('from', message.from),
    ...(message.toRecipients ?? []).map((r) => participant('to', r)),
    ...(message.ccRecipients ?? []).map((r) => participant('cc', r)),
  ].filter((p): p is Participant => p !== null);
  const seen = new Set<string>();
  return all.filter((p) => (seen.has(p.address) ? false : (seen.add(p.address), true)));
}

export function contentHash(subject: string, text: string): string {
  return createHash('sha256').update(`${subject}\n${text}`, 'utf8').digest('hex');
}

/**
 * Whether a message's Internet message id can serve as its identity: not
 * blank, and not in the document key space. The sender writes the id, so
 * neither is guaranteed; the reader drops such messages before they get here.
 */
export function isUsableMessageId(id: string | null | undefined): id is string {
  const trimmed = id?.trim();
  return Boolean(trimmed) && !isDocumentKey(trimmed!);
}

export function normalizeMessage(message: MailMessage): NormalizedItem {
  if (!isUsableMessageId(message.internetMessageId)) {
    throw new Error('discovery normalize: a message without a usable Internet message id cannot be deduplicated');
  }
  const subject = (message.subject ?? '').trim();
  const text = bodyText(message.body ?? { contentType: 'text', content: '' });
  return {
    internetMessageId: message.internetMessageId.trim(),
    conversationId: message.conversationId ?? null,
    subject,
    threadSubject: normalizeSubject(subject),
    sentAt: message.sentDateTime ?? message.receivedDateTime ?? null,
    participants: participantsOf(message),
    bodyText: text,
    contentHash: contentHash(subject, text),
  };
}

const DOCUMENT_KEY_PREFIX = 'drive:';

/** The identity key of a SharePoint document in NormalizedItem.internetMessageId. */
export function documentKey(driveItemKey: string): string {
  return `${DOCUMENT_KEY_PREFIX}${driveItemKey}`;
}

export function isDocumentKey(key: string): boolean {
  return key.startsWith(DOCUMENT_KEY_PREFIX);
}

/**
 * A SharePoint document read into text. Its name is its subject, its
 * extracted text its body, and its authors its participants. A document has
 * no thread, so it routes on a codename or an alias only.
 */
export function normalizeDocument(document: GraphDocument): NormalizedItem {
  const subject = document.name.trim();
  const text = document.text.trim();
  return {
    internetMessageId: documentKey(document.driveItemKey),
    conversationId: null,
    subject,
    threadSubject: normalizeSubject(subject),
    sentAt: document.lastModifiedDateTime ?? null,
    participants: document.authors.map((author) => ({ role: 'from' as const, address: author.address, name: author.name })),
    bodyText: text,
    contentHash: contentHash(subject, text),
    kind: 'document',
    driveItemKey: document.driveItemKey,
    drivePath: document.drivePath,
  };
}

/**
 * A sighting whose id matches an item already kept but whose content does
 * not. It is never merged: merging would make its mailbox an owner of the
 * kept item's text, and the id is the sender's to choose. The worker ledgers
 * it as skipped (id_collision) with how far the two differ, and stores
 * nothing of it.
 */
export type Collision = {
  sourceId: string;
  providerItemId: string;
  providerThreadId?: string;
  send?: SendFact;
  /** The key the sighting collided on (its internetMessageId). */
  key: string;
  itemHash: string;
  similarity: number;
  lengthRatio: number;
};

export type DedupeResult = { items: DedupedItem[]; collisions: Collision[] };

/**
 * Collapses sightings of the same message across mailboxes into one item that
 * keeps every mailbox it came from: when Alice and Bob are both on a thread
 * and both mailboxes are in scope, both own it (Q7). Sightings merge only
 * when the id and the content hash both match; a different message under a
 * known id is a collision, and the first sighting keeps the id. Order follows
 * first sighting, so the result is deterministic for a given read order.
 */
export function dedupeObservations(observations: Observation[]): DedupeResult {
  const byId = new Map<string, DedupedItem>();
  const collisions: Collision[] = [];
  for (const { sourceId, providerItemId, providerThreadId, send, item } of observations) {
    const sighting = { sourceId, providerItemId, ...(providerThreadId !== undefined ? { providerThreadId } : {}), ...(send ? { send } : {}) };
    const existing = byId.get(item.internetMessageId);
    if (!existing) {
      byId.set(item.internetMessageId, { item, observations: [sighting] });
      continue;
    }
    if (existing.item.contentHash !== item.contentHash) {
      collisions.push({
        ...sighting,
        key: item.internetMessageId,
        itemHash: item.contentHash,
        ...collisionMetrics(existing.item, item),
      });
      continue;
    }
    if (!existing.observations.some((o) => o.sourceId === sourceId)) {
      existing.observations.push(sighting);
    }
  }
  return { items: [...byId.values()], collisions };
}
