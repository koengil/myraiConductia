import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { POST as webhookPost } from '@/app/api/v1/inbound/webhook/route';
import { GET as inboxGet } from '@/app/api/v1/inbox/route';
import { PATCH as inboxPatch } from '@/app/api/v1/inbox/[messageId]/route';

// The mail channel flag is ON for these tests; the off->404 path is covered
// in flags-require.test.ts.
vi.mock('@/lib/flags/requireFlag', () => ({
  requireFlag: () => Promise.resolve(null),
}));

/*
 * The receive side (v1.5).
 *
 * Webhook (provider -> platform, secret-authenticated, no user session):
 *   1. No INBOUND_WEBHOOK_SECRET configured -> 503.
 *   2. Wrong secret -> 401. Missing ?tenant -> 400.
 *   3. Direct payload -> 201, row stored; attachment bytes dropped, meta kept.
 *   4. Resend-style envelope ({type, data}) is normalized to the same row.
 *
 * Inbox reads (session-authenticated, bank-side only):
 *   5. External caller -> 403.
 *   6. Internal caller -> 200 tenant list.
 *   7. PATCH marks a message read.
 */

type Row = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Row | Row[]>) {
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Row = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'is', 'or', 'order', 'limit']) {
      builder[k] = (...args: unknown[]) => {
        calls.push({ table, method: k, args });
        return builder;
      };
    }
    builder.insert = (payload: Record<string, unknown>) => {
      inserts.push({ table, payload });
      return builder;
    };
    builder.update = (payload: Record<string, unknown>) => {
      updates.push({ table, payload });
      return builder;
    };
    builder.single = () => Promise.resolve(resp);
    builder.maybeSingle = () => Promise.resolve(resp);
    builder.then = (f: (v: Row) => unknown) => Promise.resolve(resp).then(f);
    return builder;
  };
  const admin = { from } as unknown as ReturnType<typeof createSupabaseAdminClient>;
  return { admin, inserts, updates, calls };
}

function stubAdminOnly(admin: ReturnType<typeof createSupabaseAdminClient>) {
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
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

const TENANT = '33333333-3333-4333-8333-333333333333';
const hook = (body: unknown, secret?: string, tenant = TENANT) =>
  new Request(`http://localhost/api/v1/inbound/webhook${tenant ? `?tenant=${tenant}` : ''}`, {
    method: 'POST',
    headers: secret ? { 'x-inbound-secret': secret } : {},
    body: JSON.stringify(body),
  });

const directPayload = {
  from: 'ana.moura@target.com',
  to: 'projectgunners@conductia.dev',
  subject: 'Re: Process update',
  text: 'Monday works. Sending the list tomorrow.',
  html: '<p>Monday works.</p>',
  attachments: [{ name: 'list.xlsx', contentBase64: 'aGVsbG8=', type: 'application/x' }],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('POST /api/v1/inbound/webhook', () => {
  it('503 when INBOUND_WEBHOOK_SECRET is not configured', async () => {
    vi.stubEnv('INBOUND_WEBHOOK_SECRET', '');
    const { admin } = makeAdmin({});
    stubAdminOnly(admin);
    expect((await webhookPost(hook(directPayload, 'x'))).status).toBe(503);
  });

  it('401 on a wrong secret; 400 without ?tenant', async () => {
    vi.stubEnv('INBOUND_WEBHOOK_SECRET', 'topsecret');
    const { admin } = makeAdmin({});
    stubAdminOnly(admin);
    expect((await webhookPost(hook(directPayload, 'wrong'))).status).toBe(401);
    expect((await webhookPost(hook(directPayload, 'topsecret', ''))).status).toBe(400);
  });

  // #474: each refusal writes one line with its reason; the secret a caller sent never reaches it.
  it('logs the 503 and the 401 as one line each, without the header value', async () => {
    const lines: Array<[string, string]> = [];
    const spies = (['log', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push([method, args.map(String).join(' ')]);
      }),
    );
    try {
      const { admin } = makeAdmin({});
      stubAdminOnly(admin);
      vi.stubEnv('INBOUND_WEBHOOK_SECRET', '');
      const unconfigured = await webhookPost(hook(directPayload, 'CANARY-331-sent-secret'));
      expect([unconfigured.status, await unconfigured.text()]).toEqual([503, '{"error":"Inbound not configured"}']);
      vi.stubEnv('INBOUND_WEBHOOK_SECRET', 'topsecret');
      const refused = await webhookPost(hook(directPayload, 'CANARY-331-sent-secret'));
      expect([refused.status, await refused.text()]).toEqual([401, '{"error":"Unauthorized"}']);
      expect(lines).toEqual([
        ['error', '{"evt":"auth_unavailable","reason":"misconfigured","status":503,"gate":"inbound_webhook"}'],
        ['warn', '{"evt":"auth_denied","reason":"bad_secret","status":401,"gate":"inbound_webhook"}'],
      ]);
      expect(lines.join('\n')).not.toMatch(/CANARY-331|topsecret|ana\.moura/);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('404 when the tenant has no users (phantom tenant)', async () => {
    vi.stubEnv('INBOUND_WEBHOOK_SECRET', 'topsecret');
    const { admin, inserts } = makeAdmin({
      users: { data: null, error: null },
    });
    stubAdminOnly(admin);
    expect((await webhookPost(hook(directPayload, 'topsecret'))).status).toBe(404);
    expect(inserts).toHaveLength(0);
  });

  it('stores a direct payload; attachment bytes dropped, metadata kept', async () => {
    vi.stubEnv('INBOUND_WEBHOOK_SECRET', 'topsecret');
    const { admin, inserts } = makeAdmin({
      users: { data: { id: 'u-1' }, error: null },
      inbound_messages: { data: { id: 'in-1' }, error: null },
    });
    stubAdminOnly(admin);

    const res = await webhookPost(hook(directPayload, 'topsecret'));
    expect(res.status).toBe(201);
    const row = inserts[0].payload;
    expect(inserts[0].table).toBe('inbound_messages');
    expect(row).toMatchObject({
      tenant_id: TENANT,
      from_email: 'ana.moura@target.com',
      to_email: 'projectgunners@conductia.dev',
      subject: 'Re: Process update',
      body: 'Monday works. Sending the list tomorrow.',
    });
    const meta = row.attachments as Array<Record<string, unknown>>;
    expect(meta[0].name).toBe('list.xlsx');
    expect(JSON.stringify(row)).not.toContain('aGVsbG8=');
  });

  it('normalizes a Resend-style envelope', async () => {
    vi.stubEnv('INBOUND_WEBHOOK_SECRET', 'topsecret');
    const { admin, inserts } = makeAdmin({
      users: { data: { id: 'u-1' }, error: null },
      inbound_messages: { data: { id: 'in-2' }, error: null },
    });
    stubAdminOnly(admin);

    const res = await webhookPost(
      hook(
        {
          type: 'email.received',
          data: {
            from: 'leo@buyer.com',
            to: ['projectgunners@conductia.dev'],
            subject: 'NDA comments',
            text: 'Redlines attached.',
            email_id: 'resend-in-9',
          },
        },
        'topsecret',
      ),
    );
    expect(res.status).toBe(201);
    expect(inserts[0].payload).toMatchObject({
      from_email: 'leo@buyer.com',
      to_email: 'projectgunners@conductia.dev',
      subject: 'NDA comments',
      provider_message_id: 'resend-in-9',
    });
  });
});

describe('GET /api/v1/inbox', () => {
  it('403 for an external caller', async () => {
    const { admin } = makeAdmin({
      users: { data: { firm_role: 'member', is_external: true, department: null, tenant_id: TENANT }, error: null },
    });
    signedIn(admin);
    expect((await inboxGet()).status).toBe(403);
  });

  it('200 tenant list for an internal caller', async () => {
    const { admin } = makeAdmin({
      users: { data: { firm_role: 'member', is_external: false, department: null, tenant_id: TENANT }, error: null },
      inbound_messages: {
        data: [
          {
            id: 'in-1',
            from_email: 'ana.moura@target.com',
            to_email: 'projectgunners@conductia.dev',
            cc_emails: [],
            subject: 'Re: Process update',
            body: 'Monday works.',
            body_html: null,
            attachments: [],
            provider: null,
            received_at: '2026-07-30T12:00:00Z',
            read_at: null,
          },
        ],
        error: null,
      },
    });
    signedIn(admin);
    const res = await inboxGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].from).toBe('ana.moura@target.com');
    expect(body.messages[0].read).toBe(false);
  });

  it('scopes to a deal with ?dealId but keeps UNTAGGED inbound visible (webhook tags nothing yet)', async () => {
    const { admin, calls } = makeAdmin({
      users: {
        data: { firm_role: 'member', is_external: false, department: null, tenant_id: TENANT },
        error: null,
      },
      // The code lookup, then the caller's seat on it (tenant match).
      deals: { data: { id: 'd-uuid-1', tenant_id: TENANT }, error: null },
      deal_memberships: { data: { id: 'seat-1' }, error: null },
      inbound_messages: { data: [], error: null },
    });
    signedIn(admin);
    const res = await inboxGet(
      new Request('http://localhost/api/v1/inbox?dealId=zephy-2026-640'),
    );
    expect(res.status).toBe(200);
    expect(
      calls.some(
        (c) =>
          c.table === 'inbound_messages' &&
          c.method === 'or' &&
          c.args[0] === 'deal_id.eq.d-uuid-1,deal_id.is.null',
      ),
    ).toBe(true);
  });

  // D65, #245: a deal the caller cannot see and a deal-shaped ref that matches
  // nothing both keep only the untagged rows. A made-up code used to drop the
  // filter, while a real deal kept its tagged rows, which told the two apart.
  it.each([
    ['a real deal without a seat', 'zephy-2026-640', { id: 'd-uuid-1', tenant_id: TENANT }],
    ['a deal code that matches nothing', 'zephy-2026-999', null],
    ['a UUID that matches nothing', '22222222-2222-4222-8222-222222222222', null],
  ])('?dealId naming %s keeps only untagged inbound', async (_kind, ref, deal) => {
    const { admin, calls } = makeAdmin({
      users: {
        data: { firm_role: 'member', is_external: false, department: null, tenant_id: TENANT },
        error: null,
      },
      deals: { data: deal, error: null },
      deal_memberships: { data: null, error: null },
      inbound_messages: { data: [], error: null },
    });
    signedIn(admin);
    const res = await inboxGet(new Request(`http://localhost/api/v1/inbox?dealId=${ref}`));
    expect(res.status).toBe(200);
    const filters = calls.filter(
      (c) => c.table === 'inbound_messages' && (c.method === 'or' || c.method === 'is'),
    );
    expect(filters.map((c) => [c.method, ...c.args])).toEqual([['is', 'deal_id', null]]);
  });

  it('an unresolvable ?dealId (sandbox slug) leaves the inbox tenant-wide', async () => {
    const { admin, calls } = makeAdmin({
      users: {
        data: { firm_role: 'member', is_external: false, department: null, tenant_id: TENANT },
        error: null,
      },
      deals: { data: null, error: null },
      inbound_messages: { data: [], error: null },
    });
    signedIn(admin);
    const res = await inboxGet(
      new Request('http://localhost/api/v1/inbox?dealId=project-summit'),
    );
    expect(res.status).toBe(200);
    expect(
      calls.some(
        (c) =>
          c.table === 'inbound_messages' &&
          (c.method === 'or' || (c.method === 'eq' && c.args[0] === 'deal_id')),
      ),
    ).toBe(false);
  });
});

describe('PATCH /api/v1/inbox/{messageId}', () => {
  it('marks a message read', async () => {
    const { admin, updates } = makeAdmin({
      users: { data: { firm_role: 'member', is_external: false, department: null, tenant_id: TENANT }, error: null },
      inbound_messages: { data: { id: 'in-1' }, error: null },
    });
    signedIn(admin);
    const res = await inboxPatch(
      new Request('http://localhost/api/v1/inbox/in-1', {
        method: 'PATCH',
        body: JSON.stringify({ read: true }),
      }),
      { params: Promise.resolve({ messageId: 'in-1' }) },
    );
    expect(res.status).toBe(200);
    expect(updates[0].table).toBe('inbound_messages');
    expect(updates[0].payload.read_at).toBeTruthy();
  });
});
