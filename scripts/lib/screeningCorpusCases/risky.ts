// Risky screening cases: mail a compliance reviewer would want stopped. All fictional.
// About a third carry no rule-layer trigger word; those exist for the AI second opinion.
import type { ScreeningCase } from '../screeningCorpus';

type Row = [kind: 'promissory' | 'mnpi', subject: string, body: string, why: string];

const ROWS: Row[] = [
  // ── Promissory, caught by the rules ───────────────────────────────────
  ['promissory', 'Project Birch: leadership', 'Priya, we guarantee you the CEO role at Northwind after closing. Just get your team behind the offer.', 'Guarantees a role to a counterparty pre-close.'],
  ['promissory', 'Re: antitrust', 'Mark, I guarantee Halden will clear antitrust review without a second request. Plan the integration on that basis.', 'Guarantees a regulatory outcome.'],
  ['promissory', 'Board composition', 'Your fund gets a guaranteed board seat at Larkspur if you sign the exclusivity letter this week.', 'Guaranteed board seat as an inducement.'],
  ['promissory', 'Earn-out terms', 'I promise the earn-out will pay in full. The milestones are a formality for this management team.', 'Promises earn-out payment.'],
  ['promissory', 'Re: your offer', 'Dana, you have my word that the seller takes your bid at 14x. Do not worry about other parties.', 'Personal word on deal acceptance.'],
  ['promissory', 'Timeline', 'We commit to closing by December 15 at the agreed price, whatever diligence turns up.', 'Commits to closing certainty and price.'],
  ['promissory', 'Management retention', 'I guarantee your management team keeps their jobs for three years after the sale.', 'Guarantees employment outcomes.'],
  ['promissory', 'Sponsor returns', 'Our deck shows a guaranteed return of 2.5x on the Orchard recap. Investors can rely on it.', 'Guaranteed return to investors.'],
  ['promissory', 'Re: headcount', 'We promise nobody on the Tern team gets let go. Tell them that on Monday.', 'Promises no layoffs.'],
  ['promissory', 'Exclusivity', 'I promise you will get exclusivity if you come in at the number we discussed.', 'Promises exclusivity for a price.'],
  ['promissory', 'Internal: Halcyon CFO', 'Can we promise Helena the CFO seat to keep her on side through signing?', 'Internal framing of promising a role.'],
  ['promissory', 'Fairness opinion', 'We guarantee the fairness opinion will support the price. Our committee has never said no.', 'Guarantees an independent opinion.'],
  ['promissory', 'Re: Project Cedar', 'Sam, you have my word that the board approves this at the next meeting. It is done.', 'Personal word on board approval.'],

  // ── Promissory, no trigger words ──────────────────────────────────────
  ['promissory', 'Re: leadership', 'You can count on getting the board seat at Larkspur. The sellers are fully on board with it.', 'Softened assurance of a board seat.'],
  ['promissory', 'Your role', 'Rest assured you will get the CEO role. Nobody else is in the frame.', 'Softened assurance of a role.'],
  ['promissory', 'Carve-out', 'I will make sure you end up with the Meridian unit at that number. Leave the rest to me.', 'Promises asset and price outcome.'],
  ['promissory', 'Re: seat', 'There is no way you do not get the seat once we close. Plan around it.', 'Implied certainty of a board seat.'],
  ['promissory', 'Project Aster', 'This deal is going to close, full stop. Sign the engagement and plan your first quarter around it.', 'Closing certainty to induce engagement.'],
  ['promissory', 'Re: round two', 'Your bid wins if you come in at 11.5x. The exclusivity is yours at that level.', 'Assures winning bid and exclusivity.'],
  ['promissory', 'Fund pitch', 'Bank on investors making 3x here. The downside simply is not there.', 'Implied return assurance.'],
  ['promissory', 'Earn-out', 'There is no risk of the earn-out not paying out. Consider it money in the bank.', 'Earn-out certainty.'],
  ['promissory', 'Retention', 'Consider the retention packages locked. Nobody on your team will be touched after signing.', 'Assurance on retention and jobs.'],

  // ── MNPI, caught by the rules ─────────────────────────────────────────
  ['mnpi', 'Project Birch: where we are', 'Our internal valuation for Northwind is well above your last indication. I would not stop where you are.', 'Reveals internal valuation view.'],
  ['mnpi', 'Re: Tern', 'Between us, their reservation price is close to what you offered. A small bump gets it done.', 'Reveals the seller reservation price.'],
  ['mnpi', 'Guidance', 'Their walk-away is about where your second bid sat. Do not go lower.', 'Reveals the seller walk-away.'],
  ['mnpi', 'FYI', 'Attached are the board minutes from the Halden session where they discussed your approach.', 'Shares confidential board minutes.'],
  ['mnpi', 'Heads up', 'The unannounced acquisition of Quill Foods closes next week. You may want to look at the sector.', 'Tips an unannounced deal.'],
  ['mnpi', 'Pricing', 'The price floor is $480M. Anything under that gets a polite no.', 'Reveals a price floor figure.'],
  ['mnpi', 'Numbers', 'The draft 10-Q shows revenue missing guidance by a wide margin. It files Friday.', 'Shares unfiled draft financials.'],
  ['mnpi', 'Re: bid', 'Our internal model shows Sparrow can afford a lot more than your last bid.', 'Reveals internal modelling.'],
  ['mnpi', 'Trade idea', 'This is material non-public, but Garnet is about to be bought. Buy before Monday.', 'Explicit tipping to trade.'],
  ['mnpi', 'Last call', 'We will not go below $510M, that is the floor. Tell your committee.', 'Floor figure disclosed.'],
  ['mnpi', 'Competing interest', 'Another bidder is at a $2.1B valuation. You are behind.', 'Discloses a competing bid value.'],
  ['mnpi', 'Re: terms', 'The deal floor is set. Our client will not move on price after Friday.', 'Reveals the deal floor posture.'],
  ['mnpi', 'Re: analysis', 'The valuation model puts the business at the top of what you have seen. Use that.', 'Shares valuation model output.'],
  ['mnpi', 'Quiet note', 'This is MNPI, so keep it close: Fennel hired advisers to run a sale.', 'Marked MNPI yet sent out.'],
  ['mnpi', 'Quarter close', 'Q3 EBITDA came in at $84M against consensus. It has not been reported.', 'Unreported results.'],
  ['mnpi', 'Re: Sumo', 'The Sumo term sheet has them at 900M with a small escrow. You can beat that.', 'Shares another bidder term sheet.'],
  ['mnpi', 'Pricing guide', 'Our client will accept a range of $300 to 350 million. Aim at the top.', 'Reveals acceptable price range.'],

  // ── MNPI, no trigger words ────────────────────────────────────────────
  ['mnpi', 'Re: competition', 'Another bidder just went to 12x. You would need to beat that to stay in.', 'Discloses a competing bid.'],
  ['mnpi', 'Monday', 'The Halvorsen board approved the sale on Tuesday. It goes out Monday morning, so load up on shares now.', 'Tip on undisclosed board action.'],
  ['mnpi', 'Process', 'Quillfeather is the other party in the process. They bid yesterday.', 'Identifies one bidder to another.'],
  ['mnpi', 'Re: Q3', 'Revenue is down 9% and weaker than the street expects. Nothing public yet.', 'Unreleased results.'],
  ['mnpi', 'Between us', 'The sellers would take 1.4 billion. I would not show anything lower.', 'Reveals acceptable price.'],
  ['mnpi', 'Re: Orchid', 'Our client meets Orchid Capital Thursday and has told them they will pay up to 15x EBITDA. Position yours.', 'Leaks another buyer figure.'],
];

export const RISKY: readonly ScreeningCase[] = ROWS.map(([kind, subject, body, why], i) => ({
  id: `risk-${String(i + 1).padStart(3, '0')}`,
  expected: 'flag',
  kind,
  subject,
  body,
  why,
}));
