import { describe, expect, it } from 'vitest';

import { forwardedBlock } from '@/lib/compliance/forwardedBlock';
import { SCREEN_FIELD_LIMIT, screenIncomingItems, screenIncomingMessage } from '@/lib/compliance/screenIncoming';
import { evaluateRules, summarize } from '@/lib/compliance/screeningEval';
import { normalizeDocument, normalizeMessage } from '@/lib/discovery/normalize';
import type { MailMessage } from '@/lib/discovery/source/types';
import { SCREENING_CORPUS } from './fixtures/compliance/screeningCorpus';

/*
 * Incoming mail is screened by the same rule layer as a send (plan v5, week 3),
 * on the message as the discovery pipeline normalizes it.
 */

function mail(id: string, subject: string, body: string, contentType: 'text' | 'html' = 'text'): MailMessage {
  return {
    id,
    internetMessageId: `<${id}@corpus.test>`,
    conversationId: null,
    subject,
    sentDateTime: '2026-10-06T12:00:00Z',
    from: { emailAddress: { address: 'dana@counterparty.test' } },
    toRecipients: [{ emailAddress: { address: 'md@bank.test' } }],
    ccRecipients: [],
    body: { contentType, content: body },
  };
}

describe('screenIncomingMessage', () => {
  it('flags exactly what the send path flags, on every corpus email', () => {
    const atSend = evaluateRules(SCREENING_CORPUS);
    const incoming = SCREENING_CORPUS.map((c) => screenIncomingMessage(normalizeMessage(mail(c.id, c.subject, c.body))));
    expect(incoming.map((r) => r.flagged)).toEqual(atSend.map((r) => r.flagged));
    expect(incoming.map((r) => r.reasons)).toEqual(atSend.map((r) => r.reasons));
    const summary = summarize(atSend);
    expect(summary.falsePositives).toBe(97);
    expect(summary.caught).toBe(43);
  });

  it('judges a reply on what its sender wrote, not on the history it quotes', () => {
    const reply = mail(
      'reply',
      'Re: Process update',
      'Thanks, we will review the materials this week.\n\nOn Mon, Oct 5, 2026 at 9:00 AM Dana <dana@counterparty.test> wrote:\n> We guarantee a board seat for you after closing.',
    );
    expect(screenIncomingMessage(normalizeMessage(reply))).toMatchObject({ flagged: false, reasons: [] });
  });

  it('still flags the sender’s own words in a reply', () => {
    const reply = mail(
      'reply-own',
      'Re: Process update',
      'We guarantee a board seat for you after closing.\n\nOn Mon, Oct 5, 2026 at 9:00 AM Dana <dana@counterparty.test> wrote:\n> Thanks for the update.',
    );
    const result = screenIncomingMessage(normalizeMessage(reply));
    expect(result.flagged).toBe(true);
    expect(result.reasons[0]).toMatch(/^promissory:/);
  });

  // Normalization drops a forward's block; forwardedBlock reads it apart, for
  // screening only, so routing and the store never see it.
  it('screens the content of a forwarded email, not only the note on top', () => {
    const forward = mail(
      'fwd',
      'Fwd: Heads up',
      'FYI, see below.\n\n---------- Forwarded message ----------\nOur internal valuation model puts the business at 11x EBITDA.',
    );
    expect(screenIncomingMessage(normalizeMessage(forward)).flagged).toBe(false);
    const result = screenIncomingMessage(normalizeMessage(forward), forwardedBlock(forward));
    expect(result.flagged).toBe(true);
    expect(result.reasons.some((r) => r.startsWith('mnpi:'))).toBe(true);
  });

  // Guillermo's review of PR #416: the promissory lookaheads grow with the square of the
  // length, so outside mail is capped per field and a crafted body cannot stall a sync.
  it('screens a pathological 1 MB body within a time budget, reading only the first 32 KB', () => {
    const huge = 'I promise to send deck '.repeat(Math.ceil((1024 * 1024) / 23));
    const started = performance.now();
    screenIncomingMessage(normalizeMessage(mail('huge', 'Deck', huge)), huge);
    expect(performance.now() - started).toBeLessThan(2000);
    const late = `${'x'.repeat(SCREEN_FIELD_LIMIT + 10)} Our internal valuation model puts the business at 11x EBITDA.`;
    expect(screenIncomingMessage(normalizeMessage(mail('late', 'Note', late))).flagged).toBe(false);
  });

  it('reads an HTML body as text', () => {
    const html = mail('html', 'Heads up', '<p>Our <b>internal valuation</b> model puts the business at 11x EBITDA.</p>', 'html');
    const result = screenIncomingMessage(normalizeMessage(html));
    expect(result).toMatchObject({ internetMessageId: '<html@corpus.test>', flagged: true });
    expect(result.reasons.some((r) => r.startsWith('mnpi:'))).toBe(true);
  });
});

describe('screenIncomingItems', () => {
  it('screens messages and leaves SharePoint documents out', () => {
    const message = normalizeMessage(mail('m1', 'Board', 'The board minutes from last week show they already approved the sale.'));
    const document = normalizeDocument({
      driveItemKey: 'drive-1:doc-1',
      providerItemId: 'doc-1',
      name: 'Board minutes.docx',
      drivePath: 'Deals/Board minutes.docx',
      lastModifiedDateTime: '2026-10-06T12:00:00Z',
      authors: [],
      text: 'The board minutes from last week show they already approved the sale.',
      cTag: null,
    });
    const results = screenIncomingItems([message, document]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ internetMessageId: '<m1@corpus.test>', flagged: true });
  });
});
