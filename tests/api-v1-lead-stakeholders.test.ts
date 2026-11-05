import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { GET, POST } from '@/app/api/v1/companies/[companyId]/stakeholders/route';
import { DELETE } from '@/app/api/v1/companies/[companyId]/stakeholders/[entryId]/route';

/*
 * /api/v1/companies/{companyId}/stakeholders — lead CRM stakeholders resource.
 *
 * Contracts under test:
 *   1. POST valid body -> 201, echoes name.
 *   2. POST invalid role_in_decision -> 400.
 *   3. POST missing name -> 400.
 *   4. A walled caller (cannot search companies) -> 403.
 *   5. Company in another tenant (not found in caller's tenant) -> 404.
 *   6. DELETE existing -> 204; deleting again (no row) -> 404.
 *   7. GET lists rows -> 200.
 */

type Resp = { data: unknown; error: unknown };

/** Chainable admin stub with a per-table response queue (shift per from()). */
function makeAdmin(tables: Record<string, Resp | Resp[]>) {
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const k of ['select', 'eq', 'in', 'order', 'limit', 'insert', 'delete', 'is', 'ilike']) {
      builder[k] = chain;
    }
    builder.single = () => Promise.resolve(resp);
    builder.maybeSingle = () => Promise.resolve(resp);
    builder.then = (f: (v: Resp) => unknown) => Promise.resolve(resp).then(f);
    return builder;
  };
  return { from } as unknown as ReturnType<typeof createSupabaseAdminClient>;
}

function signedIn(
  admin: ReturnType<typeof makeAdmin>,
  user = { id: 'cco-1', email: 'cco@bank.dev' },
) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () => Promise.resolve({ data: { user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

const ctx = (companyId: string) => ({ params: Promise.resolve({ companyId }) });
const entryCtx = (companyId: string, entryId: string) => ({
  params: Promise.resolve({ companyId, entryId }),
});

const COMPANY_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = 'tenant-1';

const overseerRow = { data: { firm_role: 'cco', department: null, is_external: false }, error: null };
const tenantRow = { data: { tenant_id: TENANT_ID }, error: null };
const statusRow = { data: { status: 'active' }, error: null }; // requireApiUser onboarding probe
const companyRow = { data: { id: COMPANY_ID, registered_by_company_id: null }, error: null };
const crmPersonLookup = { data: null, error: null };
const crmPersonInsert = { data: { id: 'person-1' }, error: null };

const stakeholderRow = {
  id: 'stk-1',
  company_id: COMPANY_ID,
  name: 'Jamie Rivera',
  title: 'CFO',
  org: 'Acme Co',
  role_in_decision: 'decision-maker',
  equity_pct: 12.5,
  motivation: 'max price',
  stance: 'Supporter',
  board_seat: false,
  investor: true,
  likely_objections: null,
  created_at: '2026-07-21T10:00:00Z',
};

afterEach(() => vi.clearAllMocks());

describe('POST /api/v1/companies/{companyId}/stakeholders', () => {
  it('creates a stakeholder and returns 201', async () => {
    signedIn(
      makeAdmin({
        users: [statusRow, overseerRow, tenantRow, { data: { tenant_id: TENANT_ID, company_id: null }, error: null }],
        companies: companyRow,
        crm_people: [crmPersonLookup, crmPersonInsert],
        lead_stakeholders: { data: stakeholderRow, error: null },
      }),
    );
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ name: 'Jamie Rivera', title: 'CFO' }),
    });
    const res = await POST(req, ctx(COMPANY_ID));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { stakeholder: { id: string; name: string } };
    expect(body.stakeholder.id).toBe('stk-1');
    expect(body.stakeholder.name).toBe('Jamie Rivera');
  });

  it('400s an invalid role_in_decision', async () => {
    signedIn(
      makeAdmin({
        users: [statusRow, overseerRow, tenantRow],
        companies: companyRow,
      }),
    );
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ name: 'Jamie Rivera', role_in_decision: 'chief' }),
    });
    const res = await POST(req, ctx(COMPANY_ID));
    expect(res.status).toBe(400);
  });

  it('400s an invalid motivation', async () => {
    signedIn(
      makeAdmin({
        users: [statusRow, overseerRow, tenantRow],
        companies: companyRow,
      }),
    );
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ name: 'Jamie Rivera', motivation: 'greed' }),
    });
    const res = await POST(req, ctx(COMPANY_ID));
    expect(res.status).toBe(400);
  });

  it('400s an invalid stance', async () => {
    signedIn(
      makeAdmin({
        users: [statusRow, overseerRow, tenantRow],
        companies: companyRow,
      }),
    );
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ name: 'Jamie Rivera', stance: 'furious' }),
    });
    const res = await POST(req, ctx(COMPANY_ID));
    expect(res.status).toBe(400);
  });

  it('400s a missing name', async () => {
    signedIn(
      makeAdmin({
        users: [statusRow, overseerRow, tenantRow],
        companies: companyRow,
      }),
    );
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ title: 'CFO' }),
    });
    const res = await POST(req, ctx(COMPANY_ID));
    expect(res.status).toBe(400);
  });

  it('403s a walled caller', async () => {
    signedIn(
      makeAdmin({
        users: [{ data: { firm_role: null, department: 'research', is_external: false }, error: null }],
      }),
      { id: 'walled-1', email: 'walled@bank.dev' },
    );
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ name: 'Jamie Rivera' }),
    });
    const res = await POST(req, ctx(COMPANY_ID));
    expect(res.status).toBe(403);
  });

  it('404s a company in another tenant', async () => {
    signedIn(
      makeAdmin({
        users: [statusRow, overseerRow, tenantRow],
        companies: { data: null, error: null },
      }),
    );
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ name: 'Jamie Rivera' }),
    });
    const res = await POST(req, ctx(COMPANY_ID));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/companies/{companyId}/stakeholders', () => {
  it('lists rows for the company', async () => {
    signedIn(
      makeAdmin({
        users: [statusRow, overseerRow, tenantRow],
        companies: companyRow,
        lead_stakeholders: { data: [stakeholderRow], error: null },
      }),
    );
    const res = await GET(new Request('http://localhost'), ctx(COMPANY_ID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stakeholders: Array<{ id: string }> };
    expect(body.stakeholders).toHaveLength(1);
    expect(body.stakeholders[0].id).toBe('stk-1');
  });
});

describe('DELETE /api/v1/companies/{companyId}/stakeholders/{entryId}', () => {
  it('deletes an existing row and returns 204', async () => {
    signedIn(
      makeAdmin({
        users: [statusRow, overseerRow, tenantRow],
        companies: companyRow,
        lead_stakeholders: { data: [{ id: 'stk-1' }], error: null },
      }),
    );
    const res = await DELETE(new Request('http://localhost', { method: 'DELETE' }), entryCtx(COMPANY_ID, 'stk-1'));
    expect(res.status).toBe(204);
  });

  it('404s when the row does not exist', async () => {
    signedIn(
      makeAdmin({
        users: [statusRow, overseerRow, tenantRow],
        companies: companyRow,
        lead_stakeholders: { data: [], error: null },
      }),
    );
    const res = await DELETE(new Request('http://localhost', { method: 'DELETE' }), entryCtx(COMPANY_ID, 'stk-missing'));
    expect(res.status).toBe(404);
  });
});
