import { describe, it, expect } from 'vitest';
import { screenMessage } from '../src/lib/compliance/screen';

/**
 * Ported from intelibank-sandbox/lib/compliance/screen.test.ts (2026-05-20).
 * Rules and inputs verbatim; runner is vitest; assertions adapted to A's
 * ComplianceCheckResult shape (verdict + reasons[] + optional rewrite).
 *
 * Governance: ADR-0003 (Compliance verdict shape: three-state with rewrite
 * suggestions). Old binary `checkMessage` retired.
 */

describe('screenMessage — nominated brief cases', () => {
  it("'I guarantee the board seat stays with the founder' → blocked + rewrite", () => {
    const v = screenMessage('I guarantee the board seat stays with the founder');
    expect(v.verdict).toBe('blocked');
    expect(v.reasons[0]).toMatch(/promissory/i);
    expect(v.rewrite).toBeDefined();
    expect(v.rewrite?.length).toBeGreaterThan(0);
  });

  it("'Our internal model floors this at $510M, keep it here' → hold (MNPI)", () => {
    const v = screenMessage('Our internal model floors this at $510M, keep it here');
    expect(v.verdict).toBe('hold');
    expect(v.reasons[0]).toMatch(/mnpi/i);
    expect(v.rewrite).toBeUndefined();
  });

  it("'Sending the Figma/Canva comp read to the shared room' → compliant", () => {
    const v = screenMessage('Sending the Figma/Canva comp read to the shared room');
    expect(v.verdict).toBe('compliant');
    expect(v.reasons).toHaveLength(0);
    expect(v.rewrite).toBeUndefined();
  });
});

describe('screenMessage — promissory variants', () => {
  const blocks = [
    'I guarantee a board seat for the founder.',
    "We guarantee the price won't move.",
    'We guaranteed the timeline last week.',
    "I promise we'll close by Friday.",
    'We promise an earn-out structure.',
    'Can we promise the founder a board seat to get this done?',
    'Could we promise an extended earn-out?',
    'We commit to a top-of-range bid.',
    'I commit to keeping the team intact.',
    "You have my word the price won't move.",
    'You have our word on the indemnity cap.',
    'Guaranteed board seat will be in the offer.',
    // Still promissory after the Sep 30 tuning: the promise is about an outcome.
    'We commit to sending you a signed offer at the top of the range.',
    'I promise to keep the whole team after closing.',
    'You have my word that the buyer will not cut the price.',
    // Our own action, but the sentence names a deal term: still promissory.
    'I promise to get back to you with our best price.',
    "You have our word we'll send the revised terms today.",
    'We commit to keeping you updated on the valuation.',
    'We commit to calling you before any other bid.',
    // Adversarial review of PR #305: outcomes behind a delivery verb, an
    // object-less action, unlisted or plural deal terms, a line break.
    'We promise to deliver 20% returns.',
    'We promise to deliver the deal.',
    'We commit to deliver the company to you.',
    "You have my word we'll deliver.",
    'We promise to share the upside with your management team.',
    'We promise to share 20% of the proceeds.',
    'We commit to call the deal off.',
    'We promise to reply yes.',
    'We promise to send you the LOI.',
    'We promise to send you the equity split.',
    'We commit to sending you the headcount plan.',
    'I promise to call you with the number.',
    'We promise to send you the prices.',
    'We commit to sending you the valuations.',
    'We promise to follow up on the LOI.',
    'I promise to send you the deck\nat the top of the range.',
    'We are offering a guaranteed role to the CFO.',
    // Guillermo's review of PR #304: a benign clause first, then a promise
    // about the people or the outcome that avoids the deal-term words.
    'We promise to get back to you with good news about your future at the company.',
    'I promise to follow up personally so your team is taken care of after close.',
    'We commit to keeping you updated, and your people will be looked after.',
    'You have my word that we will follow up and nobody on your team loses out.',
    'We promise to send you the revised deck and the buyer will match it.',
    'We promise to share the materials; the other side is walking away otherwise',
    'We promise to follow up once the buyer agrees to keep everyone.',
    'I promise to call you when we have locked in your seat.',
    // Self-review of PR #313: a free time clause or topic word carried a promise.
    'We promise to call you once your team is safe.',
    'We promise to call you when no one is fired.',
    'We promise to call you as soon as everyone is protected.',
    'We promise to follow up on the keep-everyone-employed notes.',
  ];

  for (const body of blocks) {
    it(`blocks: ${body.slice(0, 60)}${body.length > 60 ? '…' : ''}`, () => {
      const v = screenMessage(body);
      expect(v.verdict).toBe('blocked');
      expect(v.rewrite).toBeDefined();
      expect(v.rewrite?.length).toBeGreaterThan(0);
    });
  }
});

describe('screenMessage — MNPI variants', () => {
  const holds = [
    'Sharing the internal valuation with the team.',
    'Internal model says $510M floor.',
    'The valuation model puts us at the high end.',
    'Our deal floor is firm.',
    'Price floor is non-negotiable.',
    'Reservation price set at $X.',
    'Walk-away is below current offer.',
    'Routing this through MNPI review.',
    'Material non-public flag on this thread.',
    'Pulled the board minutes from last quarter.',
    'Drafting draft 10-K language now.',
    'Unannounced restructuring details below.',
    'Our walk-away price is $480M.',
    'Our walk-away winner is 500.',
    'The unannounced acquisition closes next week.',
    '$510M floor in the working model.',
    '$1.2B target price for the range.',
    'Floor at 510M based on the model.',
  ];

  for (const body of holds) {
    it(`holds: ${body.slice(0, 60)}${body.length > 60 ? '…' : ''}`, () => {
      const v = screenMessage(body);
      expect(v.verdict).toBe('hold');
      expect(v.reasons[0]).toMatch(/mnpi/i);
    });
  }
});

describe('screenMessage — compliant variants (false-positive guards)', () => {
  const oks = [
    'Sending the comp set (Figma, Canva read-throughs) to the shared room.',
    'Looping the team in. Atlassian indicative range we discussed: keep it tight.',
    'Daily review window 4 PM ET. No surveillance escalation.',
    'Agreed. Forwarding to advisor now.',
    'Market cap is around $23B, revenue TTM $6.2B.',
    // dollar figure WITHOUT MNPI context should still be compliant
    'Closed a $50M round last year.',
    // 'guarantee' appearing without I/we prefix is not promissory
    'The guarantee period in the term sheet is 12 months.',
    // a question that mentions 'promise' but not 'we/can we promise'
    "What's the typical promise structure in these deals?",
    // Our own delivery or timing, not a deal term (Sep 30 tuning, PR #294 corpus).
    'We commit to sending the revised deck by Friday noon.',
    'I promise to get back to you on the diligence questions by end of day.',
    'You have my word that we will keep you updated as soon as the second round closes.',
    "You have our word we'll follow up tomorrow.",
    'We promise to follow up on the deck by Friday.',
    'I promise to call you this afternoon.',
    'We commit to sending you the CIM shortly.',
    'We commit to sending you the deck later this week.',
    'We promise to follow up with you next Monday.',
    'I promise to call you once legal signs off.',
    'The plant tour was a walk-away success.',
    'Sorry for the unannounced visit this morning.',
    '',
    '   ',
  ];

  for (const body of oks) {
    const label = body.trim() ? body.slice(0, 60) : '(empty)';
    it(`compliant: ${label}${body.length > 60 ? '…' : ''}`, () => {
      const v = screenMessage(body);
      expect(v.verdict).toBe('compliant');
      expect(v.reasons).toHaveLength(0);
      expect(v.rewrite).toBeUndefined();
    });
  }
});

describe('screenMessage — priority', () => {
  it("promissory beats MNPI: 'I guarantee the model price of $510M' → blocked", () => {
    const v = screenMessage('I guarantee the model price of $510M floor.');
    expect(v.verdict).toBe('blocked');
    expect(v.rewrite).toBeDefined();
  });
});

describe('screenMessage — input hygiene', () => {
  it('handles trim-only whitespace as compliant', () => {
    const v = screenMessage('\n\n\t  ');
    expect(v.verdict).toBe('compliant');
  });

  it('case-insensitive on patterns', () => {
    const v = screenMessage('WE GUARANTEE THE OUTCOME.');
    expect(v.verdict).toBe('blocked');
  });
});
