/** Mirrors deal_recipient_affiliations.affiliation CHECK. Access roles are separate. */
export const RECIPIENT_AFFILIATIONS = ['client', 'client_advisor', 'counterparty', 'counterparty_advisor'] as const;
export type RecipientAffiliation = (typeof RECIPIENT_AFFILIATIONS)[number];
export type AffiliationInput = {
  email: string; companyId: string; affiliation: RecipientAffiliation;
  representedCompanyId: string | null; userId: string | null; inviteId: string | null;
  expectedRevision: number | null;
};
