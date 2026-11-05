import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));
vi.mock('@/lib/api/v1/requireFlag', () => ({
  requireFlag: vi.fn(() => Promise.resolve(null)),
  isFlagEnabled: vi.fn(() => Promise.resolve(true)),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { GET } from '@/app/api/v1/deals/[dealId]/members/route';

/*
 * GET /api/v1/deals/{dealId}/members — the live Team roster.
 * Flag-gated (404 when platform_onboarding is off), readable by any member of
 * the deal, grouped client-side via members + parties + bankCompanyId.
 */

type Resp = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Resp | Resp[]>) {
  // Routes resolve the deal code/UUID first; default the read so tests
  // that never assert on deals don't have to stub it.
  if (!('deals' in tables)) tables.deals = { data: { id: 'd1', code: 'PRJRA' }, error: null };
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
    builder.in = chain;
    builder.limit = chain;
    builder.single = terminal;
    builder.maybeSingle = terminal;
    builder.then = (onFulfilled: (v: Resp) => unknown) =>
      Promise.resolve(resp).then(onFulfilled);
    return builder;
  };
  return { from } as unknown as ReturnType<typeof createSupabaseAdminClient>;
}

function signedIn(admin: ReturnType<typeof createSupabaseAdminClient>) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: 'u-1', email: 'u@bank.dev' } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

const activeStatus: Resp = { data: { status: 'active' }, error: null };
const notFirmElevated: Resp = { data: { firm_role: null }, error: null };
const memberProbe: Resp = { data: { id: 'seat-1' }, error: null };

function req(): Request {
  return new Request('http://localhost/api/v1/deals/d1/members');
}

function ctx() {
  return { params: Promise.resolve({ dealId: 'd1' }) };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET deal members', () => {
  it('returns the roster with parties and the owning bank', async () => {
    const admin = makeAdmin({
      // requireApiUser status probe, then userCanAccessDeal firm_role probe.
      users: [activeStatus, notFirmElevated],
      // userCanAccessDeal seat probe, then the member rows.
      deal_memberships: [
        memberProbe,
        {
          data: [
            {
              user_id: 'u-1',
              deal_role: 'md',
              phase: 2,
              user: {
                display_name: 'Storm',
                full_name: 'Storm Duncan',
                email: 'storm@bank.dev',
                company_id: 'bank-1',
                company_role: 'director',
                is_external: false,
              },
            },
            {
              user_id: 'u-2',
              deal_role: 'seller',
              phase: 1,
              // Supabase can hand embeds back as one-element arrays.
              user: [
                {
                  display_name: null,
                  full_name: 'Alex Whitfield',
                  email: 'alex@seller.dev',
                  company_id: 'sell-1',
                  company_role: 'director',
                  is_external: true,
                },
              ],
            },
          ],
          error: null,
        },
      ],
      deals: { data: { id: 'd1', code: 'PRJRA', bank_id: 'bank-1' }, error: null },
      deal_parties: {
        data: [{ company_id: 'sell-1', party_role: 'target' }],
        error: null,
      },
      companies: {
        data: [
          { id: 'bank-1', name: 'Conductia Advisory' },
          { id: 'sell-1', name: 'Canva' },
        ],
        error: null,
      },
    });
    signedIn(admin);

    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: Array<Record<string, unknown>>;
      parties: Array<Record<string, unknown>>;
      bankCompanyId: string;
    };
    expect(body.bankCompanyId).toBe('bank-1');
    expect(body.parties).toEqual([
      { companyId: 'sell-1', companyName: 'Canva', partyRole: 'target' },
    ]);
    expect(body.members).toHaveLength(2);
    expect(body.members[0]).toMatchObject({
      userId: 'u-1',
      displayName: 'Storm',
      fullName: 'Storm Duncan',
      email: 'storm@bank.dev',
      dealRole: 'md',
      phase: 2,
      isExternal: false,
      companyId: 'bank-1',
      companyName: 'Conductia Advisory',
      companyRole: 'director',
    });
    expect(body.members[1]).toMatchObject({
      userId: 'u-2',
      fullName: 'Alex Whitfield',
      dealRole: 'seller',
      isExternal: true,
      companyName: 'Canva',
    });
  });

  it('404s a viewer with no seat on the deal, like an unknown deal', async () => {
    const admin = makeAdmin({
      users: [activeStatus, notFirmElevated],
      deal_memberships: [{ data: null, error: null }],
    });
    signedIn(admin);

    const res = await GET(req(), ctx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Deal not found' });
  });

  it('404s when platform_onboarding is off (route does not exist yet)', async () => {
    vi.mocked(requireFlag).mockResolvedValueOnce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { status: 404 } as any,
    );
    const admin = makeAdmin({});
    signedIn(admin);

    const res = await GET(req(), ctx());
    expect(res.status).toBe(404);
  });
});
