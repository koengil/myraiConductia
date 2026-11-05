import { beforeAll, describe, expect, it } from 'vitest';
import {
  classifyInviteDomain,
  domainMatchesVerifiedDomain,
  normalizeInviteEmail,
} from '../src/lib/api/v1/inviteDomain';
import {
  digestInviteChallengeCode,
  generateInviteChallengeCode,
  inviteChallengeDigestsEqual,
} from '../src/lib/api/v1/inviteChallenge';

beforeAll(() => {
  process.env.INVITE_VERIFICATION_PEPPER = 'focused-test-pepper';
});
describe('invite domain classification', () => {
  it('normalizes case and IDNA domains to lowercase ASCII', () => {
    expect(normalizeInviteEmail('  Person@MÜNICH.example  ')).toBe(
      'person@xn--mnich-kva.example',
    );
  });

  it('accepts exact and subdomain matches without leaking configured domains', () => {
    expect(domainMatchesVerifiedDomain('bank.example', 'bank.example')).toBe(true);
    expect(domainMatchesVerifiedDomain('emea.bank.example', 'bank.example')).toBe(true);
    expect(domainMatchesVerifiedDomain('notbank.example', 'bank.example')).toBe(false);
    expect(classifyInviteDomain('person@emea.bank.example', ['bank.example'])).toBe('match');
  });

  it('always treats consumer mail as personal and distinguishes unknown companies', () => {
    expect(classifyInviteDomain('person@gmail.com', ['gmail.com'])).toBe('personal');
    expect(classifyInviteDomain('person@company.example', [])).toBe('unverified');
    expect(classifyInviteDomain('person@other.example', ['company.example'])).toBe('mismatch');
  });
});

describe('invite verification challenges', () => {
  it('generates six digits and persists only a deterministic keyed digest', () => {
    const code = generateInviteChallengeCode();
    expect(code).toMatch(/^\d{6}$/);
    const digest = digestInviteChallengeCode(code);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain(code);
    expect(inviteChallengeDigestsEqual(digest, digestInviteChallengeCode(code))).toBe(true);
    expect(inviteChallengeDigestsEqual(digest, digestInviteChallengeCode('123456'))).toBe(
      code === '123456',
    );
  });
});
