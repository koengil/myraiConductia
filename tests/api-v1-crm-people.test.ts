import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { GET } from '@/app/api/v1/crm-people/route';

type Resp = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Resp | Resp[]>) {
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const k of ['select', 'eq', 'or', 'order', 'limit', 'is']) builder[k] = chain;
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

describe('GET /api/v1/crm-people', () => {
  it('lists CRM people scoped to the caller company', async () => {
    signedIn(
      makeAdmin({
        users: [statusRow, overseerRow, profileRow, overseerRow],
        crm_people: {
          data: [{ id: 'p1', name: 'Jamie Rivera', email: null, title: 'CFO', org: 'Acme' }],
          error: null,
        },
      }),
    );

    const res = await GET(new Request('http://localhost/api/v1/crm-people'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { people: Array<{ name: string }> };
    expect(body.people[0]?.name).toBe('Jamie Rivera');
  });

  it('refuses a search term in the URL', async () => {
    signedIn(makeAdmin({ users: [statusRow, overseerRow, profileRow, overseerRow] }));

    const res = await GET(new Request('http://localhost/api/v1/crm-people?query=jamie'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Search terms are not accepted in the URL' });
  });

  it.each(['q=jamie', 'Name=Jamie+Rivera', 'email=jamie%40example.com'])(
    'refuses any free-text key in the URL: %s',
    async (search) => {
      signedIn(makeAdmin({ users: [statusRow, overseerRow, profileRow, overseerRow] }));

      const res = await GET(new Request(`http://localhost/api/v1/crm-people?${search}`));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Search terms are not accepted in the URL' });
    },
  );
});
