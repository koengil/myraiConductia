import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { GET, POST } from '@/app/api/v1/companies/[companyId]/relationships/route';
import { DELETE } from '@/app/api/v1/companies/[companyId]/relationships/[entryId]/route';

/*
 * /api/v1/companies/{companyId}/relationships — lead CRM relationships resource.
 *
 * Contracts under test:
 *   1. POST valid body -> 201, echoes person_name.
 *   2. POST invalid relationship_type -> 400.
 *   3. POST missing person_name -> 400.
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
  return {
    from,
    rpc: () => Promise.resolve({ data: false, error: null }),
  } as unknown as ReturnType<typeof createSupabaseAdminClient>;
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

const relationshipRow = {
  id: 'rel-1',
  company_id: COMPANY_ID,
  person_name: 'Jamie Rivera',
  title: 'CFO',
  person_company: 'Acme Co',
  contact_info: 'jamie@acme.com',
  relationship_type: 'colleague',
  strength: 'High',
  source: 'HubSpot',
  confidence: 'High',
  last_verified: null,
  owner: null,
  basis: null,
  created_at: '2026-07-21T10:00:00Z',
};

afterEach(() => vi.clearAllMocks());

describe('POST /api/v1/companies/{companyId}/relationships', () => {
  it('creates a relationship and returns 201', async () => {
    signedIn(
      makeAdmin({
        users: [statusRow, overseerRow, tenantRow, { data: { tenant_id: TENANT_ID, company_id: null }, error: null }],
        companies: companyRow,
        crm_people: [crmPersonLookup, crmPersonInsert],
        lead_relationships: { data: relationshipRow, error: null },
      }),
    );
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ person_name: 'Jamie Rivera', title: 'CFO' }),
    });
    const res = await POST(req, ctx(COMPANY_ID));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { relationship: { id: string; person_name: string } };
    expect(body.relationship.id).toBe('rel-1');
    expect(body.relationship.person_name).toBe('Jamie Rivera');
  });

  it('normalizes a blank last_verified to null (Postgres rejects the empty string as a date)', async () => {
    // The register form defaults last_verified to '' when the MD leaves the
    // date blank. '' would 500 the insert on a date column, so the handler
    // must send null. Capture the exact insert payload to prove it.
    let insertPayload: Record<string, unknown> | null = null;
    const captureAdmin = {
      from(table: string) {
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        for (const k of ['select', 'eq', 'in', 'order', 'limit', 'delete', 'is', 'ilike']) builder[k] = chain;
        builder.insert = (payload: Record<string, unknown>) => {
          if (table === 'lead_relationships') insertPayload = payload;
          return builder;
        };
        // users: access-gate read then tenant read; companies: the tenant check;
        // crm_people: lookup then insert; lead_relationships: the inserted row echoed back.
        const users = [statusRow, overseerRow, tenantRow, { data: { tenant_id: TENANT_ID, company_id: null }, error: null }];
        const crmPeople = [crmPersonLookup, crmPersonInsert];
        const resp: Resp =
          table === 'users'
            ? (users.shift() ?? { data: null, error: null })
            : table === 'companies'
              ? companyRow
              : table === 'crm_people'
                ? (crmPeople.shift() ?? { data: null, error: null })
              : { data: { ...relationshipRow, last_verified: null }, error: null };
        builder.single = () => Promise.resolve(resp);
        builder.maybeSingle = () => Promise.resolve(resp);
        builder.then = (f: (v: Resp) => unknown) => Promise.resolve(resp).then(f);
        return builder;
      },
    } as unknown as ReturnType<typeof createSupabaseAdminClient>;
    signedIn(captureAdmin);

    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ person_name: 'Jamie Rivera', last_verified: '' }),
    });
    const res = await POST(req, ctx(COMPANY_ID));
    expect(res.status).toBe(201);
    expect(insertPayload).not.toBeNull();
    expect(insertPayload!.last_verified).toBeNull();
  });

  it('400s an invalid relationship_type', async () => {
    signedIn(
      makeAdmin({
        users: [statusRow, overseerRow, tenantRow],
        companies: companyRow,
      }),
    );
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ person_name: 'Jamie Rivera', relationship_type: 'buddy' }),
    });
    const res = await POST(req, ctx(COMPANY_ID));
    expect(res.status).toBe(400);
  });

  it('400s a missing person_name', async () => {
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
      body: JSON.stringify({ person_name: 'Jamie Rivera' }),
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
      body: JSON.stringify({ person_name: 'Jamie Rivera' }),
    });
    const res = await POST(req, ctx(COMPANY_ID));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/companies/{companyId}/relationships', () => {
  it('lists rows for the company', async () => {
    signedIn(
      makeAdmin({
        users: [statusRow, overseerRow, tenantRow],
        companies: companyRow,
        lead_relationships: { data: [relationshipRow], error: null },
      }),
    );
    const res = await GET(new Request('http://localhost'), ctx(COMPANY_ID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { relationships: Array<{ id: string }> };
    expect(body.relationships).toHaveLength(1);
    expect(body.relationships[0].id).toBe('rel-1');
  });

  it('lists rows for an external deal member seated on a deal for that company', async () => {
    signedIn(
      makeAdmin({
        users: [
          statusRow,
          { data: { firm_role: null, department: null, is_external: true }, error: null },
          { data: { company_id: 'client-co', is_external: true, department: null }, error: null },
          { data: { company_id: 'client-co', is_external: true }, error: null },
          { data: { firm_role: null, tenant_id: TENANT_ID }, error: null },
          tenantRow,
        ],
        companies: [
          {
            data: { id: COMPANY_ID, registered_by_company_id: 'client-co' },
            error: null,
          },
          companyRow,
          companyRow,
        ],
        deal_parties: { data: [{ deal_id: 'deal-1' }], error: null },
        deal_memberships: { data: { id: 'm1' }, error: null },
        deals: { data: { tenant_id: TENANT_ID }, error: null },
        lead_relationships: { data: [relationshipRow], error: null },
      }),
      { id: 'external-md', email: 'md@client.dev' },
    );
    const res = await GET(new Request('http://localhost'), ctx(COMPANY_ID));
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/v1/companies/{companyId}/relationships/{entryId}', () => {
  it('deletes an existing row and returns 204', async () => {
    signedIn(
      makeAdmin({
        users: [statusRow, overseerRow, tenantRow],
        companies: companyRow,
        lead_relationships: { data: [{ id: 'rel-1' }], error: null },
      }),
    );
    const res = await DELETE(new Request('http://localhost', { method: 'DELETE' }), entryCtx(COMPANY_ID, 'rel-1'));
    expect(res.status).toBe(204);
  });

  it('404s when the row does not exist', async () => {
    signedIn(
      makeAdmin({
        users: [statusRow, overseerRow, tenantRow],
        companies: companyRow,
        lead_relationships: { data: [], error: null },
      }),
    );
    const res = await DELETE(new Request('http://localhost', { method: 'DELETE' }), entryCtx(COMPANY_ID, 'rel-missing'));
    expect(res.status).toBe(404);
  });
});
