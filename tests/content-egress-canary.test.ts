// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { GET as DATAROOM_LIST } from '@/app/api/v1/deals/[dealId]/steps/[stepId]/dataroom/route';
import { POST as DATAROOM_UPLOAD } from '@/app/api/v1/deals/[dealId]/steps/[stepId]/dataroom/upload/route';
import { POST as DOCUMENTS_UPLOAD } from '@/app/api/v1/deals/[dealId]/documents/route';
import { GET as DOCUMENT_DOWNLOAD } from '@/app/api/v1/deals/[dealId]/documents/[documentId]/download/route';
import { POST as DEALS_CREATE } from '@/app/api/v1/deals/route';
import { POST as TEMPLATE_RESUME } from '@/app/api/v1/deals/template-creations/[requestId]/route';
import { POST as LEAD_DOCUMENTS } from '@/app/v1/leads/[leadId]/documents/route';
import { POST as OUTBOX_SEND } from '@/app/api/v1/outbox/route';
import { PATCH as OUTBOX_REVIEW } from '@/app/api/v1/outbox/[messageId]/route';
import { requireApiUser, resolveDealRef } from '@/lib/api/v1/http';
import { deliverInvite, fetchInviteEmailContext } from '@/lib/api/v1/inviteDelivery';
import { INVITE_AUTH_METHOD } from '@/lib/constants/workIdentity';
import { encryptTokens } from '@/lib/email/tokenCrypto';
import { getBoxClient } from '@/lib/box';
import { requireConductiaLead } from '@/lib/conductia/route';
import { listDealStepsWithDatarooms, provisionDataroomFolder } from '@/lib/dataroom/steps';
import { orderedSteps } from '@/lib/rail/dealRail';
import { resetDataRoomStorage } from '@/lib/storage';
import { captureConsole, type ConsoleCapture } from './helpers/consoleCapture';

/**
 * #331 canary: a third-party body, a PostgREST message or a folder name never
 * reaches a log line or a response. CANARY-331 is planted where Box, or the
 * database, would put text; it must not surface anywhere an operator or an API
 * client can read it. Box runs through the real client and the real storage
 * provider with only `fetch` stubbed, so the whole throw-to-response path is
 * exercised. The mail paths run the same way: the real Resend transport, the
 * real Graph sender and the real invite delivery, with only `fetch` stubbed.
 */

const CANARY = 'CANARY-331';

vi.mock('@/lib/api/v1/http', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: vi.fn(),
  resolveDealRef: vi.fn(),
}));
vi.mock('@/lib/api/v1/access', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api/v1/access')>()),
  userCanAccessDeal: vi.fn(() => Promise.resolve(true)),
  classifyInternalUser: vi.fn(() => Promise.resolve('internal')),
  userCanUploadToDataroom: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/lib/flags/requireFlag', () => ({ requireFlag: vi.fn(() => Promise.resolve(null)) }));
vi.mock('@/lib/api/v1/requireFlag', () => ({
  requireFlag: vi.fn(() => Promise.resolve(null)),
  isFlagEnabled: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/lib/api/v1/documentAccess', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api/v1/documentAccess')>()),
  getDocumentViewer: vi.fn(() => Promise.resolve({})),
  userCanUploadDocument: vi.fn(() => true),
  userCanOpenDocument: vi.fn(() => true),
}));
vi.mock('@/lib/dataroom/steps', () => ({
  loadDealByIdOrCode: vi.fn(),
  provisionDataroomFolder: vi.fn(),
  listDealStepsWithDatarooms: vi.fn(),
  seedDataroomsForDeal: vi.fn(() => Promise.resolve()),
  provisionDealDataroomOnCreate: vi.fn(),
}));
vi.mock('@/lib/conductia/route', () => ({ requireConductiaLead: vi.fn() }));
vi.mock('@/lib/conductia/documents', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/conductia/documents')>()),
  persistLeadDocument: vi.fn(() =>
    Promise.resolve({
      documentId: 'doc-lead-1',
      version: 1,
      folder: 'md-brief',
      documentType: 'other',
      uploadedAt: '2026-10-02T00:00:00Z',
    }),
  ),
}));
vi.mock('@/lib/railTemplates/access', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/railTemplates/access')>()),
  requireTemplateFlags: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('@/lib/railTemplates/createDeal', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/railTemplates/createDeal')>()),
  resumeDealCreation: vi.fn(() => Promise.resolve({ deal: { id: 'deal-tpl-1', code: 'TPL-1' } })),
}));

// ---------------------------------------------------------------------------
// Box, stubbed at fetch

const BODY_SHAPES: Array<[string, string]> = [
  [
    'a Box JSON error',
    JSON.stringify({
      type: 'error',
      status: 403,
      code: 'access_denied_insufficient_permissions',
      message: `${CANARY} quoted Q3 board deck.pdf`,
    }),
  ],
  ['a plain-text body', `${CANARY} the provider wrote a sentence here`],
];

type BoxHandler = (url: string, init: RequestInit) => Response;

function stubBox(handler: BoxHandler) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      return handler(url, init ?? {});
    }),
  );
}

const fail = (body: string, status = 403) => new Response(body, { status });
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// ---------------------------------------------------------------------------
// A chainable admin stub: each table answers one configured response.

type Resp = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Resp> = {}) {
  return {
    from(table: string) {
      let resp: Resp = tables[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'in', 'neq', 'insert', 'update', 'limit', 'order']) builder[m] = () => builder;
      builder.delete = () => {
        resp = tables[`${table}:delete`] ?? { data: null, error: null };
        return builder;
      };
      builder.single = () => Promise.resolve(resp);
      builder.maybeSingle = () => Promise.resolve(resp);
      builder.then = (res: (v: Resp) => unknown) => Promise.resolve(resp).then(res);
      return builder;
    },
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  } as unknown as SupabaseClient;
}

function signIn(admin: SupabaseClient) {
  vi.mocked(requireApiUser).mockResolvedValue({
    ok: true,
    admin,
    user: { id: 'u1', email: 'md@bank.dev' },
  } as never);
}

const STEP_ID = orderedSteps()[0].id;
const stepContext = { params: Promise.resolve({ dealId: 'd1', stepId: STEP_ID }) };

function uploadRequest() {
  const form = new FormData();
  form.append('file', new File(['pdf'], 'cim.pdf'));
  return new Request('http://localhost/x', { method: 'POST', body: form });
}

let capture: ConsoleCapture;

beforeEach(() => {
  vi.clearAllMocks();
  capture = captureConsole();
  vi.stubEnv('BOX_CLIENT_ID', 'client-id');
  vi.stubEnv('BOX_SECRET', 'client-secret');
  vi.stubEnv('BOX_ENTERPRISE_ID', 'enterprise-id');
  vi.stubEnv('BOX_DEV_TOKEN', 'dev-token');
  vi.stubEnv('STORAGE_PROVIDER', 'box');
  resetDataRoomStorage();
  vi.mocked(provisionDataroomFolder).mockResolvedValue({
    id: 'room-1',
    box_folder_id: 'folder-1',
    box_folder_url: 'https://app.box.com/folder/folder-1',
    provider: 'box',
    min_phase: 1,
  } as never);
  vi.mocked(listDealStepsWithDatarooms).mockResolvedValue([]);
  vi.mocked(resolveDealRef).mockResolvedValue({ id: 'd1', code: 'PRJRA' });
  signIn(makeAdmin());
});

afterEach(() => {
  capture.restore();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetDataRoomStorage();
});

async function bodyOf(res: Response): Promise<string> {
  return res.text();
}

describe('Box failures on the step dataroom routes', () => {
  it.each(BODY_SHAPES)('list: %s never reaches the 500 body or a log', async (_label, body) => {
    stubBox(() => fail(body));
    const { loadDealByIdOrCode } = await import('@/lib/dataroom/steps');
    vi.mocked(loadDealByIdOrCode).mockResolvedValue({ id: 'd1', code: 'PRJRA' } as never);

    const res = await DATAROOM_LIST(new Request('http://localhost/x'), stepContext);
    const text = await bodyOf(res);

    expect(res.status).toBe(500);
    expect(text).not.toContain(CANARY);
    expect(JSON.parse(text)).toEqual({ error: 'Dataroom storage failed (box_403)' });
    expect(capture.output()).not.toContain(CANARY);
  });

  it.each(BODY_SHAPES)('upload: %s never reaches the 500 body or a log', async (_label, body) => {
    stubBox(() => fail(body));
    const { loadDealByIdOrCode } = await import('@/lib/dataroom/steps');
    vi.mocked(loadDealByIdOrCode).mockResolvedValue({ id: 'd1', code: 'PRJRA' } as never);

    const res = await DATAROOM_UPLOAD(uploadRequest(), stepContext);
    const text = await bodyOf(res);

    expect(res.status).toBe(500);
    expect(text).not.toContain(CANARY);
    expect(JSON.parse(text)).toEqual({ error: 'Dataroom storage failed (box_403)' });
    expect(capture.output()).not.toContain(CANARY);
  });

  it('orphan log: a failed cleanup delete logs the file id and a code, not the Box error', async () => {
    stubBox((_url, init) =>
      init.method === 'DELETE'
        ? fail(BODY_SHAPES[0][1])
        : ok({ entries: [{ id: 'box-9', name: 'cim.pdf', size: 3 }] }, 201),
    );
    const { loadDealByIdOrCode } = await import('@/lib/dataroom/steps');
    vi.mocked(loadDealByIdOrCode).mockResolvedValue({ id: 'd1', code: 'PRJRA' } as never);
    signIn(makeAdmin({ documents: { data: null, error: { code: 'XX000', message: 'row rejected' } } }));

    const res = await DATAROOM_UPLOAD(uploadRequest(), stepContext);

    expect(res.status).toBe(500);
    const logged = capture.output();
    expect(logged).not.toContain(CANARY);
    expect(logged).toContain('box-9');
  });

  it('unaudited log: a rollback the database refused logs ids and a code, not its message', async () => {
    stubBox(() => ok({ entries: [{ id: 'box-9', name: 'cim.pdf', size: 3 }] }, 201));
    const { loadDealByIdOrCode } = await import('@/lib/dataroom/steps');
    vi.mocked(loadDealByIdOrCode).mockResolvedValue({ id: 'd1', code: 'PRJRA' } as never);
    signIn(
      makeAdmin({
        documents: { data: { id: 'doc-1', name: 'cim.pdf' }, error: null },
        audit_log: { data: null, error: { code: 'XX001', message: 'chain broken' } },
        'documents:delete': { data: null, error: { code: '23503', message: `${CANARY} legal hold on cim.pdf` } },
      }),
    );

    const res = await DATAROOM_UPLOAD(uploadRequest(), stepContext);

    expect(res.status).toBe(500);
    const logged = capture.output();
    expect(logged).not.toContain(CANARY);
    expect(logged).toContain('doc-1');
    expect(logged).toContain('box-9');
    expect(logged).toContain('23503');
  });
});

describe('Box failures on the documents routes', () => {
  function documentsRequest() {
    const form = new FormData();
    form.append('file', new File(['pdf'], 'cim.pdf', { type: 'application/pdf' }));
    return new Request('http://localhost/x', { method: 'POST', body: form });
  }

  it('upload: a Box conflict does not echo the folder name into the 502', async () => {
    // The deal code is the folder name Box refuses; a 409 with no conflict id
    // used to quote it back as `Box folder conflict for "<name>"`.
    vi.mocked(resolveDealRef).mockResolvedValue({ id: 'd1', code: `${CANARY}-DEAL` });
    stubBox((url, init) => {
      if (url.endsWith('/folders') && init.method === 'POST') {
        const { name } = JSON.parse(String(init.body)) as { name: string };
        return name.startsWith(CANARY) ? fail(JSON.stringify({ code: 'item_name_in_use' }), 409) : ok({ id: `f-${name}` }, 201);
      }
      return fail(BODY_SHAPES[0][1]);
    });

    const res = await DOCUMENTS_UPLOAD(documentsRequest(), { params: Promise.resolve({ dealId: 'd1' }) });
    const text = await bodyOf(res);

    expect(res.status).toBe(502);
    expect(text).not.toContain(CANARY);
    expect(JSON.parse(text)).toEqual({ error: 'Storage is unavailable, try again (box_409)' });
    expect(capture.output()).not.toContain(CANARY);
  });

  it('upload: a refused file upload answers with the status code only', async () => {
    stubBox((url, init) =>
      url.endsWith('/folders') && init.method === 'POST' ? ok({ id: 'f-1' }, 201) : fail(BODY_SHAPES[0][1]),
    );

    const res = await DOCUMENTS_UPLOAD(documentsRequest(), { params: Promise.resolve({ dealId: 'd1' }) });
    const text = await bodyOf(res);

    expect(res.status).toBe(502);
    expect(text).not.toContain(CANARY);
    expect(JSON.parse(text)).toEqual({ error: 'Storage is unavailable, try again (box_403)' });
  });

  it('download: a refused read answers with the status code only', async () => {
    stubBox(() => fail(BODY_SHAPES[0][1]));
    signIn(
      makeAdmin({
        documents: {
          data: {
            id: 'doc-1',
            deal_id: 'd1',
            name: 'cim.pdf',
            room: 'deal',
            classification: 2,
            min_phase: 0,
            storage_file_id: 'box-file-1',
            content_type: 'application/pdf',
          },
          error: null,
        },
      }),
    );

    const res = await DOCUMENT_DOWNLOAD(new Request('http://localhost/x'), {
      params: Promise.resolve({ dealId: 'd1', documentId: 'doc-1' }),
    });
    const text = await bodyOf(res);

    expect(res.status).toBe(502);
    expect(text).not.toContain(CANARY);
    expect(JSON.parse(text)).toEqual({ error: 'Storage is unavailable, try again (box_403)' });
  });
});

describe('Box failures on the lead documents route', () => {
  it('a brief that cannot be filed answers with fixed copy and a code', async () => {
    stubBox(() => fail(BODY_SHAPES[0][1]));
    const { loadDealByIdOrCode } = await import('@/lib/dataroom/steps');
    vi.mocked(loadDealByIdOrCode).mockResolvedValue({ id: 'd1', code: 'PRJRA' } as never);
    const admin = makeAdmin({ deals: { data: { mandate_owner_id: 'owner-1' }, error: null } });
    vi.mocked(requireConductiaLead).mockResolvedValue({
      ok: true,
      admin,
      scope: { agentName: 'ignatious', runId: 'run-1', tenantId: 'tenant-1', claims: null },
    } as never);

    const res = await LEAD_DOCUMENTS(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Brief',
          contentBase64: Buffer.from('hello').toString('base64'),
          originalFilename: 'brief.docx',
        }),
      }),
      { params: Promise.resolve({ leadId: 'd1' }) },
    );
    const text = await bodyOf(res);

    expect(res.status).toBe(500);
    expect(text).not.toContain(CANARY);
    expect(JSON.parse(text).error.message).toBe('Dataroom storage failed (box_403)');
    expect(capture.output()).not.toContain(CANARY);
  });
});

describe('Box failures while provisioning a new deal', () => {
  async function failProvisioning() {
    stubBox(() => fail(BODY_SHAPES[0][1]));
    const { provisionDealDataroomOnCreate } = await import('@/lib/dataroom/steps');
    vi.mocked(provisionDealDataroomOnCreate).mockImplementation(async () => {
      await getBoxClient().createFolder('develop', '0');
      return 'ready';
    });
  }

  it('deal create: the provisioning log carries the deal id and a code, not the wrapped error', async () => {
    await failProvisioning();
    const admin = makeAdmin({
      users: { data: { tenant_id: 'tenant-1' }, error: null },
      companies: { data: { id: 'bank-1' }, error: null },
    });
    vi.mocked(admin.rpc).mockResolvedValue({
      data: {
        deal: { id: 'd1', code: 'FALCO-2026-123', codename: 'Project Falcon' },
        memberships: [],
        notified: [],
      },
      error: null,
    } as never);
    signIn(admin);

    const res = await DEALS_CREATE(
      new Request('http://localhost/api/v1/deals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          codename: 'Project Falcon',
          targetName: 'Canva',
          conflictsAttestation: { approvedBy: 'Avery Lindqvist', approvedOn: new Date().toISOString().slice(0, 10) },
        }),
      }),
    );

    expect(res.status).toBe(201);
    const logged = capture.output();
    expect(logged).not.toContain(CANARY);
    expect(logged).toContain('d1');
    expect(logged).toContain('box_403');
  });

  it('template resume: the provisioning log carries the deal id and a code, not the wrapped error', async () => {
    await failProvisioning();

    const res = await TEMPLATE_RESUME(new Request('http://localhost/x', { method: 'POST' }), {
      params: Promise.resolve({ requestId: 'req-1' }),
    });

    expect(res.status).toBe(200);
    const logged = capture.output();
    expect(logged).not.toContain(CANARY);
    expect(logged).toContain('deal-tpl-1');
    expect(logged).toContain('box_403');
  });
});

// ---------------------------------------------------------------------------
// Mail: the outbox send and release routes, and invite delivery (Phase 6).
//
// Resend and Graph are stubbed at fetch. A provider's refusal can quote the
// message, a recipient or a domain; none of it may reach a log line, the 502
// body or the invite result. First-party operator copy is the one thing that
// passes through, word for word (V8).

const MAIL_BODY_SHAPES: Array<[string, string]> = [
  [
    'a Resend JSON error',
    JSON.stringify({
      statusCode: 403,
      name: 'validation_error',
      message: `${CANARY} the domain conductia.dev is not verified for founder@target.com`,
    }),
  ],
  ['a plain-text body', `${CANARY} the provider wrote a sentence here`],
];

const GRAPH_BODY_SHAPES: Array<[string, string]> = [
  [
    'a Graph JSON error',
    JSON.stringify({
      error: { code: 'ErrorAccessDenied', message: `${CANARY} access is denied for founder@target.com` },
    }),
  ],
  ['a plain-text body', `${CANARY} the provider wrote a sentence here`],
];

const MAIL_SEND_FAILED = 'Email provider send failed';
const RESEND_URL = 'https://api.resend.com/emails';

type MailRoutes = {
  resend?: () => Response;
  graphToken?: () => Response;
  graphSend?: () => Response;
  gmailToken?: () => Response;
  gmailSend?: () => Response;
};

function stubMailFetch(routes: MailRoutes) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === RESEND_URL && routes.resend) return routes.resend();
    if (url.includes('login.microsoftonline.com') && routes.graphToken) return routes.graphToken();
    if (url.includes('graph.microsoft.com') && routes.graphSend) return routes.graphSend();
    if (url === 'https://oauth2.googleapis.com/token' && routes.gmailToken) return routes.gmailToken();
    if (url.startsWith('https://gmail.googleapis.com/') && routes.gmailSend) return routes.gmailSend();
    throw new Error(`unexpected fetch in the mail canary: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const graphTokenOk = () =>
  ok({ access_token: 'at-fresh', refresh_token: 'rt-fresh', expires_in: 3600 });

function stubResendEnv() {
  vi.stubEnv('EMAIL_PROVIDER', 'resend');
  vi.stubEnv('RESEND_API_KEY', 'resend-key');
  vi.stubEnv('EMAIL_FROM', 'Conductia <deals@conductia.dev>');
  vi.stubEnv('RESEND_FROM', 'Conductia <invites@conductia.dev>');
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
}

function stubGraphEnv() {
  vi.stubEnv('MS_CLIENT_ID', 'ms-client');
  vi.stubEnv('MS_CLIENT_SECRET', 'ms-secret');
  vi.stubEnv('MS_REDIRECT_URI', 'https://app.dev/api/mailbox/callback');
  vi.stubEnv('MAILBOX_TOKEN_KEY', '00'.repeat(32));
}

const sendRequest = () =>
  new Request('http://localhost/api/v1/outbox', {
    method: 'POST',
    body: JSON.stringify({
      to: ['founder@target.com'],
      subject: 'Process update',
      body: 'The room opens Monday.',
    }),
  });

const OUTBOX_ROW = {
  id: 'msg-1',
  status: 'pending',
  verdict: 'compliant',
  reasons: [],
  rewrite: null,
  llm_checked: false,
  provider_message_id: null,
  created_at: '2026-10-03T12:00:00Z',
};

function outboxAdmin(extra: Record<string, Resp> = {}) {
  return makeAdmin({
    users: { data: { tenant_id: 'tenant-1', firm_role: 'banker', company_id: 'company-1' }, error: null },
    outbound_messages: { data: OUTBOX_ROW, error: null },
    audit_log: { data: null, error: null },
    ...extra,
  });
}

async function sendThroughOutbox(admin: SupabaseClient) {
  vi.stubEnv('AI_GATEWAY_API_KEY', '');
  vi.stubEnv('OUTBOX_SCREEN_SECRET', 'canary-screen-secret');
  signIn(admin);
  const res = await OUTBOX_SEND(sendRequest());
  return { res, text: await res.text() };
}

describe('Resend failures on the outbox routes', () => {
  beforeEach(stubResendEnv);

  it.each(MAIL_BODY_SHAPES)('send: %s never reaches the 502 body or a log', async (_label, body) => {
    stubMailFetch({ resend: () => fail(body) });

    const { res, text } = await sendThroughOutbox(outboxAdmin());

    expect(res.status).toBe(502);
    expect(text).not.toContain(CANARY);
    expect(capture.output()).not.toContain(CANARY);
    expect(JSON.parse(text)).toEqual({ error: `${MAIL_SEND_FAILED} (resend_403)` });
  });

  it.each(MAIL_BODY_SHAPES)('release: %s never reaches the 502 body or a log', async (_label, body) => {
    stubMailFetch({ resend: () => fail(body) });
    signIn(
      makeAdmin({
        users: { data: { firm_role: 'cco', is_external: false, department: null, tenant_id: 'tenant-1' }, error: null },
        outbound_messages: {
          data: {
            id: 'msg-h1',
            status: 'held',
            sender_id: 'md-9',
            to_emails: ['founder@target.com'],
            cc_emails: [],
            bcc_emails: [],
            subject: 'Valuation range',
            body: 'The room opens Monday.',
            body_html: null,
            attachments: [],
            deal_id: null,
          },
          error: null,
        },
        audit_log: { data: null, error: null },
      }),
    );

    const res = await OUTBOX_REVIEW(
      new Request('http://localhost/api/v1/outbox/msg-h1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'release' }),
      }),
      { params: Promise.resolve({ messageId: 'msg-h1' }) },
    );
    const text = await bodyOf(res);

    expect(res.status).toBe(502);
    expect(text).not.toContain(CANARY);
    expect(capture.output()).not.toContain(CANARY);
    expect(JSON.parse(text)).toEqual({ error: `${MAIL_SEND_FAILED} (resend_403)` });
  });
});

describe('Graph failures on the outbox send route', () => {
  beforeEach(() => {
    stubResendEnv();
    stubGraphEnv();
  });

  const connected = () => ({
    mailbox_connections: {
      data: {
        id: 'conn-1',
        user_id: 'u1',
        provider: 'microsoft',
        status: 'connected',
        email: 'md@bank.dev',
        tokens_encrypted: encryptTokens({ accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: 1 }),
      },
      error: null,
    } as Resp,
  });

  it.each(GRAPH_BODY_SHAPES)('sendMail: %s never reaches the 502 body or a log', async (_label, body) => {
    stubMailFetch({ graphToken: graphTokenOk, graphSend: () => fail(body) });

    const { res, text } = await sendThroughOutbox(outboxAdmin(connected()));

    expect(res.status).toBe(502);
    expect(text).not.toContain(CANARY);
    expect(JSON.parse(text)).toEqual({ error: `${MAIL_SEND_FAILED} (graph-mail_403)` });
    expect(capture.output()).not.toContain(CANARY);
  });

  // V8: first-party operator copy is shown word for word. These pass before
  // and after the change; they pin the copy against the code mapping.
  it('V8: an expired mailbox connection keeps its reconnect copy', async () => {
    stubMailFetch({ graphToken: () => fail(`${CANARY} invalid_grant`, 400) });

    const { res, text } = await sendThroughOutbox(outboxAdmin(connected()));

    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toEqual({
      error: 'Email provider send failed: Mailbox connection expired; reconnect the mailbox',
    });
    expect(capture.output()).not.toContain(CANARY);
  });

  it('V8: an unreadable mailbox connection keeps its reconnect copy', async () => {
    stubMailFetch({});
    const admin = outboxAdmin({
      mailbox_connections: {
        data: { id: 'conn-1', user_id: 'u1', provider: 'microsoft', status: 'connected', email: 'md@bank.dev', tokens_encrypted: 'not-a-token' },
        error: null,
      },
    });

    const { res, text } = await sendThroughOutbox(admin);

    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toEqual({
      error: 'Email provider send failed: Mailbox connection unreadable; reconnect the mailbox',
    });
  });
});

const GMAIL_BODY_SHAPES: Array<[string, string]> = [
  [
    'a Gmail JSON error',
    JSON.stringify({
      error: {
        code: 403,
        message: `${CANARY} delegation denied for founder@target.com`,
        errors: [{ reason: 'insufficientPermissions', message: `${CANARY} quoted subject` }],
        status: 'PERMISSION_DENIED',
      },
    }),
  ],
  ['a plain-text body', `${CANARY} the provider wrote a sentence here`],
];

describe('Gmail failures on the outbox send route (#490)', () => {
  beforeEach(() => {
    stubResendEnv();
    vi.stubEnv('GOOGLE_SEND_CLIENT_ID', 'send-client');
    vi.stubEnv('GOOGLE_SEND_CLIENT_SECRET', 'send-secret');
    vi.stubEnv('GOOGLE_SEND_REDIRECT_URI', 'https://app.dev/api/v1/mailbox/google/callback');
    vi.stubEnv('MAILBOX_TOKEN_KEY', '00'.repeat(32));
  });

  const googleConnected = () => ({
    mailbox_connections: {
      data: {
        id: 'conn-g1',
        user_id: 'u1',
        provider: 'google',
        status: 'connected',
        email: 'md@bank.dev',
        tokens_encrypted: encryptTokens({ refreshToken: 'rt-old' }),
      },
      error: null,
    } as Resp,
  });
  const gmailTokenOk = () => ok({ access_token: 'at-fresh', expires_in: 3599 });

  it.each(GMAIL_BODY_SHAPES)('messages.send: %s never reaches the 502 body or a log', async (_label, body) => {
    stubMailFetch({ gmailToken: gmailTokenOk, gmailSend: () => fail(body) });

    const { res, text } = await sendThroughOutbox(outboxAdmin(googleConnected()));

    expect(res.status).toBe(502);
    expect(text).not.toContain(CANARY);
    expect(JSON.parse(text)).toEqual({ error: `${MAIL_SEND_FAILED} (gmail-send_403)` });
    expect(capture.output()).not.toContain(CANARY);
  });

  it('token: a 503 body never reaches the 502 body or a log', async () => {
    stubMailFetch({ gmailToken: () => fail(`${CANARY} backend unavailable`, 503) });

    const { res, text } = await sendThroughOutbox(outboxAdmin(googleConnected()));

    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toEqual({ error: `${MAIL_SEND_FAILED} (gmail-token_503)` });
    expect(capture.output()).not.toContain(CANARY);
  });

  it('token: an invalid_grant answers with the fixed reconnect copy, never its description', async () => {
    stubMailFetch({
      gmailToken: () => fail(JSON.stringify({ error: 'invalid_grant', error_description: `${CANARY} revoked for md@bank.dev` }), 400),
    });

    const { res, text } = await sendThroughOutbox(outboxAdmin(googleConnected()));

    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toEqual({
      error: `${MAIL_SEND_FAILED}: Gmail approval ended; connect for sending again in Settings › Mail`,
    });
    expect(capture.output()).not.toContain(CANARY);
  });
});

describe('V8: operator copy on the outbox send route', () => {
  it('an unset sender keeps the sandbox remedy verbatim', async () => {
    vi.stubEnv('EMAIL_PROVIDER', 'noop');
    vi.stubEnv('EMAIL_FROM', '');
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
    stubMailFetch({});

    const { res, text } = await sendThroughOutbox(outboxAdmin());

    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toEqual({
      error:
        'Email provider send failed: EMAIL_FROM is not set, so mail falls back to the onboarding@resend.dev sandbox sender. ' +
        'Resend accepts that sender and answers 200, then delivers only to the Resend account owner: ' +
        'the recipient gets nothing and the send reads as successful. ' +
        'Set it to an address on a verified Resend domain.',
    });
  });

  it('a missing Resend key keeps its configuration copy verbatim', async () => {
    vi.stubEnv('EMAIL_PROVIDER', 'resend');
    vi.stubEnv('RESEND_API_KEY', '');
    vi.stubEnv('EMAIL_FROM', 'Conductia <deals@conductia.dev>');
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
    stubMailFetch({});

    const { res, text } = await sendThroughOutbox(outboxAdmin());

    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toEqual({
      error: 'Email provider send failed: EMAIL_PROVIDER=resend requires RESEND_API_KEY',
    });
  });
});

function inviteAdmin(opts: { linkError?: { code?: string; message: string } } = {}) {
  const base = makeAdmin({ users: { data: [{ id: 'auth-1' }], error: null } }) as unknown as Record<string, unknown>;
  return {
    ...base,
    auth: {
      admin: {
        generateLink: vi.fn(async () =>
          opts.linkError
            ? { data: null, error: opts.linkError }
            : {
                data: { properties: { action_link: 'https://sb/invite-link' }, user: { id: 'auth-1' } },
                error: null,
              },
        ),
        updateUserById: vi.fn(async () => ({ error: null })),
      },
    },
  } as unknown as SupabaseClient;
}

const INVITE = {
  id: 'inv-1',
  authMethod: INVITE_AUTH_METHOD.EMAIL_CODE,
  workIdentityEnabled: true,
  email: 'director@vista.com',
  credentialNonce: 'nonce-1',
  tenantId: 'tenant-1',
  isExternal: true,
  verificationCode: '123456',
  challengeVersion: 1,
  inviterName: 'Storm Duncan',
  inviterCompanyName: 'Futureproofing Capital',
  dealCodename: 'Project Rangers',
};

describe('Invite delivery failures', () => {
  beforeEach(stubResendEnv);

  it.each(MAIL_BODY_SHAPES)('email code: %s never reaches the result or a log', async (_label, body) => {
    stubMailFetch({ resend: () => fail(body) });

    const result = await deliverInvite(inviteAdmin(), 'https://app.dev', INVITE);

    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(capture.output()).not.toContain(CANARY);
    expect(result).toEqual({ deliveryStatus: 'unsent', error: 'resend_403' });
    expect(capture.output()).toContain('inv-1');
    expect(capture.output()).toContain('resend_403');
  });

  it.each(MAIL_BODY_SHAPES)('work identity: %s never reaches the result or a log', async (_label, body) => {
    stubMailFetch({ resend: () => fail(body) });

    const result = await deliverInvite(inviteAdmin(), 'https://app.dev', {
      ...INVITE,
      authMethod: INVITE_AUTH_METHOD.WORK_IDENTITY,
    });

    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(capture.output()).not.toContain(CANARY);
    expect(result).toEqual({ deliveryStatus: 'unsent', error: 'resend_403' });
    expect(capture.output()).toContain('resend_403');
  });

  it('operator misconfiguration: a missing key logs its fixed copy beside the code', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    stubMailFetch({});

    const result = await deliverInvite(inviteAdmin(), 'https://app.dev', INVITE);

    // The result stays a code; only the log names what to fix.
    expect(result.error).toBe('unexpected');
    expect(capture.output()).toContain('inv-1');
    expect(capture.output()).toContain('unexpected');
    expect(capture.output()).toContain('RESEND_API_KEY is not set');
  });

  it('operator misconfiguration: an unset sender logs its remedy', async () => {
    vi.stubEnv('RESEND_FROM', '');
    stubMailFetch({});

    const result = await deliverInvite(inviteAdmin(), 'https://app.dev', {
      ...INVITE,
      authMethod: INVITE_AUTH_METHOD.WORK_IDENTITY,
    });

    expect(result.error).toBe('unexpected');
    expect(capture.output()).toContain('RESEND_FROM is not set, so mail falls back to the onboarding@resend.dev sandbox sender');
    expect(capture.output()).toContain('Set it to an address on a verified Resend domain.');
  });

  it('a refused link generation does not carry the auth service message', async () => {
    stubMailFetch({});

    const result = await deliverInvite(
      inviteAdmin({ linkError: { code: 'unexpected_failure', message: `${CANARY} director@vista.com is not allowed` } }),
      'https://app.dev',
      INVITE,
    );

    expect(result.deliveryStatus).toBe('unsent');
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(capture.output()).not.toContain(CANARY);
  });

  it('context lookup: a database message is logged as a code, not its text', async () => {
    const admin = makeAdmin({
      users: { data: null, error: null },
      companies: { data: null, error: { code: '42501', message: `${CANARY} permission denied for relation companies` } },
    });

    await expect(fetchInviteEmailContext(admin, 'actor-1', 'company-1', null)).rejects.toThrow('email_context_failed');

    expect(capture.output()).not.toContain(CANARY);
    expect(capture.output()).toContain('42501');
  });
});
