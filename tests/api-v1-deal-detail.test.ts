import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { GET } from '@/app/api/v1/deals/[dealId]/route';

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
    for (const k of ['select', 'eq', 'in', 'order']) builder[k] = chain;
    builder.single = () => Promise.resolve(resp);
    builder.maybeSingle = () => Promise.resolve(resp);
    builder.then = (f: (v: Resp) => unknown) => Promise.resolve(resp).then(f);
    return builder;
  };
  return { from } as unknown as ReturnType<typeof createSupabaseAdminClient>;
}

function signedIn(admin: ReturnType<typeof makeAdmin>, user = { id: 'cco-1', email: 'cco@bank.dev' }) {
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

const ctx = (dealId: string) => ({ params: Promise.resolve({ dealId }) });

// A CCO caller (userCanAccessDeal short-circuits on firm_role) keeps the mock
// focused on the code-vs-uuid resolution under test.
function ccoAdmin(dealRow: Resp) {
  return makeAdmin({
    deals: dealRow,
    users: { data: { firm_role: 'cco' }, error: null },
    deal_parties: { data: [], error: null },
    deal_memberships: { data: [], error: null },
    notifications: { data: [], error: null },
  });
}

afterEach(() => vi.clearAllMocks());

describe('GET /api/v1/deals/{dealId} — resolve by code or UUID (G14)', () => {
  const dealRow = {
    data: {
      id: '11111111-1111-4111-8111-111111111111',
      code: 'SUM-2026-014',
      codename: 'Project Summit',
      status: 'intake',
      mandate_owner_id: 'cco-1',
      bank_id: 'bank-1',
      created_at: '2026-07-15T00:00:00Z',
    },
    error: null,
  };

  it('resolves a deal by its human-readable code', async () => {
    signedIn(ccoAdmin(dealRow));
    const res = await GET(new Request('http://localhost'), ctx('SUM-2026-014'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deal: { code: string } };
    expect(body.deal.code).toBe('SUM-2026-014');
    // Book graduation fields 1-3 ride in the API's camelCase beside the raw row.
    expect(body.deal).toHaveProperty('targetCloseDate');
    expect(body.deal).toHaveProperty('feeUsd');
    expect(body.deal).toHaveProperty('scheduleStatus');
    expect(body.deal).toHaveProperty('lifecycleCategory');
  });

  it('resolves a deal by UUID (back-compat)', async () => {
    signedIn(ccoAdmin(dealRow));
    const res = await GET(new Request('http://localhost'), ctx('11111111-1111-4111-8111-111111111111'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deal: { code: string } };
    expect(body.deal.code).toBe('SUM-2026-014');
  });

  it('404s an unknown code', async () => {
    signedIn(ccoAdmin({ data: null, error: null }));
    const res = await GET(new Request('http://localhost'), ctx('NOPE-2026-999'));
    expect(res.status).toBe(404);
  });

  it('401 when not signed in', async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(createSupabaseAdminClient).mockReturnValue(makeAdmin({}));
    const res = await GET(new Request('http://localhost'), ctx('SUM-2026-014'));
    expect(res.status).toBe(401);
  });

  it('returns gate0Notifications from the deal_created fan-out', async () => {
    signedIn(
      makeAdmin({
        deals: dealRow,
        users: { data: { firm_role: 'cco' }, error: null },
        deal_parties: { data: [], error: null },
        deal_memberships: { data: [], error: null },
        notifications: {
          data: [
            {
              created_at: '2026-07-15T10:00:00Z',
              payload: {
                code: 'SUM-2026-014',
                codename: 'Project Summit',
                actor: 'Storm Duncan',
                screening: { verdict: 'compliant' },
              },
              recipient: {
                full_name: 'Casey Ortiz',
                display_name: 'Casey Ortiz',
                firm_role: 'cco',
              },
            },
          ],
          error: null,
        },
      }),
    );
    const res = await GET(new Request('http://localhost'), ctx('SUM-2026-014'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gate0Notifications: Array<{ recipientName: string; recipientRole: string | null }>;
    };
    expect(body.gate0Notifications).toHaveLength(1);
    expect(body.gate0Notifications[0]?.recipientName).toBe('Casey Ortiz');
    expect(body.gate0Notifications[0]?.recipientRole).toBe('cco');
  });
});
