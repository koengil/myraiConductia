import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { GET, POST } from '@/app/api/v1/companies/[companyId]/paths/route';
import { DELETE } from '@/app/api/v1/companies/[companyId]/paths/[pathId]/route';

type Resp = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Resp | Resp[]>) {
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const k of ['select', 'eq', 'in', 'order', 'limit', 'insert', 'delete', 'upsert']) {
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
const pathCtx = (companyId: string, pathId: string) => ({
  params: Promise.resolve({ companyId, pathId }),
});

const COMPANY_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = 'tenant-1';
const STAKEHOLDER_ID = '33333333-3333-4333-8333-333333333333';
const RELATIONSHIP_ID = '44444444-4444-4444-8444-444444444444';
const PATH_ID = '55555555-5555-4555-8555-555555555555';

const overseerRow = { data: { firm_role: 'cco', department: null, is_external: false }, error: null };
const tenantRow = { data: { tenant_id: TENANT_ID }, error: null };
const statusRow = { data: { status: 'active' }, error: null };
const companyRow = { data: { id: COMPANY_ID }, error: null };
const stakeholderRow = { data: { id: STAKEHOLDER_ID }, error: null };
const relationshipRow = { data: { id: RELATIONSHIP_ID }, error: null };

const pathRow = {
  id: PATH_ID,
  company_id: COMPANY_ID,
  stakeholder_id: STAKEHOLDER_ID,
  relationship_id: RELATIONSHIP_ID,
  path_type: 'warm',
  approved: false,
  approved_by: null,
  approved_on: null,
  created_at: '2026-08-08T12:00:00.000Z',
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('/api/v1/companies/{companyId}/paths', () => {
  it('GET lists paths', async () => {
    signedIn(
      makeAdmin({
        users: [overseerRow, tenantRow, statusRow, tenantRow],
        companies: companyRow,
        lead_relationship_paths: { data: [pathRow], error: null },
      }),
    );

    const res = await GET(new Request('http://test'), ctx(COMPANY_ID));
    expect(res).toBeDefined();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { paths: typeof pathRow[] };
    expect(body.paths).toHaveLength(1);
    expect(body.paths[0].stakeholder_id).toBe(STAKEHOLDER_ID);
  });

  it('POST warm path requires relationship_id', async () => {
    signedIn(
      makeAdmin({
        users: [overseerRow, tenantRow, statusRow, tenantRow],
        companies: companyRow,
        lead_stakeholders: stakeholderRow,
      }),
    );

    const res = await POST(
      new Request('http://test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stakeholder_id: STAKEHOLDER_ID, path_type: 'warm' }),
      }),
      ctx(COMPANY_ID),
    );
    expect(res).toBeDefined();
    expect(res!.status).toBe(400);
  });

  it('POST upserts a warm path', async () => {
    signedIn(
      makeAdmin({
        users: [overseerRow, tenantRow, statusRow, tenantRow],
        companies: companyRow,
        lead_stakeholders: stakeholderRow,
        lead_relationships: relationshipRow,
        lead_relationship_paths: { data: pathRow, error: null },
      }),
    );

    const res = await POST(
      new Request('http://test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stakeholder_id: STAKEHOLDER_ID,
          relationship_id: RELATIONSHIP_ID,
          path_type: 'warm',
        }),
      }),
      ctx(COMPANY_ID),
    );
    expect(res).toBeDefined();
    expect(res!.status).toBe(201);
    const body = (await res!.json()) as { path: typeof pathRow };
    expect(body.path.path_type).toBe('warm');
  });

  it('POST cold path omits relationship_id', async () => {
    signedIn(
      makeAdmin({
        users: [overseerRow, tenantRow, statusRow, tenantRow],
        companies: companyRow,
        lead_stakeholders: stakeholderRow,
        lead_relationship_paths: {
          data: { ...pathRow, relationship_id: null, path_type: 'cold' },
          error: null,
        },
      }),
    );

    const res = await POST(
      new Request('http://test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stakeholder_id: STAKEHOLDER_ID,
          path_type: 'cold',
        }),
      }),
      ctx(COMPANY_ID),
    );
    expect(res).toBeDefined();
    expect(res!.status).toBe(201);
  });

  it('DELETE removes a path', async () => {
    signedIn(
      makeAdmin({
        users: [overseerRow, tenantRow, statusRow, tenantRow],
        companies: companyRow,
        lead_relationship_paths: { data: [{ id: PATH_ID }], error: null },
      }),
    );

    const res = await DELETE(new Request('http://test'), pathCtx(COMPANY_ID, PATH_ID));
    expect(res).toBeDefined();
    expect(res!.status).toBe(204);
  });
});
