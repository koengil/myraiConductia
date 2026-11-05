// The deal milestones the extractor recognizes and where each one sits on the
// rail. `MILESTONE_TYPES` mirrors the phase 3 CHECK constraint; the phase 3
// schema-sync case compares them in order.

export const MILESTONE_TYPES = [
  'client_nda_signed',
  'pitch_delivered',
  'engagement_letter_signed',
  'kickoff_held',
  'vdr_opened',
  'teaser_drafted',
  'cim_drafted',
  'buyer_outreach_started',
  'buyer_nda_executed',
  'buyer_vdr_access_granted',
  'management_presentation_held',
  'process_letter_sent',
  'bids_received',
  'exclusivity_lapsed',
  'round_reopened',
  'loi_signed',
  'exclusivity_granted',
  'spa_draft_circulated',
  'disclosure_schedules_exchanged',
  'signed',
  'announced',
  'regulatory_filing',
  'closed',
  'process_paused',
  'process_terminated',
] as const;

export type MilestoneType = (typeof MILESTONE_TYPES)[number];

/** v1 milestone → rail step id (architecture Q-mapping; verified against MVP_DEAL_RAIL). null keeps the step. */
export const MILESTONE_STATION: Record<MilestoneType, string | null> = {
  client_nda_signed: 'p1-s12',
  pitch_delivered: 'p1-s24',
  engagement_letter_signed: 'p2-s26',
  kickoff_held: 'p2-s28',
  vdr_opened: 'p2-s31',
  teaser_drafted: 'p2-s36',
  cim_drafted: 'p2-s37',
  buyer_outreach_started: 'p3-s39',
  buyer_nda_executed: 'p3-s42',
  buyer_vdr_access_granted: 'p3-s43',
  management_presentation_held: 'p3-s44',
  process_letter_sent: 'p4-s46',
  bids_received: 'p4-s47',
  exclusivity_lapsed: 'p4-s47',
  round_reopened: 'p4-s47',
  loi_signed: 'p4-s48',
  exclusivity_granted: 'p4-s48',
  spa_draft_circulated: 'p4-s49',
  disclosure_schedules_exchanged: 'p4-s50',
  signed: 'p5-s51',
  announced: 'p5-s52',
  regulatory_filing: 'p5-s56',
  closed: 'p5-s57',
  process_paused: null,
  process_terminated: null,
};

/** Events that move a deal back to a lower step when they follow the leading event. */
export const REGRESSION_TYPES: ReadonlySet<MilestoneType> = new Set<MilestoneType>([
  'exclusivity_lapsed',
  'round_reopened',
]);

/** How the reason sentence names each milestone. Sentence case, no em-dashes. */
export const MILESTONE_LABEL: Record<MilestoneType, string> = {
  client_nda_signed: 'client NDA signed',
  pitch_delivered: 'pitch delivered',
  engagement_letter_signed: 'engagement letter signed',
  kickoff_held: 'kickoff held',
  vdr_opened: 'data room opened',
  teaser_drafted: 'teaser drafted',
  cim_drafted: 'CIM drafted',
  buyer_outreach_started: 'buyer outreach started',
  buyer_nda_executed: 'buyer NDAs executed',
  buyer_vdr_access_granted: 'buyer data room access granted',
  management_presentation_held: 'management presentations held',
  process_letter_sent: 'process letter sent',
  bids_received: 'bids received',
  exclusivity_lapsed: 'exclusivity lapsed',
  round_reopened: 'bid round reopened',
  loi_signed: 'LOI signed',
  exclusivity_granted: 'exclusivity granted',
  spa_draft_circulated: 'SPA draft circulated',
  disclosure_schedules_exchanged: 'disclosure schedules exchanged',
  signed: 'signing',
  announced: 'announcement',
  regulatory_filing: 'regulatory filing',
  closed: 'closing',
  process_paused: 'process paused',
  process_terminated: 'process terminated',
};

/** Where an event came from: a model call, or the rule detector (G-07 slice 3b). Mirrors the inputs' basis column. */
export type MilestoneBasis = 'model' | 'rules';

export type MilestoneEvent = {
  id: string;
  sourceItemId: string;
  type: MilestoneType;
  /** YYYY-MM-DD */
  occurredAt: string;
  confidence: number;
  /** A rule event places a station, never a lifecycle (stage engine v2). */
  basis: MilestoneBasis;
};
