import { describe, expect, it } from 'vitest';

import { forwardedBlock } from '@/lib/compliance/forwardedBlock';
import { normalizeMessage } from '@/lib/discovery/normalize';

/*
 * The block a forward carries, read apart from normalization for compliance
 * screening only (Guillermo, Oct 7): normalization, routing and the content
 * hash stay exactly as they are.
 */

const text = (subject: string, lines: string[]) => ({ subject, body: { contentType: 'text' as const, content: lines.join('\n') } });

const gmailForward = text('Fwd: Numbers', [
  'Sharing below, keep it tight.',
  '---------- Forwarded message ---------',
  'From: Ana <ana@target.test>',
  'Subject: Numbers',
  'Our Q3 revenue will miss guidance by 12%, not public yet.',
]);

describe('forwardedBlock', () => {
  it('returns the text after a Gmail "Forwarded message" marker', () => {
    const block = forwardedBlock(gmailForward);
    expect(block).toContain('Our Q3 revenue will miss guidance by 12%, not public yet.');
    expect(block).not.toContain('Sharing below');
  });

  it('treats an Outlook header block as forwarded when the subject is FW:', () => {
    const outlook = text('FW: Board', ['FYI', '________________________________', 'From: Ana <ana@target.test>', 'Sent: Monday', 'The board meets Friday on the sale.']);
    expect(forwardedBlock(outlook)).toContain('The board meets Friday on the sale.');
  });

  it('returns nothing for the same Outlook block on a reply', () => {
    const reply = text('RE: Board', ['Agreed.', 'From: Ana <ana@target.test>', 'Sent: Monday', 'The board meets Friday on the sale.']);
    expect(forwardedBlock(reply)).toBe('');
  });

  it('unquotes > lines inside the forwarded block', () => {
    expect(forwardedBlock(text('Fwd: price', ['see below', '---------- Forwarded message ---------', '> the price is 40 a share']))).toBe('the price is 40 a share');
  });

  it('returns nothing for a Gmail reply, whose quoted history is the earlier thread', () => {
    expect(forwardedBlock(text('RE: price', ['Thanks, agreed.', 'On Mon, Ana wrote:', '> the price is 40 a share']))).toBe('');
  });

  it('returns nothing when there is no quoted block', () => {
    expect(forwardedBlock(text('Fwd: note', ['Just a note.']))).toBe('');
  });

  it('reads an HTML body', () => {
    const html = { subject: 'Fwd: Numbers', body: { contentType: 'html' as const, content: '<p>FYI</p><p>---------- Forwarded message ---------</p><p>Our internal valuation is 11x EBITDA.</p>' } };
    expect(forwardedBlock(html)).toContain('Our internal valuation is 11x EBITDA.');
  });

  it('recognises a forward behind a gateway tag or a reply prefix', () => {
    const block = ['FYI', 'From: Ana <ana@target.test>', 'Sent: Monday', 'The board meets Friday on the sale.'];
    expect(forwardedBlock(text('[EXTERNAL] FW: Board', block))).toContain('The board meets Friday on the sale.');
    expect(forwardedBlock(text('RE: FW: Board', block))).toContain('The board meets Friday on the sale.');
    expect(forwardedBlock(text('[EXTERNAL] RE: Board', block))).toBe('');
  });

  it('returns nothing, without throwing, for a body with no content', () => {
    expect(forwardedBlock({ subject: 'Fwd: x', body: { contentType: 'text', content: null as unknown as string } })).toBe('');
  });

  it('leaves normalization untouched: the body still stops at the marker', () => {
    const item = normalizeMessage({ id: 'f', internetMessageId: '<fwd-1@test>', conversationId: 'c', sentDateTime: null, from: null, toRecipients: [], ccRecipients: [], ...gmailForward });
    expect(item.bodyText).toBe('Sharing below, keep it tight.');
    expect(item).not.toHaveProperty('forwardedText');
  });
});
