import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

// The mail channel flag is ON here; the off->404 path is flags-require.test.ts.
vi.mock('@/lib/flags/requireFlag', () => ({
  requireFlag: () => Promise.resolve(null),
}));

import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { GET as callbackGet } from '@/app/api/v1/mailbox/google/callback/route';
import { decryptTokens } from '@/lib/email/tokenCrypto';
import { fakeGmailSend, jsonResponse, type FakeGmail } from './helpers/fakeGmailSend';

/*
 * GET /api/v1/mailbox/google/callback (#490 S3a), the only writer of Google
 * mailbox_connections rows. Contracts under test:
 *   1. Without a matching gmail_send_state cookie and a gmail_send_verifier
 *      cookie it refuses before any Google call.
 *   2. A connect goes through mailbox_sending_connect_google: the refresh
 *      token encrypted, the account sub and the granted scopes, stored and
 *      audited in one transaction (#490 audit 2).
 *   3. Each refusal redirects ?mailbox=error&reason=<reason> and clears the
 *      cookies: cancelled, failed, no_firm_domain, scope_missing,
 *      scope_unexpected, not_workspace, wrong_account. It stores nothing and
 *      writes one mailbox.connect_refused row ({provider, reason}).
 *   4. Nothing is ever revoked at Google (#490 audit 1). A refusal after
 *      Google returned a code carries granted=1, so the card links to where
 *      the banker removes the grant; one before it does not.
 *   5. If the refusal's audit row cannot be written, the redirect says
 *      not_recorded instead of the refusal's reason (fail closed).
 */

const CLIENT_ID = 'send-client';
const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
const USERINFO_EMAIL = 'https://www.googleapis.com/auth/userinfo.email';
const COOKIES = 'gmail_send_state=s-1; gmail_send_verifier=v-1; gmail_send_next=/projects/p1/mail';

type Resp = { data: unknown; error: unknown };
type Call = { table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> };

/**
 * A fake admin: each table, and each RPC as `rpc:<name>`, answers from a queue
 * (then { data: null }); every call and filter is recorded.
 */
function fakeAdmin(queue: Record<string, Resp[]> = {}) {
  const calls: Call[] = [];
  const rpc = (fn: string, args: unknown) => {
    calls.push({ table: `rpc:${fn}`, op: 'rpc', payload: args, filters: [] });
    return Promise.resolve(queue[`rpc:${fn}`]?.shift() ?? { data: null, error: null });
  };
  const from = (table: string) => {
    const call: Call = { table, op: 'select', filters: [] };
    calls.push(call);
    const next = () => Promise.resolve(queue[table]?.shift() ?? { data: null, error: null });
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.limit = () => b;
    b.eq = (column: string, value: unknown) => {
      call.filters.push([column, value]);
      return b;
    };
    b.delete = () => {
      call.op = 'delete';
      return b;
    };
    for (const op of ['insert', 'upsert']) {
      b[op] = (payload: unknown) => {
        Object.assign(call, { op, payload });
        return next();
      };
    }
    b.maybeSingle = next;
    b.then = (f: (v: Resp) => unknown, r?: (e: unknown) => unknown) => next().then(f, r);
    return b;
  };
  return { admin: { from, rpc } as unknown as ReturnType<typeof createSupabaseAdminClient>, calls };
}

/** Signed in as storm@ignatious.com of company co-1, whose Google domain is ignatious.com unless overridden. */
function world(queue: Record<string, Resp[]> = {}) {
  const fake = fakeAdmin({
    users: [{ data: { status: 'active', company_id: 'co-1' }, error: null }],
    firm_identity_providers: [{ data: { organization_id: 'ignatious.com' }, error: null }],
    ...queue,
  });
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: 'u-1', email: 'storm@ignatious.com' } }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: () => Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }) },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(fake.admin);
  return fake;
}

function configure() {
  vi.stubEnv('GOOGLE_SEND_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('GOOGLE_SEND_CLIENT_SECRET', 'send-secret');
  vi.stubEnv('GOOGLE_SEND_REDIRECT_URI', 'http://localhost:3000/api/v1/mailbox/google/callback');
  vi.stubEnv('MAILBOX_TOKEN_KEY', 'a'.repeat(64));
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function idToken(overrides: Record<string, unknown> = {}): string {
  const claims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: 'google-sub-1',
    email: 'storm@ignatious.com',
    email_verified: true,
    hd: 'ignatious.com',
    ...overrides,
  };
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.signature`;
}

/** Google's code-exchange answer; `body` overrides its fields (undefined drops one). */
function google(body: Record<string, unknown> = {}): FakeGmail {
  const fake = fakeGmailSend({
    token: () =>
      jsonResponse({
        access_token: 'at-new',
        refresh_token: 'rt-new',
        scope: `openid ${USERINFO_EMAIL} ${GMAIL_SEND}`,
        id_token: idToken(),
        ...body,
      }),
  });
  vi.stubGlobal('fetch', fake.fetch);
  return fake;
}

const callback = (qs = 'code=c-1&state=s-1', cookie = COOKIES) =>
  callbackGet(new Request(`http://localhost/api/v1/mailbox/google/callback?${qs}`, { headers: { cookie } }));

function outcome(res: Response) {
  const url = new URL(res.headers.get('location') ?? '');
  return { path: url.pathname, mailbox: url.searchParams.get('mailbox'), reason: url.searchParams.get('reason') };
}

/** Whether the redirect tells the card a grant exists at Google (granted=1). */
const grantedFlag = (res: Response) => new URL(res.headers.get('location') ?? '').searchParams.get('granted');

const writes = (calls: Call[]) => calls.filter((c) => c.op !== 'select');
/** Anything that would store or change a connection. */
const stores = (calls: Call[]) => writes(calls).filter((c) => c.table !== 'audit_log');
/** The refusal's audit row: exactly one, with the provider and the reason only. */
function expectRefusalAudit(calls: Call[], reason: string) {
  expect(writes(calls).filter((c) => c.table === 'audit_log')).toEqual([
    expect.objectContaining({
      op: 'insert',
      payload: { actor_id: 'u-1', action: 'mailbox.connect_refused', detail: { provider: 'google', reason } },
    }),
  ]);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('connected', () => {
  it('stores the encrypted refresh token with sub and granted scopes in one RPC with its audit row, and clears the cookies', async () => {
    configure();
    const gmail = google();
    const { calls } = world();

    const res = await callback();
    expect(res.status).toBe(307);
    expect(outcome(res)).toEqual({ path: '/projects/p1/mail', mailbox: 'connected', reason: null });
    expect(gmail.tokenCalls[0].get('code')).toBe('c-1');
    expect(gmail.tokenCalls[0].get('code_verifier')).toBe('v-1');
    expect(gmail.revokes).toHaveLength(0);

    // The row and mailbox.connected are written by the RPC, in one transaction.
    const [connect] = writes(calls);
    expect(writes(calls)).toHaveLength(1);
    expect(connect).toMatchObject({
      table: 'rpc:mailbox_sending_connect_google',
      payload: {
        p_user: 'u-1',
        p_email: 'storm@ignatious.com',
        p_account_sub: 'google-sub-1',
        p_scopes: [GMAIL_SEND, USERINFO_EMAIL, 'openid'].sort().join(' '),
      },
    });
    const blob = String((connect.payload as { p_tokens_encrypted: string }).p_tokens_encrypted);
    expect(blob).not.toContain('rt-new');
    expect(decryptTokens(blob)).toEqual({ refreshToken: 'rt-new' });

    const cleared = res.headers.getSetCookie().join('; ');
    for (const name of ['gmail_send_state', 'gmail_send_verifier', 'gmail_send_next']) expect(cleared).toContain(`${name}=;`);
  });

  it('accepts a verified firm domain when there is no identity-provider row', async () => {
    configure();
    google();
    world({
      firm_identity_providers: [{ data: null, error: null }],
      company_verified_domains: [{ data: [{ domain: 'ignatious.com' }], error: null }],
    });
    expect(outcome(await callback()).mailbox).toBe('connected');
  });
});

describe('refused before Google is asked', () => {
  it.each([
    ['no cookies at all', 'code=c-1&state=s-1', ''],
    ['no state cookie', 'code=c-1&state=s-1', 'gmail_send_verifier=v-1'],
    ['a mismatched state', 'code=c-1&state=evil', COOKIES],
    ['no state parameter', 'code=c-1', COOKIES],
    ['no verifier cookie', 'code=c-1&state=s-1', 'gmail_send_state=s-1'],
    ['no code', 'state=s-1', COOKIES],
  ])('%s -> failed, nothing stored, the refusal audited', async (_name, qs, cookie) => {
    configure();
    const gmail = google();
    const { calls } = world();
    const res = await callback(qs, cookie);
    expect(outcome(res)).toMatchObject({ mailbox: 'error', reason: 'failed' });
    expect(gmail.log).toEqual([]);
    expect(stores(calls)).toEqual([]);
    expectRefusalAudit(calls, 'failed');
  });

  it('cancelled on Google: access_denied with a matching state', async () => {
    configure();
    const gmail = google();
    world();
    const res = await callback('error=access_denied&state=s-1');
    expect(outcome(res).reason).toBe('cancelled');
    expect(grantedFlag(res)).toBeNull();
    expect(gmail.log).toEqual([]);
  });

  it('failed when this environment has no sending client', async () => {
    configure();
    vi.stubEnv('GOOGLE_SEND_CLIENT_SECRET', '');
    const gmail = google();
    const { calls } = world();
    expect(outcome(await callback()).reason).toBe('failed');
    expect(gmail.log).toEqual([]);
    expect(stores(calls)).toEqual([]);
    expectRefusalAudit(calls, 'failed');
  });

  it('no_firm_domain when the firm has no Google domain on record', async () => {
    configure();
    const gmail = google();
    world({ firm_identity_providers: [{ data: null, error: null }], company_verified_domains: [{ data: [], error: null }] });
    expect(outcome(await callback()).reason).toBe('no_firm_domain');
    expect(gmail.log).toEqual([]);
  });

  it('not_eligible for an external user: refused before the exchange, nothing stored, the refusal audited', async () => {
    configure();
    const gmail = google();
    const { calls } = world({ users: [{ data: { status: 'active', company_id: 'co-1', is_external: true }, error: null }] });
    const res = await callback();
    expect(outcome(res)).toMatchObject({ mailbox: 'error', reason: 'not_eligible' });
    expect(gmail.log).toEqual([]);
    expect(stores(calls)).toEqual([]);
    expectRefusalAudit(calls, 'not_eligible');
  });

  it('failed when the firm domains or the binding cannot be read', async () => {
    configure();
    const gmail = google();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    world({ work_identity_bindings: [{ data: null, error: { code: '57014', message: 'x' } }] });
    expect(outcome(await callback()).reason).toBe('failed');
    expect(gmail.log).toEqual([]);
  });
});

describe('refused after the exchange: nothing stored, nothing revoked (#490 audit 1)', () => {
  it.each([
    ['scope_missing', { scope: `openid ${USERINFO_EMAIL}` }, {}],
    ['scope_unexpected', { scope: `openid ${USERINFO_EMAIL} ${GMAIL_SEND} https://www.googleapis.com/auth/drive.file` }, {}],
    ['not_workspace', { id_token: idToken({ hd: undefined }) }, {}],
    ['not_workspace', { id_token: idToken({ hd: 'other.com' }) }, {}],
    ['wrong_account', { id_token: idToken({ email: 'colleague@ignatious.com' }) }, {}],
    ['wrong_account', { id_token: idToken({ email_verified: false }) }, {}],
    [
      'wrong_account',
      {},
      { work_identity_bindings: [{ data: { provider_subject: 'google-sub-other' }, error: null }] },
    ],
    ['failed', { id_token: undefined }, {}],
  ] as Array<[string, Record<string, unknown>, Record<string, Resp[]>]>)(
    '%s: nothing stored, the refusal audited, the grant left for the banker to remove',
    async (reason, body, queue) => {
      configure();
      const gmail = google(body);
      const { calls } = world(queue);
      const res = await callback();
      expect(outcome(res)).toMatchObject({ path: '/projects/p1/mail', mailbox: 'error', reason });
      expect(stores(calls)).toEqual([]);
      expectRefusalAudit(calls, reason);
      // Google's revoke could end the account's other grants in the project, sign-in included.
      expect(gmail.revokes).toHaveLength(0);
      expect(gmail.log).toEqual(['token']);
      // Google recorded the approval at consent, so the card shows where to remove it, 'failed' included.
      expect(grantedFlag(res)).toBe('1');
    },
  );

  it('a failed store refuses: the RPC rolled the row and its audit back together', async () => {
    configure();
    const gmail = google();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { calls } = world({
      'rpc:mailbox_sending_connect_google': [{ data: null, error: { code: 'P0001', message: 'audit refused storm@ignatious.com' } }],
    });
    expect(outcome(await callback()).reason).toBe('failed');
    expect(writes(calls).map((c) => c.table)).toEqual(['rpc:mailbox_sending_connect_google', 'audit_log']);
    expectRefusalAudit(calls, 'failed');
    expect(gmail.revokes).toHaveLength(0);
    const log = JSON.stringify(logged.mock.calls);
    expect(log).toContain('P0001');
    expect(log).not.toContain('storm@ignatious.com');
  });

  it('fails closed when the refusal cannot be audited: not_recorded, nothing stored, a code-only log', async () => {
    configure();
    google({ scope: `openid ${USERINFO_EMAIL}` });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { calls } = world({ audit_log: [{ data: null, error: { code: '23514', message: 'check storm@ignatious.com' } }] });
    const res = await callback();
    expect(outcome(res)).toMatchObject({ mailbox: 'error', reason: 'not_recorded' });
    expect(grantedFlag(res)).toBe('1');
    expect(stores(calls)).toEqual([]);
    const log = JSON.stringify(logged.mock.calls);
    expect(log).toContain('23514');
    expect(log).not.toContain('storm@ignatious.com');
  });

  it('fails closed before Google too: an unaudited state mismatch is not_recorded, with no grant flag', async () => {
    configure();
    google();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    world({ audit_log: [{ data: null, error: { code: '23514', message: 'check' } }] });
    const res = await callback('state=s-1');
    expect(outcome(res).reason).toBe('not_recorded');
    expect(grantedFlag(res)).toBeNull();
  });
});
