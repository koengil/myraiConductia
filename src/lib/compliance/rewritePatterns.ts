/**
 * The sixteen rewrite patterns from the Communications Risk Lexicon and
 * Pre-Send Operating Standard v1.0, §4.3 (#163 slice 3).
 *
 * The doctrine they encode: "say the true thing better — never say a false
 * thing quietly." These are the house style the AI layer's rewrite
 * suggestions draw from. Three entries have NO safe rewrite (send: null) —
 * the right advice there is do-not-send plus escalation, never a wording fix.
 *
 * Data only. The parent document is confidential and stays out of the repo;
 * this table is its operational §4.3 content, versioned with the lexicon.
 */

export type RewritePattern = {
  /** The risky phrasing ("Instead of"). */
  instead: string;
  /** The safe phrasing ("Send this") — null when there is no safe rewrite. */
  send: string | null;
};

export const REWRITE_PATTERNS: readonly RewritePattern[] = [
  {
    instead: "Let's take this offline.",
    send: "Happy to talk this through live. I'll follow up with a short written summary so we have it on file.",
  },
  {
    instead: 'Delete my last email.',
    send: 'My earlier email had an error. The corrected figure is below; please rely on this version. I am not asking you to delete anything.',
  },
  {
    instead: 'Text me on this.',
    send: "Let's keep this on email so it's properly recorded, or call me and I'll note the outcome.",
  },
  {
    instead: 'Tell them we have three other bids above their number.',
    send: "Confirm to them that the process is competitive. Do not characterise other parties' pricing beyond what we can substantiate.",
  },
  {
    instead: 'This is a guaranteed 3x.',
    send: 'The base case models a 3.0x gross MOIC on the assumptions set out on page 12. Outcomes may differ materially and the downside case is on page 14.',
  },
  {
    instead: "Don't put this in writing.",
    send: "Please treat this as confidential and don't forward it outside the deal team.",
  },
  {
    instead: 'What are you quoting on this one? (to a competitor)',
    send: null,
  },
  {
    instead: "Let's not loop in Compliance yet.",
    send: 'Looping in Compliance now so we resolve this properly the first time.',
  },
  {
    instead: 'The deal is done.',
    send: 'We have signed the LOI. Closing remains subject to confirmatory diligence, financing and regulatory approval.',
  },
  {
    instead: "Everyone knows they're going to miss the quarter.",
    send: null,
  },
  {
    instead: 'Just book it under my code.',
    send: 'Confirming who the registered person of record should be before we book this.',
  },
  {
    instead: 'Make the model support $200 million.',
    send: 'Please run a sensitivity showing which assumptions would be required to reach $200M, and flag any that sit outside the comparable range.',
  },
  {
    instead: "She isn't a culture fit.",
    send: 'State the specific, job-related, documented behaviour or performance issue and the evidence for it.',
  },
  {
    instead: 'Send me the client list at my Gmail.',
    send: null,
  },
  {
    instead: "We'll sort the disclosure out later.",
    send: 'Flagging a disclosure gap that needs to be resolved before this is distributed.',
  },
  {
    instead: 'A thumbs-up reaction to a message containing commercial terms.',
    send: 'Received, thank you. Noting this remains subject to contract and internal approval.',
  },
];
