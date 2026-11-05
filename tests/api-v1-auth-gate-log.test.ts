// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthRetryableFetchError } from '@supabase/supabase-js';

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
import { WORK_IDENTITY_HOOK_REFUSAL } from '@/lib/auth/workIdentityHook';
import { renderConsoleArg } from './helpers/consoleCapture';

/**
 * #474 census: every refusal branch of requireApiUser and requireApiUserScoped
 * writes exactly one line with its fixed fields, and answers the same bytes it
 * answered before the logger (the bodies below are the pre-change responses).
 * A let-in writes nothing. The session's email and the planted error text never
 * reach a line.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'jane@bank.example';
const CANARY = 'CANARY-331';

type World = {
  serverThrows?: true;
  userError?: unknown;
  aal?: 'aal1' | 'aal2';
  aalError?: unknown;
  adminThrows?: true;
  profileError?: unknown;
  status?: string;
  /** A work-identity session whose token lacks the hook claim, even after a refresh (#584). */
  hookMissing?: true;
};

/** One fake client for both the session and the service role: auth answers from `w`, users answers the profile. */
function useWorld(w: World) {
  const profile = {
    data: w.status ? { status: w.status, company_id: COMPANY, is_external: false } : null,
    error: w.profileError ?? null,
  };
  const builder = { select: () => builder, eq: () => builder, maybeSingle: async () => profile };
  const client = {
    auth: {
      getUser: async () => ({
        data: {
          user: w.userError ? null : { id: USER, email: EMAIL, app_metadata: w.hookMissing ? { providers: ['azure'] } : {} },
        },
        error: w.userError ?? null,
      }),
      getSession: async () => ({ data: { session: { access_token: `${CANARY}.no-claim.token` } }, error: null }),
      refreshSession: async () => ({ data: { session: null }, error: null }),
      signOut: async () => ({ error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: w.aalError ? null : { currentLevel: w.aal ?? 'aal2', nextLevel: 'aal2' },
          error: w.aalError ?? null,
        }),
      },
    },
    from: () => builder,
  };
  if (w.serverThrows) createServer.mockRejectedValue(new Error(`${CANARY} Supabase is not configured`));
  else createServer.mockResolvedValue(client);
  if (w.adminThrows) {
    createAdmin.mockImplementation(() => {
      throw new Error(`${CANARY} no service key`);
    });
  } else createAdmin.mockReturnValue(client);
}

type Gate = 'api' | 'api_scoped';
const GUARDS: Record<Gate, () => Promise<{ ok: true } | { ok: false; response: Response }>> = {
  api: () => requireApiUser(),
  api_scoped: () => requireApiUserScoped(),
};

// [branch, world, status, pre-change body, console method, line without gate and ids, only this gate].
// requireApiUserScoped has no admin client and no suspended check (T5), so two rows are api-only.
type Row = [string, World, number, string, 'warn' | 'error', string, Gate?];
const denied = (reason: string, status: number) => `{"evt":"auth_denied","reason":"${reason}","status":${status}`;
const outage = (reason: string) => `{"evt":"auth_unavailable","reason":"${reason}","status":503`;
const ERROR_BODY = (message: string) => JSON.stringify({ error: message });

const ROWS: Row[] = [
  ['the session client cannot be built', { serverThrows: true }, 503, ERROR_BODY('Server misconfigured'), 'error', outage('misconfigured')],
  [
    'the auth provider is unreachable', { userError: new AuthRetryableFetchError(`${CANARY} fetch failed`, 0) }, 503,
    ERROR_BODY('Authentication is temporarily unavailable. Try again.'), 'error', outage('session_read'),
  ],
  ['there is no session', { userError: { message: `${CANARY} bad jwt` } }, 401, ERROR_BODY('Unauthorized'), 'warn', denied('no_session', 401)],
  ['the assurance level cannot be read', { aalError: { message: CANARY } }, 503, ERROR_BODY('mfa_unavailable'), 'error', outage('mfa_level')],
  ['the session is at AAL1', { aal: 'aal1', status: 'active' }, 403, ERROR_BODY('mfa_required'), 'warn', denied('mfa_required', 403)],
  [
    'the service-role client cannot be built', { adminThrows: true, status: 'active' }, 503, ERROR_BODY('Server misconfigured'),
    'error', outage('admin_client'), 'api',
  ],
  [
    'the profile cannot be read', { profileError: { code: '08006', message: `${CANARY} connection refused` } }, 503,
    ERROR_BODY('Access could not be verified. Try again.'), 'error', outage('profile_read'),
  ],
  ['the account is suspended', { status: 'suspended' }, 403, ERROR_BODY('account_suspended'), 'warn', denied('account_suspended', 403), 'api'],
  ['the user is still invited', { status: 'invited' }, 403, ERROR_BODY('onboarding_incomplete'), 'warn', denied('onboarding_incomplete', 403)],
];

// The ids each denial carries once the gate holds them: the user after sign-in, the firm after the profile read.
const IDS: Record<string, string> = {
  mfa_required: `,"user":"${USER}"`,
  account_suspended: `,"user":"${USER}","company":"${COMPANY}"`,
  onboarding_incomplete: `,"user":"${USER}","company":"${COMPANY}"`,
};

const census = (['api', 'api_scoped'] as const).flatMap((gate) =>
  ROWS.filter((row) => !row[6] || row[6] === gate).map(([name, world, status, body, method, line]) => {
    const reason = /"reason":"([a-z_]+)"/.exec(line)?.[1] ?? '';
    return { gate, name, world, status, body, method, line: `${line},"gate":"${gate}"${IDS[reason] ?? ''}}` };
  }),
);

let written: Array<{ method: string; text: string }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MFA_ENFORCEMENT', '');
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'prod');
  vi.stubEnv('DISABLE_MFA', '');
  written = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      written.push({ method, text: args.map(renderConsoleArg).join(' ') });
    });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('auth gate refusals write one line each (#474)', () => {
  it.each(census)('$gate: $name -> $status, one line', async ({ gate, world, status, body, method, line }) => {
    useWorld(world);
    const result = await GUARDS[gate]();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(status);
    expect(await result.response.text()).toBe(body);
    expect(written).toEqual([{ method, text: line }]);
    for (const planted of [CANARY, EMAIL, 'jane@']) expect(written[0].text).not.toContain(planted);
  });

  it.each(['api', 'api_scoped'] as const)('%s: an active user at AAL2 is let in and writes nothing', async (gate) => {
    useWorld({ aal: 'aal2', status: 'active' });
    expect((await GUARDS[gate]()).ok).toBe(true);
    expect(written).toEqual([]);
  });

  // #584's refusal: the hook writes its own fixed marker first, then the gate writes its line.
  it.each(['api', 'api_scoped'] as const)('%s: a work-identity session without the hook claim -> 401, its line', async (gate) => {
    useWorld({ hookMissing: true, status: 'active' });
    const result = await GUARDS[gate]();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect(await result.response.text()).toBe(ERROR_BODY(WORK_IDENTITY_HOOK_REFUSAL));
    expect(written).toEqual([
      { method: 'error', text: 'work_identity_hook_missing' },
      { method: 'warn', text: `${denied('work_identity_hook', 401)},"gate":"${gate}","user":"${USER}"}` },
    ]);
    for (const planted of [CANARY, EMAIL, 'jane@']) expect(written[1].text).not.toContain(planted);
  });

  it('covers every branch: ten for requireApiUser, eight for requireApiUserScoped', () => {
    expect(census.filter((c) => c.gate === 'api')).toHaveLength(9);
    expect(census.filter((c) => c.gate === 'api_scoped')).toHaveLength(7);
    // plus the work-identity refusal of each gate, tested above
  });
});
