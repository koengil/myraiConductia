// Mirrors the routing_ledger.sent_recipient CHECK in the send census migration.
export const SEND_RECIPIENT = { DEAL_CONTACT: 'deal_contact', NON_DEAL: 'non_deal' } as const;
export type SendRecipient = (typeof SEND_RECIPIENT)[keyof typeof SEND_RECIPIENT];
export const SEND_RECIPIENTS = Object.values(SEND_RECIPIENT) as SendRecipient[];
export const SEND_CENSUS_WEEKS = 8;
