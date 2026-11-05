import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

const sendMock = vi.fn();
vi.mock('@/lib/email/transport', () => ({
  getEmailTransport: () => ({ provider: 'mock', send: sendMock }),
  defaultFromAddress: () => 'Conductia <deals@conductia.dev>',
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
import { PATCH } from '@/app/api/v1/outbox/[messageId]/route';
import { OperatorCopyError, UpstreamHttpError } from '@/lib/errors/upstream';

/*
 * PATCH /api/v1/outbox/{messageId} — the supervisory review verbs over a HELD
 * message. Overseer (CCO/admin) only — and never the message's own sender
 * (four-eyes, #165).
 *   release -> the reviewer sends it: provider send, status 'sent',
 *              audit 'release' + 'send'. Attachments are NOT re-sent (bytes
 *              not retained) and the response says so.
 *   reject  -> status 'rejected' with the note; audit 'reject'. Never sent.
 */

type Row = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Row | Row[]>) {
  const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Row = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const k of ['select', 'eq', 'order', 'limit']) builder[k] = chain;
    builder.update = (payload: Record<string, unknown>) => {
      updates.push({ table, payload });
      return builder;
    };
    builder.insert = (payload: Record<string, unknown>) => {
      inserts.push({ table, payload });
      return builder;
    };
    builder.single = () => Promise.resolve(resp);
    builder.maybeSingle = () => Promise.resolve(resp);
    builder.then = (f: (v: Row) => unknown) => Promise.resolve(resp).then(f);
    return builder;
  };
  const admin = { from } as unknown as ReturnType<typeof createSupabaseAdminClient>;
  return { admin, updates, inserts };
}

function signedIn(admin: ReturnType<typeof createSupabaseAdminClient>, id = 'cco-1') {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id, email: 'cco@bank.dev' } }, error: null }),
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
const ccoRow = {
  data: { firm_role: 'cco', is_external: false, department: null, tenant_id: TENANT },
  error: null,
};
const bankerRow = {
  data: { firm_role: 'member', is_external: false, department: null, tenant_id: TENANT },
  error: null,
};

const heldRow = (over: Record<string, unknown> = {}) => ({
  data: {
    id: 'msg-h1',
    status: 'held',
    sender_id: 'md-1',
    to_emails: ['founder@target.com'],
    cc_emails: [],
    bcc_emails: [],
    subject: 'Valuation range',
    body: 'Our internal model floors this at $510M',
    body_html: null,
    attachments: [],
    deal_id: null,
    ...over,
  },
  error: null,
});

const patch = (id: string, body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/v1/outbox/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ messageId: id }) },
  );

afterEach(() => vi.clearAllMocks());

describe('PATCH /api/v1/outbox/{messageId}', () => {
  it('release: claim-first (held -> pending), then sent, audit release + send', async () => {
    sendMock.mockResolvedValue({ id: 'prov-r1', provider: 'mock' });
    const { admin, updates, inserts } = makeAdmin({
      users: ccoRow,
      outbound_messages: [
        heldRow(),
        { data: { id: 'msg-h1' }, error: null },
        { data: { id: 'msg-h1', status: 'sent' }, error: null },
      ],
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    signedIn(admin);

    const res = await patch('msg-h1', { action: 'release', note: 'Reviewed, fine to send.' });
    expect(res.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    // The claim happens BEFORE the provider call and carries the reviewer.
    expect(updates[0].payload).toMatchObject({
      status: 'pending',
      reviewed_by: 'cco-1',
      review_note: 'Reviewed, fine to send.',
    });
    expect(updates[1].payload).toMatchObject({
      status: 'sent',
      provider: 'mock',
      provider_message_id: 'prov-r1',
    });
    expect(inserts.map((i) => i.payload.action)).toEqual(['release', 'send']);
  });

  it('a concurrent release loses the claim race -> 409, provider never called', async () => {
    const { admin } = makeAdmin({
      users: ccoRow,
      // Load still shows held, but by claim time another reviewer won: the
      // conditional held->pending update matches no row.
      outbound_messages: [heldRow(), { data: null, error: null }],
    });
    signedIn(admin);

    const res = await patch('msg-h1', { action: 'release' });
    expect(res.status).toBe(409);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('release with attachments warns they are not re-sent', async () => {
    sendMock.mockResolvedValue({ id: 'prov-r2', provider: 'mock' });
    const { admin } = makeAdmin({
      users: ccoRow,
      outbound_messages: [
        heldRow({ attachments: [{ name: 'model.xlsx', bytes: 100 }] }),
        { data: { id: 'msg-h1' }, error: null },
        { data: { id: 'msg-h1', status: 'sent' }, error: null },
      ],
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    signedIn(admin);

    const res = await patch('msg-h1', { action: 'release' });
    const body = await res.json();
    expect(body.releasedWithoutAttachments).toBe(true);
    const sent = sendMock.mock.calls[0][0];
    expect(sent.attachments).toBeUndefined();
  });

  it('a provider refusal on release -> 502 with a code, the claim is returned', async () => {
    sendMock.mockRejectedValue(new UpstreamHttpError('resend', 'send', 403, 'validation_error'));
    const { admin, updates } = makeAdmin({
      users: ccoRow,
      outbound_messages: [heldRow(), { data: { id: 'msg-h1' }, error: null }, { data: null, error: null }],
    });
    signedIn(admin);

    const res = await patch('msg-h1', { action: 'release' });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('Email provider send failed (resend_403)');
    expect(updates[1].payload).toMatchObject({ status: 'held', reviewed_by: null });
  });

  it('V8: operator copy on release passes through word for word', async () => {
    sendMock.mockRejectedValue(
      new OperatorCopyError('EMAIL_PROVIDER=resend requires RESEND_API_KEY'),
    );
    const { admin } = makeAdmin({
      users: ccoRow,
      outbound_messages: [heldRow(), { data: { id: 'msg-h1' }, error: null }, { data: null, error: null }],
    });
    signedIn(admin);

    const res = await patch('msg-h1', { action: 'release' });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(
      'Email provider send failed: EMAIL_PROVIDER=resend requires RESEND_API_KEY',
    );
  });

  it('reject: never sends, status rejected, audit reject', async () => {
    const { admin, updates, inserts } = makeAdmin({
      users: ccoRow,
      outbound_messages: [heldRow(), { data: { id: 'msg-h1', status: 'rejected' }, error: null }],
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const res = await patch('msg-h1', { action: 'reject', note: 'Remove the number first.' });
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
    expect(updates[0].payload).toMatchObject({ status: 'rejected' });
    expect(inserts.map((i) => i.payload.action)).toEqual(['reject']);
  });

  // #331 F3: every database failure on this route answers fixed copy and the code, never the database message,
  // which can quote the note or the message. One row per failing step, so each rewritten site has a canary.
  const CANARY = 'CANARY-331-F3';
  const dbError = { data: null, error: { code: '22001', message: `value too long for type character varying(200): ${CANARY}` } };
  const ok = (data: unknown = null) => ({ data, error: null });
  it.each([
    { step: 'message lookup', action: 'release', copy: 'Message lookup failed', outbound: [dbError], audit: [] },
    { step: 'reject write', action: 'reject', copy: 'Reject write failed', outbound: [heldRow(), dbError], audit: [] },
    {
      step: 'reject audit',
      action: 'reject',
      copy: 'Audit write failed',
      outbound: [heldRow(), ok({ id: 'msg-h1', status: 'rejected' })],
      audit: [dbError],
    },
    { step: 'release claim', action: 'release', copy: 'Release claim failed', outbound: [heldRow(), dbError], audit: [] },
    {
      step: 'sent record update',
      action: 'release',
      copy: 'Message sent but record update failed',
      outbound: [heldRow(), ok({ id: 'msg-h1' }), dbError],
      audit: [],
    },
    {
      step: 'release audit',
      action: 'release',
      copy: 'Message sent but audit write failed',
      outbound: [heldRow(), ok({ id: 'msg-h1' }), ok({ id: 'msg-h1', status: 'sent' })],
      audit: [dbError],
    },
    {
      step: 'send audit',
      action: 'release',
      copy: 'Message sent but audit write failed',
      outbound: [heldRow(), ok({ id: 'msg-h1' }), ok({ id: 'msg-h1', status: 'sent' })],
      audit: [ok(), dbError],
    },
  ])('#331 F3 canary: a $step failure answers a code, never the database message', async ({ action, copy, outbound, audit }) => {
    sendMock.mockResolvedValue({ id: 'prov-c1', provider: 'mock' });
    const { admin } = makeAdmin({ users: ccoRow, outbound_messages: [...outbound], audit_log: [...audit] });
    signedIn(admin);

    const res = await patch('msg-h1', { action, note: CANARY });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: `${copy} (22001)` });
  });

  it('four-eyes (#165): an overseer never reviews their OWN held message', async () => {
    // The signed-in CCO is the sender of the held row: both verbs are denied
    // and the provider is never touched.
    const a = makeAdmin({
      users: ccoRow,
      outbound_messages: heldRow({ sender_id: 'cco-1' }),
    });
    signedIn(a.admin, 'cco-1');
    for (const action of ['release', 'reject'] as const) {
      const res = await patch('msg-h1', { action });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/its sender/);
    }
    expect(sendMock).not.toHaveBeenCalled();
    expect(a.updates).toEqual([]);
  });

  it('403 for a non-overseer; 409 when the message is not held', async () => {
    const a = makeAdmin({ users: bankerRow });
    signedIn(a.admin, 'md-1');
    const res = await patch('msg-h1', { action: 'release' });
    expect(res.status).toBe(403);
    // 'Forbidden' pins this 403 to the overseer gate, not the four-eyes
    // guard (the fixture default sender is also md-1).
    expect((await res.json()).error).toBe('Forbidden');

    vi.clearAllMocks();
    const b = makeAdmin({
      users: ccoRow,
      outbound_messages: heldRow({ status: 'sent' }),
    });
    signedIn(b.admin);
    expect((await patch('msg-h1', { action: 'release' })).status).toBe(409);
  });
});

describe('concurrent release of the same held message', () => {
  it('two releases at once -> exactly one provider send, the other 409s', async () => {
    // A stateful fake of the one row: the claim is honored only while the
    // row still matches every filter, as the conditional UPDATE does in SQL.
    let status = 'held';
    const inserts: unknown[] = [];
    const from = (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let patch: Record<string, unknown> | null = null;
      const builder: Record<string, unknown> = {};
      for (const k of ['select', 'order', 'limit']) builder[k] = () => builder;
      builder.eq = (col: string, val: unknown) => {
        filters.push([col, val]);
        return builder;
      };
      builder.update = (p: Record<string, unknown>) => {
        patch = p;
        return builder;
      };
      builder.insert = (p: unknown) => {
        inserts.push(p);
        return builder;
      };
      const resolve = async () => {
        await Promise.resolve();
        if (table === 'users') return ccoRow;
        if (table !== 'outbound_messages') return { data: null, error: null };
        const matches = filters.every(([col, val]) => col !== 'status' || val === status);
        if (!patch) return { data: { ...heldRow().data, status }, error: null };
        if (!matches) return { data: null, error: null };
        status = (patch as { status?: string }).status ?? status;
        return { data: { id: 'msg-h1', status }, error: null };
      };
      builder.single = resolve;
      builder.maybeSingle = resolve;
      builder.then = (f: (v: unknown) => unknown) => resolve().then(f);
      return builder;
    };
    const admin = { from } as unknown as ReturnType<typeof createSupabaseAdminClient>;
    signedIn(admin);
    sendMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { id: 'prov-once', provider: 'mock' };
    });

    const results = await Promise.all([
      patch('msg-h1', { action: 'release' }),
      patch('msg-h1', { action: 'release' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(status).toBe('sent');
  });
});
