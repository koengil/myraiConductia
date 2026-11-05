import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringToBase64URL } from '@supabase/ssr';

const mocks = vi.hoisted(() => ({
  flagOn: true,
  serverClient: null as unknown,
  adminClient: null as unknown,
  requireApiUser: vi.fn(),
}));

vi.mock('@/lib/api/v1/requireFlag', async () => {
  const { NextResponse } = await import('next/server');
  return {
    isFlagEnabled: vi.fn(async () => mocks.flagOn),
    requireFlag: vi.fn(async () =>
      mocks.flagOn ? null : NextResponse.json({ error: 'Not found' }, { status: 404 }),
    ),
  };
});
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(async () => mocks.serverClient),
  createSupabaseAdminClient: vi.fn(() => mocks.adminClient),
}));
vi.mock('@/lib/supabase/config', () => ({
  getSupabaseConfig: () => ({
    url: 'https://abcd.supabase.co',
    publishableKey: 'pk',
    environment: 'dev',
  }),
}));
vi.mock('@/lib/api/v1/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: mocks.requireApiUser,
}));

import { GET as startGET } from '@/app/auth/work/start/route';
import { GET as signinGET } from '@/app/auth/work/signin/route';
import { GET as callbackGET } from '@/app/auth/work/callback/route';
import { GET as connectGET } from '@/app/auth/work/connect/route';
import { GET as connectCallbackGET } from '@/app/auth/work/connect/callback/route';
import { GET as contextGET } from '@/app/api/v1/work-identity/context/route';
import { POST as acceptPOST } from '@/app/api/v1/work-identity/accept/route';
import { brokerProvider } from '@/app/auth/work/_shared';
import { digest, encodeAttemptCookie } from '@/lib/auth/workIdentity';
import { TOS_VERSION } from '@/lib/constants/legal';

const INVITE = '11111111-1111-4111-8111-111111111111';
const NONCE = '22222222-2222-4222-8222-222222222222';
const ATTEMPT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const SECRET = 'a'.repeat(43);
const ATTEMPT_COOKIE_VALUE = encodeAttemptCookie(ATTEMPT, SECRET);
const VERIFIER_COOKIE = 'sb-abcd-auth-token-code-verifier';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const PROVIDER_URL = `https://provider.test/authorize?code_challenge=${CHALLENGE}&code_challenge_method=s256`;

function request(path: string, cookies: Record<string, string> = {}, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  if (cookieHeader) headers.set('cookie', cookieHeader);
  return new NextRequest(new URL(path, 'http://localhost:3000'), { method: init?.method, body: init?.body, headers });
}

function location(response: Response) {
  const value = response.headers.get('location');
  return value ? new URL(value, 'http://localhost:3000') : null;
}

type RpcResult = { data: unknown; error: { message: string } | null };
type RpcFn = (...args: unknown[]) => Promise<RpcResult>;

const SESSION = '5c1e4b2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d';
function tokenWith(claims: Record<string, unknown>) {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
}
// The hook stamps work_identity_hook = 1 into every token it issues.
const ACCESS_TOKEN = tokenWith({ session_id: SESSION, work_identity_hook: 1 });
const TOKEN_WITHOUT_CLAIM = tokenWith({ session_id: SESSION });

function exchange(user: Record<string, unknown> | null, accessToken: string = ACCESS_TOKEN) {
  return vi.fn(async () => ({ data: { user, session: { access_token: accessToken } }, error: null }));
}

/** Service-role rpc: has_unbound answers `unbound` (false by default), anything else `results[name]`. */
function adminRpc(results: Record<string, RpcResult> = {}, unbound: RpcResult = { data: false, error: null }) {
  return vi.fn<RpcFn>(async (name) => {
    if (typeof name === 'string' && name in results) return results[name];
    if (name === 'work_identity_has_unbound') return unbound;
    return { data: null, error: null };
  });
}

function serverClient(overrides: Record<string, unknown> = {}) {
  const auth = {
    signInWithOAuth: vi.fn(async () => ({ data: { url: PROVIDER_URL }, error: null })),
    linkIdentity: vi.fn(async () => ({ data: { url: 'https://provider.test/link' }, error: null })),
    exchangeCodeForSession: exchange({ id: USER, email: 'a@bank.com' }),
    signOut: vi.fn(async () => ({ error: null })),
    getUser: vi.fn(async () => ({ data: { user: { id: USER } }, error: null })),
    mfa: {
      getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: { currentLevel: 'aal2' }, error: null })),
    },
    ...((overrides.auth as object) ?? {}),
  };
  return {
    rpc: vi.fn<RpcFn>(async () => ({ data: null, error: null })),
    from: vi.fn(),
    ...overrides,
    auth,
  };
}

function profileAdmin(profile: Record<string, unknown> | null) {
  return {
    rpc: adminRpc(),
    from: vi.fn(() => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }),
    })),
  };
}

beforeEach(() => {
  mocks.flagOn = true;
  mocks.serverClient = serverClient();
  mocks.adminClient = profileAdmin(null);
  mocks.requireApiUser.mockReset();
  delete process.env.WORK_IDENTITY_TEST_BROKER_PROVIDER;
});

describe('work-identity routes with the flag off', () => {
  it('every route answers 404', async () => {
    mocks.flagOn = false;
    const responses = await Promise.all([
      startGET(request(`/auth/work/start?invite=${INVITE}&k=${NONCE}`)),
      signinGET(request('/auth/work/signin?provider=google')),
      callbackGET(request('/auth/work/callback?code=abc')),
      connectGET(request('/auth/work/connect?provider=google')),
      connectCallbackGET(request('/auth/work/connect/callback?code=abc')),
      contextGET(request('/api/v1/work-identity/context')),
      acceptPOST(request('/api/v1/work-identity/accept', {}, { method: 'POST', body: '{}' })),
    ]);
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
  });
});

describe('/auth/work/start', () => {
  it('records an attempt, sets the httpOnly attempt cookie and redirects to the provider with hd', async () => {
    const admin = {
      rpc: vi.fn(async () => ({
        data: { attempt_id: ATTEMPT, provider: 'google', organization_id: 'bank.com', email: 'a@bank.com' },
        error: null,
      })),
    };
    mocks.adminClient = admin;
    const res = await startGET(request(`/auth/work/start?invite=${INVITE}&k=${NONCE}`));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(PROVIDER_URL);

    const call = admin.rpc.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(call[0]).toBe('start_work_identity_attempt');
    expect(call[1]).toMatchObject({ p_invite_id: INVITE, p_nonce: NONCE });
    expect(call[1].p_secret_digest).toMatch(/^[0-9a-f]{64}$/);
    // F14: the attempt is bound to this flow's PKCE challenge before the redirect.
    expect(admin.rpc.mock.calls[1]).toEqual([
      'bind_work_identity_attempt_flow',
      { p_attempt_id: ATTEMPT, p_secret_digest: call[1].p_secret_digest, p_code_challenge: CHALLENGE },
    ]);

    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^cw_attempt=33333333-3333-4333-8333-333333333333\./);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Max-Age=900/);

    const client = mocks.serverClient as ReturnType<typeof serverClient>;
    expect(client.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: 'http://localhost:3000/auth/work/callback',
        scopes: 'openid email profile',
        queryParams: { prompt: 'select_account', hd: 'bank.com' },
        skipBrowserRedirect: true,
      },
    });
  });

  it('starts an azure invitation without the Google hd hint, even with a tenant as the organization', async () => {
    mocks.adminClient = {
      rpc: vi.fn(async () => ({
        data: {
          attempt_id: ATTEMPT,
          provider: 'azure',
          organization_id: '9a3b1c2d-0000-4000-8000-000000000001',
          email: 'a@bank.com',
        },
        error: null,
      })),
    };
    const res = await startGET(request(`/auth/work/start?invite=${INVITE}&k=${NONCE}`));
    expect(res.status).toBe(303);
    const client = mocks.serverClient as ReturnType<typeof serverClient>;
    expect(client.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'azure',
      options: {
        redirectTo: 'http://localhost:3000/auth/work/callback',
        scopes: 'openid email profile',
        queryParams: { prompt: 'select_account' },
        skipBrowserRedirect: true,
      },
    });
  });

  it('refuses to redirect when the provider URL carries no PKCE challenge to bind', async () => {
    mocks.adminClient = {
      rpc: vi.fn(async () => ({ data: { attempt_id: ATTEMPT, provider: 'google', organization_id: 'bank.com' }, error: null })),
    };
    mocks.serverClient = serverClient({
      auth: { signInWithOAuth: vi.fn(async () => ({ data: { url: 'https://provider.test/authorize' }, error: null })) },
    });
    const res = await startGET(request(`/auth/work/start?invite=${INVITE}&k=${NONCE}`));
    expect(location(res)?.pathname).toBe('/join');
    expect(location(res)?.searchParams.get('error')).toBe('provider_failed');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('maps a superseded invitation back to /join', async () => {
    mocks.adminClient = { rpc: vi.fn(async () => ({ data: null, error: { message: 'credential_mismatch' } })) };
    const res = await startGET(request(`/auth/work/start?invite=${INVITE}&k=${NONCE}`));
    const to = location(res);
    expect(to?.pathname).toBe('/join');
    expect(to?.searchParams.get('error')).toBe('invite_superseded');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a malformed link without touching the database', async () => {
    const admin = { rpc: vi.fn() };
    mocks.adminClient = admin;
    const res = await startGET(request('/auth/work/start?invite=nope&k=nope'));
    expect(location(res)?.searchParams.get('error')).toBe('attempt_expired');
    expect(admin.rpc).not.toHaveBeenCalled();
  });
});

describe('/auth/work/signin', () => {
  it('starts OAuth without an attempt, carrying the destination, and drops any attempt cookie', async () => {
    const res = await signinGET(
      request('/auth/work/signin?provider=azure&redirectTo=%2Fprojects%2FD-1', { cw_attempt: ATTEMPT_COOKIE_VALUE }),
    );
    expect(res.status).toBe(303);
    const client = mocks.serverClient as ReturnType<typeof serverClient>;
    expect(client.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'azure',
      options: expect.objectContaining({
        redirectTo: 'http://localhost:3000/auth/work/callback?next=%2Fprojects%2FD-1',
        queryParams: { prompt: 'select_account' },
      }),
    });
    expect(res.headers.get('set-cookie')).toMatch(/cw_attempt=;/);
  });

  it('rejects an unknown provider', async () => {
    const res = await signinGET(request('/auth/work/signin?provider=github'));
    expect(location(res)?.pathname).toBe('/sign-in');
    expect(location(res)?.searchParams.get('error')).toBe('provider_failed');
  });

  it('uses the keycloak test broker only against a loopback Supabase stack', () => {
    const env = { WORK_IDENTITY_TEST_BROKER_PROVIDER: 'keycloak' } as unknown as NodeJS.ProcessEnv;
    expect(brokerProvider('azure', { ...env, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' })).toBe('keycloak');
    expect(brokerProvider('google', { ...env, NEXT_PUBLIC_SUPABASE_URL: 'https://abcd.supabase.co' })).toBe('google');
    expect(brokerProvider('google', { ...env, NEXT_PUBLIC_SUPABASE_URL: undefined })).toBe('google');
    expect(brokerProvider('google', { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' } as unknown as NodeJS.ProcessEnv)).toBe('google');
  });
});

describe('/auth/work/callback', () => {
  it('claims the attempt and sends the invitee to MFA enrolment bound for /join/confirm', async () => {
    const res = await callbackGET(
      request('/auth/work/callback?code=abc', {
        cw_attempt: ATTEMPT_COOKIE_VALUE,
        [VERIFIER_COOKIE]: `base64-${stringToBase64URL(JSON.stringify('flow-verifier'))}`,
      }),
    );
    const client = mocks.serverClient as ReturnType<typeof serverClient>;
    expect(client.auth.exchangeCodeForSession).toHaveBeenCalledWith('abc');
    // F14: the service role claims for the session this exchange minted, with
    // this flow's PKCE verifier read before the exchange; never the caller.
    expect(client.rpc).not.toHaveBeenCalled();
    expect((mocks.adminClient as ReturnType<typeof profileAdmin>).rpc).toHaveBeenCalledWith('claim_work_identity_attempt', {
      p_attempt_id: ATTEMPT,
      p_secret_digest: digest(SECRET),
      p_code_verifier: 'flow-verifier',
      p_user_id: USER,
      p_session_id: SESSION,
    });
    expect(location(res)?.pathname).toBe('/two-factor');
    expect(location(res)?.searchParams.get('redirectTo')).toBe('/join/confirm');
  });

  it('signs out and returns to /join when the claim is refused', async () => {
    const client = serverClient();
    mocks.serverClient = client;
    const admin = profileAdmin(null);
    admin.rpc = adminRpc({ claim_work_identity_attempt: { data: null, error: { message: 'attempt_consumed' } } });
    mocks.adminClient = admin;
    const res = await callbackGET(request('/auth/work/callback?code=abc', { cw_attempt: ATTEMPT_COOKIE_VALUE }));
    expect(client.auth.signOut).toHaveBeenCalled();
    expect(location(res)?.pathname).toBe('/join');
    expect(location(res)?.searchParams.get('error')).toBe('attempt_consumed');
    expect(res.headers.get('set-cookie')).toMatch(/cw_attempt=;/);
  });

  it('turns a "not connected" hook refusal on the invitation path into the existing-account recovery', async () => {
    const client = serverClient({
      auth: {
        exchangeCodeForSession: vi.fn(async () => ({ data: {}, error: { message: 'work_identity_not_connected' } })),
      },
    });
    mocks.serverClient = client;
    const res = await callbackGET(request('/auth/work/callback?code=abc', { cw_attempt: ATTEMPT_COOKIE_VALUE }));
    expect(location(res)?.searchParams.get('error')).toBe('existing_account');
  });

  it('maps a provider refusal on the sign-in path to /sign-in', async () => {
    const res = await callbackGET(request('/auth/work/callback?error=access_denied&error_description=account_suspended'));
    expect(location(res)?.pathname).toBe('/sign-in');
    expect(location(res)?.searchParams.get('error')).toBe('account_suspended');
  });

  it('maps a canceled consent to consent_canceled', async () => {
    const res = await callbackGET(request('/auth/work/callback?error=access_denied', { cw_attempt: ATTEMPT_COOKIE_VALUE }));
    expect(location(res)?.pathname).toBe('/join');
    expect(location(res)?.searchParams.get('error')).toBe('consent_canceled');
  });

  it('signs out a pending isolated profile that arrives without an attempt', async () => {
    mocks.adminClient = profileAdmin({ status: 'invited', company_id: null, tenant_id: USER });
    const res = await callbackGET(request('/auth/work/callback?code=abc'));
    const client = mocks.serverClient as ReturnType<typeof serverClient>;
    expect(client.auth.signOut).toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
    expect(location(res)?.pathname).toBe('/sign-in');
    expect(location(res)?.searchParams.get('error')).toBe('no_invitation');
  });

  it('sends an activated banker to the MFA gate with their destination', async () => {
    mocks.adminClient = profileAdmin({ status: 'active', company_id: 'c1', tenant_id: 't1' });
    const res = await callbackGET(request('/auth/work/callback?code=abc&next=%2Fprojects%2FD-9'));
    const client = mocks.serverClient as ReturnType<typeof serverClient>;
    expect(client.auth.signOut).not.toHaveBeenCalled();
    expect(location(res)?.pathname).toBe('/two-factor');
    expect(location(res)?.searchParams.get('redirectTo')).toBe('/projects/D-9');
    // Bound and active: the unbound check asked about this user and found nothing.
    expect((mocks.adminClient as ReturnType<typeof profileAdmin>).rpc).toHaveBeenCalledWith(
      'work_identity_has_unbound',
      { p_user: USER },
    );
  });

  describe('fail-closed checks (#316)', () => {
    const ACTIVE = { status: 'active', company_id: 'c1', tenant_id: 't1' };
    const PENDING = { status: 'invited', company_id: null, tenant_id: USER };

    function signedOutLocally(client: ReturnType<typeof serverClient>) {
      expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    }

    function claimCalls(admin: ReturnType<typeof profileAdmin>) {
      return admin.rpc.mock.calls.filter(([name]) => name === 'claim_work_identity_attempt');
    }

    let logged: { mock: { calls: unknown[][] }; mockRestore: () => void };
    beforeEach(() => {
      logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      logged.mockRestore();
    });

    it.each([
      ['without an attempt', {}, '/sign-in', 'provider_failed'],
      ['with an attempt', { cw_attempt: ATTEMPT_COOKIE_VALUE }, '/join', 'provider_failed'],
    ])('refuses a session with no email %s', async (_label, cookies, page, error) => {
      const client = serverClient({ auth: { exchangeCodeForSession: exchange({ id: USER }) } });
      mocks.serverClient = client;
      const admin = profileAdmin(ACTIVE);
      mocks.adminClient = admin;
      const res = await callbackGET(request('/auth/work/callback?code=abc', cookies));
      signedOutLocally(client);
      expect(location(res)?.pathname).toBe(page);
      expect(location(res)?.searchParams.get('error')).toBe(error);
      expect(admin.from).not.toHaveBeenCalled();
      expect(claimCalls(admin)).toHaveLength(0);
    });

    it('refuses a session whose token lacks the hook claim, logging the code only', async () => {
      const client = serverClient({
        auth: { exchangeCodeForSession: exchange({ id: USER, email: 'a@bank.com' }, TOKEN_WITHOUT_CLAIM) },
      });
      mocks.serverClient = client;
      const admin = profileAdmin(ACTIVE);
      mocks.adminClient = admin;
      const res = await callbackGET(request('/auth/work/callback?code=abc'));
      signedOutLocally(client);
      expect(location(res)?.pathname).toBe('/sign-in');
      expect(location(res)?.searchParams.get('error')).toBe('work_identity_not_connected');
      expect(admin.from).not.toHaveBeenCalled();
      expect(logged.mock.calls).toEqual([['work_identity_hook_missing']]);
    });

    it('treats a missing session as no claim', async () => {
      const client = serverClient({
        auth: {
          exchangeCodeForSession: vi.fn(async () => ({ data: { user: { id: USER, email: 'a@bank.com' } }, error: null })),
        },
      });
      mocks.serverClient = client;
      const res = await callbackGET(request('/auth/work/callback?code=abc'));
      signedOutLocally(client);
      expect(location(res)?.searchParams.get('error')).toBe('work_identity_not_connected');
    });

    it('on the invitation path, a missing claim reads as the existing-account recovery and drops the attempt', async () => {
      const client = serverClient({
        auth: { exchangeCodeForSession: exchange({ id: USER, email: 'a@bank.com' }, TOKEN_WITHOUT_CLAIM) },
      });
      mocks.serverClient = client;
      const admin = profileAdmin(PENDING);
      mocks.adminClient = admin;
      const res = await callbackGET(request('/auth/work/callback?code=abc', { cw_attempt: ATTEMPT_COOKIE_VALUE }));
      expect(location(res)?.pathname).toBe('/join');
      expect(location(res)?.searchParams.get('error')).toBe('existing_account');
      expect(res.headers.get('set-cookie')).toMatch(/cw_attempt=;/);
      expect(claimCalls(admin)).toHaveLength(0);
    });

    it('refuses an active user with an unbound identity, logging the code only', async () => {
      const client = serverClient();
      mocks.serverClient = client;
      const admin = profileAdmin(ACTIVE);
      admin.rpc = adminRpc({}, { data: true, error: null });
      mocks.adminClient = admin;
      const res = await callbackGET(request('/auth/work/callback?code=abc&next=%2Fprojects%2FD-9'));
      signedOutLocally(client);
      expect(location(res)?.pathname).toBe('/sign-in');
      expect(location(res)?.searchParams.get('error')).toBe('work_identity_not_connected');
      expect(admin.rpc).toHaveBeenCalledWith('work_identity_has_unbound', { p_user: USER });
      expect(logged.mock.calls).toEqual([['work_identity_unbound_session']]);
    });

    it('refuses an active user with an unbound identity on the invitation path as existing_account, without claiming', async () => {
      const client = serverClient();
      mocks.serverClient = client;
      const admin = profileAdmin(ACTIVE);
      admin.rpc = adminRpc({}, { data: true, error: null });
      mocks.adminClient = admin;
      const res = await callbackGET(request('/auth/work/callback?code=abc', { cw_attempt: ATTEMPT_COOKIE_VALUE }));
      signedOutLocally(client);
      expect(location(res)?.pathname).toBe('/join');
      expect(location(res)?.searchParams.get('error')).toBe('existing_account');
      expect(res.headers.get('set-cookie')).toMatch(/cw_attempt=;/);
      expect(claimCalls(admin)).toHaveLength(0);
    });

    it('lets a pending invitee with an attempt through to the claim although the identity is unbound', async () => {
      const client = serverClient();
      mocks.serverClient = client;
      const admin = profileAdmin(PENDING);
      admin.rpc = adminRpc({}, { data: true, error: null });
      mocks.adminClient = admin;
      const res = await callbackGET(request('/auth/work/callback?code=abc', { cw_attempt: ATTEMPT_COOKIE_VALUE }));
      expect(client.auth.signOut).not.toHaveBeenCalled();
      expect(claimCalls(admin)).toHaveLength(1);
      expect(location(res)?.pathname).toBe('/two-factor');
      expect(location(res)?.searchParams.get('redirectTo')).toBe('/join/confirm');
    });

    it.each([
      ['an error', adminRpc({}, { data: null, error: { message: 'permission denied' } })],
      [
        'a throw',
        vi.fn<RpcFn>(async (name) => {
          if (name === 'work_identity_has_unbound') throw new Error('network');
          return { data: null, error: null };
        }),
      ],
      ['an empty answer', adminRpc({}, { data: null, error: null })],
    ])('fails closed when the unbound check returns %s', async (_label, rpc) => {
      const client = serverClient();
      mocks.serverClient = client;
      const admin = profileAdmin(ACTIVE);
      admin.rpc = rpc;
      mocks.adminClient = admin;
      const res = await callbackGET(request('/auth/work/callback?code=abc'));
      signedOutLocally(client);
      expect(location(res)?.pathname).toBe('/sign-in');
      expect(location(res)?.searchParams.get('error')).toBe('work_identity_not_connected');
    });

    it('reads the profile before the claim and fails the sign-in when the read fails', async () => {
      const client = serverClient();
      mocks.serverClient = client;
      const admin = profileAdmin(null);
      (admin as { from: unknown }).from = vi.fn(() => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) }) }),
      }));
      mocks.adminClient = admin;
      const res = await callbackGET(request('/auth/work/callback?code=abc', { cw_attempt: ATTEMPT_COOKIE_VALUE }));
      expect(client.auth.signOut).toHaveBeenCalled();
      expect(location(res)?.searchParams.get('error')).toBe('provider_failed');
      expect(claimCalls(admin)).toHaveLength(0);
    });
  });
});

describe('/auth/work/connect', () => {
  it('sends an aal1 session through MFA first', async () => {
    const client = serverClient({
      auth: {
        mfa: { getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: { currentLevel: 'aal1' } })) },
      },
    });
    mocks.serverClient = client;
    const res = await connectGET(request('/auth/work/connect?provider=google&redirectTo=%2Fprojects'));
    expect(location(res)?.pathname).toBe('/two-factor');
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('clears an unread success cookie when the connect start fails', async () => {
    const res = await connectGET(request('/auth/work/connect?provider=nope&redirectTo=%2Fprofile'));
    expect(location(res)?.searchParams.get('error')).toBeTruthy();
    expect(res.cookies.get('cw_connected')?.value).toBe('');
  });

  it('begins the intent, sets the connect cookie and links the identity', async () => {
    const res = await connectGET(request('/auth/work/connect?provider=google&redirectTo=%2Fprojects'));
    const client = mocks.serverClient as ReturnType<typeof serverClient>;
    const call = client.rpc.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(call[0]).toBe('begin_work_identity_connect');
    expect(call[1].p_provider).toBe('google');
    expect(client.auth.linkIdentity).toHaveBeenCalled();
    expect(res.headers.get('location')).toBe('https://provider.test/link');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^cw_connect=[A-Za-z0-9_-]+;/);
    expect(cookie).toMatch(/HttpOnly/i);
  });
});

/*
 * Audit item 1: the middleware does not run on /auth/work, so both connect
 * routes check the hook claim themselves before any RPC. A work-identity
 * session (here a Google user connecting Microsoft) whose token lacks the
 * claim gets one refresh, then a local sign-out and a refusal.
 */
describe('/auth/work/connect hook claim', () => {
  const verifierCookie = `base64-${stringToBase64URL(JSON.stringify('the-verifier'))}`;
  const claimToken = (claim: boolean) =>
    `h.${Buffer.from(JSON.stringify(claim ? { sub: USER, work_identity_hook: 1 } : { sub: USER })).toString('base64url')}.s`;

  function workClient(claim: boolean) {
    const refreshSession = vi.fn(async () => ({ data: { session: { access_token: claimToken(claim) } }, error: null }));
    const client = serverClient({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: USER, app_metadata: { providers: ['email', 'google'] } } },
          error: null,
        })),
        getSession: vi.fn(async () => ({ data: { session: { access_token: claimToken(claim) } } })),
        refreshSession,
      },
    });
    client.rpc = vi.fn<RpcFn>(async () => ({ data: { connected: true, provider: 'azure' }, error: null }));
    mocks.serverClient = client;
    return Object.assign(client, { refreshSession });
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('start: refuses a claimless work-identity session before the AAL check and the RPC', async () => {
    const client = workClient(false);
    const res = await connectGET(request('/auth/work/connect?provider=azure&redirectTo=%2Fprofile'));
    expect(location(res)?.pathname).toBe('/profile');
    expect(location(res)?.searchParams.get('error')).toBe('work_identity_not_connected');
    expect(client.refreshSession).toHaveBeenCalledTimes(1);
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(client.auth.mfa.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.auth.linkIdentity).not.toHaveBeenCalled();
  });

  it('start: lets a work-identity session that carries the claim begin the connect', async () => {
    const client = workClient(true);
    await connectGET(request('/auth/work/connect?provider=azure&redirectTo=%2Fprofile'));
    expect(client.refreshSession).not.toHaveBeenCalled();
    expect(client.rpc.mock.calls[0]?.[0]).toBe('begin_work_identity_connect');
  });

  it('callback: refuses a claimless work-identity session before complete_work_identity_connect', async () => {
    const client = workClient(false);
    const res = await connectCallbackGET(
      request('/auth/work/connect/callback?code=xyz&next=%2Fprofile', {
        cw_connect: SECRET,
        [VERIFIER_COOKIE]: verifierCookie,
      }),
    );
    expect(location(res)?.searchParams.get('error')).toBe('work_identity_not_connected');
    expect(location(res)?.searchParams.get('connected')).toBeNull();
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(res.cookies.get('cw_connected')?.value).toBe('');
  });

  it('callback: completes the connect for a session that carries the claim', async () => {
    const client = workClient(true);
    const res = await connectCallbackGET(
      request('/auth/work/connect/callback?code=xyz&next=%2Fprojects', {
        cw_connect: SECRET,
        [VERIFIER_COOKIE]: verifierCookie,
      }),
    );
    expect(client.rpc).toHaveBeenCalledWith('complete_work_identity_connect', expect.anything());
    expect(location(res)?.searchParams.get('connected')).toBe('1');
  });
});

describe('/auth/work/connect/callback', () => {
  const verifierCookie = `base64-${stringToBase64URL(JSON.stringify('the-verifier'))}`;

  it('completes the connection with the code and PKCE verifier, without exchanging', async () => {
    (mocks.serverClient as ReturnType<typeof serverClient>).rpc = vi.fn<RpcFn>(async () => ({
      data: { connected: true, provider: 'google' },
      error: null,
    }));
    const res = await connectCallbackGET(
      request('/auth/work/connect/callback?code=xyz&next=%2Fprojects', {
        cw_connect: SECRET,
        [VERIFIER_COOKIE]: verifierCookie,
      }),
    );
    const client = mocks.serverClient as ReturnType<typeof serverClient>;
    expect(client.auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledWith('complete_work_identity_connect', {
      p_secret_digest: digest(SECRET),
      p_auth_code: 'xyz',
      p_code_verifier: 'the-verifier',
    });
    expect(location(res)?.searchParams.get('connected')).toBe('1');
    // Only a /profile return carries the success proof; elsewhere it is cleared.
    expect(res.cookies.get('cw_connected')?.value).toBe('');
  });

  it('sets the readable one-shot success cookie only for a /profile return', async () => {
    (mocks.serverClient as ReturnType<typeof serverClient>).rpc = vi.fn<RpcFn>(async () => ({
      data: { connected: true, provider: 'google' },
      error: null,
    }));
    const res = await connectCallbackGET(
      request('/auth/work/connect/callback?code=xyz&next=%2Fprofile', {
        cw_connect: SECRET,
        [VERIFIER_COOKIE]: verifierCookie,
      }),
    );
    expect(res.cookies.get('cw_connected')).toMatchObject({ value: '1', maxAge: 60, httpOnly: false });
  });

  it('treats an in-band connected:false refusal as a failure', async () => {
    (mocks.serverClient as ReturnType<typeof serverClient>).rpc = vi.fn<RpcFn>(async () => ({
      data: { connected: false, error: 'work_identity_ambiguous' },
      error: null,
    }));
    const res = await connectCallbackGET(
      request('/auth/work/connect/callback?code=xyz', {
        cw_connect: SECRET,
        [VERIFIER_COOKIE]: verifierCookie,
      }),
    );
    expect(location(res)?.searchParams.get('connected')).toBeNull();
    expect(location(res)?.searchParams.get('error')).toBeTruthy();
    // A failure clears any unread success proof.
    expect(res.cookies.get('cw_connected')?.value).toBe('');
  });

  it('maps a provider refusal for an identity linked elsewhere to wrong_account', async () => {
    const res = await connectCallbackGET(
      request(
        '/auth/work/connect/callback?error=server_error&error_code=identity_already_exists&error_description=Identity+is+already+linked+to+another+user',
        { cw_connect: SECRET, [VERIFIER_COOKIE]: verifierCookie },
      ),
    );
    expect(location(res)?.searchParams.get('error')).toBe('wrong_account');
  });

  it('maps a provider refusal for the already-linked own identity to already_connected', async () => {
    const admin = profileAdmin(null);
    admin.rpc = vi.fn<RpcFn>(async () => ({ data: 'work_identity_already_connected', error: null }));
    mocks.adminClient = admin;
    const res = await connectCallbackGET(
      request(
        '/auth/work/connect/callback?error=server_error&error_code=identity_already_exists&error_description=Identity+is+already+linked',
        { cw_connect: SECRET, [VERIFIER_COOKIE]: verifierCookie },
      ),
    );
    expect(location(res)?.searchParams.get('error')).toBe('work_identity_already_connected');
  });

  it.each([
    ['work_identity_ambiguous', 'identity_ambiguous'],
    ['work_identity_link_stale', 'work_identity_link_stale'],
    ['identity_provider_not_configured', 'provider_not_configured'],
  ])('reports an already-linked refusal the SQL rule calls %s as %s', async (refusal, expected) => {
    const admin = profileAdmin(null);
    admin.rpc = vi.fn<RpcFn>(async () => ({ data: refusal, error: null }));
    mocks.adminClient = admin;
    const res = await connectCallbackGET(
      request(
        '/auth/work/connect/callback?error=server_error&error_code=identity_already_exists&error_description=Identity+is+already+linked',
        { cw_connect: SECRET, [VERIFIER_COOKIE]: verifierCookie },
      ),
    );
    expect(admin.rpc).toHaveBeenCalledWith('work_identity_link_refusal', { p_user: USER });
    expect(location(res)?.searchParams.get('error')).toBe(expected);
  });

  it('sets the success cookie for a /profile/ return with a trailing slash', async () => {
    (mocks.serverClient as ReturnType<typeof serverClient>).rpc = vi.fn<RpcFn>(async () => ({
      data: { connected: true, provider: 'google' },
      error: null,
    }));
    const res = await connectCallbackGET(
      request('/auth/work/connect/callback?code=xyz&next=%2Fprofile%2F', {
        cw_connect: SECRET,
        [VERIFIER_COOKIE]: verifierCookie,
      }),
    );
    expect(res.cookies.get('cw_connected')?.value).toBe('1');
  });

  it('rejects an attempt cookie presented as a connect cookie', async () => {
    const res = await connectCallbackGET(
      request('/auth/work/connect/callback?code=xyz', {
        cw_connect: ATTEMPT_COOKIE_VALUE,
        [VERIFIER_COOKIE]: verifierCookie,
      }),
    );
    const client = mocks.serverClient as ReturnType<typeof serverClient>;
    expect(client.rpc).not.toHaveBeenCalled();
    expect(location(res)?.searchParams.get('error')).toBe('attempt_expired');
  });
});

describe('work-identity APIs', () => {
  function authed(serverRpc = vi.fn<RpcFn>(async () => ({ data: null, error: null }))) {
    const client = serverClient();
    client.rpc = serverRpc;
    mocks.serverClient = client;
    mocks.requireApiUser.mockResolvedValue({
      ok: true,
      user: { id: USER, email: 'a@bank.com' },
      admin: { from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { code: 'D-7' }, error: null }) }) }) })) },
    });
    return client;
  }

  it('context refuses a session without the attempt cookie', async () => {
    authed();
    const res = await contextGET(request('/api/v1/work-identity/context'));
    expect(res.status).toBe(410);
    expect(mocks.requireApiUser).toHaveBeenCalledWith({ allowInvited: true, forceAal2: true });
  });

  it('context rejects a connect cookie value in the attempt slot', async () => {
    authed();
    const res = await contextGET(request('/api/v1/work-identity/context', { cw_attempt: SECRET }));
    expect(res.status).toBe(410);
  });

  it('accept requires the terms', async () => {
    authed();
    const res = await acceptPOST(
      request('/api/v1/work-identity/accept', { cw_attempt: ATTEMPT_COOKIE_VALUE }, {
        method: 'POST',
        body: JSON.stringify({ displayName: 'Ana', tosAccepted: false }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('accept calls the RPC with the versioned terms and returns the deal', async () => {
    const rpc = vi.fn<RpcFn>(async () => ({
      data: { deal_id: 'deal-uuid', company_id: 'c1', is_external: false, duplicate: false },
      error: null,
    }));
    authed(rpc);
    const res = await acceptPOST(
      request('/api/v1/work-identity/accept', { cw_attempt: ATTEMPT_COOKIE_VALUE }, {
        method: 'POST',
        body: JSON.stringify({ displayName: '  Ana Banker ', tosAccepted: true }),
      }),
    );
    expect(rpc).toHaveBeenCalledWith('accept_work_identity_invite', {
      p_attempt_id: ATTEMPT,
      p_secret_digest: digest(SECRET),
      p_terms_version: TOS_VERSION,
      p_display_name: 'Ana Banker',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dealId: 'deal-uuid', dealCode: 'D-7' });
    expect(res.headers.get('set-cookie')).toMatch(/cw_attempt=;/);
  });

  it('accept maps an RPC refusal to copy and a status', async () => {
    authed(vi.fn<RpcFn>(async () => ({ data: null, error: { message: 'invite_expired' } })));
    const res = await acceptPOST(
      request('/api/v1/work-identity/accept', { cw_attempt: ATTEMPT_COOKIE_VALUE }, {
        method: 'POST',
        body: JSON.stringify({ displayName: 'Ana', tosAccepted: true }),
      }),
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('invite_expired');
    expect(body.error).not.toMatch(/invite_expired/);
  });
});
