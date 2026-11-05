import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

vi.mock('@/lib/api/v1/access', () => ({
  userCanViewLeads: vi.fn().mockResolvedValue(true),
  userCanSearchCompanies: vi.fn().mockResolvedValue(true),
  userCanCreateLead: vi.fn().mockResolvedValue(true),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { GET } from '@/app/api/v1/companies/route';

type Limits = { value: number | null };

function makeAdmin(limits: Limits) {
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = chain;
    builder.eq = chain;
    builder.ilike = chain;
    builder.order = chain;
    builder.limit = (value: number) => {
      limits.value = value;
      return Promise.resolve({ data: [], error: null });
    };
    builder.single = () =>
      Promise.resolve(
        table === 'users'
          ? { data: { tenant_id: 'tenant-1', company_id: 'bank-1' }, error: null }
          : { data: null, error: null },
      );
    builder.maybeSingle = builder.single;
    return builder;
  };
  return { from } as unknown as ReturnType<typeof createSupabaseAdminClient>;
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
  } as unknown as Awaited<ReturnType<typeof createSupabaseServerClient>>);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

async function limitFor(url: string): Promise<number | null> {
  const limits: Limits = { value: null };
  signedIn(makeAdmin(limits));
  const response = await GET(new Request(url));
  expect(response.status).toBe(200);
  return limits.value;
}

describe('GET /api/v1/companies', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not truncate an unfiltered list to the typeahead page size', async () => {
    expect(await limitFor('http://localhost/api/v1/companies?type=client')).toBe(500);
  });

  it('refuses a search term in the URL', async () => {
    signedIn(makeAdmin({ value: null }));
    const response = await GET(new Request('http://localhost/api/v1/companies?query=atl'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Search terms are not accepted in the URL' });
  });

  it.each(['q=atl', 'type=client&NAME=Atlassian', 'search=atl'])(
    'refuses any free-text key in the URL: %s',
    async (search) => {
      signedIn(makeAdmin({ value: null }));
      const response = await GET(new Request(`http://localhost/api/v1/companies?${search}`));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Search terms are not accepted in the URL' });
    },
  );
});
