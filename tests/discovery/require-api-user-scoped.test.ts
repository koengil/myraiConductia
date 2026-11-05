import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { requireApiUser } from '@/lib/api/v1/http';
import { requireApiUserScoped, type ScopedApiUser } from '@/lib/api/v1/httpScoped';

type Session = {
  user: { id: string; email: string | null; app_metadata?: Record<string, unknown> } | null;
  userError?: unknown;
  aal?: 'aal1' | 'aal2';
  aalError?: unknown;
  status?: string | null;
  companyId?: string | null;
};

/** A fake Supabase client: auth answers from `session`, and users reads status and company_id. */
function fakeClient(session: Session) {
  const profile =
    session.status === undefined ? null : { status: session.status, company_id: session.companyId ?? null };
  const builder = {
    select: vi.fn(() => builder),
    eq: () => builder,
    maybeSingle: async () => ({ data: profile, error: null }),
  };
  return {
    auth: {
      getUser: async () => ({ data: { user: session.user }, error: session.userError ?? null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: session.aal ?? 'aal1', nextLevel: 'aal2' },
          error: session.aalError ?? null,
        }),
      },
    },
    from: vi.fn(() => builder),
  };
}

const serverClient = vi.mocked(createSupabaseServerClient);
const adminClient = vi.mocked(createSupabaseAdminClient);

function useSession(session: Session) {
  const client = fakeClient(session);
  serverClient.mockResolvedValue(client as never);
  adminClient.mockReturnValue(fakeClient(session) as never);
  return client;
}

async function outcome(result: { ok: true } | { ok: false; response: Response }) {
  if (result.ok) return { ok: true as const };
  return { ok: false as const, status: result.response.status, body: await result.response.json() };
}

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'alice@bank.example' };
const COMPANY = '22222222-2222-4222-8222-222222222222';

const CASES: Array<{ name: string; session: Session; env?: Record<string, string> }> = [
  { name: 'no session', session: { user: null } },
  { name: 'a session without an email', session: { user: { id: USER.id, email: null } } },
  { name: 'an auth error', session: { user: USER, userError: { message: 'bad jwt' } } },
  { name: 'MFA required at AAL1', session: { user: USER, aal: 'aal1', status: 'active' } },
  { name: 'MFA unavailable', session: { user: USER, aalError: { message: 'down' }, status: 'active' } },
  { name: 'an invited user at AAL2', session: { user: USER, aal: 'aal2', status: 'invited' } },
  { name: 'an active user at AAL2', session: { user: USER, aal: 'aal2', status: 'active' } },
  { name: 'a user with no profile row', session: { user: USER, aal: 'aal2' } },
  {
    name: 'invite_only enforcement with an established account at AAL1',
    session: { user: USER, aal: 'aal1', status: 'active' },
    env: { MFA_ENFORCEMENT: 'invite_only' },
  },
  {
    name: 'invite_only enforcement with an invited identity at AAL1',
    session: {
      user: { ...USER, app_metadata: { account_origin: 'email_invite' } },
      aal: 'aal1',
      status: 'active',
    },
    env: { MFA_ENFORCEMENT: 'invite_only' },
  },
];

describe('requireApiUserScoped', () => {
  beforeEach(() => {
    vi.stubEnv('MFA_ENFORCEMENT', '');
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'prod');
    vi.stubEnv('DISABLE_MFA', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each(CASES)('answers exactly as requireApiUser for $name', async ({ session, env }) => {
    for (const [key, value] of Object.entries(env ?? {})) vi.stubEnv(key, value);
    useSession(session);
    const expected = await outcome(await requireApiUser());
    useSession(session);
    const actual = await outcome(await requireApiUserScoped());
    expect(actual).toEqual(expected);
  });

  it('returns 503 when the session client cannot be built', async () => {
    serverClient.mockRejectedValue(new Error('Supabase is not configured'));
    expect(await outcome(await requireApiUserScoped())).toEqual({
      ok: false,
      status: 503,
      body: { error: 'Server misconfigured' },
    });
  });

  it('hands back the caller\'s own session client and never builds a service-role client', async () => {
    const client = useSession({ user: USER, aal: 'aal2', status: 'active', companyId: COMPANY });
    const result = await requireApiUserScoped();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.db).toBe(client);
    expect(result.user).toEqual({ ...USER, companyId: COMPANY });
    expect(client.from).toHaveBeenCalledWith('users');
    expect(adminClient).not.toHaveBeenCalled();
    expect(Object.keys(result).sort()).toEqual(['db', 'ok', 'user']);
  });

  it('reports a profile without a firm as companyId null', async () => {
    useSession({ user: USER, aal: 'aal2', status: 'active' });
    const result = await requireApiUserScoped();
    expect(result.ok && result.user).toEqual({ ...USER, companyId: null });
  });

  it('exposes no admin client in its type', () => {
    type Ok = Extract<ScopedApiUser, { ok: true }>;
    expectTypeOf<Ok>().not.toHaveProperty('admin');
    expectTypeOf<Ok>().toHaveProperty('db');
    expectTypeOf<keyof Ok>().toEqualTypeOf<'ok' | 'user' | 'db'>();
  });
});
