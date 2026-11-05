export type RecipientField = 'to' | 'cc' | 'bcc';
export type RecipientRelationship = 'bank_team' | 'client' | 'client_advisor' | 'counterparty' | 'counterparty_advisor' | 'unassociated' | 'unverified';
export type RecipientEntry = {
  field: RecipientField; email: string; relationship: RecipientRelationship;
  boundary: 'internal' | 'external' | 'unverified';
  /** Issue #378: the address was on an email already sent on this deal. */
  knownToDeal?: boolean;
};
export type RecipientDecision = RecipientEntry & {
  requiresConfirmation: boolean;
  reason: 'counterparty' | 'not_on_deal' | 'relationship_unverified' | null;
};
export type RecipientLists = {to:string[];cc:string[];bcc:string[]};
export function reviewRecipients(entries: readonly RecipientEntry[]): RecipientDecision[] {
  return entries.map(entry => {
    // Issue #378 (Storm, Sep 30): an outsider already on this deal's sent mail
    // is logical for the project and needs no second approval. Only a verified
    // outsider: a colleague off the deal (the information wall) and an address
    // the firm's domains cannot place are still confirmed.
    const known = entry.knownToDeal === true && entry.boundary === 'external';
    const reason = entry.relationship === 'counterparty' || entry.relationship === 'counterparty_advisor'
      ? 'counterparty' : entry.relationship === 'unassociated' ? (known ? null : 'not_on_deal')
        : entry.relationship === 'unverified' ? 'relationship_unverified' : null;
    // D81 (Storm, Oct 5 demo) reverses D67's exemption: an outsider not on the
    // deal is confirmed in To as well as in Cc and Bcc.
    return {...entry,requiresConfirmation:reason!==null,reason};
  });
}
/** Storm's two colours (Issue #378) plus the 'internal' marker (Issue #429). */
export type RecipientMarking = 'internal' | 'external' | 'second_approval';
export function recipientMarking(recipient: RecipientDecision): RecipientMarking {
  if (recipient.requiresConfirmation) return 'second_approval';
  return recipient.boundary === 'internal' ? 'internal' : 'external';
}
/** An approved outsider new to the deal is a known recipient once the email is sent (Issue #378). */
export function becomesKnownRecipient(recipient: RecipientDecision): boolean {
  return recipient.requiresConfirmation && recipient.reason === 'not_on_deal' && recipient.boundary === 'external';
}
export const RELATIONSHIP_LABELS: Record<RecipientRelationship,string> = {
  bank_team:'Bank deal team',client:'Client',client_advisor:'Client advisor',
  counterparty:'Counterparty',counterparty_advisor:'Counterparty advisor',
  unassociated:'Not associated with this deal',unverified:'Relationship needs review',
};
