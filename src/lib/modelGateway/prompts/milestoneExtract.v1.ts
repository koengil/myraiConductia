// Prompt v1 for milestone extraction. Tool-less, JSON-only reply. Changing the
// system text changes PROMPT_HASH, which every recording carries; a recording
// made under another hash is stale and is re-recorded, never edited.

import { createHash } from 'node:crypto';

import { MILESTONE_TYPES } from '@/lib/discovery/milestones';

export const PROMPT_VERSION = 'v1' as const;

const DEFINITIONS = [
  'client_nda_signed: the client and the bank signed a confidentiality agreement.',
  'pitch_delivered: the bank presented its pitch for the mandate.',
  'engagement_letter_signed: the client countersigned the engagement letter.',
  'kickoff_held: the process kickoff meeting took place.',
  'vdr_opened: the virtual data room opened.',
  'teaser_drafted: the teaser was drafted.',
  'cim_drafted: the confidential information memorandum was drafted.',
  'buyer_outreach_started: outreach to prospective buyers began.',
  'buyer_nda_executed: a prospective buyer executed the non-disclosure agreement.',
  'buyer_vdr_access_granted: a buyer was given data room access.',
  'management_presentation_held: management presentations took place.',
  'process_letter_sent: the process letter went to buyers.',
  'bids_received: bids were received from buyers.',
  'exclusivity_lapsed: an exclusivity period lapsed.',
  'round_reopened: the bid round was reopened.',
  'loi_signed: a letter of intent was signed.',
  'exclusivity_granted: exclusivity was granted or its letter countersigned.',
  'spa_draft_circulated: a draft purchase agreement was circulated.',
  'disclosure_schedules_exchanged: disclosure schedules were exchanged.',
  'signed: the definitive agreement was signed.',
  'announced: the transaction was announced.',
  'regulatory_filing: a regulatory filing was made.',
  'closed: the transaction closed.',
  'process_paused: the process was put on hold.',
  'process_terminated: the process was terminated.',
];

const SYSTEM = [
  "You read one email from an investment bank's sell-side M&A process and list the deal milestones it reports as having happened.",
  'Report only events the email states happened (not plans or proposals). Use only these types: ' +
    MILESTONE_TYPES.join(', ') +
    '.',
  ...DEFINITIONS,
  'For each milestone, copy the one sentence that states it exactly as written, and give the date it happened (YYYY-MM-DD), using the sent date for "today".',
  'Return ONLY JSON: {"milestones":[{"type":"…","occurred_on":"YYYY-MM-DD","quote":"…","confidence":0.0}]}. Return {"milestones":[]} when there are none.',
].join('\n');

export const milestoneExtractV1 = {
  system: SYSTEM,
  user: (i: { subject: string; sentAt: string | null; body: string }) =>
    `Sent: ${i.sentAt ?? 'unknown'}\nSubject: ${i.subject}\n\n${i.body}`,
};

export const PROMPT_HASH = createHash('sha256').update(SYSTEM).update('\u0000user-template-v1').digest('hex');
