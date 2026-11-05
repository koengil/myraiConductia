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
import { POST } from '@/app/api/v1/screen/route';
import { DEV_TENANT_ID } from '@/lib/db/tenant';

/*
 * POST /api/v1/screen — the pre-send screening service (Component A).
 *
 * Contracts under test:
 *   1. mode fast: deterministic only, no audit row, no LLM call.
 *   2. mode fast on promissory text -> blocked + rewrite.
 *   3. mode full: audits one 'screen' row with verdict + sha256, llmChecked
 *      false when the LLM is unavailable (visible degradation).
 *   4. mode full: the LLM escalation (compliant -> hold) reaches the response.
 *   5. Missing text -> 400; invalid mode -> 400.
 *   6. Signed out -> 401.
 *   7. The model gate (#339): the caller's tenant is resolved before the
 *      screen; only a gate-allowed tenant reaches the model, and the audit
 *      row records the decision (and why the pass was withheld).
 */

type Row = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Row | Row[]>) {
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Row = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const k of ['select', 'eq', 'in', 'order', 'limit']) builder[k] = chain;
    builder.insert = (payload: unknown) => {
      inserts.push({ table, payload });
      return builder;
    };
    builder.single = () => Promise.resolve(resp);
    builder.maybeSingle = () => Promise.resolve(resp);
    builder.then = (f: (v: Row) => unknown) => Promise.resolve(resp).then(f);
    return builder;
  };
  const admin = { from } as unknown as ReturnType<typeof createSupabaseAdminClient>;
  return { admin, inserts };
}

function signedIn(admin: ReturnType<typeof createSupabaseAdminClient>) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () =>
        Promise.resolve({
          data: { user: { id: 'md-1', email: 'storm@bank.dev' } },
          error: null,
        }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

function signedOut() {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

// The model gate (#339) honors the DEV tenant only on a local, non-prod stack.
const devTenant = { data: { tenant_id: DEV_TENANT_ID }, error: null };
const otherTenant = { data: { tenant_id: 'tenant-1' }, error: null };
function localStack() {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
}
function stubModel() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ content: [{ type: 'text', text: JSON.stringify({ verdict: 'compliant', reasons: [] }) }] }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const req = (body: unknown) =>
  new Request('http://localhost/api/v1/screen', {
    method: 'POST',
    body: JSON.stringify(body),
  });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('POST /api/v1/screen — mode fast', () => {
  it('screens deterministically, calls no LLM, writes no audit row', async () => {
    const { admin, inserts } = makeAdmin({});
    signedIn(admin);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(req({ text: 'Sending the comp read to the shared room', mode: 'fast' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ verdict: 'compliant', reasons: [], mode: 'fast' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it('blocks promissory text with a rewrite', async () => {
    const { admin } = makeAdmin({});
    signedIn(admin);
    const res = await POST(req({ text: 'I guarantee the board seat stays', mode: 'fast' }));
    const body = await res.json();
    expect(body.verdict).toBe('blocked');
    expect(body.rewrite).toBeTruthy();
  });
});

describe('POST /api/v1/screen — mode full', () => {
  it('audits one screen row (verdict + sha256), llmChecked false without a key', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const { admin, inserts } = makeAdmin({ audit_log: { data: null, error: null } });
    signedIn(admin);

    const res = await POST(
      req({ text: 'Our internal model floors this at $510M', mode: 'full' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict).toBe('hold');
    expect(body.llmChecked).toBe(false);

    expect(inserts).toHaveLength(1);
    const audit = inserts[0].payload as {
      actor_id: string;
      action: string;
      detail: {
        verdict: string;
        sha256: string;
        llmChecked: boolean;
        lexiconVersion: string;
      };
    };
    expect(inserts[0].table).toBe('audit_log');
    expect(audit.action).toBe('screen');
    expect(audit.actor_id).toBe('md-1');
    expect(audit.detail.verdict).toBe('hold');
    expect(audit.detail.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.detail.llmChecked).toBe(false);
    // This route's screen rows cite the enforced vocabulary too (#163) — the
    // outbox route must never be the only audited shape.
    expect(audit.detail.lexiconVersion).toBe('1.0 (2026-08-11)');
  });

  it('lets the LLM escalate compliant -> hold', async () => {
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
                  reasons: ['Implied internal valuation.'],
                }),
              },
            ],
          }),
      }),
    );
    const { admin } = makeAdmin({ users: devTenant, audit_log: { data: null, error: null } });
    signedIn(admin);

    const res = await POST(
      req({ text: 'between us, the number is well north of what we told them', mode: 'full' }),
    );
    const body = await res.json();
    expect(body.verdict).toBe('hold');
    expect(body.reasons).toContain('Implied internal valuation.');
    expect(body.llmChecked).toBe(true);
  });
});

describe('POST /api/v1/screen — the model gate (#339)', () => {
  const auditDetail = (inserts: Array<{ table: string; payload: unknown }>) =>
    (inserts.find((i) => i.table === 'audit_log')?.payload as { detail: Record<string, unknown> }).detail;

  it('mode full for an unlisted tenant: no model call, the audit records why', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    localStack();
    const fetchMock = stubModel();
    const { admin, inserts } = makeAdmin({ users: otherTenant, audit_log: { data: null, error: null } });
    signedIn(admin);

    const res = await POST(req({ text: 'The room opens Monday.', mode: 'full' }));
    expect(res.status).toBe(200);
    expect((await res.json()).llmChecked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditDetail(inserts)).toMatchObject({
      llmChecked: false,
      modelDecision: { allowed: false, reason: 'tenant_not_synthetic', purpose: 'mail_screen', tenantId: 'tenant-1' },
      llmWithheld: 'tenant_not_synthetic',
    });
  });

  it('mode full for the DEV tenant on a local stack calls the model', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    localStack();
    const fetchMock = stubModel();
    const { admin, inserts } = makeAdmin({ users: devTenant, audit_log: { data: null, error: null } });
    signedIn(admin);

    const res = await POST(req({ text: 'The room opens Monday.', mode: 'full' }));
    expect((await res.json()).llmChecked).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const detail = auditDetail(inserts);
    expect(detail.modelDecision).toEqual({
      allowed: true,
      basis: 'synthetic_tenant',
      purpose: 'mail_screen',
      tenantId: DEV_TENANT_ID,
    });
    expect(detail).not.toHaveProperty('llmWithheld');
  });

  it('mode full for the DEV tenant on a hosted URL does not call the model', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefgh.supabase.co');
    const fetchMock = stubModel();
    const { admin, inserts } = makeAdmin({ users: devTenant, audit_log: { data: null, error: null } });
    signedIn(admin);

    await POST(req({ text: 'The room opens Monday.', mode: 'full' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditDetail(inserts)).toMatchObject({ llmWithheld: 'not_local' });
  });

  it('a tenant lookup error is withheld, and the verdict is still returned', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    localStack();
    const fetchMock = stubModel();
    const { admin, inserts } = makeAdmin({
      // The first read is requireApiUser's status check; the second is the tenant lookup.
      users: [{ data: { status: 'active' }, error: null }, { data: null, error: { message: 'boom' } }],
      audit_log: { data: null, error: null },
    });
    signedIn(admin);

    const res = await POST(req({ text: 'Our internal model floors this at $510M', mode: 'full' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ verdict: 'hold', llmChecked: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditDetail(inserts)).toMatchObject({
      modelDecision: { allowed: false, reason: 'tenant_unresolved', purpose: 'mail_screen', tenantId: null },
      llmWithheld: 'tenant_unresolved',
    });
  });
});

describe('POST /api/v1/screen — validation and auth', () => {
  it('rejects a missing text with 400', async () => {
    const { admin } = makeAdmin({});
    signedIn(admin);
    expect((await POST(req({ mode: 'fast' }))).status).toBe(400);
  });

  it('rejects an unknown mode with 400', async () => {
    const { admin } = makeAdmin({});
    signedIn(admin);
    expect((await POST(req({ text: 'hi', mode: 'turbo' }))).status).toBe(400);
  });

  it('rejects a signed-out caller with 401', async () => {
    signedOut();
    expect((await POST(req({ text: 'hi' }))).status).toBe(401);
  });
});
