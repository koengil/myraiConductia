import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

// The mail channel flag is ON for these tests; the off->404 path is covered
// in flags-require.test.ts.
vi.mock('@/lib/flags/requireFlag', () => ({
  requireFlag: () => Promise.resolve(null),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { GET as statusGet, DELETE as disconnect } from '@/app/api/v1/mailbox/route';
import { GET as connectGet } from '@/app/api/v1/mailbox/connect/route';
import { GET as callbackGet } from '@/app/api/v1/mailbox/callback/route';

/*
 * The mailbox connection surface (Microsoft Graph OAuth).
 *
 * Contracts under test:
 *   1. Status: { configured:false } without any sending client; connected +
 *      email when a row exists. #490: status and providers are added;
 *      configured is any provider (R25, with the Mail settings card); a
 *      Microsoft row reads only with the Azure app; a Google row is reported
 *      with its status whatever the config; a read error is a 500.
 *   2. Connect: 503 unconfigured; configured -> 302 to Microsoft with the
 *      CSRF state cookie set.
 *   3. Callback: state mismatch -> redirect ?mailbox=error, nothing stored;
 *      happy path -> tokens exchanged, profile read, ENCRYPTED upsert,
 *      redirect ?mailbox=connected. The upsert resets the Google-only
 *      columns (status, revoked_at, account_sub), so a Microsoft connect over
 *      a Google row of the same user satisfies the table's checks (#490 R20).
 *   4. Disconnect -> 204 through mailbox_sending_disconnect, which deletes
 *      the row and audits a Google one in one transaction (#490 audit 2); a
 *      failure is a 500 that changed nothing.
 */

type Row = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Row | Row[]>) {
  const upserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const deletes: string[] = [];
  const rpcs: Array<{ fn: string; args: unknown }> = [];
  const rpc = (fn: string, args: unknown) => {
    rpcs.push({ fn, args });
    const entry = tables[`rpc:${fn}`];
    const resp: Row = Array.isArray(entry) ? (entry.shift() ?? { data: null, error: null }) : (entry ?? { data: null, error: null });
    return Promise.resolve(resp);
  };
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Row = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const k of ['select', 'eq', 'update']) builder[k] = chain;
    builder.upsert = (payload: Record<string, unknown>) => {
      upserts.push({ table, payload });
      return Promise.resolve(resp) as unknown as Record<string, unknown>;
    };
    builder.insert = (payload: Record<string, unknown>) => {
      inserts.push({ table, payload });
      return Promise.resolve(resp) as unknown as Record<string, unknown>;
    };
    builder.delete = () => {
      deletes.push(table);
      return builder;
    };
    builder.single = () => Promise.resolve(resp);
    builder.maybeSingle = () => Promise.resolve(resp);
    builder.then = (f: (v: Row) => unknown) => Promise.resolve(resp).then(f);
    return builder;
  };
  const admin = { from, rpc } as unknown as ReturnType<typeof createSupabaseAdminClient>;
  return { admin, upserts, inserts, deletes, rpcs };
}

function signedIn(admin: ReturnType<typeof createSupabaseAdminClient>) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: 'u-1', email: 'md@bank.dev' } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

function configureGmail() {
  vi.stubEnv('GOOGLE_SEND_CLIENT_ID', 'send-client');
  vi.stubEnv('GOOGLE_SEND_CLIENT_SECRET', 'send-secret');
  vi.stubEnv('GOOGLE_SEND_REDIRECT_URI', 'http://localhost:3000/api/v1/mailbox/google/callback');
  vi.stubEnv('MAILBOX_TOKEN_KEY', 'a'.repeat(64));
}

function configure() {
  vi.stubEnv('MS_CLIENT_ID', 'client-1');
  vi.stubEnv('MS_CLIENT_SECRET', 'shh');
  vi.stubEnv('MS_REDIRECT_URI', 'http://localhost:3000/api/v1/mailbox/callback');
  vi.stubEnv('MAILBOX_TOKEN_KEY', 'a'.repeat(64));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('GET /api/v1/mailbox', () => {
  it('reports unconfigured without the Azure env', async () => {
    vi.stubEnv('MS_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_SEND_CLIENT_ID', '');
    const { admin } = makeAdmin({});
    signedIn(admin);
    const body = await (await statusGet()).json();
    expect(body).toEqual({ configured: false, connected: false, providers: { microsoft: false, google: false } });
  });

  it('a Microsoft row without the Azure env still reads as not connected, even with Gmail configured', async () => {
    vi.stubEnv('MS_CLIENT_ID', '');
    configureGmail();
    const { admin } = makeAdmin({
      mailbox_connections: {
        data: { email: 'storm@ignatius.com', provider: 'microsoft', status: 'connected', connected_at: '2026-07-30T10:00:00Z' },
        error: null,
      },
    });
    signedIn(admin);
    const body = await (await statusGet()).json();
    expect(body).toMatchObject({ configured: true, connected: false, providers: { microsoft: false, google: true } });
    expect(body).not.toHaveProperty('email');
  });

  it('configured is any provider: Gmail alone counts (#490 R25)', async () => {
    vi.stubEnv('MS_CLIENT_ID', '');
    configureGmail();
    const { admin } = makeAdmin({});
    signedIn(admin);
    expect(await (await statusGet()).json()).toEqual({
      configured: true,
      connected: false,
      providers: { microsoft: false, google: true },
    });
  });

  it('reports a Google row with its status, whatever the config', async () => {
    vi.stubEnv('MS_CLIENT_ID', '');
    configureGmail();
    const row = (status: string) => ({
      data: { email: 'storm@ignatius.com', provider: 'google', status, connected_at: '2026-10-17T10:00:00Z' },
      error: null,
    });
    const { admin } = makeAdmin({ mailbox_connections: [row('connected'), row('revoked')] });
    signedIn(admin);

    expect(await (await statusGet()).json()).toEqual({
      configured: true,
      connected: true,
      email: 'storm@ignatius.com',
      provider: 'google',
      connectedAt: '2026-10-17T10:00:00Z',
      status: 'connected',
      providers: { microsoft: false, google: true },
    });
    // Approval ended: reported, but it cannot send.
    expect(await (await statusGet()).json()).toMatchObject({ connected: false, provider: 'google', status: 'revoked' });
  });

  it('a Google row on a deployment with no sending client still reads, so the card can say Gmail is switched off', async () => {
    vi.stubEnv('MS_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_SEND_CLIENT_ID', '');
    const { admin } = makeAdmin({
      mailbox_connections: {
        data: { email: 'storm@ignatius.com', provider: 'google', status: 'connected', connected_at: '2026-10-17T10:00:00Z' },
        error: null,
      },
    });
    signedIn(admin);
    expect(await (await statusGet()).json()).toMatchObject({
      configured: false,
      connected: true,
      provider: 'google',
      email: 'storm@ignatius.com',
      providers: { microsoft: false, google: false },
    });
  });

  it('a read error is a 500, never "not connected"', async () => {
    configure();
    const { admin } = makeAdmin({ mailbox_connections: { data: null, error: { code: '57014', message: 'x' } } });
    signedIn(admin);
    const res = await statusGet();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Mailbox connection unavailable' });
  });

  it('reports the connected mailbox', async () => {
    configure();
    const { admin } = makeAdmin({
      mailbox_connections: {
        data: { email: 'storm@ignatius.com', provider: 'microsoft', status: 'connected', connected_at: '2026-07-30T10:00:00Z' },
        error: null,
      },
    });
    signedIn(admin);
    const body = await (await statusGet()).json();
    expect(body).toMatchObject({ configured: true, connected: true, email: 'storm@ignatius.com' });
  });
});

describe('GET /api/v1/mailbox/connect', () => {
  it('503 when unconfigured', async () => {
    vi.stubEnv('MS_CLIENT_ID', '');
    const { admin } = makeAdmin({});
    signedIn(admin);
    expect(
      (await connectGet(new Request('http://localhost/api/v1/mailbox/connect'))).status,
    ).toBe(503);
  });

  it('302 to Microsoft with the state cookie', async () => {
    configure();
    const { admin } = makeAdmin({});
    signedIn(admin);
    const res = await connectGet(
      new Request('http://localhost/api/v1/mailbox/connect?next=/projects/p1/mail'),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('login.microsoftonline.com');
    const cookies = res.headers.getSetCookie().join('; ');
    expect(cookies).toContain('mailbox_oauth_state=');
    expect(cookies).toContain('mailbox_next=');
  });
});

describe('GET /api/v1/mailbox/callback', () => {
  const cb = (qs: string, cookies: string) =>
    callbackGet(
      new Request(`http://localhost/api/v1/mailbox/callback?${qs}`, {
        headers: { cookie: cookies },
      }),
    );

  it('rejects a state mismatch without storing anything', async () => {
    configure();
    const { admin, upserts } = makeAdmin({});
    signedIn(admin);
    const res = await cb('code=c1&state=evil', 'mailbox_oauth_state=good; mailbox_next=/x');
    expect(res.headers.get('location')).toContain('mailbox=error');
    expect(upserts).toHaveLength(0);
  });

  it('stores the ENCRYPTED tokens and redirects connected', async () => {
    configure();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes('/oauth2/v2.0/token')) {
          return {
            ok: true,
            json: async () => ({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }),
          } as Response;
        }
        if (u.includes('graph.microsoft.com/v1.0/me')) {
          return {
            ok: true,
            json: async () => ({ mail: 'storm@ignatius.com', displayName: 'Storm Duncan' }),
          } as Response;
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );
    const { admin, upserts } = makeAdmin({ mailbox_connections: { data: null, error: null } });
    signedIn(admin);

    const res = await cb(
      'code=c1&state=good',
      'mailbox_oauth_state=good; mailbox_next=/projects/p1/mail',
    );
    expect(res.headers.get('location')).toContain('mailbox=connected');
    expect(upserts).toHaveLength(1);
    const stored = upserts[0].payload;
    expect(stored.email).toBe('storm@ignatius.com');
    expect(String(stored.tokens_encrypted)).not.toContain('at-1');
    expect(String(stored.tokens_encrypted)).not.toContain('rt-1');
    // One row per user: the upsert may land on a (revoked) Google row, so it
    // names every column a Google connection sets.
    expect(stored).toMatchObject({
      user_id: 'u-1',
      provider: 'microsoft',
      status: 'connected',
      revoked_at: null,
      account_sub: null,
    });
  });
});

describe('DELETE /api/v1/mailbox', () => {
  it('disconnects with 204 through one RPC, with no table write from the route', async () => {
    configure();
    const { admin, deletes, inserts, rpcs } = makeAdmin({ 'rpc:mailbox_sending_disconnect': { data: 'google', error: null } });
    signedIn(admin);
    expect((await disconnect()).status).toBe(204);
    expect(rpcs).toEqual([{ fn: 'mailbox_sending_disconnect', args: { p_user: 'u-1' } }]);
    // The delete and the mailbox.disconnected row are the RPC's, in one transaction.
    expect(deletes).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it('a failed disconnect is a 500 that says the mailbox is still connected, with a code-only log', async () => {
    const { admin } = makeAdmin({
      'rpc:mailbox_sending_disconnect': { data: null, error: { code: 'P0001', message: 'audit chain refused md@bank.dev' } },
    });
    signedIn(admin);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await disconnect();
    const log = JSON.stringify(logged.mock.calls);
    logged.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Disconnect failed; the mailbox is still connected' });
    expect(log).toContain('P0001');
    expect(log).not.toContain('md@bank.dev');
  });
});
