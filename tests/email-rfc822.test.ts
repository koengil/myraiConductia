// @vitest-environment node
import PostalMime from 'postal-mime';
import { describe, expect, it, vi } from 'vitest';

import { buildRfc822, checkPinnedFrom, type PinnedSender } from '../src/lib/email/rfc822';
import type { MessageInput } from '../src/lib/email/transport';

/*
 * The RFC 822 builder for Gmail send as the banker (#490 S1c), dormant until S2b.
 *
 * Contracts under test:
 *   1. The From comes only from the sender argument; MessageInput has no From, and a forged one is ignored.
 *   2. To, Cc and Bcc survive into the raw message (Gmail needs Bcc there and strips it on delivery).
 *   3. A UTF-8 subject (with [Confidential]), a UTF-8 filename, html plus text and attachment bytes survive.
 *   4. A CR or LF in any value that becomes a header is refused before building.
 *   5. The parse-back refuses unless there is exactly one From holding exactly the pinned address,
 *      and no Sender, Reply-To or Return-Path; buildRfc822 runs it on what it built.
 */

const SENDER: PinnedSender = { address: 'storm@ignatious.com', name: 'Storm Duncan' };

const message = (overrides: Partial<MessageInput> = {}): MessageInput => ({
  to: ['founder@atlassian.example'],
  subject: 'Project Falcon next steps',
  text: 'Plain body.',
  ...overrides,
});

const parse = (raw: string) => PostalMime.parse(Buffer.from(raw, 'base64url'), { attachmentEncoding: 'base64' });
const headersNamed = (email: Awaited<ReturnType<typeof parse>>, key: string) => email.headers.filter((h) => h.key === key);

describe('the From is pinned to the sender', () => {
  it('MessageInput has no From field', () => {
    // @ts-expect-error a message cannot name its own From
    const typed: MessageInput = { from: 'forged@outside.example', to: ['a@b.example'], subject: 's', text: 't' };
    expect(typed.to).toEqual(['a@b.example']);
  });

  it('takes the From from the sender only, ignoring a From smuggled onto the message', async () => {
    const forged = { ...message(), from: 'forged@outside.example' } as MessageInput;
    const email = await parse(await buildRfc822(forged, SENDER));
    expect(email.from).toEqual({ name: 'Storm Duncan', address: 'storm@ignatious.com' });
    expect(headersNamed(email, 'from')).toHaveLength(1);
    for (const key of ['sender', 'reply-to', 'return-path']) expect(headersNamed(email, key), key).toEqual([]);
  });

  it('writes a bare address when there is no display name', async () => {
    for (const name of [undefined, null, '', '   ']) {
      const email = await parse(await buildRfc822(message(), { address: SENDER.address, name }));
      expect(email.from).toEqual({ name: '', address: 'storm@ignatious.com' });
    }
  });

  it('keeps a display name with a comma or non-ASCII letters as one mailbox', async () => {
    for (const name of ['Duncan, Storm', 'Störm Dünçan']) {
      const email = await parse(await buildRfc822(message(), { address: SENDER.address, name }));
      expect(email.from, name).toEqual({ name, address: 'storm@ignatious.com' });
    }
  });

  it('returns base64url', async () => {
    expect(await buildRfc822(message(), SENDER)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('the message survives the build', () => {
  it('keeps To, Cc and Bcc in the raw message', async () => {
    const raw = await buildRfc822(
      message({ to: ['a@one.example', 'b@one.example'], cc: ['c@two.example'], bcc: ['d@three.example', 'e@three.example'] }),
      SENDER,
    );
    const email = await parse(raw);
    expect(email.to?.map((a) => a.address)).toEqual(['a@one.example', 'b@one.example']);
    expect(email.cc?.map((a) => a.address)).toEqual(['c@two.example']);
    expect(email.bcc?.map((a) => a.address)).toEqual(['d@three.example', 'e@three.example']);
  });

  it('omits Cc and Bcc when there are none', async () => {
    const email = await parse(await buildRfc822(message({ cc: [], bcc: [] }), SENDER));
    expect(headersNamed(email, 'cc')).toEqual([]);
    expect(headersNamed(email, 'bcc')).toEqual([]);
  });

  it('encodes a UTF-8 subject, including a long one, and the [Confidential] marking survives', async () => {
    for (const subject of ['[Confidential] Prüfung der Übernahme 日本語 ✓', `[Confidential] ${'Bewertung für Falcon '.repeat(12).trim()}`]) {
      const email = await parse(await buildRfc822(message({ subject }), SENDER));
      expect(email.subject).toBe(subject);
    }
  });

  it('sends html and text together, and text alone without an html part', async () => {
    const both = await parse(await buildRfc822(message({ text: 'Plain body.', html: '<p>Rich <b>body</b>.</p>' }), SENDER));
    expect(both.text?.trim()).toBe('Plain body.');
    expect(both.html).toContain('<p>Rich <b>body</b>.</p>');
    const plain = await parse(await buildRfc822(message({ text: 'Only text.' }), SENDER));
    expect(plain.text?.trim()).toBe('Only text.');
    expect(plain.html).toBeUndefined();
  });

  it('carries attachments byte for byte, with a UTF-8 filename and the given content type', async () => {
    const pdf = Buffer.from('%PDF-1.4 fake bytes \u0000ÿ').toString('base64');
    const csv = Buffer.from('a,b\n1,2\n').toString('base64');
    const email = await parse(
      await buildRfc822(
        message({
          html: '<p>See attached.</p>',
          attachments: [
            { filename: 'Bewertung Übersicht 日本.pdf', contentBase64: pdf, contentType: 'application/pdf' },
            { filename: 'model.csv', contentBase64: csv },
          ],
        }),
        SENDER,
      ),
    );
    expect(email.attachments.map((a) => a.filename)).toEqual(['Bewertung Übersicht 日本.pdf', 'model.csv']);
    expect(email.attachments[0].mimeType).toBe('application/pdf');
    expect(Buffer.from(String(email.attachments[0].content), 'base64').equals(Buffer.from(pdf, 'base64'))).toBe(true);
    expect(Buffer.from(String(email.attachments[1].content), 'base64').equals(Buffer.from(csv, 'base64'))).toBe(true);
  });
});

describe('a reply is threaded (#339)', () => {
  it('writes In-Reply-To and References, and the From stays pinned', async () => {
    const email = await parse(
      await buildRfc822(
        message({ subject: 'Re: Project Falcon', inReplyTo: '<b@x.example>', references: ['<a@x.example>', '<b@x.example>'] }),
        SENDER,
      ),
    );
    expect(email.inReplyTo).toBe('<b@x.example>');
    expect(email.references).toBe('<a@x.example> <b@x.example>');
    expect(email.from).toEqual({ name: 'Storm Duncan', address: 'storm@ignatious.com' });
  });

  it('writes neither header for a new message', async () => {
    const email = await parse(await buildRfc822(message(), SENDER));
    expect(headersNamed(email, 'in-reply-to')).toEqual([]);
    expect(headersNamed(email, 'references')).toEqual([]);
  });
});

describe('header injection is refused before building', () => {
  const refusals: Array<[string, MessageInput, PinnedSender]> = [
    ['CRLF in the subject', message({ subject: 'Hello\r\nBcc: spy@outside.example' }), SENDER],
    ['LF in the subject', message({ subject: 'Hello\nFrom: ceo@outside.example' }), SENDER],
    ['CR in the subject', message({ subject: 'Hello\rFrom: ceo@outside.example' }), SENDER],
    ['a line break in the display name', message(), { address: SENDER.address, name: 'Storm\r\nReply-To: spy@outside.example' }],
    ['a line break in a recipient', message({ bcc: ['d@three.example\r\nX-Evil: 1'] }), SENDER],
    [
      'a line break in an attachment filename',
      message({ attachments: [{ filename: 'a.pdf\r\nX-Evil: 1', contentBase64: 'AA==' }] }),
      SENDER,
    ],
    [
      'a line break in an attachment content type',
      message({ attachments: [{ filename: 'a.pdf', contentBase64: 'AA==', contentType: 'application/pdf\r\nX-Evil: 1' }] }),
      SENDER,
    ],
    ['a line break in In-Reply-To', message({ inReplyTo: '<a@x.example>\r\nBcc: spy@outside.example' }), SENDER],
    ['a line break in a References id', message({ inReplyTo: '<a@x.example>', references: ['<a@x.example>\nX: 1'] }), SENDER],
  ];

  it.each(refusals)('%s', async (_label, input, sender) => {
    await expect(buildRfc822(input, sender)).rejects.toMatchObject({ name: 'Rfc822BuildError', code: 'rfc822_header_break' });
  });

  it('carries the code, never the content, in the error message', async () => {
    const err = await buildRfc822(message({ subject: 'Project Falcon\r\nX: y' }), SENDER).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain('Falcon');
  });
});

describe('the parse-back guard', () => {
  const raw = (headerLines: string[]) =>
    Buffer.from(
      [...headerLines, 'To: founder@atlassian.example', 'Subject: x', 'MIME-Version: 1.0', 'Content-Type: text/plain', '', 'body', ''].join(
        '\r\n',
      ),
    );

  it('accepts exactly one From with the pinned address, in any case', async () => {
    await expect(checkPinnedFrom(raw(['From: Storm Duncan <storm@ignatious.com>']), 'storm@ignatious.com')).resolves.toBeUndefined();
    await expect(checkPinnedFrom(raw(['From: storm@IGNATIOUS.com']), 'storm@ignatious.com')).resolves.toBeUndefined();
  });

  it.each<[string, string[]]>([
    ['two From headers', ['From: storm@ignatious.com', 'From: ceo@outside.example']],
    ['two mailboxes in one From', ['From: storm@ignatious.com, ceo@outside.example']],
    ['a group in the From', ['From: Team: storm@ignatious.com;']],
    ['another address', ['From: ceo@outside.example']],
    ['no From', []],
    ['a Sender', ['From: storm@ignatious.com', 'Sender: ceo@outside.example']],
    ['a Reply-To', ['From: storm@ignatious.com', 'Reply-To: ceo@outside.example']],
    ['a Return-Path', ['From: storm@ignatious.com', 'Return-Path: <ceo@outside.example>']],
  ])('refuses %s', async (_label, headerLines) => {
    await expect(checkPinnedFrom(raw(headerLines), 'storm@ignatious.com')).rejects.toMatchObject({
      code: 'rfc822_from_not_pinned',
    });
  });

  it('runs on what buildRfc822 built: a composer that emits a second From fails the build', async () => {
    const tampered = raw(['From: storm@ignatious.com', 'From: ceo@outside.example']);
    vi.resetModules();
    vi.doMock('nodemailer/lib/mail-composer', () => ({
      default: class {
        compile() {
          return { keepBcc: false, build: async () => tampered };
        }
      },
    }));
    try {
      const fresh = await import('../src/lib/email/rfc822');
      await expect(fresh.buildRfc822(message(), SENDER)).rejects.toMatchObject({ code: 'rfc822_from_not_pinned' });
    } finally {
      vi.doUnmock('nodemailer/lib/mail-composer');
      vi.resetModules();
    }
  });
});
