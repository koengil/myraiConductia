import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  emailInviteAppMetadata,
  isMfaRequiredForUser,
  isWorkIdentityUser,
  wasCreatedFromEmailInvite,
} from '@/lib/auth/mfaPolicy';

const existingUser = { app_metadata: {} };
const invitedUser = { app_metadata: emailInviteAppMetadata() };

describe('invite-only MFA policy', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('recognizes only the server-owned email-invite marker', () => {
    expect(wasCreatedFromEmailInvite(invitedUser)).toBe(true);
    expect(wasCreatedFromEmailInvite(existingUser)).toBe(false);
    expect(
      wasCreatedFromEmailInvite({
        app_metadata: {},
        user_metadata: { account_origin: 'email_invite' },
      } as never),
    ).toBe(false);
  });

  it.each(['dev', 'staging', 'prod'])('exempts existing accounts but still requires invited accounts in %s', (appEnv) => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', appEnv);
    vi.stubEnv('MFA_ENFORCEMENT', 'invite_only');
    expect(isMfaRequiredForUser(existingUser)).toBe(false);
    expect(isMfaRequiredForUser(invitedUser)).toBe(true);
  });

  it('lets invite_only take precedence over the broad development bypass', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    vi.stubEnv('MFA_ENFORCEMENT', 'invite_only');
    vi.stubEnv('DISABLE_MFA', 'true');
    expect(isMfaRequiredForUser(existingUser)).toBe(false);
    expect(isMfaRequiredForUser(invitedUser)).toBe(true);
  });

  it.each(['dev', 'staging', 'prod'])('fails safe for invalid modes in %s', (appEnv) => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', appEnv);
    vi.stubEnv('MFA_ENFORCEMENT', 'typo');
    expect(isMfaRequiredForUser(existingUser)).toBe(true);
    expect(isMfaRequiredForUser(invitedUser)).toBe(true);
  });

  it.each([
    ['google'],
    ['azure'],
  ])('always requires MFA for a %s work identity, in every mode and under the bypass', (provider) => {
    const workUser = { app_metadata: { provider, providers: ['email', provider] } };
    for (const mode of ['invite_only', 'all', 'typo', '']) {
      for (const bypass of ['true', 'false']) {
        vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
        vi.stubEnv('MFA_ENFORCEMENT', mode);
        vi.stubEnv('DISABLE_MFA', bypass);
        expect(isMfaRequiredForUser(workUser), `${mode}/${bypass}`).toBe(true);
      }
    }
  });

  it('reads work identity only from server-owned app_metadata.providers', () => {
    expect(isWorkIdentityUser({ app_metadata: { providers: ['azure'] } })).toBe(true);
    expect(isWorkIdentityUser({ app_metadata: { providers: ['email'] } })).toBe(false);
    expect(isWorkIdentityUser({ app_metadata: { providers: ['email', 'keycloak'] } })).toBe(true);
    expect(isWorkIdentityUser({ app_metadata: { providers: ['email', 'phone'] } })).toBe(false);
    expect(isWorkIdentityUser({ app_metadata: {} })).toBe(false);
    expect(
      isWorkIdentityUser({ app_metadata: {}, user_metadata: { providers: ['google'] } } as never),
    ).toBe(false);
  });
});
