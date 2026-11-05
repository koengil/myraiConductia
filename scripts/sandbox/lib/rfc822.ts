import MailComposer from 'nodemailer/lib/mail-composer';

import type { SandboxMessage } from './types';

/** Builds a raw RFC 822 message (bytes) for Gmail send/import. */
export async function buildSandboxRfc822(message: SandboxMessage): Promise<Uint8Array> {
  const composer = new MailComposer({
    messageId: message.messageId,
    date: message.date,
    from: message.from.name ? { name: message.from.name, address: message.from.address } : message.from.address,
    to: message.to,
    ...(message.cc.length ? { cc: message.cc } : {}),
    subject: message.subject,
    ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
    ...(message.references?.length ? { references: message.references } : {}),
    headers: message.customHeaders,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
    ...(message.attachments.length
      ? {
          attachments: message.attachments.map((a) => ({
            filename: a.filename,
            content: Buffer.from(a.content),
            contentType: a.contentType,
          })),
        }
      : {}),
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  composer.keepBcc = true;
  return composer.build();
}

export function toBase64Url(raw: Uint8Array): string {
  return Buffer.from(raw).toString('base64url');
}
