/**
 * Mock-at-scale fixtures (#190, Jess's Aug 17 ask): a banker's full book —
 * 10+ deals with the fields Storm's deck mockup makes first-class (stage via
 * rail entry, close date, schedule status, fee) plus per-deal mail volume.
 *
 * Consumed today by scripts/seed-mock-scale.ts (dev seeding); the Book view
 * the Book's Today's Tasks panel used to read it too, until the panel was
 * retired (Aug 31, 2026) pending the real task model.
 * Close date / fee / schedule / category have GRADUATED to real columns (#191);
 * the values here seed them (scripts/seed-mock-scale.ts). They used to become
 * columns only if the Book view graduates (recorded on #191).
 */

export type MockScheduleStatus = 'on_time' | 'ahead' | 'late';

export type MockDealDef = {
  codename: string;
  targetName: string;
  /** Rail entry seq — sets the visible stage (pre-entry steps = skipped_entry). */
  entryStepSeq: number;
  /** Live deal vs pitch — the two collapsible groups in the deck mockup. */
  category: 'live' | 'pitch';
  closeDate: string; // ISO date
  scheduleStatus: MockScheduleStatus;
  /** Whole-dollar advisory fee, deck's FEE column. */
  feeUsd: number;
  /** Outbound / inbound message volume to seed. */
  outboundCount: number;
  inboundCount: number;
};

export const MOCK_BOOK_MD_SLUG = 'book-md';

export const MOCK_DEALS: readonly MockDealDef[] = [
  { codename: 'Mesa', targetName: 'Mesa Analytics', entryStepSeq: 57, category: 'live', closeDate: '2026-10-09', scheduleStatus: 'ahead', feeUsd: 5_100_000, outboundCount: 32, inboundCount: 9 },
  { codename: 'Nova', targetName: 'Nova Grid Systems', entryStepSeq: 51, category: 'live', closeDate: '2026-11-06', scheduleStatus: 'ahead', feeUsd: 6_000_000, outboundCount: 30, inboundCount: 8 },
  { codename: 'Falcon', targetName: 'Falcon Freight', entryStepSeq: 45, category: 'live', closeDate: '2027-04-02', scheduleStatus: 'late', feeUsd: 3_500_000, outboundCount: 28, inboundCount: 8 },
  { codename: 'Cobalt', targetName: 'Cobalt Materials', entryStepSeq: 9, category: 'live', closeDate: '2027-05-21', scheduleStatus: 'on_time', feeUsd: 1_900_000, outboundCount: 24, inboundCount: 7 },
  { codename: 'Basalt', targetName: 'Basalt Energy', entryStepSeq: 39, category: 'live', closeDate: '2027-02-12', scheduleStatus: 'on_time', feeUsd: 2_800_000, outboundCount: 26, inboundCount: 6 },
  { codename: 'Juniper', targetName: 'Juniper Health', entryStepSeq: 33, category: 'live', closeDate: '2027-01-15', scheduleStatus: 'on_time', feeUsd: 4_200_000, outboundCount: 27, inboundCount: 8 },
  { codename: 'Meridian', targetName: 'Meridian Logistics', entryStepSeq: 27, category: 'live', closeDate: '2027-03-19', scheduleStatus: 'late', feeUsd: 3_100_000, outboundCount: 25, inboundCount: 7 },
  { codename: 'Caldera', targetName: 'Caldera Foods', entryStepSeq: 21, category: 'live', closeDate: '2027-06-30', scheduleStatus: 'on_time', feeUsd: 2_200_000, outboundCount: 22, inboundCount: 6 },
  // Pitches enter at the earliest step the product allows: entry is always
  // past Gate 0 (firstStepAfterGate0 = seq 8), never inside or before it.
  { codename: 'Vega', targetName: 'Vega Robotics', entryStepSeq: 12, category: 'pitch', closeDate: '2027-08-20', scheduleStatus: 'on_time', feeUsd: 4_800_000, outboundCount: 10, inboundCount: 3 },
  { codename: 'Sierra', targetName: 'Sierra Payments', entryStepSeq: 9, category: 'pitch', closeDate: '2027-09-10', scheduleStatus: 'on_time', feeUsd: 3_900_000, outboundCount: 9, inboundCount: 3 },
  { codename: 'Quartz', targetName: 'Quartz Mobility', entryStepSeq: 10, category: 'pitch', closeDate: '2027-07-24', scheduleStatus: 'on_time', feeUsd: 2_600_000, outboundCount: 8, inboundCount: 2 },
  { codename: 'Sable', targetName: 'Sable Media', entryStepSeq: 8, category: 'pitch', closeDate: '2027-10-02', scheduleStatus: 'on_time', feeUsd: 1_700_000, outboundCount: 8, inboundCount: 2 },
];

/** Deterministic pick — index-based, never Math.random, so reseeding is stable. */
export function pick<T>(list: readonly T[], index: number): T {
  return list[index % list.length];
}

export const MOCK_CONTACT_FIRST_NAMES = [
  'ana', 'leo', 'marta', 'kai', 'nora', 'raj', 'ines', 'tom', 'lena', 'omar',
] as const;

export const MOCK_SUBJECTS = [
  'Process update',
  'Data room access',
  'Management session scheduling',
  'Diligence Q&A batch',
  'NDA redline',
  'Working session follow-up',
  'Buyer list review',
  'Timeline check-in',
  'Fee letter draft',
  'Site visit logistics',
] as const;

export const MOCK_BODIES = [
  'The data room opens Monday. Access instructions follow separately.',
  'We received the latest Q&A batch and will route answers by Thursday.',
  'Management is available Tuesday or Wednesday afternoon next week.',
  'Please find the updated process timeline attached to the portal.',
  'The redline is with counsel. We expect a turn by end of week.',
  'Following up on the site visit: proposed dates are the 14th and 16th.',
  'The buyer list is ready for your review in tomorrow’s session.',
  'Confirming receipt of the signed NDA. Access will be provisioned today.',
] as const;

/** Today's Tasks fixtures for the Book home preview (#191) — the four groups
 *  from the deck mockup (slide 9), role chips included. Mock-backed on
 *  purpose: no task system exists yet; the Book view is a read-only preview
 *  judged against the Console, and these rows give it honest volume. */
export type MockTaskGroupKey =
  | 'live_deals'
  | 'pitches'
  | 'client_maintenance'
  | 'firm_activities';

export type MockTodayTask = {
  group: MockTaskGroupKey;
  /** Mock deal codename when the task belongs to one (links resolve by it). */
  dealCodename?: string;
  title: string;
  /** Owner role chip (MD / VP / SVP / ASC), as drawn on the slide. */
  role: 'MD' | 'VP' | 'SVP' | 'ASC';
};

export const MOCK_TODAY_TASKS: readonly MockTodayTask[] = [
  { group: 'live_deals', dealCodename: 'Mesa', title: 'Buyer C diligence Q&A', role: 'VP' },
  { group: 'live_deals', dealCodename: 'Mesa', title: 'Buyer B management session follow-ups', role: 'MD' },
  { group: 'live_deals', dealCodename: 'Nova', title: 'Sign off diligence responses', role: 'MD' },
  { group: 'live_deals', dealCodename: 'Basalt', title: 'LOI comparison for review', role: 'VP' },
  { group: 'pitches', dealCodename: 'Vega', title: 'Pitch next Thursday, deck at 80%', role: 'MD' },
  { group: 'pitches', dealCodename: 'Sierra', title: 'Send follow-up materials', role: 'ASC' },
  { group: 'client_maintenance', title: 'Quarterly check-in call with Meridian Logistics', role: 'MD' },
  { group: 'client_maintenance', title: 'Send the market update note', role: 'VP' },
  { group: 'client_maintenance', title: 'Reference call for a former client CFO', role: 'MD' },
  { group: 'client_maintenance', title: 'Refresh the relationship map', role: 'ASC' },
  { group: 'firm_activities', title: 'Monday pipeline review', role: 'MD' },
  { group: 'firm_activities', title: 'Compliance attestation due Friday', role: 'SVP' },
  { group: 'firm_activities', title: 'Interview with the associate candidate', role: 'VP' },
];

/** Deal Console fixtures for the Book deal view (#191 slice 2, deck slide 10):
 *  TASK | SOURCE | STATUS with the agent-vs-human assignment first-class.
 *  Mock-backed and labeled as preview, like the Today's Tasks rows.
 *
 *  Keyed by the canonical phase (1..5) so the console shows the ACTIVE
 *  phase's work — Storm's Aug 24 demo feedback: a closing-stage deal was
 *  showing diligence tasks. Each task carries done / not-done sub-items in
 *  the shape he described ("buyer outreach = agree list, find emails, send,
 *  follow up"). Keyed by phase today; the product shape is one task set per
 *  step (~81 steps), which is the next slice. */
export type MockConsoleSource = 'agent' | 'agent_vp' | 'svp' | 'md';
export type MockConsoleStatus = 'md_review' | 'vp_review' | 'in_progress' | 'completed';

export type MockConsoleSubtask = {
  title: string;
  done: boolean;
};

export type MockConsoleTask = {
  title: string;
  source: MockConsoleSource;
  status: MockConsoleStatus;
  subtasks: readonly MockConsoleSubtask[];
};

const sub = (title: string, done: boolean): MockConsoleSubtask => ({ title, done });

/** The canonical phase indices — a set per phase is a compile-time obligation,
 *  not a runtime lookup that can come back empty. */
export type ConsolePhaseIndex = 1 | 2 | 3 | 4 | 5;

export const MOCK_DEAL_CONSOLE_BY_PHASE: Readonly<
  Record<ConsolePhaseIndex, readonly MockConsoleTask[]>
> = {
  // Origination, Qualification & Mandate (steps 8–25)
  1: [
    { title: 'Engagement letter negotiation', source: 'md', status: 'in_progress', subtasks: [sub('Fee proposal agreed', true), sub('Tail terms redlined', true), sub('Exclusivity period', false), sub('Signature', false)] },
    { title: 'Pitchbook draft (v3)', source: 'agent_vp', status: 'md_review', subtasks: [sub('Positioning narrative', true), sub('Comparable transactions', true), sub('Valuation range', true), sub('Page QC', false)] },
    { title: 'Buyer universe (first cut, 60 names)', source: 'agent', status: 'vp_review', subtasks: [sub('Strategics screened', true), sub('Sponsors screened', true), sub('Fit scores', false)] },
    { title: 'Client NDA', source: 'svp', status: 'completed', subtasks: [sub('Draft sent', true), sub('Redline returned', true), sub('Executed', true)] },
    { title: 'MD briefing and company backgrounding', source: 'agent', status: 'completed', subtasks: [sub('Public filings', true), sub('Management bios', true), sub('Press and litigation scan', true)] },
  ],
  // Preparation & Market Readiness (steps 26–38)
  2: [
    { title: 'CIM and management presentation', source: 'agent_vp', status: 'md_review', subtasks: [sub('Business overview', true), sub('Financial section', true), sub('Growth plan', false), sub('Design pass', false)] },
    { title: 'Financial normalization (QoE adjustments)', source: 'agent', status: 'vp_review', subtasks: [sub('Add-backs identified', true), sub('Run-rate bridge', true), sub('Management sign-off', false)] },
    { title: 'Completing the broader data room', source: 'svp', status: 'in_progress', subtasks: [sub('Folder structure', true), sub('Contracts uploaded', true), sub('HR files', false), sub('Redactions', false)] },
    { title: 'Teaser', source: 'agent', status: 'completed', subtasks: [sub('Draft', true), sub('MD edits', true), sub('Compliance clearance', true)] },
    { title: 'Kickoff and working group list', source: 'md', status: 'completed', subtasks: [sub('Kickoff held', true), sub('WGL circulated', true)] },
  ],
  // Marketing & First-Round Bids (steps 39–45)
  3: [
    { title: 'Buyer outreach (42 parties)', source: 'md', status: 'in_progress', subtasks: [sub('List agreed', true), sub('Contacts found', true), sub('First wave sent', true), sub('Follow-ups', false)] },
    { title: 'Buyer NDAs (18 in negotiation)', source: 'agent', status: 'vp_review', subtasks: [sub('Standard form sent', true), sub('Redlines triaged', true), sub('Counsel escalations', false)] },
    { title: 'Management meeting schedule (wave 1)', source: 'agent_vp', status: 'md_review', subtasks: [sub('Slots proposed', true), sub('Buyer confirmations', false), sub('Logistics', false)] },
    { title: 'Buyer log and feedback tracker', source: 'agent', status: 'in_progress', subtasks: [sub('Calls made', true), sub('Weekly summary', false)] },
    { title: 'Buyer synergies model and valuation', source: 'svp', status: 'completed', subtasks: [sub('Synergy cases', true), sub('Valuation football field', true)] },
  ],
  // Diligence, LOI & Definitive Docs (steps 46–50)
  4: [
    { title: 'Buyer C diligence Q&A (14 responses)', source: 'agent', status: 'md_review', subtasks: [sub('Responses drafted', true), sub('Data room references checked', true), sub('MD sign-off', false)] },
    { title: 'Buyer B management session follow-ups', source: 'agent', status: 'vp_review', subtasks: [sub('Open questions listed', true), sub('Answers drafted', false)] },
    { title: 'LOI template and bid comparison sheet', source: 'agent_vp', status: 'in_progress', subtasks: [sub('Template circulated', true), sub('Bids received (3 of 5)', false), sub('Comparison grid', false)] },
    { title: 'Completing the broader data room', source: 'svp', status: 'in_progress', subtasks: [sub('Phase 2 documents', true), sub('Confirmatory requests', false)] },
    { title: 'Buyer outreach (42 parties)', source: 'md', status: 'completed', subtasks: [sub('List agreed', true), sub('Contacts found', true), sub('Sent', true), sub('Followed up', true)] },
  ],
  // Signing, Closing & Post-Close (steps 51–65)
  5: [
    { title: 'Closing checklist (31 items)', source: 'agent_vp', status: 'md_review', subtasks: [sub('Conditions precedent tracked', true), sub('Funds flow memo', true), sub('Signature pages', false), sub('Escrow instructions', false)] },
    { title: 'Regulatory approval tracker (HSR)', source: 'agent', status: 'in_progress', subtasks: [sub('Filing submitted', true), sub('Waiting period', false)] },
    { title: 'Announcement package and press release', source: 'agent', status: 'vp_review', subtasks: [sub('Press release draft', true), sub('LinkedIn post', true), sub('Email blast list', false)] },
    { title: 'Fee realization and invoice', source: 'svp', status: 'in_progress', subtasks: [sub('Fee computed', true), sub('Invoice to Finalis', false)] },
    { title: 'Signing and announcement prep', source: 'md', status: 'completed', subtasks: [sub('Board approvals', true), sub('Signing logistics', true), sub('Announcement timing', true)] },
  ],
};

/** Bodies that legitimately trip the deterministic gate — a realistic book has
 *  a few stopped messages (evidence rows), never held ones (a mock must not
 *  inflate the live CCO queue). */
export const MOCK_BLOCKED_BODY =
  'We guarantee the timeline your board asked for.';
export const MOCK_REJECTED_BODY =
  'Our internal model floors this at $510M.';
export const MOCK_REJECTED_NOTE = 'Remove the number before sending.';
