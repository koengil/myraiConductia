import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  enforceWorkIdentityHook,
  hasWorkIdentityHookClaim,
} from '@/lib/auth/workIdentityHook';

function token(payload: unknown): string {
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${body}.signature`;
}

const WITH_CLAIM = token({ sub: 'u1', work_identity_hook: 1 });
const WITHOUT_CLAIM = token({ sub: 'u1' });

function client(options: {
  sessionToken?: string | null;
  refreshedToken?: string | null;
  refreshThrows?: boolean;
  signOutThrows?: boolean;
}) {
  const getSession = vi.fn().mockResolvedValue({
    data: {
      session: options.sessionToken ? { access_token: options.sessionToken } : null,
    },
    error: null,
  });
  const refreshSession = options.refreshThrows
    ? vi.fn().mockRejectedValue(new Error('network'))
    : vi.fn().mockResolvedValue({
        data: {
          session: options.refreshedToken ? { access_token: options.refreshedToken } : null,
        },
        error: options.refreshedToken ? null : { message: 'refresh failed' },
      });
  const signOut = options.signOutThrows
    ? vi.fn().mockRejectedValue(new Error('network'))
    : vi.fn().mockResolvedValue({ error: null });
  return {
    supabase: { auth: { getSession, refreshSession, signOut } } as never,
    getSession,
    refreshSession,
    signOut,
  };
}

const WORK_USER = { app_metadata: { providers: ['email', 'azure'] } };
const PASSWORD_USER = { app_metadata: { providers: ['email'] } };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('hasWorkIdentityHookClaim', () => {
  it('is true when the payload carries work_identity_hook = 1', () => {
    expect(hasWorkIdentityHookClaim(WITH_CLAIM)).toBe(true);
  });

  it('is false when the claim is absent or not exactly 1', () => {
    expect(hasWorkIdentityHookClaim(WITHOUT_CLAIM)).toBe(false);
    expect(hasWorkIdentityHookClaim(token({ work_identity_hook: 0 }))).toBe(false);
    expect(hasWorkIdentityHookClaim(token({ work_identity_hook: '1' }))).toBe(false);
    expect(hasWorkIdentityHookClaim(token({ work_identity_hook: true }))).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['not a jwt', 'not-a-jwt'],
    ['two segments', 'a.b'],
    ['empty payload segment', 'a..c'],
    ['payload not base64', 'a.@@@.c'],
    ['payload not json', `a.${btoa('plain text')}.c`],
    ['payload json null', token(null)],
    ['payload json array', token([1])],
    ['payload json number', token(1)],
  ])('is false for a malformed token (%s)', (_label, value) => {
    expect(hasWorkIdentityHookClaim(value as string | undefined)).toBe(false);
  });

  it('reads a base64url payload whose length needs padding', () => {
    expect(hasWorkIdentityHookClaim(token({ work_identity_hook: 1, pad: 'a'.repeat(7) }))).toBe(
      true,
    );
  });
});

describe('enforceWorkIdentityHook', () => {
  it('passes a password user without reading the session', async () => {
    const c = client({ sessionToken: WITHOUT_CLAIM });
    await expect(enforceWorkIdentityHook(c.supabase, PASSWORD_USER)).resolves.toBe('ok');
    expect(c.getSession).not.toHaveBeenCalled();
    expect(c.refreshSession).not.toHaveBeenCalled();
    expect(c.signOut).not.toHaveBeenCalled();
  });

  it('passes a work-identity session that carries the claim with no refresh', async () => {
    const c = client({ sessionToken: WITH_CLAIM });
    await expect(enforceWorkIdentityHook(c.supabase, WORK_USER)).resolves.toBe('ok');
    expect(c.refreshSession).not.toHaveBeenCalled();
    expect(c.signOut).not.toHaveBeenCalled();
  });

  it('refreshes once when the claim is missing and passes when the refresh restores it', async () => {
    const c = client({ sessionToken: WITHOUT_CLAIM, refreshedToken: WITH_CLAIM });
    await expect(enforceWorkIdentityHook(c.supabase, WORK_USER)).resolves.toBe('ok');
    expect(c.refreshSession).toHaveBeenCalledTimes(1);
    expect(c.signOut).not.toHaveBeenCalled();
  });

  it('refuses and signs out locally when the refreshed token still lacks the claim', async () => {
    const c = client({ sessionToken: WITHOUT_CLAIM, refreshedToken: WITHOUT_CLAIM });
    await expect(enforceWorkIdentityHook(c.supabase, WORK_USER)).resolves.toBe('refused');
    expect(c.refreshSession).toHaveBeenCalledTimes(1);
    expect(c.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(console.error).toHaveBeenCalledWith('work_identity_hook_missing');
  });

  it('refuses and signs out locally when the refresh fails', async () => {
    const c = client({ sessionToken: WITHOUT_CLAIM, refreshedToken: null });
    await expect(enforceWorkIdentityHook(c.supabase, WORK_USER)).resolves.toBe('refused');
    expect(c.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('refuses when the refresh throws', async () => {
    const c = client({ sessionToken: WITHOUT_CLAIM, refreshThrows: true });
    await expect(enforceWorkIdentityHook(c.supabase, WORK_USER)).resolves.toBe('refused');
    expect(c.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('refuses a work-identity user with no session token at all', async () => {
    const c = client({ sessionToken: null, refreshedToken: null });
    await expect(enforceWorkIdentityHook(c.supabase, WORK_USER)).resolves.toBe('refused');
  });

  it('still refuses when the local sign-out throws', async () => {
    const c = client({
      sessionToken: WITHOUT_CLAIM,
      refreshedToken: WITHOUT_CLAIM,
      signOutThrows: true,
    });
    await expect(enforceWorkIdentityHook(c.supabase, WORK_USER)).resolves.toBe('refused');
  });

  it('covers any external provider, not only azure', async () => {
    const c = client({ sessionToken: WITHOUT_CLAIM, refreshedToken: WITHOUT_CLAIM });
    await expect(
      enforceWorkIdentityHook(c.supabase, { app_metadata: { providers: ['google'] } }),
    ).resolves.toBe('refused');
  });
});
