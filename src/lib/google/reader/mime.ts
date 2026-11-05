// RFC 5322 parsing for the Gmail reader (#259). The reader asks Gmail for the
// raw message (format=raw) because Graph's fields (the body as sent, the header
// chain) are what the router reads, and the API's parsed payload tree is
// lossy for both. Attachment bytes are dropped here and never kept (plan F3):
// only whether the message has any survives.

import { createHash } from 'node:crypto';

import PostalMime from 'postal-mime';
import type { Address, Mailbox } from 'postal-mime';

export type ParsedAddress = { name: string | null; address: string };

export type ParsedMail = {
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  subject: string | null;
  date: string | null;
  from: ParsedAddress | null;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  body: { contentType: 'html' | 'text'; content: string };
  hasAttachments: boolean;
  /** #261: hashed at ingest; #264 stores the original. */
  rawSha256: string;
};

export const MAX_RAW_BYTES = 25 * 1024 * 1024;

/** A raw message over MAX_RAW_BYTES. The reader skips it and reads on. */
export class RawMessageTooLargeError extends Error {
  constructor() {
    super('raw message exceeds the size bound');
    this.name = 'RawMessageTooLargeError';
  }
}

function flatten(list: Address[] | undefined): ParsedAddress[] {
  const out: ParsedAddress[] = [];
  const add = (m: Mailbox) => {
    const address = m.address?.trim();
    if (address) out.push({ name: m.name?.trim() || null, address });
  };
  for (const entry of list ?? []) {
    if (entry.group) for (const member of entry.group) add(member);
    else add(entry);
  }
  return out;
}

export async function parseRaw(rawBase64Url: string): Promise<ParsedMail> {
  const bytes = Buffer.from(rawBase64Url, 'base64url');
  if (bytes.byteLength > MAX_RAW_BYTES) throw new RawMessageTooLargeError();
  const rawSha256 = createHash('sha256').update(bytes).digest('hex');
  const email = await PostalMime.parse(bytes);
  const [from] = flatten(email.from ? [email.from] : undefined);
  const body: ParsedMail['body'] =
    email.html !== undefined && email.html !== ''
      ? { contentType: 'html', content: email.html }
      : { contentType: 'text', content: email.text ?? '' };
  return {
    messageId: email.messageId?.trim() || null,
    inReplyTo: email.inReplyTo?.trim() || null,
    references: email.references?.trim() || null,
    subject: email.subject ?? null,
    date: email.date ?? null,
    from: from ?? null,
    to: flatten(email.to),
    cc: flatten(email.cc),
    body,
    // Inline images referenced by the HTML are not attachments in Graph's sense.
    hasAttachments: email.attachments.some((a) => !a.related),
    rawSha256,
  };
}
