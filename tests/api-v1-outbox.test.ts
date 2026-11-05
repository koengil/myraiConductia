import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

const reviewMock=vi.hoisted(()=>vi.fn(async()=>({recipients:[],policyFingerprint:'base'})));
vi.mock('@/lib/api/v1/recipientReview',async original=>({...await original<object>(),loadRecipientReview:reviewMock}));
const sendMock = vi.fn();
const PLATFORM_FROM = 'Conductia <deals@conductia.dev>';
const fromMock = vi.fn((): string => PLATFORM_FROM);
vi.mock('@/lib/email/transport', () => ({
  getEmailTransport: () => ({ provider: 'mock', send: sendMock }),
  defaultFromAddress: () => fromMock(),
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
import { GET, POST } from '@/app/api/v1/outbox/route';
import { mintScreenToken } from '@/lib/compliance/screenToken';
import { DEV_TENANT_ID } from '@/lib/db/tenant';
import { mintReplyToken } from '@/lib/email/replyToken';
import { OperatorCopyError, UpstreamHttpError } from '@/lib/errors/upstream';
import { encryptTokens } from '@/lib/email/tokenCrypto';
import { resolveSender, SENDER_REMEDY } from '@/lib/email/sender';
import { GMAIL_RECONNECT_COPY, GMAIL_UNCONFIGURED_COPY, MAILBOX_CHANGED_COPY } from '@/lib/constants/mailboxSend';
import { GATEWAY_MESSAGES_URL } from '@/lib/modelGateway/gatewayClient';
import { buildPdf, buildPdfPages, buildZip } from './helpers/attachmentFixtures';
import { fakeGmailSend, invalidGrant, jsonResponse, sentOk } from './helpers/fakeGmailSend';

// The send-as-is token is HMAC-signed (#192 slice 2b).
process.env.OUTBOX_SCREEN_SECRET = 'test-screen-secret';

/*
 * /api/v1/outbox — the send path of the compliance email client (Component B
 * server side). Every send attempt is screened in mode full FIRST; the verdict
 * decides the outcome:
 *   compliant -> provider send, row status 'sent', audit 'screen' + 'send'.
 *   hold      -> NO send, row status 'held' (the supervisory queue), audit 'screen'.
 *   blocked   -> NO send, row status 'blocked' + rewrite back, audit 'screen'.
 */

type Row = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Row | Row[]>) {
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const deletes: Array<{ table: string }> = [];
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const rpcs: Array<{ fn: string; args: unknown }> = [];
  // An RPC answers from tables['rpc:<name>'], like a table.
  const rpc = (fn: string, args: unknown) => {
    rpcs.push({ fn, args });
    const entry = tables[`rpc:${fn}`];
    return Promise.resolve(
      Array.isArray(entry) ? (entry.shift() ?? { data: null, error: null }) : (entry ?? { data: null, error: null }),
    );
  };
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Row = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'in', 'order', 'limit']) {
      builder[k] = (...args: unknown[]) => {
        calls.push({ table, method: k, args });
        return builder;
      };
    }
    builder.insert = (payload: Record<string, unknown>) => {
      inserts.push({ table, payload });
      return builder;
    };
    builder.upsert = (payload: Record<string, unknown>) => {
      inserts.push({ table, payload });
      return builder;
    };
    builder.update = (payload: Record<string, unknown>) => {
      updates.push({ table, payload });
      return builder;
    };
    builder.delete = () => {
      deletes.push({ table });
      return builder;
    };
    builder.single = () => Promise.resolve(resp);
    builder.maybeSingle = () => Promise.resolve(resp);
    builder.then = (f: (v: Row) => unknown) => Promise.resolve(resp).then(f);
    return builder;
  };
  const admin = { from, rpc } as unknown as ReturnType<typeof createSupabaseAdminClient>;
  return { admin, inserts, updates, deletes, calls, rpcs };
}

function signedIn(admin: ReturnType<typeof createSupabaseAdminClient>, id = 'md-1') {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id, email: 'storm@bank.dev' } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

const senderRow = { data: { tenant_id: 'tenant-1', firm_role: 'banker' }, error: null };
// The model gate (#339) lets the screen's model pass run only for a synthetic
// tenant on a local, non-prod stack (or a verified processor, which ships off).
// Tests that exercise the model pass send as the DEV tenant on a local URL.
const devSenderRow = { data: { tenant_id: DEV_TENANT_ID, firm_role: 'banker' }, error: null };
// The gate decision a send screen's token carries (#339): the DEV tenant's synthetic path.
const DEV_SEND_DECISION = { allowed: true, basis: 'synthetic_tenant', purpose: 'mail_send_screen', tenantId: DEV_TENANT_ID } as const;
function localStack() {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
}
const ccoRow = { data: { tenant_id: 'tenant-1', firm_role: 'cco' }, error: null };
const insertedRow = (over: Record<string, unknown>) => ({
  data: {
    id: 'msg-1',
    status: 'sent',
    verdict: 'compliant',
    reasons: [],
    rewrite: null,
    llm_checked: false,
    provider_message_id: null,
    created_at: '2026-07-29T12:00:00Z',
    ...over,
  },
  error: null,
});

const post = (body: unknown) =>
  new Request('http://localhost/api/v1/outbox', {
    method: 'POST',
    body: JSON.stringify(body),
  });

const compliantDraft = {
  to: ['founder@target.com'],
  subject: 'Process update',
  body: 'The room opens Monday.',
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  fromMock.mockImplementation(() => PLATFORM_FROM);
  reviewMock.mockReset().mockResolvedValue({recipients:[],policyFingerprint:'base'});
});

describe('POST /api/v1/outbox', () => {
  it('compliant -> record-first: pending row BEFORE the send, then sent + audits', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockResolvedValue({ id: 'prov-1', provider: 'mock' });
    const { admin, inserts, updates } = makeAdmin({
      users: senderRow,
      outbound_messages: [
        insertedRow({ status: 'pending' }),
        insertedRow({ status: 'sent', provider_message_id: 'prov-1' }),
      ],
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    signedIn(admin);

    const res = await POST(post(compliantDraft));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message.status).toBe('sent');
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Record-first: the row is INSERTED as pending (before anything can
    // leave) and only the post-send UPDATE flips it to sent.
    const outboxInsert = inserts.find((i) => i.table === 'outbound_messages');
    expect(outboxInsert?.payload).toMatchObject({
      tenant_id: 'tenant-1',
      sender_id: 'md-1',
      status: 'pending',
      provider: null,
      verdict: 'compliant',
      subject: 'Process update',
      body: 'The room opens Monday.',
      // #192: a proceeding message stores its band (LLM off + no sign-offs
      // -> routine); the raw score is never in the payload.
      risk_band: 'routine',
    });
    const outboxUpdate = updates.find((u) => u.table === 'outbound_messages');
    expect(outboxUpdate?.payload).toMatchObject({
      status: 'sent',
      provider: 'mock',
      provider_message_id: 'prov-1',
    });
    const auditActions = inserts
      .filter((i) => i.table === 'audit_log')
      .map((i) => i.payload.action);
    expect(auditActions).toEqual(['screen', 'send']);
    const screenDetail = inserts.find((i) => i.table === 'audit_log')?.payload
      .detail as Record<string, unknown>;
    expect(screenDetail.riskBand).toBe('routine');
    expect(screenDetail).not.toHaveProperty('heat');
  });

  it('MNPI hidden in the HTML body (compliant text) -> risk issues back to the sender', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const { admin, inserts } = makeAdmin({
      users: senderRow,
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const res = await POST(
      post({
        ...compliantDraft,
        html: '<p>Our internal model floors this at <b>$510M</b></p>',
      }),
    );
    // #192: nothing holds — the screened HTML still cannot sneak past the
    // control; the risk issues return to the sender, nothing stored or sent.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.riskIssues.cause).toBe('mnpi');
    expect(sendMock).not.toHaveBeenCalled();
    expect(inserts.some((i) => i.table === 'outbound_messages')).toBe(false);
  });

  it('a simulated (noop) delivery is marked simulated in the send audit detail', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockResolvedValue({ id: 'noop-1', provider: 'noop', simulated: true });
    const { admin, inserts } = makeAdmin({
      users: senderRow,
      outbound_messages: [
        insertedRow({ status: 'pending' }),
        insertedRow({ status: 'sent', provider_message_id: 'noop-1' }),
      ],
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    signedIn(admin);

    const res = await POST(post(compliantDraft));
    expect(res.status).toBe(201);
    const sendAudit = inserts.find(
      (i) => i.table === 'audit_log' && i.payload.action === 'send',
    );
    expect((sendAudit?.payload.detail as Record<string, unknown>).simulated).toBe(true);
  });

  it('an MNPI read returns risk issues with a binding token; only the screen is audited', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const { admin, inserts } = makeAdmin({
      users: senderRow,
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const res = await POST(
      post({ ...compliantDraft, body: 'Our internal model floors this at $510M' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.riskIssues.cause).toBe('mnpi');
    expect(body.riskIssues.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sendMock).not.toHaveBeenCalled();
    const auditActions = inserts
      .filter((i) => i.table === 'audit_log')
      .map((i) => i.payload.action);
    expect(auditActions).toEqual(['screen']);
    // A screen returned to the sender proceeds nowhere — no band on its row.
    const detail = inserts[0].payload.detail as Record<string, unknown>;
    expect(detail).not.toHaveProperty('riskBand');
  });

  it('a promissory hit (in the SUBJECT too) returns risk issues with the rewrite advice', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const { admin, inserts } = makeAdmin({
      users: senderRow,
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const res = await POST(
      post({ ...compliantDraft, subject: 'We guarantee the price' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.riskIssues.cause).toBe('promissory');
    // Rules-only screen: the note is ADVICE, never a sendable body (#192
    // review — one click must not email compliance guidance to a client).
    expect(body.riskIssues.rewrite).toBeNull();
    expect(body.riskIssues.advice).toBeTruthy();
    expect(sendMock).not.toHaveBeenCalled();
    expect(inserts.some((i) => i.table === 'outbound_messages')).toBe(false);
  });

  it('cc/bcc/html/attachments: forwarded to the provider, metadata stored, bytes NOT stored', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockResolvedValue({ id: 'prov-2', provider: 'mock' });
    const { admin, inserts } = makeAdmin({
      users: senderRow,
      outbound_messages: [
        insertedRow({ status: 'pending' }),
        insertedRow({ status: 'sent', provider_message_id: 'prov-2' }),
      ],
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    signedIn(admin);

    const res = await POST(
      post({
        ...compliantDraft,
        cc: ['counsel@bank.dev'],
        bcc: ['records@bank.dev'],
        html: '<p>The room opens <strong>Monday</strong>.</p>',
        attachments: [
          { name: 'teaser.txt', contentBase64: 'aGVsbG8=', type: 'text/plain' },
        ],
      }),
    );
    expect(res.status).toBe(201);

    const sent = sendMock.mock.calls[0][0];
    expect(sent.cc).toEqual(['counsel@bank.dev']);
    expect(sent.bcc).toEqual(['records@bank.dev']);
    expect(sent.html).toContain('<strong>');
    expect(sent.attachments).toEqual([
      { filename: 'teaser.txt', contentBase64: 'aGVsbG8=', contentType: 'text/plain' },
    ]);

    const row = inserts.find((i) => i.table === 'outbound_messages')?.payload as Record<
      string,
      unknown
    >;
    expect(row.cc_emails).toEqual(['counsel@bank.dev']);
    expect(row.bcc_emails).toEqual(['records@bank.dev']);
    expect(row.body_html).toContain('<strong>');
    const meta = row.attachments as Array<Record<string, unknown>>;
    expect(meta).toHaveLength(1);
    expect(meta[0].name).toBe('teaser.txt');
    expect(meta[0].bytes).toBe(5);
    expect(meta[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('aGVsbG8=');
  });

  it('rejects an invalid cc address and an oversized attachment set', async () => {
    const { admin } = makeAdmin({ users: senderRow });
    signedIn(admin);
    expect((await POST(post({ ...compliantDraft, cc: ['nope'] }))).status).toBe(400);
    const big = 'A'.repeat(4_200_000);
    expect(
      (
        await POST(
          post({ ...compliantDraft, attachments: [{ name: 'big.bin', contentBase64: big }] }),
        )
      ).status,
    ).toBe(400);
  });

  it('provider failure -> 502 with a code, the pending row is dropped (the message can be retried)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockRejectedValue(new UpstreamHttpError('resend', 'send', 403, 'validation_error'));
    const { admin, inserts, deletes } = makeAdmin({
      users: senderRow,
      outbound_messages: [insertedRow({ status: 'pending' }), { data: null, error: null }],
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const res = await POST(post(compliantDraft));
    expect(res.status).toBe(502);
    // V7: the provider's sentence is gone, the code stays.
    expect((await res.json()).error).toBe('Email provider send failed (resend_403)');
    // Record-first still held: the row existed before the send attempt...
    expect(inserts.find((i) => i.table === 'outbound_messages')?.payload.status).toBe('pending');
    // ...and was dropped when nothing left, so the sender can retry.
    expect(deletes.some((d) => d.table === 'outbound_messages')).toBe(true);
  });

  it('V8: operator copy passes through the 502 word for word', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockRejectedValue(new OperatorCopyError('Mailbox connection expired; reconnect the mailbox'));
    const { admin } = makeAdmin({
      users: senderRow,
      outbound_messages: [insertedRow({ status: 'pending' }), { data: null, error: null }],
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const res = await POST(post(compliantDraft));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(
      'Email provider send failed: Mailbox connection expired; reconnect the mailbox',
    );
  });

  it('an unclassified provider error answers with an unexpected code, never its message', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockRejectedValue(new Error('domain not verified for founder@target.com'));
    const { admin } = makeAdmin({
      users: senderRow,
      outbound_messages: [insertedRow({ status: 'pending' }), { data: null, error: null }],
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const res = await POST(post(compliantDraft));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('Email provider send failed (unexpected)');
  });

  // #490 (R18): the platform From is resolved only when the platform
  // transport sends, so a missing EMAIL_FROM fails that send alone.
  const emailFromUnset = () => resolveSender('EMAIL_FROM', {});

  it('EMAIL_FROM unset outside dev: a Graph-connected send still leaves, as the mailbox', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    vi.stubEnv('MS_CLIENT_ID', 'client-1');
    vi.stubEnv('MS_CLIENT_SECRET', 'shh');
    vi.stubEnv('MS_REDIRECT_URI', 'http://localhost:3000/api/v1/mailbox/callback');
    vi.stubEnv('MAILBOX_TOKEN_KEY', 'a'.repeat(64));
    fromMock.mockImplementation(emailFromUnset);
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('/oauth2/v2.0/token')
        ? { ok: true, json: async () => ({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }) }
        : { ok: true, status: 202 },
    );
    vi.stubGlobal('fetch', fetchMock);
    const tokens = encryptTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 });
    const { admin, updates } = makeAdmin({
      users: senderRow,
      mailbox_connections: {
        data: { id: 'mb-1', user_id: 'md-1', provider: 'microsoft', email: 'storm@bank.dev', status: 'connected', tokens_encrypted: tokens },
        error: null,
      },
      outbound_messages: [
        insertedRow({ status: 'pending' }),
        insertedRow({ status: 'sent', provider: 'graph' }),
      ],
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    signedIn(admin);

    const res = await POST(post(compliantDraft));
    vi.unstubAllGlobals();
    expect(res.status).toBe(201);
    expect(fromMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
    expect(updates.find((u) => u.table === 'outbound_messages')?.payload).toMatchObject({
      status: 'sent',
      provider: 'graph',
    });
  });

  it('EMAIL_FROM unset outside dev: the platform send still fails closed with the operator copy', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    vi.stubEnv('MS_CLIENT_ID', '');
    fromMock.mockImplementation(emailFromUnset);
    const { admin, deletes } = makeAdmin({
      users: senderRow,
      outbound_messages: [insertedRow({ status: 'pending' }), { data: null, error: null }],
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const res = await POST(post(compliantDraft));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(
      'Email provider send failed: EMAIL_FROM is not set, so mail falls back to the ' +
        `onboarding@resend.dev sandbox sender. ${SENDER_REMEDY}`,
    );
    expect(fromMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
    expect(deletes.some((d) => d.table === 'outbound_messages')).toBe(true);
  });

  it('audit write failure BEFORE the send aborts the send entirely', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockResolvedValue({ id: 'prov-1', provider: 'mock' });
    const { admin } = makeAdmin({
      users: senderRow,
      audit_log: { data: null, error: { message: 'audit down' } },
    });
    signedIn(admin);

    const res = await POST(post(compliantDraft));
    expect(res.status).toBe(500);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('#331 F3 canary: an outbox insert failure answers a code, never the database message that quotes the draft', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const { admin } = makeAdmin({
      users: senderRow,
      audit_log: { data: null, error: null },
      outbound_messages: {
        data: null,
        error: { code: '22001', message: 'value too long for type character varying(200): CANARY-331-F3' },
      },
    });
    signedIn(admin);

    const res = await POST(post(compliantDraft));
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('CANARY-331-F3');
    expect(text).toContain('22001');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('resolves a deal CODE dealId (lowercased by the URL) and tags the record', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockResolvedValue({ id: 'prov-3', provider: 'mock' });
    const { admin, inserts } = makeAdmin({
      deals: [
        { data: { id: 'd-uuid-1' }, error: null }, // code -> uuid
        { data: { tenant_id: 'tenant-1' }, error: null }, // membership tenant check
        { data: { lifecycle_category: 'live' }, error: null },
      ],
      users: [
        { data: { status: 'active' }, error: null }, // requireApiUser invited-status check
        { data: { firm_role: null, tenant_id: 'tenant-1' }, error: null }, // access predicate
        senderRow,
      ],
      deal_memberships: { data: { id: 'm1' }, error: null }, // member of the deal
      outbound_messages: [
        insertedRow({ status: 'pending' }),
        insertedRow({ status: 'sent', provider_message_id: 'prov-3' }),
      ],
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    signedIn(admin);

    const res = await POST(post({ ...compliantDraft, dealId: 'zephy-2026-640' }));
    expect(res.status).toBe(201);
    const row = inserts.find((i) => i.table === 'outbound_messages');
    expect(row?.payload.deal_id).toBe('d-uuid-1');
  });

  it('an unresolvable dealRef (sandbox slug) sends UNTAGGED instead of failing', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockResolvedValue({ id: 'prov-4', provider: 'mock' });
    const { admin, inserts } = makeAdmin({
      deals: { data: null, error: null }, // no such code
      users: senderRow,
      outbound_messages: [
        insertedRow({ status: 'pending' }),
        insertedRow({ status: 'sent', provider_message_id: 'prov-4' }),
      ],
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    signedIn(admin);

    const res = await POST(post({ ...compliantDraft, dealId: 'project-summit' }));
    expect(res.status).toBe(201);
    const row = inserts.find((i) => i.table === 'outbound_messages');
    expect(row?.payload.deal_id).toBeNull();
  });

  // D65, #245: a deal-shaped ref that matches nothing used to send untagged
  // (a code) or answer 403 (a UUID), while a real deal the caller cannot see
  // answered 403. All three now get the "no such deal" answer, and nothing sends.
  it.each([
    ['a deal code', 'zephy-2026-999'],
    ['a UUID', '22222222-2222-4222-8222-222222222222'],
  ])('%s that matches no deal answers like a missing deal and sends nothing', async (_kind, dealId) => {
    const { admin, inserts } = makeAdmin({
      deals: { data: null, error: null },
      users: senderRow,
    });
    signedIn(admin);

    const res = await POST(post({ ...compliantDraft, dealId }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Deal not found' });
    expect(inserts).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('preApproved claims are validated against REAL hits and never soften the verdict (#156)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const { admin, inserts } = makeAdmin({
      users: senderRow,
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const res = await POST(
      post({
        ...compliantDraft,
        body: 'Our internal model floors this at $510M',
        // One real hit, one fabricated claim, one junk value.
        preApproved: ['Internal Model', 'not-a-real-hit', 42],
      }),
    );
    expect(res.status).toBe(200);
    // The deterministic control does not bend to sender sign-off: the MNPI
    // read still comes back as risk issues, not a clean send.
    expect((await res.json()).riskIssues.cause).toBe('mnpi');
    expect(sendMock).not.toHaveBeenCalled();

    const screenAudit = inserts.find(
      (i) => i.table === 'audit_log' && i.payload.action === 'screen',
    );
    const detail = screenAudit?.payload.detail as Record<string, unknown>;
    // Only the term the rule pack itself matched is recorded; the fabricated
    // claim and the junk value are dropped.
    expect(detail.preApproved).toEqual(['internal model']);
    // Every screen audit cites the lexicon version it enforced (#163) — the
    // lexicon is a working draft, so the record must say which vocabulary ran.
    expect(detail.lexiconVersion).toBe('1.0 (2026-08-11)');
  });

  it('a reputational-only read returns risk issues: 200 back to the sender, nothing stored', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    localStack();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  verdict: 'hold',
                  reasons: ['Disparaging remark about the counterparty CFO.'],
                  cause: 'reputational',
                  heat: 58,
                  rewrite: 'Their CFO seemed to struggle with the numbers.',
                }),
              },
            ],
          }),
      }),
    );
    const { admin, inserts } = makeAdmin({
      users: devSenderRow,
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const res = await POST(
      post({ ...compliantDraft, body: 'Honestly their CFO is a clown.' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.riskIssues.reasons[0]).toMatch(/disparaging/i);
    expect(body.riskIssues.heat).toBe(58);
    expect(body.riskIssues.cause).toBe('reputational');
    expect(body.riskIssues.rewrite).toContain('struggle');
    // The send-as-is token is the FIRST screen's read, signed and bound to
    // the content sha (#192 slice 2b) — opaque to the client.
    expect(body.riskIssues.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // Nothing stored, nothing sent — the decision went back to the sender.
    expect(inserts.some((i) => i.table === 'outbound_messages')).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
    // The control firing IS recorded (cause included, heat deliberately not).
    const screenAudit = inserts.find(
      (i) => i.table === 'audit_log' && i.payload.action === 'screen',
    );
    const detail = screenAudit?.payload.detail as Record<string, unknown>;
    expect(detail.holdCause).toBe('reputational');
    expect(JSON.stringify(detail)).not.toContain('58');
    vi.unstubAllGlobals();
  });

  it('send-as-is SENDS a reputational read, replaying the FIRST screen — one LLM call, not two (#192 slice 2b)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    localStack();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                verdict: 'hold',
                reasons: ['Front-page risk.'],
                cause: 'reputational',
                heat: 41,
              }),
            },
          ],
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    sendMock.mockResolvedValue({ id: 'prov-r1', provider: 'mock' });
    const { admin, inserts } = makeAdmin({
      users: devSenderRow,
      outbound_messages: [
        insertedRow({ status: 'pending', verdict: 'hold' }),
        insertedRow({ status: 'sent', verdict: 'hold', provider_message_id: 'prov-r1' }),
      ],
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    signedIn(admin);

    // First screen: the sender sees the risk issues and gets the token.
    const first = await POST(post({ ...compliantDraft, body: 'Honestly their CFO is a clown.' }));
    expect(first.status).toBe(200);
    const { token } = (await first.json()).riskIssues;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Resubmit as-is: the token replays that screen — no second LLM call.
    const res = await POST(
      post({
        ...compliantDraft,
        body: 'Honestly their CFO is a clown.',
        sendAsIs: true,
        overrideToken: token,
      }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).message.status).toBe('sent');
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The row records the read the sender SAW — the first screen's verdict
    // and reasons, with the sent status (what happened).
    const row = inserts.find((i) => i.table === 'outbound_messages');
    expect(row?.payload.verdict).toBe('hold');
    expect(row?.payload.reasons).toEqual(['Front-page risk.']);
    expect(row?.payload.llm_checked).toBe(true);
    expect(row?.payload.status).toBe('pending');
    // Two screen rows: the first screen, and the replay citing the SAME
    // evidence sha with the replay marker (no fresh screen claimed).
    const screens = inserts.filter((i) => i.table === 'audit_log' && i.payload.action === 'screen');
    expect(screens).toHaveLength(2);
    const firstDetail = screens[0].payload.detail as Record<string, unknown>;
    const replayDetail = screens[1].payload.detail as Record<string, unknown>;
    expect(replayDetail.replayed).toBe(true);
    expect(replayDetail.sentAsIs).toBe(true);
    expect(replayDetail.sha256).toBe(firstDetail.sha256);
    expect(replayDetail.holdCause).toBe('reputational');
    expect(replayDetail.riskBand).toBe('queued');
    expect(replayDetail).not.toHaveProperty('heat');
    // The replay ran no model: it records the first screen's gate decision,
    // carried in the signed token, and the replaying request's own gate
    // beside it (#339).
    expect(firstDetail.modelDecision).toEqual(DEV_SEND_DECISION);
    expect(firstDetail).not.toHaveProperty('replayGate');
    expect(replayDetail.modelDecision).toEqual(DEV_SEND_DECISION);
    expect(replayDetail.replayGate).toEqual(DEV_SEND_DECISION);
    expect(replayDetail).not.toHaveProperty('llmWithheld');
    expect(row?.payload).not.toHaveProperty('heat');
    // The send row can now name the cause the sender saw — it is the first
    // screen's, not a nondeterministic second read.
    const sendAudit = inserts.find((i) => i.table === 'audit_log' && i.payload.action === 'send');
    const sendDetail = sendAudit?.payload.detail as Record<string, unknown>;
    expect(sendDetail.sentAsIs).toBe(true);
    expect(sendDetail.holdCause).toBe('reputational');
    vi.unstubAllGlobals();
  });

  it('a replay under a gate that now withholds keeps the first read and says the current gate withheld (#339)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    localStack();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [
            { type: 'text', text: JSON.stringify({ verdict: 'hold', reasons: ['Front-page risk.'], cause: 'reputational', heat: 41 }) },
          ],
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    sendMock.mockResolvedValue({ id: 'prov-r2', provider: 'mock' });
    const { admin, inserts } = makeAdmin({
      users: devSenderRow,
      outbound_messages: [
        insertedRow({ status: 'pending', verdict: 'hold' }),
        insertedRow({ status: 'sent', verdict: 'hold', provider_message_id: 'prov-r2' }),
      ],
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    signedIn(admin);

    const first = await POST(post({ ...compliantDraft, body: 'Honestly their CFO is a clown.' }));
    const { token } = (await first.json()).riskIssues;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The stack is no longer local when the sender resubmits.
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefgh.supabase.co');
    const res = await POST(
      post({ ...compliantDraft, body: 'Honestly their CFO is a clown.', sendAsIs: true, overrideToken: token }),
    );
    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const replayDetail = inserts.filter((i) => i.table === 'audit_log' && i.payload.action === 'screen')[1].payload
      .detail as Record<string, unknown>;
    expect(replayDetail.replayed).toBe(true);
    // The read applied is the first screen's, which the model did see...
    expect(replayDetail.llmChecked).toBe(true);
    expect(replayDetail.modelDecision).toEqual(DEV_SEND_DECISION);
    expect(replayDetail).not.toHaveProperty('llmWithheld');
    // ...and this request's gate is recorded apart, withheld, with its reason.
    expect(replayDetail.replayGate).toEqual({
      allowed: false,
      reason: 'not_local',
      purpose: 'mail_send_screen',
      tenantId: DEV_TENANT_ID,
    });
    vi.unstubAllGlobals();
  });

  it('a token for OTHER content is not honored: the edited text is screened afresh', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    localStack();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [
            { type: 'text', text: JSON.stringify({ verdict: 'hold', reasons: ['Front-page risk.'], cause: 'reputational', heat: 41 }) },
          ],
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { admin, inserts } = makeAdmin({
      users: devSenderRow,
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const token = mintScreenToken({
      sha: createHash('sha256').update('Process update\n\nSome other text').digest('hex'),
      actorId: 'md-1',
      dealId: null,
      verdict: 'hold',
      reasons: ['Front-page risk.'],
      holdCause: 'reputational',
      llmChecked: true,
      modelDecision: DEV_SEND_DECISION,
      iat: Date.now(),
    });
    const res = await POST(
      post({ ...compliantDraft, body: 'Honestly their CFO is a clown.', sendAsIs: true, overrideToken: token }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).riskIssues).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
    expect(inserts.some((i) => i.table === 'outbound_messages')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('send-as-is WITHOUT the bound token is not honored — risk issues again', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    localStack();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  verdict: 'hold',
                  reasons: ['Front-page risk.'],
                  cause: 'reputational',
                  heat: 41,
                }),
              },
            ],
          }),
      }),
    );
    const { admin, inserts } = makeAdmin({
      users: devSenderRow,
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const res = await POST(
      post({
        ...compliantDraft,
        body: 'Honestly their CFO is a clown.',
        sendAsIs: true,
        overrideToken: 'stale-or-forged-token',
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).riskIssues).toBeTruthy();
    expect(sendMock).not.toHaveBeenCalled();
    expect(inserts.some((i) => i.table === 'outbound_messages')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('the binding is per FIELD, not the joined text: a split-phrase screen cannot be replayed over the recomposed text', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const { admin, inserts } = makeAdmin({
      users: senderRow,
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    signedIn(admin);

    // Fields are screened SEPARATELY. "We" at the end of the body and
    // "guarantee…" as an attachment NAME never form "we guarantee" in any
    // one field: the first screen reads MNPI-hold only (the milder read), and
    // hands back a token. Joined with a blank line, those fields are byte-
    // identical to a body that carries the recomposed promissory phrase —
    // so a joined-text binding would replay the milder read over it.
    const first = await POST(
      post({
        ...compliantDraft,
        body: 'Our internal model floors this at $510M. We',
        attachments: [{ name: 'guarantee the timeline.txt', contentBase64: 'aGk=' }],
      }),
    );
    expect(first.status).toBe(200);
    const firstIssues = (await first.json()).riskIssues;
    expect(firstIssues.cause).toBe('mnpi');
    expect(firstIssues.reasons.join(' ')).not.toMatch(/promissory/i);

    const res = await POST(
      post({
        ...compliantDraft,
        body: 'Our internal model floors this at $510M. We\n\nguarantee the timeline.txt',
        sendAsIs: true,
        overrideToken: firstIssues.token,
      }),
    );
    // Not honored: the recomposed text is screened afresh and the promissory
    // phrase is caught — nothing sent, nothing stored.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.riskIssues.reasons.join(' ')).toMatch(/promissory/i);
    expect(sendMock).not.toHaveBeenCalled();
    expect(inserts.some((i) => i.table === 'outbound_messages')).toBe(false);
    const screens = inserts.filter((i) => i.table === 'audit_log' && i.payload.action === 'screen');
    expect(screens).toHaveLength(2);
    expect((screens[1].payload.detail as Record<string, unknown>).replayed).toBeUndefined();
  });

  it('a token minted for another sender is not honored', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const { admin, inserts } = makeAdmin({
      users: senderRow,
      audit_log: { data: null, error: null },
    });
    signedIn(admin);
    const first = await POST(post({ ...compliantDraft, body: 'Our internal model floors this at $510M' }));
    const { token } = (await first.json()).riskIssues;
    // Same content, same token, a different signed-in user.
    const other = makeAdmin({ users: senderRow, audit_log: { data: null, error: null } });
    signedIn(other.admin, 'md-2');
    const res = await POST(
      post({ ...compliantDraft, body: 'Our internal model floors this at $510M', sendAsIs: true, overrideToken: token }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).riskIssues).toBeTruthy();
    expect(sendMock).not.toHaveBeenCalled();
    expect(inserts.some((i) => i.table === 'outbound_messages')).toBe(false);
    expect(other.inserts.some((i) => i.table === 'outbound_messages')).toBe(false);
  });

  it('flag sent but token NOT honored and the fresh screen compliant: sends, band floor still Queued, intent audited', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockResolvedValue({ id: 'prov-e1', provider: 'mock' });
    const { admin, inserts } = makeAdmin({
      users: senderRow,
      outbound_messages: [
        insertedRow({ status: 'pending' }),
        insertedRow({ status: 'sent', provider_message_id: 'prov-e1' }),
      ],
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    signedIn(admin);
    // An EXPIRED token for this very content (a sender who sat on the Risk
    // Patcher for over an hour): re-screened, and the deterministic pass
    // finds nothing in the compliant draft.
    const sha = createHash('sha256').update(JSON.stringify(['Process update', 'The room opens Monday.'])).digest('hex');
    const token = mintScreenToken({
      sha,
      actorId: 'md-1',
      dealId: null,
      verdict: 'hold',
      reasons: ['Front-page risk.'],
      holdCause: 'reputational',
      llmChecked: true,
      modelDecision: DEV_SEND_DECISION,
      iat: Date.now() - 2 * 60 * 60 * 1000,
    });
    const res = await POST(post({ ...compliantDraft, sendAsIs: true, overrideToken: token }));
    expect(res.status).toBe(201);
    expect(sendMock).toHaveBeenCalledTimes(1);
    // The sender pushed "send as-is": always the CCO's business (#192 band
    // floor), whatever the fresh screen said.
    const row = inserts.find((i) => i.table === 'outbound_messages');
    expect(row?.payload.risk_band).toBe('queued');
    expect(row?.payload.verdict).toBe('compliant');
    const screenDetail = inserts.find((i) => i.table === 'audit_log' && i.payload.action === 'screen')
      ?.payload.detail as Record<string, unknown>;
    expect(screenDetail.replayed).toBeUndefined();
    expect(screenDetail.riskBand).toBe('queued');
    const sendDetail = inserts.find((i) => i.table === 'audit_log' && i.payload.action === 'send')
      ?.payload.detail as Record<string, unknown>;
    expect(sendDetail.sentAsIsRequested).toBe(true);
    expect(sendDetail.sentAsIs).toBeUndefined();
  });

  it('no signing key configured: a clean 500 BEFORE any screen or audit write, never a half-recorded request', async () => {
    vi.stubEnv('OUTBOX_SCREEN_SECRET', '');
    vi.stubEnv('INVITE_VERIFICATION_PEPPER', '');
    const { admin, inserts } = makeAdmin({ users: senderRow, audit_log: { data: null, error: null } });
    signedIn(admin);
    const res = await POST(post({ ...compliantDraft, body: 'Honestly their CFO is a clown.' }));
    expect(res.status).toBe(500);
    // Generic to the caller (env var names are logged, not echoed).
    expect((await res.json()).error).toMatch(/not configured/i);
    expect(inserts).toHaveLength(0);
    expect(sendMock).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    process.env.OUTBOX_SCREEN_SECRET = 'test-screen-secret';
  });

  it('send-as-is with the bound token SENDS even an MNPI read (#192: no blocking, ever)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockResolvedValue({ id: 'prov-m1', provider: 'mock' });
    const { admin, inserts } = makeAdmin({
      users: senderRow,
      outbound_messages: [
        insertedRow({ status: 'pending', verdict: 'hold' }),
        insertedRow({ status: 'sent', verdict: 'hold', provider_message_id: 'prov-m1' }),
      ],
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    signedIn(admin);

    const first = await POST(
      post({ ...compliantDraft, body: 'Our internal model floors this at $510M' }),
    );
    expect(first.status).toBe(200);
    const { token, cause } = (await first.json()).riskIssues;
    expect(cause).toBe('mnpi');
    const res = await POST(
      post({
        ...compliantDraft,
        body: 'Our internal model floors this at $510M',
        sendAsIs: true,
        overrideToken: token,
      }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).message.status).toBe('sent');
    expect(sendMock).toHaveBeenCalledTimes(1);
    // The row preserves the screen's verdict; the band routes the CCO's
    // POST-send review — traceability, not blocking.
    const row = inserts.find((i) => i.table === 'outbound_messages');
    expect(row?.payload.verdict).toBe('hold');
    // The band floor: a send-as-is is ALWAYS queued for post-send review,
    // whatever the nondeterministic re-screen said.
    expect(row?.payload.risk_band).toBe('queued');
    const sendAudit = inserts.find(
      (i) => i.table === 'audit_log' && i.payload.action === 'send',
    );
    expect((sendAudit?.payload.detail as Record<string, unknown>).sentAsIs).toBe(true);
  });

  it('validates recipients, subject and body', async () => {
    const { admin } = makeAdmin({ users: senderRow });
    signedIn(admin);
    expect((await POST(post({ ...compliantDraft, to: [] }))).status).toBe(400);
    expect((await POST(post({ ...compliantDraft, to: ['not-an-email'] }))).status).toBe(400);
    expect((await POST(post({ ...compliantDraft, subject: '' }))).status).toBe(400);
    expect((await POST(post({ ...compliantDraft, body: '' }))).status).toBe(400);
  });
});

describe('POST /api/v1/outbox: the model gate (#339)', () => {
  function stubModel() {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: 'text', text: JSON.stringify({ verdict: 'compliant', reasons: [] }) }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  function sendingAdmin(users: Row) {
    sendMock.mockResolvedValue({ id: 'prov-g', provider: 'mock' });
    return makeAdmin({
      users,
      outbound_messages: [insertedRow({ status: 'pending' }), insertedRow({ status: 'sent', provider_message_id: 'prov-g' })],
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
  }
  const screenDetail = (inserts: ReturnType<typeof makeAdmin>['inserts']) =>
    inserts.find((i) => i.table === 'audit_log' && i.payload.action === 'screen')?.payload.detail as Record<string, unknown>;

  afterEach(() => vi.unstubAllGlobals());

  it('an unlisted tenant on a local stack: no model call, the screen row records why, and the send proceeds', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    localStack();
    const fetchMock = stubModel();
    const { admin, inserts } = sendingAdmin(senderRow);
    signedIn(admin);

    const res = await POST(post(compliantDraft));
    expect(res.status).toBe(201);
    expect(fetchMock).not.toHaveBeenCalled();
    const detail = screenDetail(inserts);
    expect(detail.llmChecked).toBe(false);
    expect(detail.modelDecision).toEqual({
      allowed: false,
      reason: 'tenant_not_synthetic',
      purpose: 'mail_send_screen',
      tenantId: 'tenant-1',
    });
    expect(detail.llmWithheld).toBe('tenant_not_synthetic');
    // No model ran, so no cost line.
    expect(inserts.some((i) => i.table === 'ai_usage')).toBe(false);
  });

  it('the DEV tenant on a local stack calls the model', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    localStack();
    const fetchMock = stubModel();
    const { admin, inserts } = sendingAdmin(devSenderRow);
    signedIn(admin);

    expect((await POST(post(compliantDraft))).status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const detail = screenDetail(inserts);
    expect(detail.llmChecked).toBe(true);
    expect(detail.modelDecision).toEqual(DEV_SEND_DECISION);
    expect(detail).not.toHaveProperty('llmWithheld');
  });

  it('the DEV tenant on a hosted URL does not call the model', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefgh.supabase.co');
    const fetchMock = stubModel();
    const { admin, inserts } = sendingAdmin(devSenderRow);
    signedIn(admin);

    expect((await POST(post(compliantDraft))).status).toBe(201);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screenDetail(inserts)).toMatchObject({ llmChecked: false, llmWithheld: 'not_local' });
  });

  it('a sender with no tenant is withheld as unresolved', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    localStack();
    const fetchMock = stubModel();
    const { admin, inserts } = sendingAdmin({ data: { tenant_id: null, firm_role: 'banker' }, error: null });
    signedIn(admin);

    await POST(post(compliantDraft));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screenDetail(inserts)).toMatchObject({
      modelDecision: { allowed: false, reason: 'tenant_unresolved', purpose: 'mail_send_screen', tenantId: null },
      llmWithheld: 'tenant_unresolved',
    });
  });
});

describe('GET /api/v1/outbox', () => {
  it('band filter: ?status=sent&band=queued is the post-send review queue (#192 slice 3)', async () => {
    const { admin, calls } = makeAdmin({
      users: senderRow,
      outbound_messages: { data: [insertedRow({}).data], error: null },
    });
    signedIn(admin);

    const res = await GET(
      new Request('http://localhost/api/v1/outbox?status=sent&band=queued'),
    );
    expect(res.status).toBe(200);
    expect(
      calls.some(
        (c) =>
          c.table === 'outbound_messages' &&
          c.method === 'eq' &&
          c.args[0] === 'risk_band' &&
          c.args[1] === 'queued',
      ),
    ).toBe(true);
  });

  it('band filter rejects unknown values', async () => {
    const { admin } = makeAdmin({ users: senderRow });
    signedIn(admin);
    const res = await GET(new Request('http://localhost/api/v1/outbox?band=severe'));
    expect(res.status).toBe(400);
  });


  it('a banker sees only their own messages', async () => {
    const { admin, calls } = makeAdmin({
      users: senderRow,
      outbound_messages: { data: [insertedRow({}).data], error: null },
    });
    signedIn(admin);

    const res = await GET(new Request('http://localhost/api/v1/outbox'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(1);
    expect(
      calls.some(
        (c) =>
          c.table === 'outbound_messages' &&
          c.method === 'eq' &&
          c.args[0] === 'sender_id' &&
          c.args[1] === 'md-1',
      ),
    ).toBe(true);
  });

  it('a CCO reads the tenant-wide held queue with ?status=held', async () => {
    const { admin, calls } = makeAdmin({
      users: ccoRow,
      outbound_messages: { data: [], error: null },
    });
    signedIn(admin, 'cco-1');

    const res = await GET(new Request('http://localhost/api/v1/outbox?status=held'));
    expect(res.status).toBe(200);
    const outboxCalls = calls.filter((c) => c.table === 'outbound_messages' && c.method === 'eq');
    expect(outboxCalls.some((c) => c.args[0] === 'tenant_id' && c.args[1] === 'tenant-1')).toBe(
      true,
    );
    expect(outboxCalls.some((c) => c.args[0] === 'status' && c.args[1] === 'held')).toBe(true);
    expect(outboxCalls.some((c) => c.args[0] === 'sender_id')).toBe(false);
  });

  it('rejects an invalid status filter', async () => {
    const { admin } = makeAdmin({ users: senderRow });
    signedIn(admin);
    expect((await GET(new Request('http://localhost/api/v1/outbox?status=weird'))).status).toBe(
      400,
    );
  });

  it('scopes to a deal with ?dealId (code resolved leniently, like the send path)', async () => {
    const { admin, calls } = makeAdmin({
      users: senderRow,
      // The code lookup, then the caller's seat on it (tenant match).
      deals: { data: { id: 'd-uuid-1', tenant_id: 'tenant-1' }, error: null },
      deal_memberships: { data: { id: 'seat-1' }, error: null },
      outbound_messages: { data: [], error: null },
    });
    signedIn(admin);

    const res = await GET(new Request('http://localhost/api/v1/outbox?dealId=zephy-2026-640'));
    expect(res.status).toBe(200);
    expect(
      calls.some(
        (c) =>
          c.table === 'deals' &&
          c.method === 'eq' &&
          c.args[0] === 'code' &&
          c.args[1] === 'ZEPHY-2026-640',
      ),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.table === 'outbound_messages' &&
          c.method === 'eq' &&
          c.args[0] === 'deal_id' &&
          c.args[1] === 'd-uuid-1',
      ),
    ).toBe(true);
  });

  // D65, #245: a deal the caller cannot see and a deal-shaped ref that matches
  // nothing both filter to an id that matches nothing. A made-up code used to
  // drop the filter and list every message, which told the two apart.
  it.each([
    ['a real deal without a seat', 'zephy-2026-640', { id: 'd-uuid-1', tenant_id: 'tenant-1' }],
    ['a deal code that matches nothing', 'zephy-2026-999', null],
    ['a UUID that matches nothing', '22222222-2222-4222-8222-222222222222', null],
  ])('?dealId naming %s reads as an empty deal, never the unfiltered list', async (_kind, ref, deal) => {
    const { admin, calls } = makeAdmin({
      users: senderRow,
      deals: { data: deal, error: null },
      deal_memberships: { data: null, error: null },
      outbound_messages: { data: [], error: null },
    });
    signedIn(admin);

    const res = await GET(new Request(`http://localhost/api/v1/outbox?dealId=${ref}`));
    expect(res.status).toBe(200);
    const dealFilters = calls.filter(
      (c) => c.table === 'outbound_messages' && c.method === 'eq' && c.args[0] === 'deal_id',
    );
    expect(dealFilters.map((c) => c.args[1])).toEqual(['00000000-0000-0000-0000-000000000000']);
  });

  it('an unresolvable ?dealId (sandbox slug) applies NO deal filter', async () => {
    const { admin, calls } = makeAdmin({
      users: senderRow,
      deals: { data: null, error: null },
      outbound_messages: { data: [], error: null },
    });
    signedIn(admin);

    const res = await GET(new Request('http://localhost/api/v1/outbox?dealId=project-summit'));
    expect(res.status).toBe(200);
    expect(
      calls.some(
        (c) => c.table === 'outbound_messages' && c.method === 'eq' && c.args[0] === 'deal_id',
      ),
    ).toBe(false);
  });

  it('a deal lookup ERROR fails loud (500) instead of silently widening the scope', async () => {
    const { admin } = makeAdmin({
      users: senderRow,
      deals: { data: null, error: { message: 'boom' } },
    });
    signedIn(admin);
    expect(
      (await GET(new Request('http://localhost/api/v1/outbox?dealId=zephy-2026-640'))).status,
    ).toBe(500);
  });

  it('an EXTERNAL user holding a firm_role never reads the tenant-wide queue', async () => {
    const { admin, calls } = makeAdmin({
      users: { data: { tenant_id: 'tenant-1', firm_role: 'cco', is_external: true }, error: null },
      outbound_messages: { data: [], error: null },
    });
    signedIn(admin, 'ext-cco');

    const res = await GET(new Request('http://localhost/api/v1/outbox'));
    expect(res.status).toBe(200);
    const eqs = calls.filter((c) => c.table === 'outbound_messages' && c.method === 'eq');
    expect(eqs.some((c) => c.args[0] === 'sender_id' && c.args[1] === 'ext-cco')).toBe(true);
    expect(eqs.some((c) => c.args[0] === 'tenant_id')).toBe(false);
  });

  it('embeds the deal code so the supervisory queue can show a Deal column', async () => {
    const heldData = insertedRow({ status: 'held', verdict: 'hold' }).data as Record<
      string,
      unknown
    >;
    const { admin } = makeAdmin({
      users: ccoRow,
      outbound_messages: {
        data: [{ ...heldData, deal: { code: 'ZEPHY-2026-640' } }],
        error: null,
      },
    });
    signedIn(admin, 'cco-1');

    const res = await GET(new Request('http://localhost/api/v1/outbox?status=held'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages[0].dealCode).toBe('ZEPHY-2026-640');
  });
});


describe('automatic Confidential marking', () => {
  const dealId = '11111111-1111-4111-8111-111111111111';
  function fixture(lifecycle: Row, member = true) {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockResolvedValue({ id: 'provider-1', provider: 'mock' });
    const result = makeAdmin({
      users: senderRow,
      // The id lookup, the caller's seat (tenant match), then the lifecycle read.
      deals: [{ data: { id: dealId }, error: null }, { data: { tenant_id: 'tenant-1' }, error: null }, lifecycle],
      deal_memberships: { data: member ? { id: 'seat-1' } : null, error: null },
      outbound_messages: [insertedRow({ status: 'pending' }), insertedRow({ status: 'sent' })],
      audit_log: { data: null, error: null },
    });
    signedIn(result.admin);
    return result;
  }
  it.each(['live', 'pitch', 'prospect', 'mandate_hold', 'terminated', 'closed', 'lost'])('uses server lifecycle %s despite client claims', async (category) => {
    const { inserts } = fixture({ data: { lifecycle_category: category }, error: null });
    const res = await POST(post({ ...compliantDraft, dealId, lifecycleCategory: 'closed', confidential: false }));
    expect(res.status).toBe(201);
    const expected = ['live', 'pitch'].includes(category) ? '[Confidential] Process update' : 'Process update';
    expect(sendMock.mock.calls[0][0].subject).toBe(expected);
    expect(inserts.find((i) => i.table === 'outbound_messages')?.payload.subject).toBe(expected);
    const detail = inserts.find((i) => i.table === 'audit_log')?.payload.detail as Record<string, unknown>;
    expect(detail.sha256).toBe(createHash('sha256').update(JSON.stringify([expected, compliantDraft.body])).digest('hex'));
  });
  it.each([
    [{ data: null, error: { message: 'lookup failed' } }, 500],
    [{ data: null, error: null }, 404],
    [{ data: { lifecycle_category: null }, error: null }, 500],
    [{ data: { lifecycle_category: 'invalid' }, error: null }, 500],
  ] as [Row, number][])('fails safely when lifecycle is unavailable', async (row, status) => {
    fixture(row);
    expect((await POST(post({ ...compliantDraft, dealId }))).status).toBe(status);
    expect(sendMock).not.toHaveBeenCalled();
  });
  it('does not label or send an inaccessible deal, and answers like a missing one (D65)', async () => {
    fixture({ data: { lifecycle_category: 'live' }, error: null }, false);
    const res = await POST(post({ ...compliantDraft, dealId }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Deal not found' });
    expect(sendMock).not.toHaveBeenCalled();
  });
  it('rejects subjects that exceed the limit after marking', async () => {
    fixture({ data: { lifecycle_category: 'live' }, error: null });
    expect((await POST(post({ ...compliantDraft, dealId, subject: 'a'.repeat(990) }))).status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });
  it.each(['live', 'closed', 'lost'])('preserves manual labels for %s', async (category) => {
    fixture({ data: { lifecycle_category: category }, error: null });
    await POST(post({ ...compliantDraft, dealId, subject: '[Confidential] Process update' }));
    expect(sendMock.mock.calls[0][0].subject).toBe('[Confidential] Process update');
  });
  it.each([
    ['the raw subject', 'Process update'],
    ['the marked subject', '[Confidential] Process update'],
  ])('honors the bound token on a live deal when the second call echoes %s', async (_label, echoed) => {
    const risky = { ...compliantDraft, dealId, body: 'Our internal model floors this at $510M' };
    fixture({ data: { lifecycle_category: 'live' }, error: null });
    const first = await POST(post(risky));
    const { riskIssues } = await first.json();
    expect(riskIssues?.token).toBeTruthy();
    expect(sendMock).not.toHaveBeenCalled();
    fixture({ data: { lifecycle_category: 'live' }, error: null });
    const second = await POST(post({ ...risky, subject: echoed, sendAsIs: true, overrideToken: riskIssues.token }));
    expect(second.status).toBe(201);
    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][0].subject).toBe('[Confidential] Process update');
  });
  it('rejects a replay when lifecycle changes the screened subject', async () => {
    const risky = { ...compliantDraft, dealId, body: 'Our internal model floors this at $510M' };
    fixture({ data: { lifecycle_category: 'closed' }, error: null });
    const first = await POST(post(risky));
    const { riskIssues } = await first.json();
    fixture({ data: { lifecycle_category: 'live' }, error: null });
    const second = await POST(post({ ...risky, sendAsIs: true, overrideToken: riskIssues.token }));
    expect(second.status).toBe(200);
    expect((await second.json()).riskIssues).toBeDefined();
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('outbound recipient boundary', () => {
  function setup(domains: string[] = ['bank.example'], error: unknown = null) {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockResolvedValue({ id: 'provider-1', provider: 'mock' });
    const result = makeAdmin({
      users: { data: { tenant_id: 'tenant-1', company_id: 'firm-1', firm_role: 'banker' }, error: null },
      companies: { data: { tenant_id: 'tenant-1' }, error: null },
      company_verified_domains: { data: domains.map((domain) => ({ domain })), error },
      outbound_messages: [insertedRow({ status: 'pending' }), insertedRow({ status: 'sent', recipient_boundary: 'external' })],
      audit_log: { data: null, error: null },
    });
    signedIn(result.admin);
    return result;
  }
  it.each(['to', 'cc', 'bcc'])('records an external %s without adding confirmation', async (field) => {
    const { inserts, calls } = setup();
    const res = await POST(post({ ...compliantDraft, to: ['a@bank.example'], [field]: ['b@outside.test'], recipientBoundary: 'internal', companyId: 'forged' }));
    expect(res.status).toBe(201);
    expect(sendMock).toHaveBeenCalledOnce();
    expect(inserts.find((i) => i.table === 'outbound_messages')?.payload.recipient_boundary).toBe('external');
    expect((await res.json()).message.recipientBoundary).toBe('external');
    expect(calls).toContainEqual({ table: 'company_verified_domains', method: 'eq', args: ['company_id', 'firm-1'] });
    expect(calls).toContainEqual({ table: 'company_verified_domains', method: 'eq', args: ['tenant_id', 'tenant-1'] });
  });
  it.each([['bank.example'], []])('records configured internal versus unverified without guessing', async (...args) => {
    const domains = args.flat() as string[];
    const { inserts } = setup(domains);
    expect((await POST(post({ ...compliantDraft, to: ['a@bank.example'] }))).status).toBe(201);
    expect(inserts.find((i) => i.table === 'outbound_messages')?.payload.recipient_boundary).toBe(domains.length ? 'internal' : 'unverified');
  });
  it('still sends when the verified-domain lookup fails, and records the boundary as unverified', async () => {
    const { inserts } = setup([], { message: 'database unavailable' });
    expect((await POST(post(compliantDraft))).status).toBe(201);
    expect(sendMock).toHaveBeenCalledOnce();
    expect(inserts.find((i) => i.table === 'outbound_messages')?.payload.recipient_boundary).toBe('unverified');
  });
  // D86 (Storm, Oct 10): internal mail carries the same risk as external
  // mail, so the screen must not shortcut on an all-internal recipient list.
  it.each([
    ['MNPI', { body: 'Our internal model floors this at $510M' }, 'mnpi'],
    ['promissory', { subject: 'We guarantee the price' }, 'promissory'],
  ])('screens all-internal %s mail exactly like external mail, boundary on the screen row', async (_label, draft, cause) => {
    const screenOf = async (to: string[]) => {
      const { inserts } = setup();
      const res = await POST(post({ ...compliantDraft, ...draft, to }));
      expect(res.status).toBe(200);
      expect((await res.json()).riskIssues.cause).toBe(cause);
      expect(inserts.some((i) => i.table === 'outbound_messages')).toBe(false);
      return inserts.find((i) => i.table === 'audit_log' && i.payload.action === 'screen')?.payload.detail as Record<string, unknown>;
    };
    const internal = await screenOf(['a@bank.example', 'b@desk.bank.example']);
    const external = await screenOf(['founder@target.com']);
    expect(sendMock).not.toHaveBeenCalled();
    expect(internal.recipientBoundary).toBe('internal');
    expect(external.recipientBoundary).toBe('external');
    // Same read, field for field (content hash included), except the boundary.
    expect({ ...internal, recipientBoundary: null }).toEqual({ ...external, recipientBoundary: null });
    expect(internal).toMatchObject({ returned: true, verdict: expect.not.stringMatching(/^compliant$/) });
  });
  it('records the boundary on the send audit row of a sent internal message', async () => {
    const { inserts } = setup();
    expect((await POST(post({ ...compliantDraft, to: ['a@bank.example'] }))).status).toBe(201);
    const sendRow = inserts.find((i) => i.table === 'audit_log' && i.payload.action === 'send');
    expect((sendRow?.payload.detail as Record<string, unknown>).recipientBoundary).toBe('internal');
  });
});


describe('recipient confirmation',()=>{
 const dealId='11111111-1111-4111-8111-111111111111';
 function fixture(){
  vi.stubEnv('AI_GATEWAY_API_KEY','');sendMock.mockResolvedValue({id:'receipt',provider:'mock'});
  const result=makeAdmin({users:senderRow,deals:{data:{id:dealId,tenant_id:'tenant-1',lifecycle_category:'live'},error:null},deal_memberships:{data:{id:'seat'},error:null},outbound_messages:insertedRow({status:'sent'}),audit_log:{data:null,error:null}});
  signedIn(result.admin);
  reviewMock.mockResolvedValue({recipients:[{field:'to',email:'founder@target.com',boundary:'external',relationship:'counterparty',requiresConfirmation:true,reason:'counterparty'}],policyFingerprint:'version1'} as never);
  return result;
 }
 it('holds the send for approval when an outsider not on the deal is addressed in To (D81)',async()=>{
  const result=fixture();
  reviewMock.mockResolvedValue({recipients:[{field:'to',email:'bob@outside.test',boundary:'external',relationship:'unassociated',requiresConfirmation:true,reason:'not_on_deal'}],policyFingerprint:'version1'} as never);
  const res=await POST(post({...compliantDraft,dealId}));
  expect((await res.json()).recipientReviewRequired).toBeDefined();expect(sendMock).not.toHaveBeenCalled();expect(result.inserts).toHaveLength(0);
 });
 it('returns approval without transport or preflight persistence, then sends after approval',async()=>{
  const result=fixture();const draft={...compliantDraft,dealId};
  const first=await POST(post({...draft,recipientApproved:true}));
  const challenge=await first.json();expect(challenge.recipientReviewRequired).toBeDefined();expect(result.inserts).toHaveLength(0);expect(sendMock).not.toHaveBeenCalled();
  const second=await POST(post({...draft,recipientApprovalToken:challenge.recipientReviewRequired.token}));
  expect(second.status).toBe(201);expect(sendMock).toHaveBeenCalledOnce();
  expect(result.inserts.find(i=>i.table==='outbound_messages')?.payload.recipient_review).toEqual(expect.objectContaining({policyFingerprint:'version1'}));
 });
 it('marks the SENT message\'s audit row with an explicit recipient override and the known recipients it adds (Issues #429, #378)',async()=>{
  const result=fixture();const draft={...compliantDraft,dealId,cc:['new@outside.test']};
  reviewMock.mockResolvedValue({recipients:[
   {field:'to',email:'founder@target.com',boundary:'external',relationship:'counterparty',requiresConfirmation:true,reason:'counterparty'},
   {field:'cc',email:'new@outside.test',boundary:'external',relationship:'unassociated',requiresConfirmation:true,reason:'not_on_deal'},
   {field:'cc',email:'colleague@bank.test',boundary:'internal',relationship:'unassociated',requiresConfirmation:true,reason:'not_on_deal'},
  ],policyFingerprint:'version1'} as never);
  const challenge=await (await POST(post(draft))).json();
  // D80: the unsent challenge leaves no audit row and no override flag anywhere.
  expect(result.inserts.filter(i=>i.table==='audit_log')).toHaveLength(0);
  expect((await POST(post({...draft,recipientApprovalToken:challenge.recipientReviewRequired.token}))).status).toBe(201);
  const detail=result.inserts.find(i=>i.table==='audit_log'&&i.payload.action==='send')?.payload.detail as Record<string,unknown>;
  expect(detail.recipientOverride).toBe(true);
  expect(detail.knownRecipientsAdded).toEqual(['new@outside.test']);
  const screenDetail=result.inserts.find(i=>i.table==='audit_log'&&i.payload.action==='screen')?.payload.detail as Record<string,unknown>;
  expect(screenDetail).not.toHaveProperty('recipientOverride');
 });
 it('carries no override flag when no recipient needed approval',async()=>{
  const result=fixture();
  reviewMock.mockResolvedValue({recipients:[{field:'to',email:'cfo@client.test',boundary:'external',relationship:'client',requiresConfirmation:false,reason:null}],policyFingerprint:'version1'} as never);
  expect((await POST(post({...compliantDraft,dealId}))).status).toBe(201);
  const detail=result.inserts.find(i=>i.table==='audit_log'&&i.payload.action==='send')?.payload.detail as Record<string,unknown>;
  expect(detail).toHaveProperty('recipientReview');
  expect(detail).not.toHaveProperty('recipientOverride');
  expect(detail).not.toHaveProperty('knownRecipientsAdded');
 });
 it('recipient approval does not bypass content risk',async()=>{
  fixture();const draft={...compliantDraft,dealId,body:'We guarantee a 20% return.'};
  const first=await (await POST(post(draft))).json();
  const second=await (await POST(post({...draft,recipientApprovalToken:first.recipientReviewRequired.token}))).json();
  expect(second.riskIssues).toBeDefined();expect(sendMock).not.toHaveBeenCalled();
 });
 it('changes to BCC invalidate an earlier approval',async()=>{
  fixture();const draft={...compliantDraft,dealId};const first=await (await POST(post(draft))).json();
  const second=await (await POST(post({...draft,bcc:['new@outside.test'],recipientApprovalToken:first.recipientReviewRequired.token}))).json();
  expect(second.recipientReviewRequired).toBeDefined();expect(sendMock).not.toHaveBeenCalled();
 });
 it.each([
  {to:['changed@outside.test']}, {cc:['changed@outside.test']}, {subject:'Changed subject'},
  {body:'Changed body'}, {html:'<p>Changed HTML</p>'},
  {attachments:[{name:'ZZ TEST.txt',contentBase64:'Y2hhbmdlZA==',type:'text/plain'}]},
 ])('message changes invalidate approval %j',async changes=>{
  fixture();const draft={...compliantDraft,dealId};const first=await (await POST(post(draft))).json();
  const result=await (await POST(post({...draft,...changes,recipientApprovalToken:first.recipientReviewRequired.token}))).json();
  expect(result.recipientReviewRequired).toBeDefined();expect(sendMock).not.toHaveBeenCalled();
 });
 it('a changed policy invalidates the token without sending',async()=>{
  fixture();const draft={...compliantDraft,dealId};const first=await (await POST(post(draft))).json();
  const previous=await reviewMock.mock.results[0].value;reviewMock.mockResolvedValue({...previous,policyFingerprint:'version2'} as never);
  const result=await (await POST(post({...draft,recipientApprovalToken:first.recipientReviewRequired.token}))).json();
  expect(result.recipientReviewRequired).toBeDefined();expect(sendMock).not.toHaveBeenCalled();
 });
 it('policy lookup failure cannot send',async()=>{fixture();reviewMock.mockRejectedValue(new Error('unavailable'));expect((await POST(post({...compliantDraft,dealId}))).status).toBe(503);expect(sendMock).not.toHaveBeenCalled();});
});

// Storm, Oct 9 (Option B): every attachment's CONTENT is read and screened
// with the body. One not read in full is never clean (fail closed).
describe('POST /api/v1/outbox: attachment content screening', () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const docx = (text: string) =>
    buildZip({
      'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    });
  const attach = (name: string, bytes: Buffer, type?: string) => ({
    name,
    contentBase64: bytes.toString('base64'),
    ...(type ? { type } : {}),
  });
  const screenDetail = (inserts: Array<{ table: string; payload: Record<string, unknown> }>) =>
    inserts.find((i) => i.table === 'audit_log' && i.payload.action === 'screen')?.payload.detail as Record<string, unknown>;
  const sendingAdmin = (users: typeof senderRow = senderRow) =>
    makeAdmin({
      users,
      outbound_messages: [insertedRow({ status: 'pending' }), insertedRow({ status: 'sent', provider_message_id: 'prov-a' })],
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });

  it('a promissory phrase inside a PDF is flagged at send, with clean body and filename', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const { admin, inserts } = makeAdmin({ users: senderRow, audit_log: { data: null, error: null } });
    signedIn(admin);

    const res = await POST(
      post({ ...compliantDraft, attachments: [attach('teaser.pdf', buildPdf('Project Falcon: we guarantee the close by Friday'), 'application/pdf')] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.riskIssues.cause).toBe('promissory');
    expect(sendMock).not.toHaveBeenCalled();
    expect(inserts.some((i) => i.table === 'outbound_messages')).toBe(false);
    const detail = screenDetail(inserts);
    expect(detail.verdict).toBe('blocked');
    // Attributed by position, never by name or text (D80).
    expect(detail.attachments).toEqual([{ position: 1, read: 'ok', ruleHits: ['promissory'] }]);
    expect(JSON.stringify(detail)).not.toContain('teaser.pdf');
    expect(JSON.stringify(detail)).not.toContain('Project Falcon');
  });

  it('an MNPI figure inside a DOCX is flagged at send', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const { admin, inserts } = makeAdmin({ users: senderRow, audit_log: { data: null, error: null } });
    signedIn(admin);

    const res = await POST(
      post({
        ...compliantDraft,
        attachments: [attach('notes.txt', Buffer.from('Agenda attached.')), attach('memo.docx', docx('Our internal model floors this at $510M'))],
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).riskIssues.cause).toBe('mnpi');
    expect(sendMock).not.toHaveBeenCalled();
    expect(screenDetail(inserts).attachments).toEqual([
      { position: 1, read: 'ok' },
      { position: 2, read: 'ok', ruleHits: ['mnpi'] },
    ]);
  });

  it.each([
    ['a scanned PDF', 'scan.pdf', buildPdf(null), 'empty'],
    ['a partly scanned PDF', 'mixed.pdf', buildPdfPages(['Readable page', null]), 'partial'],
    ['an image', 'chart.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]), 'unsupported_type'],
  ])('%s cannot be screened: risk issues back to the sender, nothing sent', async (_label, name, bytes, read) => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const { admin, inserts } = makeAdmin({ users: senderRow, audit_log: { data: null, error: null } });
    signedIn(admin);

    const res = await POST(post({ ...compliantDraft, attachments: [attach(name, bytes)] }));
    expect(res.status).toBe(200);
    const issues = (await res.json()).riskIssues;
    expect(issues.reasons[0]).toMatch(/^Attachment 1 was not screened: .+\. Review it before sending\.$/);
    expect(issues.cause).toBeNull();
    expect(issues.token).toBeTruthy();
    expect(sendMock).not.toHaveBeenCalled();
    expect(inserts.some((i) => i.table === 'outbound_messages')).toBe(false);
    const detail = screenDetail(inserts);
    expect(detail.verdict).toBe('hold');
    expect(detail.returned).toBe(true);
    expect(detail.attachments).toEqual([{ position: 1, read }]);
  });

  it('an unread attachment keeps the content flags it sits beside', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const { admin } = makeAdmin({ users: senderRow, audit_log: { data: null, error: null } });
    signedIn(admin);

    const res = await POST(
      post({ ...compliantDraft, body: 'Our internal model floors this at $510M', attachments: [attach('scan.pdf', buildPdf(null))] }),
    );
    const issues = (await res.json()).riskIssues;
    expect(issues.cause).toBe('mnpi');
    expect(issues.reasons).toHaveLength(2);
    expect(issues.reasons[1]).toMatch(/^Attachment 1 was not screened/);
  });

  it('send-as-is over an unread attachment sends, queued for the CCO', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockResolvedValue({ id: 'prov-a', provider: 'mock' });
    const { admin, inserts } = makeAdmin({
      users: senderRow,
      outbound_messages: [insertedRow({ status: 'pending', verdict: 'hold' }), insertedRow({ status: 'sent', verdict: 'hold' })],
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    signedIn(admin);
    const draft = { ...compliantDraft, attachments: [attach('scan.pdf', buildPdf(null))] };

    const { token } = (await (await POST(post(draft))).json()).riskIssues;
    const res = await POST(post({ ...draft, sendAsIs: true, overrideToken: token }));
    expect(res.status).toBe(201);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const row = inserts.find((i) => i.table === 'outbound_messages')?.payload as Record<string, unknown>;
    expect(row.verdict).toBe('hold');
    expect(row.risk_band).toBe('queued');
    expect((row.reasons as string[])[0]).toMatch(/^Attachment 1 was not screened/);
  });

  it('send-as-is does not carry over to different bytes under the same attachment name', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const { admin, inserts } = makeAdmin({
      users: senderRow,
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    signedIn(admin);
    const png = (fill: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, fill)]);

    const { token } = (await (await POST(post({ ...compliantDraft, attachments: [attach('chart.png', png(1))] }))).json()).riskIssues;
    const res = await POST(post({ ...compliantDraft, attachments: [attach('chart.png', png(2))], sendAsIs: true, overrideToken: token }));
    expect(res.status).toBe(200);
    expect((await res.json()).riskIssues.token).toBeTruthy();
    expect(sendMock).not.toHaveBeenCalled();
    expect(inserts.some((i) => i.table === 'outbound_messages')).toBe(false);
  });

  it('a clean PDF and DOCX still send normally', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockResolvedValue({ id: 'prov-a', provider: 'mock' });
    const { admin, inserts } = sendingAdmin();
    signedIn(admin);

    const res = await POST(
      post({
        ...compliantDraft,
        attachments: [attach('agenda.pdf', buildPdf('The data room opens Monday'), 'application/pdf'), attach('notes.docx', docx('Kickoff call on Tuesday'))],
      }),
    );
    expect(res.status).toBe(201);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const detail = screenDetail(inserts);
    expect(detail.verdict).toBe('compliant');
    expect(detail.riskBand).toBe('routine');
    expect(detail.attachments).toEqual([
      { position: 1, read: 'ok' },
      { position: 2, read: 'ok' },
    ]);
  });

  it('the AI pass reads the attachment text with the body', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    // The model gate (#339) opens only for the DEV tenant on a local stack.
    localStack();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: 'text', text: JSON.stringify({ verdict: 'compliant', reasons: [], heat: 5 }) }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    sendMock.mockResolvedValue({ id: 'prov-a', provider: 'mock' });
    const { admin } = sendingAdmin(devSenderRow);
    signedIn(admin);

    const res = await POST(post({ ...compliantDraft, attachments: [attach('agenda.pdf', buildPdf('The data room opens Monday'))] }));
    expect(res.status).toBe(201);
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body as string).messages[0].content as string;
    expect(prompt).toContain('The room opens Monday.');
    expect(prompt).toContain('The data room opens Monday');
    vi.unstubAllGlobals();
  });
});

describe('send idempotency (clientRequestId)', () => {
  const KEY_A = 'compose-attempt-aaaa';
  const KEY_B = 'compose-attempt-bbbb';
  const sentRow = (id: string, providerId: string) =>
    insertedRow({ id, status: 'sent', provider: 'mock', provider_message_id: providerId, to_emails: ['founder@target.com'] });

  it('the same key twice -> one provider send; the retry mirrors the first answer', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockResolvedValue({ id: 'prov-1', provider: 'mock' });
    const { admin, inserts, calls } = makeAdmin({
      users: senderRow,
      outbound_messages: [
        { data: null, error: null }, // first request: key unclaimed
        insertedRow({ status: 'pending' }),
        sentRow('msg-1', 'prov-1'),
        sentRow('msg-1', 'prov-1'), // retry: the claimed, sent row
      ],
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const first = await POST(post({ ...compliantDraft, clientRequestId: KEY_A }));
    const second = await POST(post({ ...compliantDraft, clientRequestId: KEY_A }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await second.json()).toEqual(await first.json());
    expect(sendMock).toHaveBeenCalledTimes(1);
    // The key is the claim, stored on the record-first insert, and the
    // lookup is scoped to the sender.
    const outboxInserts = inserts.filter((i) => i.table === 'outbound_messages');
    expect(outboxInserts).toHaveLength(1);
    expect(outboxInserts[0].payload.client_request_id).toBe(KEY_A);
    const lookups = calls.filter((c) => c.method === 'eq' && c.args[0] === 'client_request_id');
    expect(lookups.map((c) => c.args[1])).toEqual([KEY_A, KEY_A]);
    expect(calls).toContainEqual({ table: 'outbound_messages', method: 'eq', args: ['sender_id', 'md-1'] });
    // The retry ran no second screen: one screen + one send audit only.
    expect(inserts.filter((i) => i.table === 'audit_log').map((i) => i.payload.action)).toEqual(['screen', 'send']);
  });

  it('a concurrent request that loses the insert claim (23505) never sends', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const { admin } = makeAdmin({
      users: senderRow,
      outbound_messages: [
        { data: null, error: null }, // looked unclaimed before the screen
        { data: null, error: { code: '23505', message: 'duplicate key' } },
        sentRow('msg-1', 'prov-1'), // the winner's row
      ],
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const res = await POST(post({ ...compliantDraft, clientRequestId: KEY_A }));
    expect(res.status).toBe(201);
    expect((await res.json()).message.id).toBe('msg-1');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('a key whose send is still pending -> 409, nothing sent', async () => {
    const { admin } = makeAdmin({
      users: senderRow,
      outbound_messages: insertedRow({ status: 'pending' }),
    });
    signedIn(admin);

    const res = await POST(post({ ...compliantDraft, clientRequestId: KEY_A }));
    expect(res.status).toBe(409);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('different keys -> two sends', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock
      .mockResolvedValueOnce({ id: 'prov-1', provider: 'mock' })
      .mockResolvedValueOnce({ id: 'prov-2', provider: 'mock' });
    const { admin, inserts } = makeAdmin({
      users: senderRow,
      outbound_messages: [
        { data: null, error: null },
        insertedRow({ status: 'pending' }),
        sentRow('msg-1', 'prov-1'),
        { data: null, error: null },
        insertedRow({ id: 'msg-2', status: 'pending' }),
        sentRow('msg-2', 'prov-2'),
      ],
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    expect((await POST(post({ ...compliantDraft, clientRequestId: KEY_A }))).status).toBe(201);
    expect((await POST(post({ ...compliantDraft, clientRequestId: KEY_B }))).status).toBe(201);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(
      inserts.filter((i) => i.table === 'outbound_messages').map((i) => i.payload.client_request_id),
    ).toEqual([KEY_A, KEY_B]);
  });

  it('no key -> unchanged: no lookup, no key stored, every request sends', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockResolvedValue({ id: 'prov-1', provider: 'mock' });
    const { admin, inserts, calls } = makeAdmin({
      users: senderRow,
      outbound_messages: [
        insertedRow({ status: 'pending' }),
        sentRow('msg-1', 'prov-1'),
        insertedRow({ status: 'pending' }),
        sentRow('msg-1', 'prov-1'),
      ],
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    expect((await POST(post(compliantDraft))).status).toBe(201);
    expect((await POST(post(compliantDraft))).status).toBe(201);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(calls.some((c) => c.args[0] === 'client_request_id')).toBe(false);
    for (const i of inserts.filter((x) => x.table === 'outbound_messages')) {
      expect(i.payload).not.toHaveProperty('client_request_id');
    }
  });

  it.each([42, 'short', 'has spaces in it', 'x'.repeat(129)])(
    'a malformed key (%j) -> 400 before anything runs',
    async (clientRequestId) => {
      const { admin } = makeAdmin({ users: senderRow });
      signedIn(admin);
      const res = await POST(post({ ...compliantDraft, clientRequestId }));
      expect(res.status).toBe(400);
      expect(sendMock).not.toHaveBeenCalled();
    },
  );
});

describe('POST /api/v1/outbox: Jev second opinion (D82, off by default)', () => {
  const flagged = { ...compliantDraft, body: 'We guarantee the deal closes by March.' };
  const JEV_URL = 'https://ai-gateway.vercel.sh/v1/evaluate';

  function stubJev(promissory: number, mnpi: number) {
    const fetchMock = vi.fn(async (url: string) =>
      url === JEV_URL
        ? new Response(
            JSON.stringify({
              answers: { promissory: { probability: promissory }, mnpi: { probability: mnpi } },
              providerMetadata: { gateway: { cost: '0.00002' } },
            }),
            { status: 200 },
          )
        : new Response(
            JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ verdict: 'compliant', reasons: [] }) }] }),
            { status: 200 },
          ),
    );
    vi.stubGlobal('fetch', fetchMock);
    return () => fetchMock.mock.calls.filter(([url]) => url === JEV_URL).length;
  }

  it('cleared: sends, band Sampled, the audit names the outcome without probabilities, Jev is a cost line', async () => {
    // The escalate-only Claude pass must run for a clear to stand (D87), and
    // the model gate (#339) lets it run only for the DEV tenant on a local stack.
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gateway-test-key');
    localStack();
    const jevCalls = stubJev(0.01, 0.02);
    sendMock.mockResolvedValue({ id: 'prov-j1', provider: 'mock' });
    const { admin, inserts } = makeAdmin({
      users: devSenderRow,
      feature_flags: { data: { enabled: true }, error: null },
      outbound_messages: [
        insertedRow({ status: 'pending' }),
        insertedRow({ status: 'sent', provider_message_id: 'prov-j1' }),
      ],
      audit_log: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    signedIn(admin);

    const res = await POST(post(flagged));
    expect(res.status).toBe(201);
    expect(jevCalls()).toBe(1);
    const row = inserts.find((i) => i.table === 'outbound_messages');
    expect(row?.payload).toMatchObject({ verdict: 'compliant', risk_band: 'sampled' });
    const screen = inserts.find((i) => i.table === 'audit_log' && i.payload.action === 'screen');
    const screenDetail = screen?.payload.detail as Record<string, unknown>;
    expect(screenDetail.secondOpinion).toEqual({
      outcome: 'cleared',
      threshold: 0.05,
      clearedReasons: ['Promissory language to a counterparty. Rewrite suggested before send.'],
    });
    expect(screenDetail.riskBand).toBe('sampled');
    const send = inserts.find((i) => i.table === 'audit_log' && i.payload.action === 'send');
    expect((send?.payload.detail as Record<string, unknown>).secondOpinion).toBe('cleared');
    // No probability anywhere in what the route writes.
    expect(JSON.stringify(inserts)).not.toMatch(/0\.01|0\.02\b/);
    const ledger = inserts.find((i) => i.table === 'ai_usage');
    expect(ledger?.payload).toMatchObject({
      tenant_id: DEV_TENANT_ID,
      actor_id: 'md-1',
      source: 'screen',
      task: 'mail_send_second_opinion',
      model: 'typesafe-ai/jev',
      cost_usd: 0.00002,
    });
    vi.unstubAllGlobals();
  });

  it('kept: the email goes back to the sender, and the returned screen row says so', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gateway-test-key');
    localStack();
    stubJev(0.4, 0.01);
    const { admin, inserts } = makeAdmin({
      users: devSenderRow,
      feature_flags: { data: { enabled: true }, error: null },
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const res = await POST(post(flagged));
    expect(res.status).toBe(200);
    expect((await res.json()).riskIssues.cause).toBe('promissory');
    expect(sendMock).not.toHaveBeenCalled();
    const screenDetail = inserts.find((i) => i.table === 'audit_log')?.payload.detail as Record<string, unknown>;
    expect(screenDetail.returned).toBe(true);
    expect(screenDetail.secondOpinion).toEqual({ outcome: 'kept', threshold: 0.05, clearedReasons: [] });
    vi.unstubAllGlobals();
  });

  it('model gate withholds the tenant (#339): flag on, Jev is never called, the flag stands', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gateway-test-key');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefgh.supabase.co');
    const jevCalls = stubJev(0.01, 0.01);
    const { admin, inserts } = makeAdmin({
      users: senderRow,
      feature_flags: { data: { enabled: true }, error: null },
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const res = await POST(post(flagged));
    expect(res.status).toBe(200);
    expect((await res.json()).riskIssues.cause).toBe('promissory');
    expect(jevCalls()).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
    const screenDetail = inserts.find((i) => i.table === 'audit_log')?.payload.detail as Record<string, unknown>;
    expect(screenDetail).not.toHaveProperty('secondOpinion');
    expect(inserts.some((i) => i.table === 'ai_usage')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('flag off: Jev is never called and the screen row has no second opinion', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gateway-test-key');
    localStack();
    const jevCalls = stubJev(0.01, 0.01);
    const { admin, inserts } = makeAdmin({
      users: devSenderRow,
      feature_flags: { data: { enabled: false }, error: null },
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const res = await POST(post(flagged));
    expect(res.status).toBe(200);
    expect(jevCalls()).toBe(0);
    const screenDetail = inserts.find((i) => i.table === 'audit_log')?.payload.detail as Record<string, unknown>;
    expect(screenDetail).not.toHaveProperty('secondOpinion');
    expect(inserts.some((i) => i.table === 'ai_usage')).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('POST /api/v1/outbox: a Gmail-connected sender (#490)', () => {
  const gmailRow = (over: Record<string, unknown> = {}): Row => ({
    data: {
      id: 'mb-g1',
      user_id: 'md-1',
      provider: 'google',
      email: 'storm@bank.dev',
      status: 'connected',
      tokens_encrypted: encryptTokens({ refreshToken: 'rt-1' }),
      ...over,
    },
    error: null,
  });
  const mnpiDraft = { ...compliantDraft, body: 'Our internal model floors this at $510M' };
  const ok: Row = { data: null, error: null };
  const isOutbox = (entry: { table: string }) => entry.table === 'outbound_messages';

  function configureGmail() {
    vi.stubEnv('GOOGLE_SEND_CLIENT_ID', 'send-client');
    vi.stubEnv('GOOGLE_SEND_CLIENT_SECRET', 'send-secret');
    vi.stubEnv('GOOGLE_SEND_REDIRECT_URI', 'http://localhost:3000/api/v1/mailbox/google/callback');
    vi.stubEnv('MAILBOX_TOKEN_KEY', 'a'.repeat(64));
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
  }

  /** A send that reaches the provider: the pending insert, then the sent update. */
  const gmailAdmin = (mailbox: Row | Row[], extra: Record<string, Row | Row[]> = {}, users: Row = senderRow) =>
    makeAdmin({
      ...extra,
      users,
      mailbox_connections: mailbox,
      outbound_messages: [
        insertedRow({ status: 'pending' }),
        insertedRow({ status: 'sent', provider: 'gmail', provider_message_id: 'gmail-msg-1' }),
      ],
      audit_log: ok,
    });

  /** The first screen of an MNPI draft: risk issues, and a token bound to this envelope. */
  async function riskToken(mailbox: Row = gmailRow()): Promise<string> {
    const { admin } = makeAdmin({ users: senderRow, mailbox_connections: mailbox, audit_log: ok });
    signedIn(admin);
    return (await (await POST(post(mnpiDraft))).json()).riskIssues.token as string;
  }

  afterEach(() => vi.unstubAllGlobals());

  it('screens first, then sends through Gmail as the connected address; a forged from is ignored', async () => {
    configureGmail();
    const { admin, inserts, updates } = gmailAdmin(gmailRow());
    let screenedFirst = false;
    const gmail = fakeGmailSend({
      send: () => {
        screenedFirst = inserts.some((i) => i.table === 'audit_log' && i.payload.action === 'screen');
        return sentOk();
      },
    });
    vi.stubGlobal('fetch', gmail.fetch);
    signedIn(admin);

    const res = await POST(post({ ...compliantDraft, from: 'ceo@target.com', bcc: ['records@bank.dev'] }));

    expect(res.status).toBe(201);
    expect(screenedFirst).toBe(true);
    expect(gmail.log).toEqual(['token', 'send']);
    const sent = await gmail.parsed();
    expect(sent.from).toMatchObject({ address: 'storm@bank.dev' });
    expect(JSON.stringify(sent.headers)).not.toContain('ceo@target.com');
    expect(sent.bcc?.map((a) => a.address)).toEqual(['records@bank.dev']);
    expect(sendMock).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();
    expect(updates.find(isOutbox)?.payload).toMatchObject({
      status: 'sent',
      provider: 'gmail',
      provider_message_id: 'gmail-msg-1',
    });
    const sendAudit = inserts.find((i) => i.table === 'audit_log' && i.payload.action === 'send');
    expect(sendAudit?.payload.detail).toMatchObject({ provider: 'gmail', providerMessageId: 'gmail-msg-1' });
  });

  it('a ZDR refusal still screens on the rules and sends through Gmail, llmChecked false', async () => {
    configureGmail();
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    // The model gate (#339) lets the pass reach the gateway only for the DEV tenant on a local stack.
    localStack();
    const zdr = () =>
      jsonResponse({ type: 'error', error: { type: 'permission_denied', message: 'Zero Data Retention (ZDR) is not available' } }, 403);
    const gmail = fakeGmailSend({
      other: async (input) => {
        if (String(input) === GATEWAY_MESSAGES_URL) return zdr();
        throw new Error(`unexpected fetch ${String(input)}`);
      },
    });
    vi.stubGlobal('fetch', gmail.fetch);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { admin, inserts } = gmailAdmin(gmailRow(), {}, devSenderRow);
    signedIn(admin);

    const res = await POST(post(compliantDraft));
    warn.mockRestore();

    expect(res.status).toBe(201);
    expect(gmail.otherCalls).toEqual([GATEWAY_MESSAGES_URL]);
    expect(gmail.log).toEqual(['token', 'send']);
    expect(inserts.find(isOutbox)?.payload.llm_checked).toBe(false);
  });

  it('a send-as-is replays only for the same recipients and connection (R17)', async () => {
    configureGmail();
    const gmail = fakeGmailSend();
    vi.stubGlobal('fetch', gmail.fetch);
    const token = await riskToken();

    // A Bcc added, another connected address, or the same address disconnected and connected
    // again (a new row, #490 audit 3): a fresh screen and a fresh token, nothing sent.
    for (const [draft, mailbox] of [
      [{ ...mnpiDraft, bcc: ['records@bank.dev'] }, gmailRow()],
      [mnpiDraft, gmailRow({ email: 'storm.duncan@bank.dev' })],
      [mnpiDraft, gmailRow({ id: 'mb-g2' })],
    ] as const) {
      const { admin } = makeAdmin({ users: senderRow, mailbox_connections: mailbox, audit_log: ok });
      signedIn(admin);
      const res = await POST(post({ ...draft, sendAsIs: true, overrideToken: token }));
      expect(res.status).toBe(200);
      expect((await res.json()).riskIssues.token).not.toBe(token);
    }
    expect(gmail.log).toEqual([]);

    // The same envelope replays the first screen and sends.
    const { admin, inserts } = gmailAdmin(gmailRow());
    signedIn(admin);
    expect((await POST(post({ ...mnpiDraft, sendAsIs: true, overrideToken: token }))).status).toBe(201);
    const screen = inserts.find((i) => i.table === 'audit_log' && i.payload.action === 'screen');
    expect(screen?.payload.detail).toMatchObject({ replayed: true, sentAsIs: true });
    expect(gmail.log).toEqual(['token', 'send']);
  });

  it('a platform sender keeps the unbound token: a changed Bcc still replays (T13)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockResolvedValue({ id: 'prov-1', provider: 'mock' });
    const token = await riskToken(ok);
    const { admin, inserts } = gmailAdmin(ok);
    signedIn(admin);
    const res = await POST(post({ ...mnpiDraft, bcc: ['records@bank.dev'], sendAsIs: true, overrideToken: token }));
    expect(res.status).toBe(201);
    const screen = inserts.find((i) => i.table === 'audit_log' && i.payload.action === 'screen');
    expect(screen?.payload.detail).toMatchObject({ replayed: true });
  });

  it('a Gmail 500 is a 502 with a code and drops the pending row; a retry with the token replays once more', async () => {
    configureGmail();
    let failing = true;
    const gmail = fakeGmailSend({
      send: () => (failing ? jsonResponse({ error: { code: 500, status: 'INTERNAL' } }, 500) : sentOk()),
    });
    vi.stubGlobal('fetch', gmail.fetch);
    const token = await riskToken();

    const first = gmailAdmin(gmailRow());
    signedIn(first.admin);
    const res = await POST(post({ ...mnpiDraft, sendAsIs: true, overrideToken: token }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('Email provider send failed (gmail-send_500)');
    expect(first.deletes.some(isOutbox)).toBe(true);

    failing = false;
    const retry = gmailAdmin(gmailRow());
    signedIn(retry.admin);
    expect((await POST(post({ ...mnpiDraft, sendAsIs: true, overrideToken: token }))).status).toBe(201);
    expect(gmail.log).toEqual(['token', 'send', 'token', 'send']);
  });

  it('invalid_grant: a 502 with the reconnect copy, the connection marked revoked and audited in one RPC', async () => {
    configureGmail();
    const gmail = fakeGmailSend({ token: invalidGrant });
    vi.stubGlobal('fetch', gmail.fetch);
    const row = gmailRow();
    const { admin, inserts, updates, deletes, rpcs } = gmailAdmin([row, row], {
      'rpc:mailbox_sending_mark_revoked': { data: true, error: null },
    });
    signedIn(admin);

    const res = await POST(post(compliantDraft));

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(`Email provider send failed: ${GMAIL_RECONNECT_COPY}`);
    expect(gmail.log).toEqual(['token']);
    // The revoke and its mailbox.approval_ended row are one transaction in SQL (#490 audit 2).
    const stored = row.data as { id: string; tokens_encrypted: string };
    expect(rpcs).toEqual([
      { fn: 'mailbox_sending_mark_revoked', args: { p_connection: stored.id, p_read_blob: stored.tokens_encrypted } },
    ]);
    expect(updates.some((u) => u.table === 'mailbox_connections')).toBe(false);
    expect(inserts.filter((i) => i.table === 'audit_log').map((i) => i.payload.action)).toEqual(['screen']);
    expect(deletes.some(isOutbox)).toBe(true);
  });

  it.each([
    ['the approval ended', () => gmailRow({ status: 'revoked', tokens_encrypted: null }), GMAIL_RECONNECT_COPY],
    [
      'Gmail sending is switched off',
      () => {
        vi.stubEnv('GOOGLE_SEND_CLIENT_ID', '');
        return gmailRow();
      },
      GMAIL_UNCONFIGURED_COPY,
    ],
  ])('%s: a 502 before the screen, with no AI call, audit row or pending row (R23)', async (_label, seed, copy) => {
    configureGmail();
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { admin, inserts } = gmailAdmin(seed());
    signedIn(admin);

    const res = await POST(post(compliantDraft));

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(`Email provider send failed: ${copy}`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('a mailbox read error is a 500 before the screen, never a platform send (R21)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { admin, inserts } = gmailAdmin({ data: null, error: { code: '57014', message: 'statement timeout' } });
    signedIn(admin);

    const res = await POST(post(compliantDraft));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Mailbox connection unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('a mailbox connected between the screen and the send refuses rather than re-routing (T7)', async () => {
    configureGmail();
    const gmail = fakeGmailSend();
    vi.stubGlobal('fetch', gmail.fetch);
    const { admin, deletes } = gmailAdmin([ok, gmailRow()]);
    signedIn(admin);

    const res = await POST(post(compliantDraft));

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(`Email provider send failed: ${MAILBOX_CHANGED_COPY}`);
    expect(gmail.log).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
    expect(deletes.some(isOutbox)).toBe(true);
  });
});

describe('POST /api/v1/outbox: a reply (#339)', () => {
  const dealId = 'KESTR-2026-412';
  const ok = { data: null, error: null };
  const record = (over: Record<string, unknown> = {}) => ({
    actorId: 'md-1',
    dealCode: dealId,
    sourceItemId: 'i-2',
    inReplyTo: '<b@target.com>',
    references: ['<a@target.com>', '<b@target.com>'],
    participants: ['founder@target.com', 'md@bank.example'],
    iat: Date.now(),
    ...over,
  });

  function fixture() {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    vi.stubEnv('INVITE_VERIFICATION_PEPPER', 'pepper');
    sendMock.mockResolvedValue({ id: 'prov-1', provider: 'mock' });
    const result = makeAdmin({
      users: senderRow,
      deals: [{ data: { id: 'deal-uuid' }, error: null }, { data: { tenant_id: 'tenant-1' }, error: null }, { data: { lifecycle_category: 'closed' }, error: null }],
      deal_memberships: { data: { id: 'seat-1' }, error: null },
      outbound_messages: [insertedRow({ status: 'pending' }), insertedRow({ status: 'sent', provider_message_id: 'prov-1' })],
      audit_log: [ok, ok],
    });
    signedIn(result.admin);
    return result;
  }

  it('threads the reply from the signed token only, and audits the message it answers', async () => {
    const { inserts } = fixture();
    const replyToken = mintReplyToken(record());

    const res = await POST(post({ ...compliantDraft, dealId, replyToken, inReplyTo: '<forged@x>', references: ['<forged@x>'] }));

    expect(res.status).toBe(201);
    const [sent] = sendMock.mock.calls[0] as [Record<string, unknown>];
    expect(sent).toMatchObject({ inReplyTo: '<b@target.com>', references: ['<a@target.com>', '<b@target.com>'] });
    expect(JSON.stringify(sent)).not.toContain('forged');
    const sendAudit = inserts.find((i) => i.table === 'audit_log' && i.payload.action === 'send');
    expect(sendAudit?.payload.detail).toMatchObject({ replyToSourceItemId: 'i-2' });
    expect(sendAudit?.payload.detail).not.toHaveProperty('replyRecipientsOutsideThread');
    // The screen row ties the reply to its thread too, so a refused reply is not orphaned.
    const screenAudit = inserts.find((i) => i.table === 'audit_log' && i.payload.action === 'screen');
    expect(screenAudit?.payload.detail).toMatchObject({ replyToSourceItemId: 'i-2' });
  });

  it('sends a reply that adds someone outside the thread unthreaded, and audits that it did', async () => {
    const { inserts } = fixture();
    const replyToken = mintReplyToken(record());

    const res = await POST(post({ ...compliantDraft, cc: ['newcomer@other.example'], dealId, replyToken }));

    expect(res.status).toBe(201);
    const [sent] = sendMock.mock.calls[0] as [Record<string, unknown>];
    expect(sent).not.toHaveProperty('inReplyTo');
    expect(sent).not.toHaveProperty('references');
    for (const action of ['screen', 'send']) {
      const audit = inserts.find((i) => i.table === 'audit_log' && i.payload.action === action);
      expect(audit?.payload.detail).toMatchObject({ replyToSourceItemId: 'i-2', replyRecipientsOutsideThread: true });
    }
  });

  it('a new message carries no threading', async () => {
    fixture();
    expect((await POST(post({ ...compliantDraft, dealId }))).status).toBe(201);
    const [sent] = sendMock.mock.calls[0] as [Record<string, unknown>];
    expect(sent).not.toHaveProperty('inReplyTo');
    expect(sent).not.toHaveProperty('references');
  });

  it.each([
    ["another sender's token", () => ({ dealId, replyToken: mintReplyToken(record({ actorId: 'md-2' })) })],
    ["another deal's token", () => ({ dealId, replyToken: mintReplyToken(record({ dealCode: 'OSPRY-2026-001' })) })],
    ['an expired token', () => ({ dealId, replyToken: mintReplyToken(record({ iat: Date.now() - 13 * 60 * 60 * 1000 })) })],
    ['a forged token', () => ({ dealId, replyToken: 'e30.AAAA' })],
    ['a token without a deal', () => ({ replyToken: mintReplyToken(record()) })],
    ['a token with no participants', () => ({ dealId, replyToken: mintReplyToken(record({ participants: undefined })) })],
    ['a non-string token', () => ({ dealId, replyToken: 42 })],
  ])('400s %s before writing or sending anything', async (_label, extra) => {
    const { inserts } = fixture();
    const res = await POST(post({ ...compliantDraft, ...extra() }));
    expect(res.status).toBe(400);
    expect(inserts).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

// Issue #94 / Issue #95 (D105): the firm's thresholds, the queued-send
// notification and the confirm step before an external send.
describe('firm compliance settings on the send path', () => {
  function setup(settings: Record<string, unknown> | null, opts: { settingsError?: unknown } = {}) {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    sendMock.mockResolvedValue({ id: 'provider-1', provider: 'mock' });
    const result = makeAdmin({
      users: [
        // requireApiUser's profile read, then the sender.
        { data: { tenant_id: 'tenant-1', company_id: 'firm-1', firm_role: 'banker' }, error: null },
        { data: { tenant_id: 'tenant-1', company_id: 'firm-1', firm_role: 'banker' }, error: null },
        // notifyQueuedSend: the firm's reviewers, then the sender's name.
        { data: [{ id: 'cco-1' }, { id: 'md-1' }], error: null },
        { data: { display_name: 'Dana Banker' }, error: null },
      ],
      companies: { data: { tenant_id: 'tenant-1' }, error: null },
      company_verified_domains: { data: [{ domain: 'bank.example' }], error: null },
      firm_compliance_settings: { data: settings, error: opts.settingsError ?? null },
      outbound_messages: [insertedRow({ status: 'pending' }), insertedRow({ status: 'sent' })],
      audit_log: { data: null, error: null },
      notifications: { data: null, error: null },
    });
    signedIn(result.admin);
    return result;
  }
  const confirmExternal = { queued_from: 70, sampled_from: 40, unchecked_floor: 'routine', send_friction: 'confirm_external' };

  it('asks for confirmation before an external send, before any screen or record', async () => {
    const { inserts } = setup(confirmExternal);
    const res = await POST(post({ ...compliantDraft, to: ['a@bank.example'], cc: ['founder@target.com'] }));
    expect(res.status).toBe(409);
    expect((await res.json()).externalConfirmationRequired).toEqual({ recipients: ['founder@target.com'] });
    expect(sendMock).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it('sends once confirmed and records the confirmation on the send row', async () => {
    const { inserts } = setup(confirmExternal);
    const res = await POST(post({ ...compliantDraft, externalConfirmed: true }));
    expect(res.status).toBe(201);
    expect(sendMock).toHaveBeenCalledOnce();
    const sendRow = inserts.find((i) => i.table === 'audit_log' && i.payload.action === 'send');
    expect((sendRow?.payload.detail as Record<string, unknown>).externalConfirmed).toBe(true);
  });

  it('never asks for an all-internal send, nor for a one-click firm', async () => {
    setup(confirmExternal);
    expect((await POST(post({ ...compliantDraft, to: ['a@bank.example'] }))).status).toBe(201);
    const { inserts } = setup(null);
    expect((await POST(post(compliantDraft))).status).toBe(201);
    const sendRow = inserts.find((i) => i.table === 'audit_log' && i.payload.action === 'send');
    expect((sendRow?.payload.detail as Record<string, unknown>).externalConfirmed).toBeUndefined();
  });

  it('refuses the send when the settings cannot be read, rather than using looser defaults', async () => {
    const { inserts } = setup(null, { settingsError: { message: 'down', code: '08006' } });
    const res = await POST(post(compliantDraft));
    expect(res.status).toBe(503);
    expect(sendMock).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it('bands with the firm floor and notifies the reviewers, not the sender, when a queued send goes out', async () => {
    // The AI pass is off in tests (no gateway key), so the rules alone pass this.
    const { inserts } = setup({ ...confirmExternal, send_friction: 'one_click', unchecked_floor: 'queued' });
    const res = await POST(post({ ...compliantDraft, dealId: 'not-a-deal' }));
    expect(res.status).toBe(201);
    expect(inserts.find((i) => i.table === 'outbound_messages')?.payload.risk_band).toBe('queued');
    const notes = inserts.find((i) => i.table === 'notifications')?.payload as unknown as Array<Record<string, unknown>>;
    expect(notes.map((n) => n.recipient_id)).toEqual(['cco-1']);
    expect(notes[0]).toMatchObject({ event_type: 'mail_queued_for_review', tenant_id: 'tenant-1' });
    expect((notes[0].payload as Record<string, unknown>).destinationLabel).toBe('Dana Banker: a sent email is queued for your review');
    // Content-free: no subject, no reasons.
    expect(JSON.stringify(notes)).not.toContain(compliantDraft.subject);
  });

  it('sends no notification for a routine send', async () => {
    const { inserts } = setup(null);
    expect((await POST(post(compliantDraft))).status).toBe(201);
    expect(inserts.some((i) => i.table === 'notifications')).toBe(false);
  });
});
