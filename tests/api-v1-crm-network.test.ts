import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { GET } from '@/app/api/v1/crm-network/route';

type Resp = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Resp | Resp[]>) {
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const k of ['select', 'eq', 'or', 'order', 'limit', 'is', 'in']) builder[k] = chain;
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

function signedIn(admin: ReturnType<typeof makeAdmin>) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: 'md-1', email: 'md@bank.dev' } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

const statusRow = { data: { status: 'active' }, error: null };
const overseerRow = { data: { firm_role: 'md', department: null, is_external: false }, error: null };
const profileRow = { data: { tenant_id: 'tenant-1', company_id: 'cust-1' }, error: null };

afterEach(() => vi.clearAllMocks());

describe('GET /api/v1/crm-network', () => {
  it('returns a scoped CRM network payload', async () => {
    signedIn(
      makeAdmin({
        users: [statusRow, overseerRow, profileRow, overseerRow],
        companies: [
          {
            data: [{ id: 'lead-a', name: 'Alpha Co' }],
            error: null,
          },
          { data: { id: 'cust-1', name: 'Tokmail' }, error: null },
        ],
        crm_people: {
          data: [{ id: 'p1', name: 'Alex Chen' }],
          error: null,
        },
        lead_stakeholders: {
          data: [{ id: 'stk-1', company_id: 'lead-a', person_id: 'p1', name: 'Alex Chen' }],
          error: null,
        },
        lead_relationships: { data: [], error: null },
        lead_relationship_paths: { data: [], error: null },
      }),
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clientCompany: { name: string } | null;
      companies: Array<{ name: string }>;
      people: Array<{ name: string }>;
    };
    expect(body.clientCompany?.name).toBe('Tokmail');
    expect(body.companies[0]?.name).toBe('Alpha Co');
    expect(body.people[0]?.name).toBe('Alex Chen');
  });
});
