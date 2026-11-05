// Every number the scorer decides with, in one place, so a review reads one
// block and a change is one diff. match.ts, assign.ts, score.ts and report.ts
// import these and hold no literal of their own.
//
// FROZEN 2026-09-26 (phase 5 review), before the first real score. Change a
// value only as a reviewed diff, and never after looking at a real-tenant
// scorecard: sweep on synthetic data only. The scorecard prints the harness
// commit and TUNING_DIGEST (score.ts), and test/tuning.test.ts pins the
// digest, so a change cannot slip through unnoticed.

/** How a candidate is matched to a true deal (match.ts). */
export const MATCH_TUNING = {
  /**
   * Days added to each side of a deal's window before the candidate's
   * [firstSeenAt, lastSeenAt] must overlap it. Mail about a deal starts
   * before its formal window (pitch, NDA) and trails after it (closing
   * mechanics); 30 days admits that without joining deals months apart.
   */
  windowToleranceDays: 30,
  /**
   * Score weight of a name match: the deal's codename, its name, a codename
   * derived from its name ("Project Falcon" -> "falcon") or an alias. The
   * largest: it is the firm's own name for the deal, so it identifies it
   * almost alone.
   */
  codenameWeight: 0.6,
  /**
   * Score weight of the share of the deal's parties the candidate names (by
   * mail domain or company name). Parties recur across a firm's deals with
   * the same counterparty, so they weigh less than a codename.
   */
  partyWeight: 0.3,
  /**
   * Score weight of a known date overlap. A tie-breaker only: an unknown date
   * is not disqualifying, and many deals overlap in time.
   */
  timeWeight: 0.1,
  /**
   * The evidence gate (review item 2): a candidate qualifies for a deal only
   * when at least this share of its labeled evidence items belongs to that
   * deal. A majority: names, parties and dates only say which deal a
   * candidate may be; its evidence has to say it is. A candidate with no
   * labeled evidence qualifies for nothing.
   */
  minEvidenceShare: 0.5,
} as const;

/** When a candidate counts as a merge of two deals on its evidence (score.ts). */
export const MERGE_TUNING = {
  /**
   * Each of two deals must hold at least this share of the candidate's
   * labeled evidence. 20% keeps one stray misrouted item from calling a
   * candidate a merge.
   */
  minShare: 0.2,
  /** ... and at least this many of its labeled items, for the same reason on small candidates. */
  minItems: 2,
} as const;

/**
 * Which candidate states each metric counts (review item 12, approved by
 * Guillermo 2026-09-26).
 *
 * The rule: a metric that a rejection or a merge could improve is taken
 * pre-rejection in the verdict, and a metric that it can only worsen is taken
 * post-rejection. So the verdict's discovery precision, item precision,
 * fragmentation and merge rate count every candidate the system created and
 * every link of those candidates, whatever the state of either; no
 * correction, by a person or automatically, can move them. Discovery recall
 * stays post-rejection. The rule holds when human corrections arrive in
 * phases 7 and 8.
 *
 * The headline also shows each metric post-rejection, labeled so.
 *
 * Phase 8 rule (confirmed by Guillermo 2026-09-26): the eval always scores the
 * model's output before any correction, which is the input to
 * foldCorrections. Once corrections exist, the export supplies that output,
 * so no merge, rejection or relink, by a person or automatically, can move
 * any metric. This replaces "recall stays post-rejection" from then on.
 */
export const CANDIDATE_STATE_POLICY = {
  /** Counted by the post-rejection metrics: proposed and confirmed candidates, and their active links. */
  postRejection: ['proposed', 'confirmed'],
  /** Counted by the pre-rejection metrics: every candidate ever created, and all its links. */
  preRejection: ['proposed', 'confirmed', 'rejected', 'merged_into'],
} as const;

/**
 * The week-2 checkpoint (handoff 05): at or within every target, the demo is
 * discovery-led; outside any, it is seeded. An n/a (0/0) value fails every
 * target but discovery precision and recall, whose n/a leaves the verdict
 * undetermined only when nothing else failed. A key whose coverage is not
 * complete leaves the verdict undetermined whatever the values: its unlabeled
 * items are invisible to the evidence gate and to item precision. PROVISIONAL:
 * set by Guillermo on 2026-09-26, pending Storm's confirmation. The scorecard
 * says so.
 */
export const CHECKPOINT_TARGETS = {
  /** Discovery precision, pre-rejection, one-to-one: at least. */
  discoveryPrecision: 0.8,
  /** Discovery recall, post-rejection, one-to-one: at least. */
  discoveryRecall: 0.7,
  /** Item precision, pre-rejection: at least (review items 3 and 13). */
  itemPrecision: 0.8,
  /**
   * Item recall, post-rejection: at least (second review). Without it, one
   * correct link per deal passes every other target at 1% item recall.
   */
  itemRecall: 0.5,
  /** Fragmentation rate, pre-rejection: at most (review item 3). */
  fragmentation: 0.25,
  /** Merge rate, pre-rejection: at most (review item 3). */
  merge: 0.2,
  provisional: true,
  setBy: 'Guillermo, 2026-09-26; pending Storm',
} as const;
