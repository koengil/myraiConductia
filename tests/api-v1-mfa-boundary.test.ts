import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createServer, createAdmin } = vi.hoisted(() => ({
  createServer: vi.fn(),
  createAdmin: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: createServer,
  createSupabaseAdminClient: createAdmin,
}));

import { requireApiUser } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';

function tokenWith(payload: Record<string, unknown>): string {
  return `h.${btoa(JSON.stringify(payload))}.s`;
}

const WITH_CLAIM = tokenWith({ work_identity_hook: 1 });
const WITHOUT_CLAIM = tokenWith({ sub: 'user-1' });

type Tokens = { session?: string; refreshed?: string | null };

function serverAt(
  currentLevel: 'aal1' | 'aal2',
  assuranceError: object | null = null,
  appMetadata: Record<string, unknown> = {},
  // A work-identity session carries the hook claim unless a test says otherwise.
  tokens: Tokens = { session: WITH_CLAIM },
) {
  const getSession = vi.fn().mockResolvedValue({
    data: { session: tokens.session ? { access_token: tokens.session } : null },
  });
  const refreshSession = vi.fn().mockResolvedValue({
    data: { session: tokens.refreshed ? { access_token: tokens.refreshed } : null },
    error: tokens.refreshed ? null : { message: 'refresh failed' },
  });
  const signOut = vi.fn().mockResolvedValue({ error: null });
  const getAuthenticatorAssuranceLevel = vi.fn().mockResolvedValue({
    data: { currentLevel, nextLevel: 'aal2' },
    error: assuranceError,
  });
  createServer.mockResolvedValue({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn().mockResolvedValue({
            data: { status: 'active', company_id: 'company-1' },
            error: null,
          }),
        })),
      })),
    })),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: 'user-1', email: 'md@example.com', app_metadata: appMetadata } },
        error: null,
      }),
      getSession,
      refreshSession,
      signOut,
      mfa: { getAuthenticatorAssuranceLevel },
    },
  });
  return { getSession, refreshSession, signOut, getAuthenticatorAssuranceLevel };
}

function adminWithStatus(status: string) {
  createAdmin.mockReturnValue({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn().mockResolvedValue({ data: { status }, error: null }),
        })),
      })),
    })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  adminWithStatus('active');
});

afterEach(() => vi.unstubAllEnvs());

describe('requireApiUser MFA boundary', () => {
  it('returns the stable MFA-required response for an AAL1 session', async () => {
    serverAt('aal1');
    const result = await requireApiUser();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    await expect(result.response.json()).resolves.toEqual({ error: 'mfa_required' });
    expect(createAdmin).not.toHaveBeenCalled();
  });

  it('allows a narrowly opted-in AAL1 request', async () => {
    serverAt('aal1');
    const result = await requireApiUser({ allowAal1: true, allowInvited: true });
    expect(result.ok).toBe(true);
  });

  it('allows an AAL2 request through the existing profile containment', async () => {
    serverAt('aal2');
    const result = await requireApiUser();
    expect(result.ok).toBe(true);
    expect(createAdmin).toHaveBeenCalledOnce();
  });

  it('fails closed when the provider cannot establish the current AAL', async () => {
    serverAt('aal1', { message: 'provider unavailable' });
    const result = await requireApiUser();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(503);
    await expect(result.response.json()).resolves.toEqual({ error: 'mfa_unavailable' });
  });

  it('exempts an existing AAL1 account in invite-only development mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    vi.stubEnv('MFA_ENFORCEMENT', 'invite_only');
    serverAt('aal1');
    const result = await requireApiUser();
    expect(result.ok).toBe(true);
  });

  it('still rejects an invite-created AAL1 account in invite-only mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    vi.stubEnv('MFA_ENFORCEMENT', 'invite_only');
    serverAt('aal1', null, { account_origin: 'email_invite' });
    const result = await requireApiUser();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
  });

  it('honors a force-AAL2 route even for an exempt existing account', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    vi.stubEnv('MFA_ENFORCEMENT', 'invite_only');
    serverAt('aal1');
    const result = await requireApiUser({ forceAal2: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
  });

  it('requires AAL2 for a work-identity account even in invite-only mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    vi.stubEnv('MFA_ENFORCEMENT', 'invite_only');
    serverAt('aal1', null, { providers: ['google'] });
    const result = await requireApiUser();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    await expect(result.response.json()).resolves.toEqual({ error: 'mfa_required' });
  });
});

describe('requireApiUser account status', () => {
  it.each([
    [{}],
    [{ allowInvited: true, allowAal1: true }],
  ])('refuses a suspended account with account_suspended (options %j)', async (options) => {
    serverAt('aal2');
    adminWithStatus('suspended');
    const result = await requireApiUser(options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    await expect(result.response.json()).resolves.toEqual({ error: 'account_suspended' });
  });

  it('contains an invited account unless the route allows it', async () => {
    serverAt('aal2');
    adminWithStatus('invited');
    const contained = await requireApiUser();
    expect(contained.ok).toBe(false);
    if (contained.ok) return;
    await expect(contained.response.json()).resolves.toEqual({ error: 'onboarding_incomplete' });
    expect((await requireApiUser({ allowInvited: true })).ok).toBe(true);
  });
});

describe('work-identity hook claim at the API boundary', () => {
  const WORK = { providers: ['email', 'azure'] };

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('passes a work-identity AAL2 session that carries the claim', async () => {
    const server = serverAt('aal2', null, WORK, { session: WITH_CLAIM });
    expect((await requireApiUser()).ok).toBe(true);
    expect(server.refreshSession).not.toHaveBeenCalled();
  });

  it.each([
    ['a default route at AAL2', {}, 'aal2'],
    ['a default route at AAL1', {}, 'aal1'],
    ['an allowAal1 route at AAL1 (invites/accept)', { allowAal1: true, allowInvited: true }, 'aal1'],
    ['a forceAal2 route', { forceAal2: true }, 'aal2'],
  ] as const)('refuses a work-identity session without the claim on %s', async (_label, options, level) => {
    const server = serverAt(level, null, WORK, { session: WITHOUT_CLAIM, refreshed: WITHOUT_CLAIM });
    const result = await requireApiUser(options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    await expect(result.response.json()).resolves.toEqual({ error: 'work_identity_not_connected' });
    expect(server.refreshSession).toHaveBeenCalledTimes(1);
    expect(server.signOut).toHaveBeenCalledWith({ scope: 'local' });
    // The refusal comes before the AAL lookup and before any profile read.
    expect(server.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
    expect(createAdmin).not.toHaveBeenCalled();
  });

  it('refuses when the refresh fails', async () => {
    const server = serverAt('aal2', null, WORK, { session: WITHOUT_CLAIM, refreshed: null });
    const result = await requireApiUser();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect(server.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('continues when one refresh restores the claim, including on an allowAal1 route', async () => {
    const server = serverAt('aal1', null, WORK, { session: WITHOUT_CLAIM, refreshed: WITH_CLAIM });
    const result = await requireApiUser({ allowAal1: true, allowInvited: true });
    expect(result.ok).toBe(true);
    expect(server.refreshSession).toHaveBeenCalledTimes(1);
    expect(server.signOut).not.toHaveBeenCalled();
  });

  it('never reads the session for a password user', async () => {
    const server = serverAt('aal2', null, { providers: ['email'] }, { session: WITHOUT_CLAIM });
    expect((await requireApiUser()).ok).toBe(true);
    expect(server.getSession).not.toHaveBeenCalled();
    expect(server.refreshSession).not.toHaveBeenCalled();
  });
});

describe('requireApiUserScoped hook claim', () => {
  const WORK = { providers: ['email', 'azure'] };

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('passes a work-identity AAL2 session that carries the claim', async () => {
    serverAt('aal2', null, WORK, { session: WITH_CLAIM });
    expect((await requireApiUserScoped()).ok).toBe(true);
  });

  it('refuses a work-identity session without the claim before the AAL lookup', async () => {
    const server = serverAt('aal1', null, WORK, { session: WITHOUT_CLAIM, refreshed: WITHOUT_CLAIM });
    const result = await requireApiUserScoped();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    await expect(result.response.json()).resolves.toEqual({ error: 'work_identity_not_connected' });
    expect(server.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(server.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
  });

  it('continues when one refresh restores the claim', async () => {
    const server = serverAt('aal2', null, WORK, { session: WITHOUT_CLAIM, refreshed: WITH_CLAIM });
    expect((await requireApiUserScoped()).ok).toBe(true);
    expect(server.refreshSession).toHaveBeenCalledTimes(1);
  });

  it('leaves a password user untouched', async () => {
    const server = serverAt('aal2', null, { providers: ['email'] }, { session: WITHOUT_CLAIM });
    expect((await requireApiUserScoped()).ok).toBe(true);
    expect(server.getSession).not.toHaveBeenCalled();
  });
});
