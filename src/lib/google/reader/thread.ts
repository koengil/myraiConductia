// Thread identity for Gmail items (#259, design R18). Thread continuation in
// the router keys on conversationId + threadSubject, so the conversationId must
// be the same in every mailbox holding a copy of the message. Gmail's threadId
// is per mailbox and is not that; it only orders the backfill (R19). The root
// of the RFC 5322 References chain is the same wherever the message is read.

const MESSAGE_ID = /<[^<>\s]+>/;
const MESSAGE_IDS = /<[^<>\s]+>/g;

/**
 * conversationId from RFC 5322 headers: the first Message-ID in References,
 * else the In-Reply-To one, else the message's own. Lowercased, prefixed so it
 * can never equal a Graph conversationId.
 */
export function conversationIdOf(h: {
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
}): string {
  const refs = (h.references ?? '').match(MESSAGE_IDS) ?? [];
  const root = refs[0] ?? (h.inReplyTo ?? '').match(MESSAGE_ID)?.[0] ?? h.messageId;
  return `rfc822:${root.trim().toLowerCase()}`;
}
