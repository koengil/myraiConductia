import { describe, expect, it } from 'vitest';

import { SEND_RECIPIENT } from '@/lib/constants/sendCensus';
import { threadRecipient } from '@/lib/google/reader/sendCensus';

const contacts = { addresses: new Set(['person@buyer.example']), domains: ['target.example'] };
const message = (name: string, value: string) => ({ payload: { headers: [{ name, value }] } });

describe('threadRecipient', () => {
  it('matches named people in To and Bcc regardless of case', () => {
    expect(threadRecipient([message('To', 'Person@Buyer.Example')], contacts)).toBe(SEND_RECIPIENT.DEAL_CONTACT);
    expect(threadRecipient([message('Bcc', 'PERSON@BUYER.EXAMPLE')], contacts)).toBe(SEND_RECIPIENT.DEAL_CONTACT);
  });

  it('matches domains and subdomains, but not suffix lookalikes', () => {
    expect(threadRecipient([message('To', 'a@target.example')], contacts)).toBe(SEND_RECIPIENT.DEAL_CONTACT);
    expect(threadRecipient([message('Cc', 'a@division.target.example')], contacts)).toBe(SEND_RECIPIENT.DEAL_CONTACT);
    expect(threadRecipient([message('To', 'a@nottarget.example')], contacts)).toBe(SEND_RECIPIENT.NON_DEAL);
  });

  it('judges the entire thread and preserves uncertain classifications', () => {
    expect(threadRecipient([message('To', 'a@outside.example'), message('From', 'person@buyer.example')], contacts)).toBe(SEND_RECIPIENT.DEAL_CONTACT);
    expect(threadRecipient([message('Cc', 'not an address')], contacts)).toBeNull();
    expect(threadRecipient([message('Cc', 'not an address'), message('To', 'person@buyer.example')], contacts)).toBe(SEND_RECIPIENT.DEAL_CONTACT);
    expect(threadRecipient([message('To', 'person@buyer.example')], undefined)).toBeNull();
    expect(threadRecipient([], contacts)).toBe(SEND_RECIPIENT.NON_DEAL);
  });
});
