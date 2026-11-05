import type { DoubleTable } from './modelReplyDouble';

// The test double's answers. Each quote is a sentence the corpus test below
// asserts is in the body, so the parser's span check is real, not assumed.
export const DEMO_REPLY_TABLE: DoubleTable = {
  '<kestrel-002@northwind-robotics.example>': [
    { type: 'engagement_letter_signed', occurred_on: '2026-05-06', quote: 'The engagement letter was countersigned on 6 May 2026.' },
  ],
  '<kestrel-003@bank.example>': [
    { type: 'kickoff_held', occurred_on: '2026-05-14', quote: 'The Project Kestrel kickoff meeting was held on 14 May 2026 with the Northwind board and the deal team.' },
  ],
  '<kestrel-004@bank.example>': [
    { type: 'vdr_opened', occurred_on: '2026-05-28', quote: 'The virtual data room for Project Kestrel opened on 28 May 2026.' },
  ],
  '<kestrel-005@bank.example>': [
    { type: 'teaser_drafted', occurred_on: '2026-06-09', quote: 'The Project Kestrel teaser was drafted on 9 June 2026 and is ready for your review.' },
  ],
  '<kestrel-006@bank.example>': [
    { type: 'cim_drafted', occurred_on: '2026-06-23', quote: 'The confidential information memorandum for Project Kestrel was drafted on 23 June 2026.' },
  ],
  '<kestrel-007@bank.example>': [
    { type: 'buyer_outreach_started', occurred_on: '2026-07-01', quote: 'Buyer outreach for Project Kestrel started on 1 July 2026.' },
  ],
  '<kestrel-008@aldermoor.example>': [
    { type: 'buyer_nda_executed', occurred_on: '2026-07-10', quote: 'Aldermoor executed the non-disclosure agreement for Project Kestrel on 10 July 2026.' },
  ],
  '<kestrel-009@castellan.example>': [
    { type: 'buyer_nda_executed', occurred_on: '2026-07-14', quote: 'Castellan executed the non-disclosure agreement for Project Kestrel on 14 July 2026.' },
  ],
  '<kestrel-010@bank.example>': [
    { type: 'management_presentation_held', occurred_on: '2026-07-29', quote: 'The management presentations for Project Kestrel were held on 29 July 2026.' },
  ],
  '<kestrel-011@bank.example>': [
    { type: 'process_letter_sent', occurred_on: '2026-08-12', quote: 'The process letter for Project Kestrel was sent on 12 August 2026.' },
  ],
  '<kestrel-012@bank.example>': [
    { type: 'bids_received', occurred_on: '2026-08-28', quote: 'Final bids for Project Kestrel were received on 28 August 2026 from Aldermoor and Castellan.' },
  ],
  '<kestrel-013@bank.example>': [
    { type: 'loi_signed', occurred_on: '2026-09-18', quote: 'The letter of intent for Project Kestrel was signed on 18 September 2026.' },
  ],
  '<kestrel-014@aldermoor.example>': [
    { type: 'loi_signed', occurred_on: '2026-09-18', quote: 'Aldermoor confirms the letter of intent was signed on 18 September 2026.' },
  ],
  '<kestrel-015@bank.example>': [
    { type: 'loi_signed', occurred_on: '2026-09-18', quote: 'The LOI for Project Kestrel was signed today, 18 September 2026.' },
  ],
  '<kestrel-017@bank.example>': [
    { type: 'spa_draft_circulated', occurred_on: '2026-10-26', quote: 'The first draft of the SPA for Project Kestrel was circulated on 26 October 2026.' },
  ],
  '<kestrel-018@aldermoor.example>': [
    { type: 'signed', occurred_on: '2026-10-28', quote: 'The SPA for Project Kestrel was signed on 28 October 2026.' },
  ],
  '<harbor-003@northwind-robotics.example>': [
    { type: 'exclusivity_granted', occurred_on: '2026-09-17', quote: 'The Northwind board countersigned the exclusivity letter for Project Harbor on 17 September 2026.' },
  ],
  '<osprey-001@bank.example>': [
    { type: 'engagement_letter_signed', occurred_on: '2025-01-13', quote: 'The engagement letter for Project Osprey was countersigned on 13 January 2025.' },
  ],
  '<osprey-002@bank.example>': [
    { type: 'vdr_opened', occurred_on: '2025-02-04', quote: 'The data room for Project Osprey opened on 4 February 2025.' },
  ],
  '<osprey-003@meridian-care.example>': [
    { type: 'buyer_nda_executed', occurred_on: '2025-03-05', quote: 'Meridian executed the non-disclosure agreement for Project Osprey on 5 March 2025.' },
  ],
  '<osprey-004@bank.example>': [
    { type: 'loi_signed', occurred_on: '2025-04-15', quote: 'The letter of intent for Project Osprey was signed on 15 April 2025.' },
  ],
  '<osprey-005@bank.example>': [
    { type: 'signed', occurred_on: '2025-05-30', quote: 'The purchase agreement for Project Osprey was signed on 30 May 2025.' },
  ],
  '<osprey-006@bank.example>': [
    { type: 'announced', occurred_on: '2025-06-17', quote: 'Project Osprey was announced to the market on 17 June 2025.' },
  ],
  '<osprey-007@bank.example>': [
    { type: 'closed', occurred_on: '2025-07-15', quote: 'Project Osprey closed on 15 July 2025.' },
  ],
};
