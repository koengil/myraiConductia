import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { createServerClient } = vi.hoisted(() => ({ createServerClient: vi.fn() }));

vi.mock('@supabase/ssr', () => ({ createServerClient }));
vi.mock('@/lib/supabase/config', () => ({
  getSupabaseConfig: () => ({ url: 'https://supabase.test', publishableKey: 'public-key' }),
}));

import { config as middlewareConfig, middleware } from '@/middleware';

function tokenWith(payload: Record<string, unknown>): string {
  return `h.${btoa(JSON.stringify(payload))}.s`;
}

function authState(
  user: object | null,
  currentLevel: 'aal1' | 'aal2' = 'aal1',
  error: object | null = null,
  tokens: { session?: string; refreshed?: string | null } = {},
) {
  const getSession = vi.fn().mockResolvedValue({
    data: { session: tokens.session ? { access_token: tokens.session } : null },
  });
  const refreshSession = vi.fn().mockResolvedValue({
    data: { session: tokens.refreshed ? { access_token: tokens.refreshed } : null },
    error: tokens.refreshed ? null : { message: 'refresh failed' },
  });
  const signOut = vi.fn().mockResolvedValue({ error: null });
  createServerClient.mockReturnValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
      getSession,
      refreshSession,
      signOut,
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
          data: { currentLevel, nextLevel: 'aal2' },
          error,
        }),
      },
    },
  });
  return { getSession, refreshSession, signOut };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe('browser AAL2 middleware boundary', () => {
  it('sends an anonymous root request to sign-in, then the platform home', async () => {
    authState(null);
    const response = await middleware(new NextRequest('https://app.test/'));
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('redirectTo')).toBe('/projects');
  });

  it('sends an anonymous /about request to sign-in, then the platform home', async () => {
    authState(null);
    const response = await middleware(new NextRequest('https://app.test/about'));
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('redirectTo')).toBe('/projects');
  });

  it('sends an anonymous request to sign-in with the full safe destination', async () => {
    authState(null);
    const response = await middleware(
      new NextRequest('https://app.test/projects/rangers?tab=mail&view=compact'),
    );
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('redirectTo')).toBe(
      '/projects/rangers?tab=mail&view=compact',
    );
  });

  it('sends an AAL1 request to two-factor with the full safe destination', async () => {
    authState({ id: 'user-1' }, 'aal1');
    const response = await middleware(new NextRequest('https://app.test/projects/rangers?tab=mail'));
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/two-factor');
    expect(location.searchParams.get('redirectTo')).toBe('/projects/rangers?tab=mail');
  });

  it('passes an AAL2 request through', async () => {
    authState({ id: 'user-1' }, 'aal2');
    const response = await middleware(new NextRequest('https://app.test/projects/rangers'));
    expect(response.headers.get('location')).toBeNull();
  });

  it('fails closed to two-factor when assurance lookup fails', async () => {
    authState({ id: 'user-1' }, 'aal1', { message: 'unavailable' });
    const response = await middleware(new NextRequest('https://app.test/projects/rangers'));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/two-factor');
  });

  it('lets an existing AAL1 account through in invite-only development mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    vi.stubEnv('MFA_ENFORCEMENT', 'invite_only');
    authState({ id: 'user-1', app_metadata: {} }, 'aal1');
    const response = await middleware(new NextRequest('https://app.test/projects/rangers'));
    expect(response.headers.get('location')).toBeNull();
  });

  it('still sends an invite-created AAL1 account to two-factor', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    vi.stubEnv('MFA_ENFORCEMENT', 'invite_only');
    authState({ id: 'user-1', app_metadata: { account_origin: 'email_invite' } }, 'aal1');
    const response = await middleware(new NextRequest('https://app.test/projects/rangers'));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/two-factor');
  });
});

describe('work-identity hook claim at the middleware boundary', () => {
  const workUser = { id: 'user-1', app_metadata: { providers: ['email', 'azure'] } };
  const WITH_CLAIM = tokenWith({ work_identity_hook: 1 });
  const WITHOUT_CLAIM = tokenWith({ sub: 'user-1' });

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('passes a work-identity AAL2 session that carries the claim', async () => {
    const auth = authState(workUser, 'aal2', null, { session: WITH_CLAIM });
    const response = await middleware(new NextRequest('https://app.test/projects/rangers'));
    expect(response.headers.get('location')).toBeNull();
    expect(auth.refreshSession).not.toHaveBeenCalled();
  });

  it('refuses a work-identity session without the claim to sign-in, ahead of the AAL redirect', async () => {
    const auth = authState(workUser, 'aal1', null, {
      session: WITHOUT_CLAIM,
      refreshed: WITHOUT_CLAIM,
    });
    const response = await middleware(new NextRequest('https://app.test/projects/rangers'));
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('error')).toBe('work_identity_not_connected');
    expect(auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('refuses at AAL2 too: the claim is independent of assurance', async () => {
    authState(workUser, 'aal2', null, { session: WITHOUT_CLAIM, refreshed: null });
    const response = await middleware(new NextRequest('https://app.test/projects/rangers'));
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('error')).toBe('work_identity_not_connected');
  });

  it('continues to the AAL check when a refresh restores the claim', async () => {
    const auth = authState(workUser, 'aal1', null, {
      session: WITHOUT_CLAIM,
      refreshed: WITH_CLAIM,
    });
    const response = await middleware(new NextRequest('https://app.test/projects/rangers'));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/two-factor');
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('leaves a password user untouched', async () => {
    const auth = authState({ id: 'user-1', app_metadata: { providers: ['email'] } }, 'aal2');
    const response = await middleware(new NextRequest('https://app.test/projects/rangers'));
    expect(response.headers.get('location')).toBeNull();
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(auth.refreshSession).not.toHaveBeenCalled();
  });
});

/*
 * Audit item 2: the cookies the Supabase client writes on this request (a
 * rotated session from a refresh, the cleared one from a local sign-out) must
 * reach the browser on every redirect, not only the refusal. These drive the
 * middleware's own setAll instead of a mocked signOut.
 */
describe('cookies written during the request ride on every redirect', () => {
  const workUser = { id: 'user-1', app_metadata: { providers: ['email', 'azure'] } };
  const WITH_CLAIM = tokenWith({ work_identity_hook: 1 });
  const WITHOUT_CLAIM = tokenWith({ sub: 'user-1' });
  type CookieWrite = { name: string; value: string; options?: Record<string, unknown> };
  type CookieOptions = { cookies: { setAll(cookies: CookieWrite[]): void } };

  /** A client whose refresh and sign-out write cookies through the middleware's setAll. */
  function writingClient(options: {
    user: object | null;
    level?: 'aal1' | 'aal2';
    session?: string;
    refreshed?: string | null;
  }) {
    const calls = { refreshSession: vi.fn(), signOut: vi.fn() };
    createServerClient.mockImplementation((_url: string, _key: string, opts: CookieOptions) => ({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: options.user }, error: null }),
        getSession: vi.fn().mockResolvedValue({
          data: { session: options.session ? { access_token: options.session } : null },
        }),
        refreshSession: calls.refreshSession.mockImplementation(async () => {
          opts.cookies.setAll([{ name: 'sb-test-auth-token', value: 'rotated', options: { path: '/' } }]);
          return {
            data: { session: options.refreshed ? { access_token: options.refreshed } : null },
            error: options.refreshed ? null : { message: 'refresh failed' },
          };
        }),
        signOut: calls.signOut.mockImplementation(async () => {
          opts.cookies.setAll([{ name: 'sb-test-auth-token', value: '', options: { path: '/', maxAge: 0 } }]);
          return { error: null };
        }),
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
            data: { currentLevel: options.level ?? 'aal1', nextLevel: 'aal2' },
            error: null,
          }),
        },
      },
    }));
    return calls;
  }

  const setCookie = (response: Response) => response.headers.get('set-cookie') ?? '';

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('carries the rotated session onto the AAL1 redirect to two-factor', async () => {
    writingClient({ user: workUser, level: 'aal1', session: WITHOUT_CLAIM, refreshed: WITH_CLAIM });
    const response = await middleware(new NextRequest('https://app.test/projects/rangers'));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/two-factor');
    expect(setCookie(response)).toMatch(/sb-test-auth-token=rotated/);
  });

  it('carries the cleared session onto the refusal redirect', async () => {
    const calls = writingClient({ user: workUser, level: 'aal2', session: WITHOUT_CLAIM, refreshed: WITHOUT_CLAIM });
    const response = await middleware(new NextRequest('https://app.test/projects/rangers'));
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('work_identity_not_connected');
    expect(calls.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(setCookie(response)).toMatch(/sb-test-auth-token=;/);
    expect(setCookie(response)).toMatch(/Max-Age=0/i);
  });

  it('passes the rotated session through on an allowed request', async () => {
    writingClient({ user: workUser, level: 'aal2', session: WITHOUT_CLAIM, refreshed: WITH_CLAIM });
    const response = await middleware(new NextRequest('https://app.test/projects/rangers'));
    expect(response.headers.get('location')).toBeNull();
    expect(setCookie(response)).toMatch(/sb-test-auth-token=rotated/);
  });

  describe('/two-factor, matched for the hook check only', () => {
    it('is matched by the middleware, and /auth/work and /join are still not', () => {
      const pattern = new RegExp(`^${middlewareConfig.matcher[1]}$`);
      expect(pattern.test('/two-factor')).toBe(true);
      expect(pattern.test('/auth/work/connect')).toBe(false);
      expect(pattern.test('/join/confirm')).toBe(false);
    });

    it('refuses a work-identity session without the claim, persisting the local sign-out', async () => {
      const calls = writingClient({ user: workUser, level: 'aal1', session: WITHOUT_CLAIM, refreshed: WITHOUT_CLAIM });
      const response = await middleware(new NextRequest('https://app.test/two-factor?redirectTo=%2Fprojects'));
      const location = new URL(response.headers.get('location')!);
      expect(location.pathname).toBe('/sign-in');
      expect(location.searchParams.get('error')).toBe('work_identity_not_connected');
      expect(calls.signOut).toHaveBeenCalledWith({ scope: 'local' });
      expect(setCookie(response)).toMatch(/Max-Age=0/i);
    });

    it('lets an AAL1 session through to enrol (no redirect loop), with a refresh persisted', async () => {
      writingClient({ user: workUser, level: 'aal1', session: WITHOUT_CLAIM, refreshed: WITH_CLAIM });
      const response = await middleware(new NextRequest('https://app.test/two-factor?redirectTo=%2Fprojects'));
      expect(response.headers.get('location')).toBeNull();
      expect(setCookie(response)).toMatch(/sb-test-auth-token=rotated/);
    });

    it('leaves an anonymous visitor to the page, which sends it to sign-in itself', async () => {
      writingClient({ user: null });
      const response = await middleware(new NextRequest('https://app.test/two-factor'));
      expect(response.headers.get('location')).toBeNull();
    });
  });
});
