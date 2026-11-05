import MailComposer from 'nodemailer/lib/mail-composer';
import PostalMime, { addressParser } from 'postal-mime';

import type { MessageInput } from './transport';

/**
 * The RFC 822 message for Gmail's users.messages.send (#490, design R7).
 *
 * This is the control behind "From is always the connected user": Gmail
 * accepts a forged From (rehearsal test 4), so the From is pinned here.
 *   - The message has no From field (MessageInput); the From comes only from
 *     the sender argument, which the caller reads from the connection row.
 *   - No Sender, Reply-To or custom header is taken from the caller.
 *   - A CR or LF in any value that becomes a header is refused before building.
 *   - The built bytes are parsed back with postal-mime, and the build fails
 *     closed unless there is exactly one From header holding exactly one
 *     mailbox, equal to the pinned address, and no Sender, Reply-To or
 *     Return-Path.
 *
 * nodemailer is used only for MailComposer (MIME, header encoding, folding),
 * never for SMTP. File and URL content sources are switched off: attachment
 * bytes are always passed in. Bcc stays in the raw message (keepBcc), because
 * Gmail reads the recipients from it and strips Bcc on delivery.
 *
 * Errors carry a code, never message content.
 */

export type PinnedSender = {
  /** The connected mailbox's address, from the connection row. */
  address: string;
  /** The banker's display name, users.display_name ?? users.full_name. */
  name?: string | null;
};

export type Rfc822BuildCode = 'rfc822_header_break' | 'rfc822_from_not_pinned';

export class Rfc822BuildError extends Error {
  readonly code: Rfc822BuildCode;

  constructor(code: Rfc822BuildCode) {
    super(`message build refused: ${code}`);
    this.name = 'Rfc822BuildError';
    this.code = code;
  }
}

const LINE_BREAK = /[\r\n]/;

/** Every caller-supplied value that lands in a header, the root's or an attachment part's. */
function headerValues(message: MessageInput, sender: PinnedSender): string[] {
  return [
    message.subject,
    sender.address,
    sender.name ?? '',
    ...message.to,
    ...(message.cc ?? []),
    ...(message.bcc ?? []),
    ...(message.attachments ?? []).flatMap((a) => [a.filename, a.contentType ?? '']),
    message.inReplyTo ?? '',
    ...(message.references ?? []),
  ];
}

/** Parses built bytes back and throws unless the From is exactly the pinned address. */
export async function checkPinnedFrom(bytes: Uint8Array, address: string): Promise<void> {
  const parsed = await PostalMime.parse(bytes);
  const froms = parsed.headers.filter((h) => h.key === 'from');
  const redirects = parsed.headers.some((h) => h.key === 'sender' || h.key === 'reply-to' || h.key === 'return-path');
  let mailboxes: ReturnType<typeof addressParser> = [];
  if (froms.length === 1) {
    try {
      mailboxes = addressParser(froms[0].value);
    } catch {
      mailboxes = [];
    }
  }
  const [only] = mailboxes;
  // Case-insensitive: nodemailer lowercases the domain. An IDN domain comes back punycoded and fails closed.
  const pinned =
    froms.length === 1 &&
    !redirects &&
    mailboxes.length === 1 &&
    !only.group &&
    (only.address ?? '').toLowerCase() === address.toLowerCase();
  if (!pinned) throw new Rfc822BuildError('rfc822_from_not_pinned');
}

/** Builds the message with From pinned to the sender and returns it base64url-encoded, as messages.send takes it. */
export async function buildRfc822(message: MessageInput, sender: PinnedSender): Promise<string> {
  if (headerValues(message, sender).some((v) => LINE_BREAK.test(v))) {
    throw new Rfc822BuildError('rfc822_header_break');
  }
  const name = sender.name?.trim();
  const root = new MailComposer({
    from: name ? { name, address: sender.address } : sender.address,
    to: message.to,
    ...(message.cc?.length ? { cc: message.cc } : {}),
    ...(message.bcc?.length ? { bcc: message.bcc } : {}),
    subject: message.subject,
    // Threading (#339): the reply lands in the recipient's conversation.
    ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
    ...(message.inReplyTo && message.references?.length ? { references: message.references } : {}),
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((a) => ({
            filename: a.filename,
            content: Buffer.from(a.contentBase64, 'base64'),
            ...(a.contentType ? { contentType: a.contentType } : {}),
          })),
        }
      : {}),
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  root.keepBcc = true;
  const bytes = await root.build();
  await checkPinnedFrom(bytes, sender.address);
  return bytes.toString('base64url');
}
