import { describe, expect, it } from 'vitest';

import { findLexiconMatches, findLexiconHits } from '../src/lib/compliance/lexicon';
import { LEXICON_CATEGORIES, LEXICON_ENTRIES } from '../src/lib/compliance/lexicon.generated';
import { screenMessage } from '../src/lib/compliance/screen';
import { REWRITE_PATTERNS } from '../src/lib/compliance/rewritePatterns';

/*
 * The lexicon eval set (#163 slice 4), built from the standard's OWN §4.3
 * examples — the document is its own ground truth:
 *
 *   1. The risky "instead of" phrasings that map to a phrase family fire a
 *      signal (the vocabulary works on the document's own examples).
 *   2. No "send this" rewrite carries a Tier-1 signal — the house-approved
 *      safe vocabulary stays untouched at the urgent tier.
 *   3. The deterministic layer never BLOCKS a house rewrite (a safe rewrite
 *      demanding another rewrite would be absurd). A fail-closed MNPI HOLD
 *      is allowed — see the documented divergence below.
 *   4. Ordinary deal vocabulary stays untouched entirely.
 */

describe('lexicon eval — the standard’s own examples', () => {
  it('risky §4.3 phrasings that map to a phrase family fire a signal', () => {
    // Only these five map onto the Phrase Index; the others are worked
    // examples with no library family (asserted so a lexicon regen that
    // silently changes coverage fails loudly here).
    const expected: Array<[string, number]> = [
      ["Let's take this offline.", 2],
      ['Text me on this.', 1],
      ['This is a guaranteed 3x.', 1],
      ['The deal is done.', 2],
      ["Everyone knows they're going to miss the quarter.", 1],
    ];
    for (const [phrase, tier] of expected) {
      const hits = findLexiconHits(phrase);
      expect(hits.length, phrase).toBeGreaterThan(0);
      expect(hits[0].tier, phrase).toBe(tier);
    }

    const unmapped = REWRITE_PATTERNS.filter(
      (p) => !expected.some(([phrase]) => phrase === p.instead),
    );
    for (const p of unmapped) {
      expect(findLexiconHits(p.instead), p.instead).toEqual([]);
    }
  });

  it('no house rewrite carries a Tier-1 signal', () => {
    for (const p of REWRITE_PATTERNS) {
      if (!p.send) continue;
      const t1 = findLexiconMatches(p.send).filter((m) => m.tier === 1);
      expect(t1, p.send).toEqual([]);
    }
  });

  it('the deterministic layer never BLOCKS a house rewrite', () => {
    for (const p of REWRITE_PATTERNS) {
      if (!p.send) continue;
      const verdict = screenMessage(p.send).verdict;
      // Documented divergence: the $200M sensitivity rewrite trips the
      // fail-closed MNPI cross-pattern (an internal target figure next to
      // model/assumption language) and HOLDS for review. That is the rule
      // pack erring toward supervision, not a broken rewrite — a hold is
      // review, a block is "rewrite this", and no house rewrite may block.
      expect(verdict, p.send).not.toBe('blocked');
    }
  });

  it('ordinary deal vocabulary stays untouched (no signals, compliant)', () => {
    const ordinary = [
      'The revised draft of the SPA is attached for your review.',
      'Can we move the diligence call to Thursday afternoon?',
      'Management presentations are scheduled for the week of the 14th.',
      'Please confirm receipt of the signed NDA.',
      'The data room index was updated this morning.',
    ];
    for (const text of ordinary) {
      expect(findLexiconHits(text), text).toEqual([]);
      expect(screenMessage(text).verdict, text).toBe('compliant');
    }
  });

  it('findLexiconMatches returns the text that matched, not the library phrase', () => {
    // A slash-group entry fires on ONE alternative and reports what it saw.
    const m = findLexiconMatches('We should agree the fee before Friday.');
    const slashed = m.find((x) => x.phrase === 'agree the price/fee/spread');
    expect(slashed?.match.toLowerCase()).toBe('agree the fee');

    // Smart quotes (Outlook/iOS defaults) normalize before matching, and the
    // matched text is reported in its normalized form.
    const curly = findLexiconMatches('Everyone knows they’re going to miss the quarter.');
    expect(curly.some((x) => x.tier === 1)).toBe(true);
  });
});

/*
 * Eval expansion (#163 slice 5): the whole indicator library, not five
 * examples. "Measure missed risk, not alert volume" — so the first block is
 * RECALL over every phrase in the index, and the last is a per-category
 * legitimate-use set that must stay silent.
 */

/** A phrase as it would appear in real mail: placeholders filled, open
 *  templates completed, dropped into a sentence. */
function inSentence(phrase: string): string {
  const filled = phrase
    .replace(/\[[^\]]+\]/g, 'Acme')
    .replace(/(?:\.\.\.|…)+\s*$/, ' the announcement');
  return `Quick note before the call: ${filled}, then we can regroup on Friday.`;
}

describe('lexicon eval — library recall', () => {
  it('every one of the 521 index phrases fires when it appears in a sentence', () => {
    const missed: string[] = [];
    for (const e of LEXICON_ENTRIES) {
      const hits = findLexiconHits(inSentence(e.phrase));
      if (!hits.some((h) => h.phrase === e.phrase)) missed.push(e.phrase);
    }
    // Pinned, not tolerated: a regen or a matcher change that drops recall
    // must fail here by name.
    expect(missed).toEqual([]);
  });

  it('every one of the 228 families and 24 categories is reachable through at least one firing phrase', () => {
    const families = new Set<number>();
    const categories = new Set<number>();
    for (const e of LEXICON_ENTRIES) {
      if (findLexiconHits(inSentence(e.phrase)).some((h) => h.phrase === e.phrase)) {
        families.add(e.family);
        categories.add(e.category);
      }
    }
    expect(families.size).toBe(228);
    expect(categories.size).toBe(24);
    expect(Object.keys(LEXICON_CATEGORIES)).toHaveLength(24);
  });

  it('a hit reports the phrase\'s own tier and category (no cross-family bleed) — all 521', () => {
    for (const e of LEXICON_ENTRIES) {
      const hit = findLexiconHits(inSentence(e.phrase)).find((h) => h.phrase === e.phrase);
      expect(hit?.tier, e.phrase).toBe(e.tier);
      expect(hit?.category, e.phrase).toBe(e.category);
    }
  });
});

describe('lexicon eval — legitimate use produces evidence, never a verdict (one sentence per category)', () => {
  // Each sentence USES a real phrase from its category the way the standard's
  // "common legitimate use" column describes — the vocabulary fires (that is
  // the point of a signal), and the deterministic layer stays compliant:
  // a library that blocked these "will not survive contact with a live
  // deal". Two categories (15 Workplace conduct, 21 Threats) consist only of
  // conduct phrases with no legitimate use; they get an ordinary sentence
  // that must stay silent instead.
  const legitimate: Record<number, { text: string; fires: boolean }> = {
    1: { text: 'Please use the code name only in all correspondence, per the engagement letter.', fires: true },
    2: { text: 'The wall-cross was logged with Compliance before the materials went out.', fires: true },
    3: { text: 'The channel check is booked through the approved expert network with a chaperone on the line.', fires: true },
    4: { text: 'Our note explains why the strategic bid may support the price already in the market.', fires: true },
    5: { text: 'The engagement letter includes a most-favored nation clause on fees, reviewed by counsel.', fires: true },
    6: { text: 'The side letter on fees was disclosed to the client and sits in the deal file.', fires: true },
    7: { text: 'Any special economics for anchor investors are disclosed in the offering memorandum.', fires: true },
    8: { text: 'The allocation is closing on Friday; the final book will be circulated by counsel.', fires: true },
    9: { text: 'Pre-marketing is limited to the accredited investors listed in the counsel-approved memorandum.', fires: true },
    10: { text: "Counsel confirmed in writing that the quiet period doesn't apply here because the issuer is private.", fires: true },
    11: { text: 'The advisory retainer is documented in the engagement letter and invoiced monthly.', fires: true },
    12: { text: "The buyer's offshore entity has completed KYC and the beneficial ownership schedule is attached.", fires: true },
    13: { text: 'The manual override in the model is documented in the assumptions tab and reviewed by the controller.', fires: true },
    14: { text: "Please keep this privileged: counsel's advice on the litigation exposure is attached.", fires: true },
    15: { text: "The associate's work on this deal has been excellent; please recognize her in the review.", fires: false },
    16: { text: 'Please send the passport number through the secure portal, not by email.', fires: true },
    17: { text: "I have a recording of that call, made with everyone's consent, if you want the exact wording.", fires: true },
    18: { text: 'Agreed on the timetable; the commercial terms remain subject to contract.', fires: true },
    19: { text: "The client said they'll follow me to the new coverage team; HR and Compliance are handling the transition.", fires: true },
    20: { text: 'The rounding difference is too small to matter for the valuation; it is noted in the footnote.', fires: true },
    21: { text: 'Let us find a time this week to talk through the open points constructively.', fires: false },
    22: { text: 'The memo never argues "the model says so"; every output was checked by a senior banker.', fires: true },
    23: { text: 'Counsel confirmed the M&A broker exemption covers it, and the memo is in the compliance file.', fires: true },
    24: { text: 'Counsel confirmed the JDA covers it before the memo was shared with co-defendant counsel.', fires: true },
  };

  it('the category fires as evidence and the rules layer stays compliant', () => {
    for (let c = 1; c <= 24; c++) {
      const { text, fires } = legitimate[c];
      const matches = findLexiconMatches(text);
      if (fires) {
        expect(matches.some((m) => m.category === c), `category ${c} must fire: ${text}`).toBe(true);
      } else {
        expect(matches, `category ${c} must stay silent: ${text}`).toEqual([]);
      }
      expect(screenMessage(text).verdict, `category ${c}: ${text}`).toBe('compliant');
    }
  });

  it('a lexicon hit alone never sets a verdict, whatever the tier', () => {
    for (let c = 1; c <= 24; c++) {
      const { text } = legitimate[c];
      expect(screenMessage(text).reasons, `category ${c}`).toEqual([]);
    }
  });
});
