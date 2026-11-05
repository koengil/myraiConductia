import type { RecipientDecision } from '@/lib/mail/recipientReview';

/**
 * Where a just-emailed address gets onto the deal. Outsiders (clients' advisers,
 * buyers) are given access from the Data Room; colleagues are added from Team.
 * When the sent-to side cannot be told from the review result, both choices are
 * offered so the sender decides.
 */
export type RecipientHandoffLink = {
  kind: 'data-room' | 'team';
  label: string;
  href: string;
};

export function recipientHandoffLinks(
  projectId: string,
  recipient: Pick<RecipientDecision, 'email' | 'boundary'>,
): RecipientHandoffLink[] {
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const dataRoom: RecipientHandoffLink = {
    kind: 'data-room',
    label: `Give ${recipient.email} data room access`,
    href: `${base}/data-room`,
  };
  const team: RecipientHandoffLink = {
    kind: 'team',
    label: `Invite ${recipient.email} to deal`,
    href: `${base}/team`,
  };
  if (recipient.boundary === 'external') return [dataRoom];
  if (recipient.boundary === 'internal') return [team];
  return [dataRoom, team];
}

/** One entry per address, in first-seen order, with the links that fit its side. */
export function recipientHandoffs(
  projectId: string,
  recipients: readonly Pick<RecipientDecision, 'email' | 'boundary'>[],
): Array<{ email: string; links: RecipientHandoffLink[] }> {
  const seen = new Set<string>();
  const out: Array<{ email: string; links: RecipientHandoffLink[] }> = [];
  for (const recipient of recipients) {
    if (seen.has(recipient.email)) continue;
    seen.add(recipient.email);
    out.push({ email: recipient.email, links: recipientHandoffLinks(projectId, recipient) });
  }
  return out;
}
