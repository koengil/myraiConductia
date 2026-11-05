import { expect, it } from 'vitest';
import { recipientBoundary } from '@/lib/mail/recipientBoundary';
it.each([
  [['a@bank.example'], ['bank.example'], 'internal'],
  [['a@dept.bank.example'], ['bank.example'], 'internal'],
  [['a@bank.example.evil.test'], ['bank.example'], 'external'],
  [['a@BANK.EXAMPLE', 'b@outside.test'], ['bank.example'], 'external'],
  [['a@bank.example'], [], 'unverified'],
  [['unfinished@'], ['bank.example'], 'unverified'],
  [['a@bücher.example'], ['xn--bcher-kva.example'], 'internal'],
  // Complete addresses the outbox accepts but whose domain we cannot parse leave the firm: external, never unverified.
  [['ceo@corp_group.com'], ['bank.example'], 'external'],
  [['a@bank.example/path'], ['bank.example'], 'external'],
  [['a@bank.example:80'], ['bank.example'], 'external'],
  [['a@bank.example#x'], ['bank.example'], 'external'],
  [['a@bank.example%2e'], ['bank.example'], 'external'],
  [['a@@bank.example'], ['bank.example'], 'unverified'],
  [['a@bank.example', 'bad'], ['bank.example'], 'unverified'],
  [['a@outside.example', 'bad'], ['bank.example'], 'external'],
  [['a@bank.example.'], ['bank.example'], 'internal'],
  [[], ['bank.example'], 'unverified'],
] as const)('classifies %j with %j', (emails, domains, expected) => {
  expect(recipientBoundary(emails, domains)).toBe(expected);
});
