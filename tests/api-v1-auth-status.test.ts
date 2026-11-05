import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthUnknownError,
} from '@supabase/supabase-js';

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

type ProfileResult = { data: { status: string } | null; error: { message: string } | null };

function usersTable(result: ProfileResult) {
  return vi.fn(() => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue(result) })),
    })),
  }));
}

// AAL2 so the MFA gate passes and each test exercises only its own branch.
function mockAuth(getUser: { data: { user: unknown }; error: unknown }, profile: ProfileResult) {
  const from = usersTable(profile);
  createServer.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue(getUser),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
          data: { currentLevel: 'aal2', nextLevel: 'aal2' },
          error: null,
        }),
      },
    },
    from,
  });
  createAdmin.mockReturnValue({ from });
}

const signedIn = { data: { user: { id: 'user-1', email: 'md@example.com', app_metadata: {} } }, error: null };
const noUser = (error: unknown) => ({ data: { user: null }, error });
const active: ProfileResult = { data: { status: 'active' }, error: null };

const guards = [
  ['requireApiUser', () => requireApiUser()],
  ['requireApiUserScoped', () => requireApiUserScoped()],
] as const;

beforeEach(() => vi.clearAllMocks());

describe.each(guards)('%s status semantics (#222)', (_name, guard) => {
  async function statusOf() {
    const result = await guard();
    return result.ok ? 200 : result.response.status;
  }

  it('lets an active user through', async () => {
    mockAuth(signedIn, active);
    expect(await statusOf()).toBe(200);
  });

  it('returns 401 when there is no session', async () => {
    mockAuth(noUser(new AuthSessionMissingError()), active);
    expect(await statusOf()).toBe(401);
  });

  it('returns 401 for an invalid JWT', async () => {
    mockAuth(noUser(new AuthApiError('invalid JWT', 403, 'bad_jwt')), active);
    expect(await statusOf()).toBe(401);
  });

  it('returns 503 when the auth provider is unreachable', async () => {
    mockAuth(noUser(new AuthRetryableFetchError('fetch failed', 0)), active);
    const result = await guard();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(503);
    await expect(result.response.json()).resolves.toEqual({
      error: 'Authentication is temporarily unavailable. Try again.',
    });
  });

  it('returns 503 when the auth provider answers with a server error', async () => {
    mockAuth(noUser(new AuthApiError('unexpected failure', 500, 'unexpected_failure')), active);
    expect(await statusOf()).toBe(503);
  });

  it('returns 503 when the auth provider reply cannot be parsed', async () => {
    mockAuth(noUser(new AuthUnknownError('Unexpected token <', null)), active);
    expect(await statusOf()).toBe(503);
  });

  it('returns 403 onboarding_incomplete for an invited user', async () => {
    mockAuth(signedIn, { data: { status: 'invited' }, error: null });
    const result = await guard();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    await expect(result.response.json()).resolves.toEqual({ error: 'onboarding_incomplete' });
  });

  it('fails closed with 503 when the profile cannot be read', async () => {
    mockAuth(signedIn, { data: null, error: { message: 'connection refused' } });
    const result = await guard();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(503);
    await expect(result.response.json()).resolves.toEqual({
      error: 'Access could not be verified. Try again.',
    });
  });
});
