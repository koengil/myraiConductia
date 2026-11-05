// Demo book fixtures (data only, no behaviour). Consumed by scripts/seed-demo-book.ts.
// Local-only demo data: fictional companies and people, never real records.
//
// Code names avoid every name another seed uses (seed-data, the mock book in
// src/lib/mock/scale.ts, the discovery corpora: Falcon, Cobra, Kestrel,
// Harbor, Osprey, Larkspur), because live code names are unique per tenant.
//
// Step references are canonical seqs on the MVP rail (src/lib/rail/dealRail.ts).
// A deal enters at `entrySeq` (earlier steps are skipped at entry, as the
// create path does), then `complete` is walked in order from the entry step,
// so the cursor lands on the step after the last one. `outOfOrder` steps are
// completed later in the rail without moving the cursor. No completed step may
// require an upload (the step route refuses those without a dataroom file);
// the runner checks this and every manual step's required fields.

import type { ScheduleStatus } from '../src/lib/constants/deals';

export type DemoSlug = 'md' | 'deal-team' | 'legal' | 'ib-director' | 'cco' | 'read-only' | 'admin';

export type DemoStepAct = {
  seq: number;
  /** Who completes it. Not the MD: the MD assigns it to them first. Default: the deal's owner. */
  by?: DemoSlug;
};

export type DemoLeadPerson = {
  name: string;
  title: string;
  email: string;
};

export type DemoLeadDef = {
  name: string;
  stakeholder: DemoLeadPerson & {
    role: 'decision-maker' | 'influencer' | 'gatekeeper' | 'blocker';
    motivation: 'max price' | 'speed' | 'legacy' | 'keep the team' | 'liquidity' | 'return hurdle';
    stance: 'Supporter' | 'Neutral' | 'Detractor';
    boardSeat: boolean;
    equityPct: number | null;
  };
  relationship: DemoLeadPerson & {
    personCompany: string;
    type: 'colleague' | 'co-investor' | 'board member' | 'prior client' | 'prior banker' | 'personal' | 'school' | 'prior deal counterparty';
    strength: 'High' | 'Medium' | 'Low';
    source: 'HubSpot' | 'M365 email-calendar' | 'PitchBook' | 'CapIQ' | 'banker asserted';
    basis: string;
  };
};

export type DemoDealDef = {
  codename: string;
  /** Seat that creates the deal and holds the MD seat. */
  ownerSlug: DemoSlug;
  lead: DemoLeadDef;
  entrySeq: number;
  complete: DemoStepAct[];
  outOfOrder?: DemoStepAct[];
  /** Assign the deal's current step (after the walk) to this seat. */
  assignCurrentTo?: DemoSlug;
  /** Extra assignments by the MD: seq -> seat. */
  assign?: Array<{ seq: number; to: DemoSlug }>;
  members: Array<{ slug: DemoSlug; dealRole: 'deal_team' | 'legal' }>;
  conflicts: { approvedBy: string; approvedOn: string };
  book: { closeDate: string; feeUsd: number; scheduleStatus: ScheduleStatus };
};

const person = (name: string, title: string, domain: string): DemoLeadPerson => ({
  name,
  title,
  email: `${name.toLowerCase().split(' ')[0]}.${name.toLowerCase().split(' ').slice(-1)[0]}@${domain}`,
});

function lead(
  name: string,
  domain: string,
  stakeholder: [string, string, DemoLeadDef['stakeholder']['motivation'], DemoLeadDef['stakeholder']['stance'], number | null],
  relationship: [string, string, string, DemoLeadDef['relationship']['type'], DemoLeadDef['relationship']['strength'], DemoLeadDef['relationship']['source'], string],
): DemoLeadDef {
  const [sName, sTitle, motivation, stance, equityPct] = stakeholder;
  const [rName, rTitle, rCompany, type, strength, source, basis] = relationship;
  return {
    name,
    stakeholder: {
      ...person(sName, sTitle, domain),
      role: 'decision-maker',
      motivation,
      stance,
      boardSeat: true,
      equityPct,
    },
    relationship: {
      ...person(rName, rTitle, `${rCompany.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`),
      personCompany: rCompany,
      type,
      strength,
      source,
      basis,
    },
  };
}

/** Storm's twelve live mandates, spread across the five phases. */
export const DEMO_DEALS: DemoDealDef[] = [
  {
    codename: 'Project Alder',
    ownerSlug: 'md',
    lead: lead(
      'Alder Health Partners', 'alderhealth.example',
      ['Renee Okafor', 'Chief Executive Officer', 'legacy', 'Supporter', 34],
      ['Tom Whitcombe', 'Operating Partner', 'Cedar Lane Capital', 'co-investor', 'High', 'banker asserted', 'Co-invested alongside Storm on the Meadowlark recap.'],
    ),
    entrySeq: 10,
    complete: [{ seq: 10 }],
    outOfOrder: [{ seq: 13, by: 'deal-team' }],
    assignCurrentTo: 'deal-team',
    members: [{ slug: 'deal-team', dealRole: 'deal_team' }],
    conflicts: { approvedBy: 'Morgan Vale', approvedOn: '2026-09-29' },
    book: { closeDate: '2027-06-30', feeUsd: 2_400_000, scheduleStatus: 'on_time' },
  },
  {
    codename: 'Project Beacon',
    ownerSlug: 'md',
    lead: lead(
      'Beacon Payroll Systems', 'beaconpayroll.example',
      ['Marcus Feld', 'Founder and CEO', 'liquidity', 'Supporter', 41],
      ['Hannah Ruiz', 'CFO', 'Beacon Payroll Systems', 'prior client', 'Medium', 'HubSpot', 'Advised on the 2023 debt refinancing.'],
    ),
    entrySeq: 12,
    complete: [{ seq: 12 }, { seq: 13, by: 'deal-team' }, { seq: 14 }],
    assignCurrentTo: 'deal-team',
    members: [
      { slug: 'deal-team', dealRole: 'deal_team' },
      { slug: 'legal', dealRole: 'legal' },
    ],
    conflicts: { approvedBy: 'Morgan Vale', approvedOn: '2026-09-15' },
    book: { closeDate: '2027-05-14', feeUsd: 3_100_000, scheduleStatus: 'ahead' },
  },
  {
    codename: 'Project Cinder',
    ownerSlug: 'md',
    lead: lead(
      'Cinder Ridge Materials', 'cinderridge.example',
      ['Paul Gutierrez', 'Chairman', 'max price', 'Neutral', 52],
      ['Elena Marsh', 'Managing Director', 'Ridgeway Partners', 'prior banker', 'Medium', 'PitchBook', 'Sat across the table on the Quarry Hill sale.'],
    ),
    entrySeq: 16,
    complete: [{ seq: 16 }, { seq: 17 }, { seq: 18 }, { seq: 19 }],
    assignCurrentTo: 'legal',
    members: [{ slug: 'legal', dealRole: 'legal' }],
    conflicts: { approvedBy: 'Morgan Vale', approvedOn: '2026-08-31' },
    book: { closeDate: '2027-07-23', feeUsd: 1_800_000, scheduleStatus: 'late' },
  },
  {
    codename: 'Project Driftwood',
    ownerSlug: 'md',
    lead: lead(
      'Driftwood Hospitality Group', 'driftwoodhg.example',
      ['Simone Achebe', 'President', 'keep the team', 'Supporter', 18],
      ['Greg Lindqvist', 'Board Director', 'Driftwood Hospitality Group', 'board member', 'High', 'banker asserted', 'Served together on the Harlow Foundation board.'],
    ),
    entrySeq: 26,
    complete: [{ seq: 26 }, { seq: 27 }],
    assignCurrentTo: 'ib-director',
    members: [
      { slug: 'deal-team', dealRole: 'deal_team' },
      { slug: 'ib-director', dealRole: 'deal_team' },
    ],
    conflicts: { approvedBy: 'Morgan Vale', approvedOn: '2026-08-12' },
    book: { closeDate: '2027-04-09', feeUsd: 2_900_000, scheduleStatus: 'on_time' },
  },
  {
    codename: 'Project Ember',
    ownerSlug: 'md',
    lead: lead(
      'Ember Analytics', 'emberanalytics.example',
      ['Jonah Pierce', 'Co-founder and CEO', 'speed', 'Supporter', 27],
      ['Priya Raman', 'General Partner', 'Northgate Ventures', 'co-investor', 'High', 'M365 email-calendar', 'Monthly breakfast since the Series B.'],
    ),
    entrySeq: 33,
    complete: [{ seq: 33 }, { seq: 34 }],
    assignCurrentTo: 'deal-team',
    members: [{ slug: 'deal-team', dealRole: 'deal_team' }],
    conflicts: { approvedBy: 'Morgan Vale', approvedOn: '2026-07-28' },
    book: { closeDate: '2027-03-12', feeUsd: 4_600_000, scheduleStatus: 'on_time' },
  },
  {
    codename: 'Project Fjord',
    ownerSlug: 'md',
    lead: lead(
      'Fjord Cold Chain', 'fjordcold.example',
      ['Ingrid Halvorsen', 'Chief Executive Officer', 'return hurdle', 'Neutral', 12],
      ['Owen Tate', 'Partner', 'Bluewater Equity', 'prior deal counterparty', 'Medium', 'CapIQ', 'Bought Polar Freight from a Storm-led process.'],
    ),
    entrySeq: 34,
    complete: [{ seq: 34 }, { seq: 35 }],
    members: [
      { slug: 'deal-team', dealRole: 'deal_team' },
      { slug: 'ib-director', dealRole: 'deal_team' },
    ],
    conflicts: { approvedBy: 'Morgan Vale', approvedOn: '2026-07-21' },
    book: { closeDate: '2027-02-26', feeUsd: 3_800_000, scheduleStatus: 'ahead' },
  },
  {
    codename: 'Project Granite',
    ownerSlug: 'md',
    lead: lead(
      'Granite Peak Software', 'granitepeak.example',
      ['Dev Malhotra', 'Founder and CEO', 'max price', 'Supporter', 46],
      ['Laura Chen', 'Head of Corporate Development', 'Summitline Systems', 'personal', 'Medium', 'banker asserted', 'Neighbors; kids at the same school.'],
    ),
    entrySeq: 39,
    complete: [{ seq: 39 }, { seq: 40, by: 'deal-team' }],
    outOfOrder: [{ seq: 43 }],
    assignCurrentTo: 'deal-team',
    members: [
      { slug: 'deal-team', dealRole: 'deal_team' },
      { slug: 'legal', dealRole: 'legal' },
    ],
    conflicts: { approvedBy: 'Morgan Vale', approvedOn: '2026-06-30' },
    book: { closeDate: '2027-01-29', feeUsd: 5_200_000, scheduleStatus: 'late' },
  },
  {
    codename: 'Project Heron',
    ownerSlug: 'md',
    lead: lead(
      'Heron Bay Foods', 'heronbay.example',
      ['Clara Benoit', 'Executive Chair', 'legacy', 'Neutral', 38],
      ['Sam Okoro', 'Senior Advisor', 'Tidal Advisors', 'colleague', 'Low', 'HubSpot', 'Former colleague at the previous firm.'],
    ),
    entrySeq: 41,
    complete: [{ seq: 41 }, { seq: 42 }],
    assignCurrentTo: 'ib-director',
    members: [{ slug: 'ib-director', dealRole: 'deal_team' }],
    conflicts: { approvedBy: 'Morgan Vale', approvedOn: '2026-06-16' },
    book: { closeDate: '2027-02-05', feeUsd: 2_200_000, scheduleStatus: 'on_time' },
  },
  {
    codename: 'Project Ironwood',
    ownerSlug: 'md',
    lead: lead(
      'Ironwood Industrial Services', 'ironwoodis.example',
      ['Frank Delgado', 'Chief Executive Officer', 'return hurdle', 'Supporter', 9],
      ['Nadia Petrov', 'Managing Partner', 'Keystone Industrial Fund', 'prior client', 'High', 'HubSpot', 'Ran the sponsor buy-side on Ironwood in 2021.'],
    ),
    entrySeq: 46,
    complete: [{ seq: 46 }],
    assignCurrentTo: 'deal-team',
    members: [
      { slug: 'deal-team', dealRole: 'deal_team' },
      { slug: 'legal', dealRole: 'legal' },
    ],
    conflicts: { approvedBy: 'Morgan Vale', approvedOn: '2026-05-26' },
    book: { closeDate: '2026-12-18', feeUsd: 6_000_000, scheduleStatus: 'ahead' },
  },
  {
    codename: 'Project Juno',
    ownerSlug: 'md',
    lead: lead(
      'Juno Pet Health', 'junopet.example',
      ['Amelia Ward', 'Founder and CEO', 'keep the team', 'Supporter', 31],
      ['Ben Adeyemi', 'Partner', 'Harbinger Growth', 'school', 'Medium', 'banker asserted', 'Business school classmates.'],
    ),
    entrySeq: 47,
    complete: [{ seq: 47 }, { seq: 48 }],
    assignCurrentTo: 'legal',
    members: [
      { slug: 'legal', dealRole: 'legal' },
      { slug: 'ib-director', dealRole: 'deal_team' },
    ],
    conflicts: { approvedBy: 'Morgan Vale', approvedOn: '2026-05-12' },
    book: { closeDate: '2026-12-04', feeUsd: 4_100_000, scheduleStatus: 'on_time' },
  },
  {
    codename: 'Project Lantern',
    ownerSlug: 'md',
    lead: lead(
      'Lantern Learning', 'lanternlearning.example',
      ['Rosa Castillo', 'Chief Executive Officer', 'speed', 'Supporter', 22],
      ['Ian Fletcher', 'Board Observer', 'Lantern Learning', 'board member', 'Medium', 'M365 email-calendar', 'Quarterly board dinners since 2024.'],
    ),
    entrySeq: 51,
    complete: [{ seq: 51 }, { seq: 52 }],
    outOfOrder: [{ seq: 56, by: 'deal-team' }],
    assignCurrentTo: 'deal-team',
    members: [{ slug: 'deal-team', dealRole: 'deal_team' }],
    conflicts: { approvedBy: 'Morgan Vale', approvedOn: '2026-04-20' },
    book: { closeDate: '2026-11-20', feeUsd: 3_400_000, scheduleStatus: 'on_time' },
  },
  {
    codename: 'Project Monarch',
    ownerSlug: 'md',
    lead: lead(
      'Monarch Fleet Telematics', 'monarchfleet.example',
      ['Victor Hale', 'Founder and Executive Chair', 'max price', 'Supporter', 58],
      ['Grace Liu', 'Chief Financial Officer', 'Monarch Fleet Telematics', 'prior client', 'High', 'HubSpot', 'Storm advised on her prior company sale.'],
    ),
    entrySeq: 55,
    complete: [{ seq: 55 }, { seq: 56 }],
    assignCurrentTo: 'deal-team',
    members: [
      { slug: 'deal-team', dealRole: 'deal_team' },
      { slug: 'legal', dealRole: 'legal' },
      { slug: 'ib-director', dealRole: 'deal_team' },
    ],
    conflicts: { approvedBy: 'Morgan Vale', approvedOn: '2026-04-06' },
    book: { closeDate: '2026-11-13', feeUsd: 7_500_000, scheduleStatus: 'ahead' },
  },
];

/**
 * Morgan Vale's mandate with Storm in a deal-team seat. Only a deal's MD can
 * assign steps, so this is the honest way Storm receives "Step assigned to
 * you": Morgan assigns him two steps.
 */
export const COLLEAGUE_DEAL: DemoDealDef = {
  codename: 'Project Sextant',
  ownerSlug: 'ib-director',
  lead: lead(
    'Sextant Marine Electronics', 'sextantmarine.example',
    ['Oliver Brandt', 'Chief Executive Officer', 'liquidity', 'Neutral', 15],
    ['Maya Sorensen', 'Partner', 'Anchor Point Capital', 'prior deal counterparty', 'Medium', 'PitchBook', 'Bid on Sextant in the 2022 minority round.'],
  ),
  entrySeq: 28,
  complete: [{ seq: 28 }],
  assign: [
    { seq: 29, to: 'md' },
    { seq: 30, to: 'md' },
  ],
  members: [
    { slug: 'md', dealRole: 'deal_team' },
    { slug: 'deal-team', dealRole: 'deal_team' },
  ],
  conflicts: { approvedBy: 'Storm Duncan', approvedOn: '2026-09-08' },
  book: { closeDate: '2027-05-28', feeUsd: 2_700_000, scheduleStatus: 'on_time' },
};

/** Leads with no mandate yet: prospects on the /leads list. */
export const PROSPECT_LEADS: DemoLeadDef[] = [
  lead(
    'Pinecrest Dental Group', 'pinecrestdental.example',
    ['Leah Morgan', 'Chief Executive Officer', 'liquidity', 'Neutral', 40],
    ['Chris Albright', 'Partner', 'Meadowbrook Health Capital', 'co-investor', 'Medium', 'banker asserted', 'Co-invested in Brightsmile in 2020.'],
  ),
  lead(
    'Tidewater Logistics', 'tidewaterlog.example',
    ['Andre Mitchell', 'President', 'speed', 'Supporter', 63],
    ['Kara Jensen', 'CFO', 'Tidewater Logistics', 'personal', 'High', 'M365 email-calendar', 'Weekly squash partner.'],
  ),
  lead(
    'Quillon Robotics', 'quillon.example',
    ['Sofia Russo', 'Co-founder and CTO', 'keep the team', 'Detractor', 19],
    ['Mark Ellison', 'Venture Partner', 'Foundry Hill', 'board member', 'Low', 'CapIQ', 'Shares the Quillon board with the lead investor.'],
  ),
];

/** Summit (SUMMIT-2026-003, from seed:users) multiplayer plan: steps spread across the three seated people (md, deal-team, ib-director). */
export const SUMMIT_CODE = 'SUMMIT-2026-003';
export const SUMMIT_BOOK = { closeDate: '2027-03-26', feeUsd: 3_600_000, scheduleStatus: 'on_time' as ScheduleStatus };
export const SUMMIT_ASSIGNMENTS: Array<{ seq: number; to: DemoSlug }> = [
  { seq: 12, to: 'deal-team' },
  { seq: 13, to: 'ib-director' },
  { seq: 14, to: 'md' },
  { seq: 15, to: 'deal-team' },
  { seq: 16, to: 'md' },
  { seq: 17, to: 'ib-director' },
];
/** Draft work saved by two different people (no completion). */
export const SUMMIT_DRAFTS: Array<{ seq: number; by: DemoSlug; work: Record<string, unknown> }> = [
  {
    seq: 12,
    by: 'deal-team',
    work: {
      nda_drafted: true,
      precedent_compared: true,
      legal_review_required: true,
    },
  },
  {
    seq: 17,
    by: 'ib-director',
    work: {
      buyer_universe_notes:
        'Tier 1: three strategics with lakehouse gaps (two hyperscalers, one analytics platform). Tier 2: four large sponsors with data infrastructure theses. Tier 3: two sovereign funds. Hold the two strategics with open litigation until conflicts clear.',
      conflicts_screened: true,
    },
  },
];
/** A later step completed out of order by its assignee. */
export const SUMMIT_OUT_OF_ORDER: DemoStepAct = { seq: 13, by: 'ib-director' };

/** Required free-text answers for the manual steps the walk completes. {target} and {codename} are filled in. */
export const STEP_TEXT: Record<string, string> = {
  meeting_notes: 'First meeting with {target} leadership. Owners want a clean process and a 2027 close.',
  pursue_pass_rationale: 'Strong fit with our sector coverage and a motivated founder.',
  swot_summary: 'Strengths: recurring revenue and a sticky customer base. Weaknesses: founder-led sales. Opportunity: strategic consolidation. Threat: rate-driven multiple compression.',
  alignment_map: 'Founder is the decision-maker; two independent directors lean toward a sponsor; the lead investor wants liquidity within twelve months.',
  buyer_universe_notes: 'Twenty-eight names ranked: nine strategics, fourteen sponsors, five family offices. Top tier has active theses in the segment.',
  selected_case_studies: 'Three comparable sell-side processes from the last two years, client consent on file for each.',
  fee_rationale: 'Success fee at 1.5 percent with a minimum, monthly retainer credited against the success fee.',
  scope_captured: 'Sell-side mandate for 100 percent of {target}; fee economics per the signed engagement letter.',
  debrief_notes: 'Won on sector depth and the buyer map. The client valued the process timeline we proposed.',
  wgl_seed: 'Client: CEO, CFO, general counsel. Bank: Storm Duncan, Alex Chen. Counsel and accountants to be confirmed.',
  milestone_targets: 'Teaser in three weeks, CIM in six, first-round bids in ten.',
  risk_register: 'Customer concentration above 20 percent in the top account; two expiring leases; open sales tax nexus question.',
  assumptions_log: 'Add-backs limited to one-time legal costs and the discontinued product line; each mapped to the general ledger.',
  wave_plan: 'Wave 1: eight strategics owned by Storm Duncan. Wave 2: twelve sponsors owned by Alex Chen. Tailored rationale per buyer in the tracker.',
  buyer_models: 'Synergy cases for the top six buyers: cost synergies on logistics, revenue synergies on cross-sell. Ranges labeled as estimates.',
  buyer_log: 'Thirty-one parties contacted, eighteen NDAs signed, six passes logged with reasons.',
  bidder_list: 'Five bidders advance to the second round; distribution logged per bidder.',
  bid_instructions: 'Final bids due in four weeks with a marked SPA, financing evidence and a diligence plan.',
  comparison_matrix: 'Bids compared on price, cash and stock mix, escrow, earnout and certainty of close. Two bids lead on certainty.',
  negotiation_points: 'Hold the escrow at 7.5 percent; trade the earnout cap for a shorter survival period.',
  exclusivity_risk: 'Thirty days of exclusivity costs the runner-up bid; the runner-up stays warm through a standstill letter.',
  signing_checklist: 'Signature pages, disclosure schedules, board consents and the funds flow memo tracked to the signing date.',
  confidentiality_limits: 'No price disclosure; the buyer may name {target} after closing only.',
  transaction_description: 'Sale of {target} to a strategic acquirer; terms not disclosed.',
  platforms_submitted: 'Submitted to the three league table providers; receipts filed.',
  approval_checklist: 'HSR filing submitted; lender consent requested; shareholder consent obtained.',
  closing_deliverables: 'Payoff letters, officer certificates and the escrow agreement tracked to the closing date.',
};

/** Preferred answers for required select fields, by field id. */
export const STEP_SELECT: Record<string, string> = {
  ai_consent: 'Consent granted',
  recommendation: 'Pursue',
  outcome: 'Won',
  qc_result: 'Pass',
};

/** Skill runs with two or more versions (Ignatious is not configured locally). */
export type DemoSkillRunDef = {
  key: string;
  /** Deal code name (resolved under its owner) or the Summit code. */
  deal: { codename: string } | { code: string };
  seq: number;
  by: DemoSlug;
  mount: { name: string; version: number };
  model: string;
  instructions: string;
  result: string;
  costUsd: number;
  revisions: Array<{
    by: DemoSlug;
    /** A passage of the parent text the comment is anchored to, and its replacement. */
    passage: string;
    replacement: string;
    comment: string;
    costUsd: number;
  }>;
};

export const DEMO_SKILL_RUNS: DemoSkillRunDef[] = [
  {
    key: 'fjord-teaser',
    deal: { codename: 'Project Fjord' },
    seq: 36,
    by: 'md',
    mount: { name: 'teaser-drafting', version: 4 },
    model: 'claude-sonnet-4-6',
    instructions: 'One-page anonymized teaser. Lead with the network, not the fleet.',
    result:
      'Project Fjord\n\nA leading temperature-controlled logistics platform in Northern Europe.\n\nThe company operates 14 cold-storage hubs and a contracted fleet serving grocery, pharma and food service customers.\n\nRevenue grew at a 19 percent annual rate over three years, with 82 percent from multi-year contracts.\n\nThe owners are exploring a sale of the business. Interested parties should contact the deal team.',
    costUsd: 0.42,
    revisions: [
      {
        by: 'deal-team',
        passage: 'Revenue grew at a 19 percent annual rate over three years, with 82 percent from multi-year contracts.',
        replacement: 'Revenue grew 19 percent a year over three years. 82 percent comes from multi-year contracts with an average tenure of six years.',
        comment: 'Split this sentence and add contract tenure; buyers will ask.',
        costUsd: 0.11,
      },
      {
        by: 'md',
        passage: 'The owners are exploring a sale of the business.',
        replacement: 'The shareholders have retained the bank to explore strategic alternatives.',
        comment: 'Softer framing. Do not say sale in the teaser.',
        costUsd: 0.09,
      },
    ],
  },
  {
    key: 'summit-swot',
    deal: { code: 'SUMMIT-2026-003' },
    seq: 15,
    by: 'deal-team',
    mount: { name: 'swot-analysis', version: 2 },
    model: 'claude-sonnet-4-6',
    instructions: 'SWOT for the board deck. Keep each quadrant to two lines.',
    result:
      'Strengths: category leader in the lakehouse market with net revenue retention above 140 percent.\n\nWeaknesses: heavy dependence on one cloud marketplace for new logos.\n\nOpportunities: AI workloads are pulling data platforms into every enterprise budget.\n\nThreats: hyperscalers bundling competing services at a discount.',
    costUsd: 0.31,
    revisions: [
      {
        by: 'md',
        passage: 'Weaknesses: heavy dependence on one cloud marketplace for new logos.',
        replacement: 'Weaknesses: one cloud marketplace sources 40 percent of new logos.',
        comment: 'Quantify it. The board will ask how heavy.',
        costUsd: 0.08,
      },
    ],
  },
];

/** Recorded AI spend beyond the skill runs: per person, across deals, back-dated. */
export type DemoSpendDef = {
  key: string;
  by: DemoSlug;
  deal?: { codename: string } | { code: string };
  lead?: string;
  source: 'screen' | 'agent_run' | 'bench_chat';
  task: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  daysAgo: number;
};

export const DEMO_SPEND: DemoSpendDef[] = [
  { key: 'beacon-bench-1', by: 'deal-team', deal: { codename: 'Project Beacon' }, source: 'bench_chat', task: 'p1-s14', model: 'claude-sonnet-4-6', inputTokens: 18_400, outputTokens: 3_100, daysAgo: 19 },
  { key: 'beacon-bench-2', by: 'deal-team', deal: { codename: 'Project Beacon' }, source: 'bench_chat', task: 'p1-s15', model: 'claude-sonnet-4-6', inputTokens: 22_900, outputTokens: 4_600, daysAgo: 12 },
  { key: 'granite-agent', by: 'deal-team', deal: { codename: 'Project Granite' }, source: 'agent_run', task: 'p3-s40', model: 'claude-opus-4-7', inputTokens: 96_000, outputTokens: 14_200, daysAgo: 9 },
  { key: 'summit-bench', by: 'ib-director', deal: { code: 'SUMMIT-2026-003' }, source: 'bench_chat', task: 'p1-s17', model: 'claude-sonnet-4-6', inputTokens: 31_500, outputTokens: 5_800, daysAgo: 6 },
  { key: 'juno-bench', by: 'ib-director', deal: { codename: 'Project Juno' }, source: 'bench_chat', task: 'p4-s48', model: 'claude-haiku-4-5', inputTokens: 12_000, outputTokens: 2_200, daysAgo: 4 },
  { key: 'cinder-bench', by: 'legal', deal: { codename: 'Project Cinder' }, source: 'bench_chat', task: 'p1-s20', model: 'claude-sonnet-4-6', inputTokens: 27_300, outputTokens: 6_900, daysAgo: 7 },
  { key: 'ironwood-bench', by: 'md', deal: { codename: 'Project Ironwood' }, source: 'bench_chat', task: 'p4-s47', model: 'claude-opus-4-7', inputTokens: 41_000, outputTokens: 7_400, daysAgo: 3 },
  { key: 'monarch-agent', by: 'md', deal: { codename: 'Project Monarch' }, source: 'agent_run', task: 'p5-s57', model: 'claude-opus-4-7', inputTokens: 72_000, outputTokens: 11_800, daysAgo: 2 },
  { key: 'ember-screen', by: 'md', deal: { codename: 'Project Ember' }, source: 'screen', task: 'mail_send_screen', model: 'claude-haiku-4-5', inputTokens: 2_400, outputTokens: 310, daysAgo: 1 },
  { key: 'tidewater-presearch', by: 'md', lead: 'Tidewater Logistics', source: 'agent_run', task: 'lead_presearch', model: 'claude-sonnet-4-6', inputTokens: 58_000, outputTokens: 9_300, daysAgo: 14 },
];

/** Outbound mail that reached supervision: one queued send, one legacy held message. */
export const HELD_MAIL = {
  key: 'demo-book-held-ember',
  deal: 'Project Ember',
  to: ['jonah.pierce@emberanalytics.example'],
  subject: 'Valuation view ahead of Thursday',
  body: 'Jonah, ahead of Thursday: our internal model floors this at $510M. Happy to walk the board through it.',
};

export const QUEUED_MAIL = {
  key: 'demo-book-queued-granite',
  deal: 'Project Granite',
  to: ['dev.malhotra@granitepeak.example'],
  subject: 'Second round timing',
  body: 'Dev, sharing the range before the call: our internal model floors this at $480M. Second round bids land in four weeks.',
};
