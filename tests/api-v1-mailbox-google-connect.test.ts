import { createHash } from 'node:crypto';

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
import { GET as connectGet } from '@/app/api/v1/mailbox/google/connect/route';
import { GET as callbackGet } from '@/app/api/v1/mailbox/google/callback/route';
import { fakeGmailSend, jsonResponse } from './helpers/fakeGmailSend';

/*
 * GET /api/v1/mailbox/google/connect (#490 S3b), the front door of Connect for
 * sending. Contracts under test:
 *   1. 503 without the sending client; 409 { reason: no_firm_domain } when the
 *      firm has no Google Workspace domain on record; 500 when it cannot be
 *      read. None of them sets a cookie or starts a consent.
 *   2. Otherwise 307 to Google with PKCE S256, offline access, consent,
 *      login_hint = the caller's own address and hd = the firm's domain.
 *   3. The gmail_send_{state,verifier,next} cookies are httpOnly, SameSite=Lax,
 *      Path=/, 600 s, Secure outside development; `next` is app-internal only.
 *   4. The cookies it sets are the ones the callback reads: a round trip
 *      through both routes connects.
 */

const CLIENT_ID = 'send-client';
const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';

type Resp = { data: unknown; error: unknown };
type Call = { table: string; op: string; payload?: unknown };

/** A fake admin: each table answers from a queue (then { data: null }); every call is recorded. */
function fakeAdmin(queue: Record<string, Resp[]>) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, op: 'select' };
    calls.push(call);
    const next = () => Promise.resolve(queue[table]?.shift() ?? { data: null, error: null });
    const b: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'limit']) b[k] = () => b;
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
  const rpc = (fn: string, payload: unknown) => {
    calls.push({ table: `rpc:${fn}`, op: 'rpc', payload });
    return Promise.resolve(queue[`rpc:${fn}`]?.shift() ?? { data: null, error: null });
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

const connect = (qs = 'next=/projects/p1/mail') =>
  connectGet(new Request(`http://localhost/api/v1/mailbox/google/connect?${qs}`));

/** Set-Cookie headers by cookie name: the decoded value and the lowercased attribute list. */
function cookiesOf(res: Response): Record<string, { value: string; attrs: string[] }> {
  const out: Record<string, { value: string; attrs: string[] }> = {};
  for (const header of res.headers.getSetCookie()) {
    const [pair, ...attrs] = header.split(';').map((part) => part.trim());
    const eq = pair.indexOf('=');
    out[pair.slice(0, eq)] = {
      value: decodeURIComponent(pair.slice(eq + 1)),
      attrs: attrs.map((a) => a.toLowerCase()),
    };
  }
  return out;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('refused before any consent', () => {
  it('503 without the sending client, before the firm is read', async () => {
    vi.stubEnv('GOOGLE_SEND_CLIENT_ID', '');
    const { calls } = world();
    const res = await connect();
    expect(res.status).toBe(503);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(calls.map((c) => c.table)).toEqual(['users']);
  });

  it('409 no_firm_domain when the firm has neither an identity-provider row nor verified domains', async () => {
    configure();
    world({
      firm_identity_providers: [{ data: null, error: null }],
      company_verified_domains: [{ data: [], error: null }],
    });
    const res = await connect();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Your firm's Google Workspace is not set up for sending yet",
      reason: 'no_firm_domain',
    });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('403 not_eligible for an external user: no cookie, no consent, no firm read (owner decision 2026-10-19)', async () => {
    configure();
    const { calls } = world({ users: [{ data: { status: 'active', company_id: 'co-1', is_external: true }, error: null }] });
    const res = await connect();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Sending from Gmail is for the bank's own team", reason: 'not_eligible' });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(calls.map((c) => c.table)).not.toContain('firm_identity_providers');
  });

  it('409 no_firm_domain for a caller with no company', async () => {
    configure();
    world({ users: [{ data: { status: 'active', company_id: null }, error: null }] });
    expect((await connect()).status).toBe(409);
  });

  it('500 when the firm domain cannot be read, never "no domain"', async () => {
    configure();
    world({ firm_identity_providers: [{ data: null, error: { code: '57014', message: 'timeout' } }] });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await connect();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Firm Google Workspace domain unavailable' });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('timeout');
  });
});

describe('307 to Google', () => {
  it('asks for openid, email and gmail.send with PKCE, offline access, consent, login_hint and the firm hd', async () => {
    configure();
    world();
    const res = await connect();
    expect(res.status).toBe(307);
    const url = new URL(res.headers.get('location') ?? '');
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe('http://localhost:3000/api/v1/mailbox/google/callback');
    expect(p.get('scope')?.split(' ').sort()).toEqual(['email', GMAIL_SEND, 'openid']);
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('login_hint')).toBe('storm@ignatious.com');
    expect(p.get('hd')).toBe('ignatious.com');
    expect(p.get('code_challenge_method')).toBe('S256');

    const cookies = cookiesOf(res);
    expect(p.get('state')).toBe(cookies.gmail_send_state.value);
    const verifier = cookies.gmail_send_verifier.value;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(p.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'));
    // The verifier never travels in the URL.
    expect(url.toString()).not.toContain(verifier);
  });

  it('takes hd from the verified domains when there is no identity-provider row', async () => {
    configure();
    world({
      firm_identity_providers: [{ data: null, error: null }],
      company_verified_domains: [{ data: [{ domain: 'Ignatious.com' }], error: null }],
    });
    const url = new URL((await connect()).headers.get('location') ?? '');
    expect(url.searchParams.get('hd')).toBe('ignatious.com');
  });

  it('sets the three cookies httpOnly, SameSite=Lax, Path=/, 600 s and Secure outside development', async () => {
    configure();
    world();
    const cookies = cookiesOf(await connect());
    expect(Object.keys(cookies).sort()).toEqual(['gmail_send_next', 'gmail_send_state', 'gmail_send_verifier']);
    for (const { attrs } of Object.values(cookies)) {
      expect(attrs).toEqual(expect.arrayContaining(['httponly', 'samesite=lax', 'path=/', 'max-age=600', 'secure']));
    }
    expect(cookies.gmail_send_next.value).toBe('/projects/p1/mail');
  });

  it('drops Secure in development, so the flow works on http://localhost', async () => {
    configure();
    vi.stubEnv('NODE_ENV', 'development');
    world();
    for (const { attrs } of Object.values(cookiesOf(await connect()))) expect(attrs).not.toContain('secure');
  });

  it.each([['//evil.example/x'], ['https://evil.example/x'], ['/\\evil.example']])(
    'replaces an open-redirect next (%s) with /',
    async (next) => {
      configure();
      world();
      const cookies = cookiesOf(await connect(`next=${encodeURIComponent(next)}`));
      expect(cookies.gmail_send_next.value).toBe('/');
    },
  );

  it('a fresh state and verifier on every start', async () => {
    configure();
    const active = { data: { status: 'active', company_id: 'co-1' }, error: null };
    const idp = { data: { organization_id: 'ignatious.com' }, error: null };
    world({ users: [active, active], firm_identity_providers: [idp, idp] });
    const a = cookiesOf(await connect());
    const b = cookiesOf(await connect());
    expect(a.gmail_send_state.value).not.toBe(b.gmail_send_state.value);
    expect(a.gmail_send_verifier.value).not.toBe(b.gmail_send_verifier.value);
  });
});

describe('round trip', () => {
  it('the callback accepts what the connect route set, and sends Google the same verifier', async () => {
    configure();
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const idToken = `${b64({ alg: 'RS256' })}.${b64({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: 'google-sub-1',
      email: 'storm@ignatious.com',
      email_verified: true,
      hd: 'ignatious.com',
    })}.signature`;
    const gmail = fakeGmailSend({
      token: () =>
        jsonResponse({ access_token: 'at-new', refresh_token: 'rt-new', scope: `openid email ${GMAIL_SEND}`, id_token: idToken }),
    });
    vi.stubGlobal('fetch', gmail.fetch);
    const active = { data: { status: 'active', company_id: 'co-1' }, error: null };
    const idp = { data: { organization_id: 'ignatious.com' }, error: null };
    const { calls } = world({ users: [active, active], firm_identity_providers: [idp, idp] });

    const started = await connect();
    const state = new URL(started.headers.get('location') ?? '').searchParams.get('state');
    const set = cookiesOf(started);
    const cookie = Object.entries(set)
      .map(([name, { value }]) => `${name}=${encodeURIComponent(value)}`)
      .join('; ');

    const back = await callbackGet(
      new Request(`http://localhost/api/v1/mailbox/google/callback?code=c-1&state=${state}`, { headers: { cookie } }),
    );
    const landed = new URL(back.headers.get('location') ?? '');
    expect(landed.pathname).toBe('/projects/p1/mail');
    expect(landed.searchParams.get('mailbox')).toBe('connected');
    expect(gmail.tokenCalls[0].get('code_verifier')).toBe(set.gmail_send_verifier.value);
    expect(calls.some((c) => c.table === 'rpc:mailbox_sending_connect_google')).toBe(true);
  });
});
