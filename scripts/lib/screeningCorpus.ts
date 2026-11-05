// Screening corpus for measuring false positives in the pre-send email screen.
//
// Lives under scripts/lib because scripts/screening-eval.ts (npm run eval:screening) reads it, and production
// code never imports from tests/ (tests/mailbox-reader-fence.test.ts, 'test-import'). The test fixture path
// tests/fixtures/compliance/screeningCorpus.ts re-exports it, so the tests still import from where they did.
//
// Every email here is fictional: invented codenames, companies and people,
// written the way a sell-side M&A banker actually writes. `expected` is what a
// compliance reviewer would want, not what the screen does today:
//   clear — ordinary banker mail; interrupting the sender is a false positive.
//   flag  — the screen should stop and ask the sender to look again.
//
// Oct 8 (Jev, D82): 315 more cases in scripts/lib/screeningCorpusCases, so a
// false-positive rate near 1% is measurable (with 30 ordinary emails, one
// false positive was already 3%). The near-miss set is deliberately hard:
// ordinary mail that uses trigger words innocently. Report it apart from the
// realistic mix, never blended into one rate.
//
// Oct 20 (Storm, Oct 19 build sync): the set was too small and not diverse
// (only promissory and MNPI, few risky cases). scripts/lib/screeningCorpusCases/riskRepository.ts
// adds a first slice of a risk repository: 100 twin pairs (a risky email and a
// clean twin in the same words), tagged by `risk` (legal, regulatory,
// compliance, reputational) and `difficulty` (obvious, edge), drawn from the
// types of conduct in SEC and FINRA enforcement, bank litigation and negative
// press. Borderline cases are weighted over obvious ones. It is reported per
// category and difficulty, apart from the realistic mix and the near-miss set.
// The long-term target is 10k to 100k synthetic emails.
//
// The measured behaviour of the rule layer lives in
// tests/compliance-false-positives.test.ts, so the corpus stays a statement
// of intent and the test records where the rules disagree with it.

import { NEAR_MISS } from './screeningCorpusCases/nearMiss';
import { ORDINARY_A } from './screeningCorpusCases/ordinaryA';
import { ORDINARY_B } from './screeningCorpusCases/ordinaryB';
import { RISKY } from './screeningCorpusCases/risky';
import { RISK_REPOSITORY } from './screeningCorpusCases/riskRepository';

export type ScreeningCase = {
  id: string;
  expected: 'clear' | 'flag';
  /** What kind of mail this is, for grouping the results. */
  kind:
    | 'logistics'
    | 'deal-vocabulary'
    | 'public-figures'
    | 'everyday-commitment'
    | 'idiom'
    | 'process-update'
    | 'promissory'
    | 'mnpi'
    // Ordinary mail that uses a trigger word innocently: the cases a second
    // opinion (Jev, D82) has to clear without clearing anything risky.
    | 'near-miss'
    // Disclaimers, NDA wording and signatures quoted in ordinary mail.
    | 'boilerplate'
    // The risk repository (Oct 20): twin pairs carrying `risk` and `difficulty`.
    | 'risk-repository';
  subject: string;
  body: string;
  /** Why a reviewer would want this outcome. */
  why: string;
  /** Risk repository only: which kind of exposure the pair is about. */
  risk?: 'legal' | 'regulatory' | 'compliance' | 'reputational';
  /** Risk repository only: obvious, or edge (borderline wording; for a clean twin, risky-sounding words used innocently). */
  difficulty?: 'obvious' | 'edge';
};

/** The first 45 cases (Sep 29), whose rule-layer results tests/compliance-false-positives.test.ts pins by id. */
export const CORE_CORPUS: readonly ScreeningCase[] = [
  // ── Logistics ──────────────────────────────────────────────────────────
  {
    id: 'logistics-01',
    expected: 'clear',
    kind: 'logistics',
    subject: 'Project Birch: Thursday call',
    body: 'Hi Dana, can we move Thursday\'s call to 3pm ET? Same dial-in. I\'ll send an updated invite this afternoon.',
    why: 'Scheduling only.',
  },
  {
    id: 'logistics-02',
    expected: 'clear',
    kind: 'logistics',
    subject: 'Re: Project Birch: Thursday call',
    body: 'Works for us. Please add Priya from our team to the invite.',
    why: 'Scheduling only.',
  },
  {
    id: 'logistics-03',
    expected: 'clear',
    kind: 'logistics',
    subject: 'Data room access',
    body: 'Mark, your data room access is set up. You should receive an email from Box shortly. Let me know if the link does not work.',
    why: 'Access logistics.',
  },
  {
    id: 'logistics-04',
    expected: 'clear',
    kind: 'logistics',
    subject: 'Management meeting dinner',
    body: 'We have booked dinner for eight at 7:30 on Tuesday after the management meeting. Dress is business casual.',
    why: 'Event logistics.',
  },
  {
    id: 'logistics-05',
    expected: 'clear',
    kind: 'logistics',
    subject: 'Out of office',
    body: 'I am out on Friday. Sam will cover anything urgent on Project Birch while I am away.',
    why: 'Coverage note.',
  },

  // ── Deal vocabulary used normally ──────────────────────────────────────
  {
    id: 'vocab-01',
    expected: 'clear',
    kind: 'deal-vocabulary',
    subject: 'Process letter',
    body: 'Attached is the first-round process letter. Indications of interest are due on October 20. Please direct all questions to our team, not to the company.',
    why: 'Standard process communication.',
  },
  {
    id: 'vocab-02',
    expected: 'clear',
    kind: 'deal-vocabulary',
    subject: 'NDA comments',
    body: 'Thanks for the markup. We can accept your changes to the non-solicit, but the standstill needs to stay at 12 months.',
    why: 'Routine NDA negotiation.',
  },
  {
    id: 'vocab-03',
    expected: 'clear',
    kind: 'deal-vocabulary',
    subject: 'CIM draft',
    body: 'Here is the latest CIM draft for your review. The industry section and the management bios are updated. Comments by Monday would be great.',
    why: 'Internal drafting with the client.',
  },
  {
    id: 'vocab-04',
    expected: 'clear',
    kind: 'deal-vocabulary',
    subject: 'Buyer list',
    body: 'We added three strategic buyers to the outreach list and removed two sponsors who passed last quarter. Updated list attached.',
    why: 'Process management.',
  },
  {
    id: 'vocab-05',
    expected: 'clear',
    kind: 'deal-vocabulary',
    subject: 'Model review',
    body: 'Can you walk me through the model tomorrow morning? I want to understand the working capital assumptions before we send the draft to the client.',
    why: 'Internal work on the model, no figures, sent inside the deal team.',
  },
  {
    id: 'vocab-06',
    expected: 'clear',
    kind: 'deal-vocabulary',
    subject: 'Term sheet',
    body: 'Please find attached our comments on the term sheet. Most are clarifications on the closing conditions.',
    why: 'Legal document exchange without numbers.',
  },
  {
    id: 'vocab-07',
    expected: 'clear',
    kind: 'deal-vocabulary',
    subject: 'Management presentation',
    body: 'The management presentation is scheduled for the week of November 3. We will confirm the agenda and attendees by Friday.',
    why: 'Process scheduling.',
  },

  // ── Public figures and ordinary numbers ────────────────────────────────
  {
    id: 'figures-01',
    expected: 'clear',
    kind: 'public-figures',
    subject: 'Comparable transactions',
    body: 'For context, Atlas Software was acquired last year for $1.2 billion, per the public announcement. I have added it to the comps page.',
    why: 'A publicly announced figure.',
  },
  {
    id: 'figures-02',
    expected: 'clear',
    kind: 'public-figures',
    subject: 'Market update',
    body: 'Software M&A volume reached $310 billion in the first half, according to the latest industry report. Deck attached.',
    why: 'Public market data.',
  },
  {
    id: 'figures-03',
    expected: 'clear',
    kind: 'public-figures',
    subject: 'Engagement letter',
    body: 'Attached is the engagement letter. The minimum fee is $2 million, as discussed with your CFO last week.',
    why: 'Our own fee, sent to our own client.',
  },
  {
    id: 'figures-04',
    expected: 'clear',
    kind: 'public-figures',
    subject: 'Public filing',
    body: 'Their 10-K shows revenue of $840 million and an EBITDA margin in the mid-teens. Worth a look before the call.',
    why: 'Figures from a public filing.',
  },
  {
    id: 'figures-05',
    expected: 'clear',
    kind: 'public-figures',
    subject: 'Conference',
    body: 'The conference expects 2,000 attendees this year. We have a booth and two panel slots.',
    why: 'Ordinary numbers.',
  },

  // ── Everyday commitments that use promissory words ─────────────────────
  {
    id: 'commit-01',
    expected: 'clear',
    kind: 'everyday-commitment',
    subject: 'Deck',
    body: 'We commit to sending the revised deck by Friday noon.',
    why: 'A delivery commitment, not a promise about deal terms.',
  },
  {
    id: 'commit-02',
    expected: 'clear',
    kind: 'everyday-commitment',
    subject: 'Follow-up',
    body: 'I promise to get back to you on the diligence questions by end of day.',
    why: 'A response-time promise, not a promise about outcome.',
  },
  {
    id: 'commit-03',
    expected: 'clear',
    kind: 'everyday-commitment',
    subject: 'Confidentiality',
    body: 'We guarantee that only the named deal team will have access to the materials you share.',
    why: 'A confidentiality assurance about our own conduct.',
  },
  {
    id: 'commit-04',
    expected: 'clear',
    kind: 'everyday-commitment',
    subject: 'Timing',
    body: 'You have my word that we will keep you updated as soon as the second round closes.',
    why: 'A communication commitment.',
  },

  // ── Idioms and innocent uses of flagged words ──────────────────────────
  {
    id: 'idiom-01',
    expected: 'clear',
    kind: 'idiom',
    subject: 'Site visit',
    body: 'The plant tour was a walk-away success. The buyer team was impressed with the automation line.',
    why: 'Idiomatic use of "walk-away".',
  },
  {
    id: 'idiom-02',
    expected: 'clear',
    kind: 'idiom',
    subject: 'Office visit',
    body: 'Sorry for the unannounced visit this morning. Thanks for making time anyway.',
    why: '"Unannounced" in its everyday sense.',
  },
  {
    id: 'idiom-03',
    expected: 'clear',
    kind: 'idiom',
    subject: 'Budget',
    body: 'Our travel budget for the roadshow has a floor of two trips per quarter. Can you confirm the dates?',
    why: '"Floor" about travel budget, no deal figure.',
  },
  {
    id: 'idiom-04',
    expected: 'clear',
    kind: 'idiom',
    subject: 'Hiring',
    body: 'We are hiring two analysts. Salary range is in line with the street, and we can sponsor visas.',
    why: '"Range" about hiring, no deal figure.',
  },

  // ── Process updates with numbers ───────────────────────────────────────
  {
    id: 'process-01',
    expected: 'clear',
    kind: 'process-update',
    subject: 'Round one',
    body: 'We received 14 indications of interest. We plan to invite six parties to the second round.',
    why: 'A process count, sent to the client.',
  },
  {
    id: 'process-02',
    expected: 'clear',
    kind: 'process-update',
    subject: 'Timeline',
    body: 'We are on track to sign by mid-December, subject to diligence and board approval.',
    why: 'Timeline update to the client.',
  },
  {
    id: 'process-03',
    expected: 'clear',
    kind: 'process-update',
    subject: 'Financing',
    body: 'Two lenders confirmed they can support a financing package of $400 million for the buyer, subject to their credit committees.',
    why: 'A financing update to the client; the figure is the lenders\' capacity, not a valuation.',
  },
  {
    id: 'process-04',
    expected: 'clear',
    kind: 'process-update',
    subject: 'Diligence',
    body: 'The buyer asked for customer contracts above $5 million annual value. We will post redacted versions to the data room.',
    why: 'A diligence request with a threshold, not a valuation.',
  },
  {
    id: 'process-05',
    expected: 'clear',
    kind: 'process-update',
    subject: 'Board meeting',
    body: 'The board meets on October 14. We will circulate the materials two days before.',
    why: 'Scheduling a board meeting.',
  },

  // ── Should be flagged: promises about outcomes ─────────────────────────
  {
    id: 'promise-01',
    expected: 'flag',
    kind: 'promissory',
    subject: 'Re: Management',
    body: 'We guarantee a board seat for you after closing.',
    why: 'Promises a deal term the bank cannot promise.',
  },
  {
    id: 'promise-02',
    expected: 'flag',
    kind: 'promissory',
    subject: 'Outcome',
    body: 'I promise this deal will close by year end at the price you want.',
    why: 'Promises an outcome and a price.',
  },
  {
    id: 'promise-03',
    expected: 'flag',
    kind: 'promissory',
    subject: 'Retention',
    body: 'You have our word that the buyer will keep the whole management team.',
    why: 'Promises something only the buyer controls.',
  },
  {
    id: 'promise-04',
    expected: 'flag',
    kind: 'promissory',
    subject: 'Returns',
    body: 'Our clients have seen 40% returns on deals like this, so you can expect the same.',
    why: 'Performance claim and implied guarantee.',
  },
  {
    id: 'promise-05',
    expected: 'flag',
    kind: 'promissory',
    subject: 'Next steps',
    body: 'We promise to get back to you with good news about your future at the company.',
    why: 'A benign "get back to you" carrying a promise about the future of the reader.',
  },
  {
    id: 'promise-06',
    expected: 'flag',
    kind: 'promissory',
    subject: 'Your team',
    body: 'I promise to follow up personally so your team is taken care of after close.',
    why: 'A follow-up that promises how the team is treated after close.',
  },
  {
    id: 'promise-07',
    expected: 'flag',
    kind: 'promissory',
    subject: 'Updates',
    body: 'We commit to keeping you updated, and your people will be looked after.',
    why: 'A communication commitment joined to a promise about the people.',
  },
  {
    id: 'promise-08',
    expected: 'flag',
    kind: 'promissory',
    subject: 'Re: Team',
    body: 'You have my word that we will follow up and nobody on your team loses out.',
    why: 'A follow-up joined to a promise that nobody loses out.',
  },
  {
    id: 'promise-09',
    expected: 'flag',
    kind: 'promissory',
    subject: 'Deck',
    body: 'We promise to send you the revised deck and the buyer will match it.',
    why: 'A delivery promise joined to a promise about what the buyer will do.',
  },
  {
    id: 'promise-10',
    expected: 'flag',
    kind: 'promissory',
    subject: 'Materials',
    body: 'We promise to share the materials; the other side is walking away otherwise',
    why: 'A delivery promise used to apply pressure about the other side.',
  },

  // ── Should be flagged: material non-public information ─────────────────
  {
    id: 'mnpi-01',
    expected: 'flag',
    kind: 'mnpi',
    subject: 'Project Birch valuation',
    body: 'Between us, the seller will not go below $510 million.',
    why: 'Leaks the seller\'s reservation price to the other side.',
  },
  {
    id: 'mnpi-02',
    expected: 'flag',
    kind: 'mnpi',
    subject: 'Heads up',
    body: 'Our internal valuation model puts the business at 11x EBITDA. Keep this to yourself.',
    why: 'Shares the internal valuation.',
  },
  {
    id: 'mnpi-03',
    expected: 'flag',
    kind: 'mnpi',
    subject: 'Board',
    body: 'The board minutes from last week show they already approved the sale. Nothing is public yet.',
    why: 'Shares board minutes and an unannounced decision.',
  },
  {
    id: 'mnpi-04',
    expected: 'flag',
    kind: 'mnpi',
    subject: 'Quick one',
    body: 'Keep this quiet, but they are about to announce a large acquisition next week. Might be worth buying the stock.',
    why: 'Tips an unannounced transaction and suggests trading on it.',
  },
  {
    id: 'mnpi-05',
    expected: 'flag',
    kind: 'mnpi',
    subject: 'Range',
    body: 'The other bidder is in a range of $450 million to $480 million. You need to beat that.',
    why: 'Leaks a competing bid to a bidder.',
  },
];

/** Every case: the core 45, realistic ordinary mail, near-misses, risky mail and the risk repository. */
export const SCREENING_CORPUS: readonly ScreeningCase[] = [
  ...CORE_CORPUS,
  ...ORDINARY_A,
  ...ORDINARY_B,
  ...NEAR_MISS,
  ...RISKY,
  ...RISK_REPOSITORY,
];
