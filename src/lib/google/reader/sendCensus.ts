import { SEND_RECIPIENT, type SendRecipient } from '@/lib/constants/sendCensus';
import type { DealContacts } from '@/lib/discovery/sendCensus/types';

import { addressesOf, type GmailPolicySource } from './policyInput';

const ADDRESS_HEADERS = ['From', 'To', 'Cc', 'Bcc', 'Reply-To', 'Sender'] as const;

function isDealContact(address: string, contacts: DealContacts): boolean {
  if (contacts.addresses.has(address)) return true;
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return contacts.domains.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`));
}

export function threadRecipient(messages: readonly GmailPolicySource[], contacts: DealContacts | undefined): SendRecipient | null {
  if (!contacts) return null;
  let parsedAll = true;
  for (const meta of messages) {
    const headers = meta.payload?.headers ?? [];
    for (const name of ADDRESS_HEADERS) {
      const list = addressesOf(headers, name);
      if (list === null) {
        parsedAll = false;
        continue;
      }
      if (list.some((address) => isDealContact(address, contacts))) return SEND_RECIPIENT.DEAL_CONTACT;
    }
  }
  return parsedAll ? SEND_RECIPIENT.NON_DEAL : null;
}
