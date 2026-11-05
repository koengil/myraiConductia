import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from '@/lib/supabase/server';
import { GET } from '@/app/api/v1/companies/[companyId]/notify-recipients/route';

type Resp = { data: unknown; error: unknown };

function makeAdmin(opts: { tables?: Record<string, Resp | Resp[]>; rpc?: Resp }) {
  const tables = opts.tables ?? {};
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    const terminal = () => Promise.resolve(resp);
    builder.select = chain;
    builder.eq = chain;
    builder.maybeSingle = terminal;
    builder.single = terminal;
    builder.then = (onFulfilled: (v: Resp) => unknown) =>
      Promise.resolve(resp).then(onFulfilled);
    return builder;
  };
  const rpc = vi.fn(() => Promise.resolve(opts.rpc ?? { data: [], error: null }));
  return { from, rpc } as unknown as ReturnType<typeof createSupabaseAdminClient> & {
    rpc: ReturnType<typeof vi.fn>;
  };
}

function signedIn(admin: ReturnType<typeof makeAdmin>) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () =>
        Promise.resolve({
          data: { user: { id: 'u-1', email: 'md@bank.dev' } },
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

function req(): Request {
  return new Request('http://localhost/api/v1/companies/bank-1/notify-recipients');
}

const ctx = { params: Promise.resolve({ companyId: 'bank-1' }) };

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/companies/{companyId}/notify-recipients', () => {
  it('401 when not signed in', async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(createSupabaseAdminClient).mockReturnValue(makeAdmin({}));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
  });

  it('403 when the caller cannot view the company', async () => {
    signedIn(
      makeAdmin({
        tables: {
          users: {
            data: { firm_role: null, company_id: 'other-bank', tenant_id: 't-1' },
            error: null,
          },
        },
      }),
    );
    const res = await GET(req(), ctx);
    expect(res.status).toBe(403);
  });

  it('400 when the company is not a bank', async () => {
    signedIn(
      makeAdmin({
        tables: {
          users: {
            data: { firm_role: null, company_id: 'bank-1', tenant_id: 't-1' },
            error: null,
          },
          companies: {
            data: { id: 'bank-1', type: 'client', tenant_id: 't-1' },
            error: null,
          },
        },
      }),
    );
    const res = await GET(req(), ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/configured on the bank/i);
  });

  it('200 with mapped recipient names and roles', async () => {
    const admin = makeAdmin({
      tables: {
        users: {
          data: { firm_role: null, company_id: 'bank-1', tenant_id: 't-1' },
          error: null,
        },
        companies: {
          data: { id: 'bank-1', type: 'bank', tenant_id: 't-1' },
          error: null,
        },
      },
      rpc: {
        data: [
          {
            user_id: 'dir-1',
            display_name: 'Drew Director',
            full_name: 'Drew Director',
            firm_role: null,
            company_role: 'director',
          },
        ],
        error: null,
      },
    });
    signedIn(admin);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recipients: Array<{ id: string; name: string; role: string }>;
    };
    expect(body.recipients).toEqual([
      { id: 'dir-1', name: 'Drew Director', role: 'Director' },
    ]);
    expect(admin.rpc).toHaveBeenCalledWith('gate0_notify_recipients', {
      p_tenant_id: 't-1',
      p_bank_id: 'bank-1',
    });
  });
});
