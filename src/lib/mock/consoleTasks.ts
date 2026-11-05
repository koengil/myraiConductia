/**
 * Deal Console task sets PER STEP (#191 follow-up, Storm Aug 24: "each of the
 * ~81 steps carries its own task set, sub-tasks done / not done"). Keyed by
 * the MVP rail step id; every step on MVP_DEAL_RAIL has a set (the test pins
 * it). Sample data under a Preview banner — no task system exists yet; the phase
 * sets in scale.ts remain the fallback for a cursor that is off the rail.
 */

import type { MockConsoleSource, MockConsoleStatus, MockConsoleSubtask, MockConsoleTask } from './scale';

const sub = (title: string, done: boolean): MockConsoleSubtask => ({ title, done });
const task = (
  title: string,
  source: MockConsoleSource,
  status: MockConsoleStatus,
  subtasks: readonly MockConsoleSubtask[],
): MockConsoleTask => ({ title, source, status, subtasks });

export const MOCK_DEAL_CONSOLE_BY_STEP: Readonly<Record<string, readonly MockConsoleTask[]>> = {
  // ---- Gate 0 (steps 1–3 on the MVP rail)
  'p1-s7': [
    task('Codename assigned', 'md', 'completed', [sub('Theme picked', true), sub('Mask check passed', true)]),
    task('Confidential folder created', 'agent', 'completed', [sub('Folder under code name', true), sub('Access limited to deal team', true)]),
  ],
  'p1-s6': [
    task('Conflicts checklist', 'agent_vp', 'md_review', [sub('Restricted list', true), sub('Existing NDAs', true), sub('Senior partner attestation', false)]),
  ],
  'g0-notify': [
    task('Gate 0 notice to Compliance', 'agent', 'completed', [sub('Notice screened for MNPI', true), sub('Sent under code name', true)]),
  ],
  // ---- Phase 1 · Origination, Qualification & Mandate
  'p1-s8': [
    task('Decision-maker map', 'agent', 'vp_review', [sub('Board and investors identified', true), sub('Warm paths scored', true), sub('Gaps flagged', false)]),
    task('Introduction requests', 'md', 'in_progress', [sub('Two intros asked', true), sub('One confirmed', false)]),
  ],
  'p1-s9': [
    task('MD brief for the first call', 'agent', 'md_review', [sub('Call objectives', true), sub('Questions to ask', true), sub('Public backgrounding', true), sub('Risk notes', false)]),
  ],
  'p1-s10': [
    task('First meeting notes', 'agent_vp', 'md_review', [sub('Consent to AI notes recorded', true), sub('Transcript summarized', true), sub('Follow-ups extracted', false)]),
  ],
  'p1-s11': [
    task('Mandate fit score', 'agent', 'md_review', [sub('Eight dimensions scored', true), sub('Comparable outcomes', true), sub('Go / no-go memo', false)]),
    task('Pursue or pass', 'md', 'in_progress', [sub('Fee potential reviewed', true), sub('Decision recorded', false)]),
  ],
  'p1-s12': [
    task('Client NDA', 'svp', 'in_progress', [sub('House form sent', true), sub('Redline returned', true), sub('Executed', false)]),
  ],
  'p1-s13': [
    task('Initial diligence request list', 'agent', 'vp_review', [sub('Sector template applied', true), sub('Company-specific asks added', true), sub('Sent to client', false)]),
  ],
  'p1-s14': [
    task('Outreach strategy per stakeholder', 'agent', 'md_review', [sub('CEO narrative', true), sub('CFO narrative', true), sub('Board angle', false)]),
  ],
  'p1-s15': [
    task('Strategic analysis and SWOT', 'agent_vp', 'md_review', [sub('SWOT drafted', true), sub('Strategic alternatives', true), sub('Why-sell-now thesis', false)]),
  ],
  'p1-s16': [
    task('Stakeholder psychology map', 'agent', 'vp_review', [sub('Decision styles', true), sub('Anxieties and motivations', false)]),
  ],
  'p1-s17': [
    task('Buyer universe (first cut)', 'agent', 'vp_review', [sub('Strategics screened', true), sub('Sponsors screened', true), sub('Fit scores', false)]),
    task('Buyer list sign-off', 'md', 'in_progress', [sub('Top 20 reviewed', true), sub('Exclusions noted', false)]),
  ],
  'p1-s18': [
    task('Relevant case studies pulled', 'agent', 'completed', [sub('Precedent deals matched', true), sub('Tombstones assembled', true)]),
  ],
  'p1-s19': [
    task('Engagement economics', 'agent_vp', 'md_review', [sub('Fee benchmarks', true), sub('Retainer and tail scenarios', true), sub('MD proposal', false)]),
  ],
  'p1-s20': [
    task('Engagement letter strategy', 'md', 'in_progress', [sub('Fee proposal agreed', true), sub('Tail terms', false), sub('Exclusivity period', false)]),
  ],
  'p1-s21': [
    task('Pitchbook draft (v3)', 'agent_vp', 'md_review', [sub('Positioning narrative', true), sub('Comparable transactions', true), sub('Valuation range', true), sub('Page QC', false)]),
  ],
  'p1-s22': [
    task('Pitch page QC', 'agent', 'completed', [sub('Numbers tie to model', true), sub('Code names only', true), sub('Footnotes checked', true)]),
  ],
  'p1-s23': [
    task('Pitch rehearsal', 'md', 'in_progress', [sub('Dry run held', true), sub('Q&A bank reviewed', false)]),
  ],
  'p1-s24': [
    task('Pitch follow-up', 'agent', 'md_review', [sub('Thank-you note drafted', true), sub('Open questions answered', false)]),
  ],
  'p1-s25': [
    task('Engagement negotiation', 'md', 'in_progress', [sub('Fee agreed', true), sub('Tail agreed', true), sub('Signature', false)]),
    task('Engagement letter execution', 'svp', 'in_progress', [sub('Final draft to client', true), sub('Countersigned', false)]),
  ],
  // ---- Phase 2 · Preparation & Market Readiness
  'p2-s26': [
    task('Mandate activation checklist', 'agent_vp', 'md_review', [sub('Deal team seated', true), sub('Compliance notified', true), sub('Working folders live', false)]),
  ],
  'p2-s27': [
    task('Win / loss debrief', 'md', 'completed', [sub('Client feedback captured', true), sub('Lessons filed', true)]),
  ],
  'p2-s28': [
    task('Kickoff and organizational meeting', 'md', 'completed', [sub('Agenda circulated', true), sub('Kickoff held', true), sub('Actions assigned', true)]),
  ],
  'p2-s29': [
    task('Process timeline', 'agent_vp', 'md_review', [sub('Milestones drafted', true), sub('Client dates confirmed', false)]),
  ],
  'p2-s30': [
    task('Working group list', 'agent', 'completed', [sub('Counsel added', true), sub('Accountants added', true), sub('Circulated', true)]),
  ],
  'p2-s31': [
    task('VDR setup', 'svp', 'in_progress', [sub('Folder structure', true), sub('Permissions model', true), sub('Watermarking on', false)]),
  ],
  'p2-s32': [
    task('Document intake and metadata', 'agent', 'in_progress', [sub('Contracts tagged', true), sub('HR files tagged', false), sub('Redactions flagged', false)]),
  ],
  'p2-s33': [
    task('Data room diligence', 'agent_vp', 'vp_review', [sub('Gap list drafted', true), sub('Client asked for missing items', true), sub('Issues log', false)]),
  ],
  'p2-s34': [
    task('Financial normalization', 'agent', 'vp_review', [sub('Add-backs identified', true), sub('Run-rate bridge', true), sub('Management sign-off', false)]),
  ],
  'p2-s35': [
    task('Deal pulse checklist', 'agent', 'completed', [sub('Readiness scored', true), sub('Blockers listed', true)]),
  ],
  'p2-s36': [
    task('Teaser', 'agent', 'md_review', [sub('Draft', true), sub('MD edits', true), sub('Compliance clearance', false)]),
  ],
  'p2-s37': [
    task('CIM and management presentation', 'agent_vp', 'md_review', [sub('Business overview', true), sub('Financial section', true), sub('Growth plan', false), sub('Design pass', false)]),
  ],
  'p2-s38': [
    task('Anticipated buyer FAQ', 'agent', 'vp_review', [sub('Top 30 questions drafted', true), sub('Management answers', false)]),
  ],
  // ---- Phase 3 · Marketing & First-Round Bids
  'p3-s39': [
    task('Buyer outreach (42 parties)', 'md', 'in_progress', [sub('List agreed', true), sub('Contacts found', true), sub('First wave sent', true), sub('Follow-ups', false)]),
    task('Outreach sequencing', 'agent', 'completed', [sub('Waves defined', true), sub('Messaging per wave', true)]),
  ],
  'p3-s40': [
    task('Buyer synergies model and valuation', 'svp', 'completed', [sub('Synergy cases', true), sub('Valuation football field', true)]),
  ],
  'p3-s41': [
    task('Buyer log and feedback tracker', 'agent', 'in_progress', [sub('Calls recorded', true), sub('Weekly summary', false)]),
  ],
  'p3-s42': [
    task('Buyer NDAs (18 in negotiation)', 'agent', 'vp_review', [sub('Standard form sent', true), sub('Redlines triaged', true), sub('Counsel escalations', false)]),
  ],
  'p3-s43': [
    task('Buyer VDR access', 'svp', 'in_progress', [sub('Signed NDAs matched', true), sub('Access granted (11 of 18)', false)]),
  ],
  'p3-s44': [
    task('Management meeting schedule (wave 1)', 'agent_vp', 'md_review', [sub('Slots proposed', true), sub('Buyer confirmations', false), sub('Logistics', false)]),
  ],
  'p3-s45': [
    task('Buyer Q&A queue', 'agent', 'md_review', [sub('Questions triaged', true), sub('Answers drafted', true), sub('MD sign-off', false)]),
  ],
  // ---- Phase 4 · Diligence, LOI & Definitive Docs
  'p4-s46': [
    task('Process letter and LOI form', 'agent_vp', 'md_review', [sub('Process letter drafted', true), sub('LOI form attached', true), sub('Sent to advancing bidders', false)]),
  ],
  'p4-s47': [
    task('Bid comparison', 'agent', 'md_review', [sub('Bids received (3 of 5)', false), sub('Term-by-term grid', true), sub('Headline value ranked', true)]),
  ],
  'p4-s48': [
    task('LOI review and exclusivity', 'md', 'in_progress', [sub('Counsel markup', true), sub('Exclusivity terms', false), sub('Client approval', false)]),
    task('Buyer C diligence Q&A (14 responses)', 'agent', 'md_review', [sub('Responses drafted', true), sub('Data room references checked', true), sub('MD sign-off', false)]),
  ],
  'p4-s49': [
    task('Merger agreement distribution', 'svp', 'in_progress', [sub('Form agreement sent', true), sub('Buyer comments tracked', false)]),
  ],
  'p4-s50': [
    task('Definitive agreement support', 'agent', 'in_progress', [sub('Open issues list', true), sub('Disclosure schedules tracked', false)]),
  ],
  // ---- Phase 5 · Signing, Closing & Post-Close
  'p5-s51': [
    task('Signing and announcement prep', 'md', 'in_progress', [sub('Board approvals', true), sub('Signing logistics', true), sub('Announcement timing', false)]),
  ],
  'p5-s52': [
    task('Announcement', 'agent', 'vp_review', [sub('Press release draft', true), sub('Client approval', false)]),
  ],
  'p5-s53': [
    task('LinkedIn post', 'agent', 'md_review', [sub('Draft', true), sub('Compliance clearance', false)]),
  ],
  'p5-s54': [
    task('Email blast', 'agent', 'vp_review', [sub('Recipient list', true), sub('Copy drafted', true), sub('Send scheduled', false)]),
  ],
  'p5-s55': [
    task('League table submission', 'agent', 'in_progress', [sub('Deal data compiled', true), sub('Submitted', false)]),
  ],
  'p5-s56': [
    task('Regulatory approval tracker (HSR)', 'agent', 'in_progress', [sub('Filing submitted', true), sub('Waiting period', false)]),
  ],
  'p5-s57': [
    task('Closing checklist (31 items)', 'agent_vp', 'md_review', [sub('Conditions precedent tracked', true), sub('Funds flow memo', true), sub('Signature pages', false), sub('Escrow instructions', false)]),
  ],
  'p5-s58': [
    task('Fee realization and invoice', 'svp', 'in_progress', [sub('Fee computed', true), sub('Invoice to Finalis', false)]),
  ],
  'p5-s59': [
    task('Closing compliance binder', 'agent', 'in_progress', [sub('Executed documents collected', true), sub('Binder index', false)]),
  ],
  'p5-s60': [
    task('Post-close fee monitor', 'agent', 'in_progress', [sub('Payment milestones tracked', true), sub('Escrow release dates', false)]),
  ],
  'p5-s61': [
    task('Closing dinner and relationship follow-up', 'md', 'in_progress', [sub('Date proposed', true), sub('Invitations', false)]),
  ],
  'p5-s62': [
    task('Transaction marketing assets', 'agent', 'vp_review', [sub('Tombstone', true), sub('Case study draft', false)]),
  ],
  'p5-s63': [
    task('Earned / paid publication', 'agent', 'in_progress', [sub('Outlets shortlisted', true), sub('Pitch sent', false)]),
  ],
  'p5-s64': [
    task('Deal post-mortem', 'md', 'in_progress', [sub('Team debrief held', true), sub('Lessons filed', false)]),
  ],
  'p5-s65': [
    task('Tail rights and termination monitor', 'agent', 'in_progress', [sub('Tail period recorded', true), sub('Alerts set', false)]),
  ],
};
