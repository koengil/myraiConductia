import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { PATCH } from '@/app/api/v1/deals/[dealId]/progress/route';

type Resp = { data: unknown; error: unknown };

const rpcCalls: [string, unknown][] = [];

function makeAdmin(tables: Record<string, Resp | Resp[]>, rpcResp: Resp = { data: null, error: null }) {
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const k of ['select', 'eq', 'is', 'update', 'insert']) builder[k] = chain;
    builder.single = () => Promise.resolve(resp);
    builder.maybeSingle = () => Promise.resolve(resp);
    builder.then = (f: (v: Resp) => unknown) => Promise.resolve(resp).then(f);
    return builder;
  };
  const rpc = (name: string, args: unknown) => {
    rpcCalls.push([name, args]);
    return Promise.resolve(rpcResp);
  };
  return { from, rpc } as unknown as ReturnType<typeof createSupabaseAdminClient>;
}

function signedIn(admin: ReturnType<typeof makeAdmin>, user = { id: 'u-1', email: 'u@bank.dev' }) {
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
const patch = (body: unknown) =>
  new Request('http://localhost', { method: 'PATCH', body: JSON.stringify(body) });

afterEach(() => {
  vi.clearAllMocks();
  rpcCalls.length = 0;
});

describe('PATCH /api/v1/deals/{dealId}/progress (G15)', () => {
  it('400 on a non-positive / non-integer currentStepSeq', async () => {
    signedIn(makeAdmin({}));
    expect((await PATCH(patch({ currentStepSeq: 0 }), ctx('SUM-2026-014'))).status).toBe(400);
    expect((await PATCH(patch({}), ctx('SUM-2026-014'))).status).toBe(400);
  });

  it('404 when the deal (code) does not resolve', async () => {
    signedIn(makeAdmin({ deals: { data: null, error: null } }));
    const res = await PATCH(patch({ currentStepSeq: 5 }), ctx('NOPE-2026-1'));
    expect(res.status).toBe(404);
  });

  it('404 for a non-member, like a deal that does not resolve', async () => {
    signedIn(
      makeAdmin({
        deals: { data: { id: 'd-uuid', code: 'SUM-2026-014', current_step_seq: 1 }, error: null },
        users: { data: { firm_role: null }, error: null },
        deal_memberships: { data: null, error: null }, // no membership → access denied
      }),
    );
    const res = await PATCH(patch({ currentStepSeq: 5 }), ctx('SUM-2026-014'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Deal not found' });
  });

  it('advances forward for a member and returns the new position', async () => {
    signedIn(
      makeAdmin({
        deals: [
          { data: { id: 'd-uuid', code: 'SUM-2026-014', current_step_seq: 1 }, error: null }, // resolve
          { data: { tenant_id: 't1' }, error: null }, // userCanAccessDeal tenant check (#116)
        ],
        users: { data: { firm_role: 'cco', tenant_id: 't1' }, error: null }, // overseer → access
        deal_steps: { data: { id: 'step-12' }, error: null }, // resolve seq to a rail row
      }),
    );
    const res = await PATCH(patch({ currentStepSeq: 12 }), ctx('SUM-2026-014'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deal: { currentStepSeq: number } };
    expect(body.deal.currentStepSeq).toBe(12);
    // The move and its audit row go through one transaction (#249).
    expect(rpcCalls).toEqual([
      [
        'deal_move_cursor',
        { p_deal_id: 'd-uuid', p_actor_id: 'u-1', p_step_id: 'step-12', p_from_seq: 1, p_to_seq: 12 },
      ],
    ]);
  });

  it('500s without touching the cursor when the move and its audit are rejected (#249)', async () => {
    const admin = makeAdmin(
      {
        deals: [
          { data: { id: 'd-uuid', code: 'SUM-2026-014', current_step_seq: 1 }, error: null },
          { data: { tenant_id: 't1' }, error: null },
        ],
        users: { data: { firm_role: 'cco', tenant_id: 't1' }, error: null },
        deal_steps: { data: { id: 'step-12' }, error: null },
      },
      { data: null, error: { message: 'chain rejected' } },
    );
    const originalFrom = admin.from;
    const writes: string[] = [];
    admin.from = ((table: string) => {
      const builder = originalFrom(table) as unknown as Record<string, unknown>;
      for (const k of ['update', 'insert']) {
        const fn = builder[k] as (...args: unknown[]) => unknown;
        builder[k] = (...args: unknown[]) => {
          writes.push(`${table}.${k}`);
          return fn(...args);
        };
      }
      return builder;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    signedIn(admin);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await PATCH(patch({ currentStepSeq: 12 }), ctx('SUM-2026-014'));

    expect(res.status).toBe(500);
    expect(writes).toEqual([]);
    expect(((await res.json()) as { error: string }).error).toMatch(/did not happen/);
  });

  it('409s when the seq resolves to no active step, and never writes a cursor', async () => {
    const admin = makeAdmin({
      deals: {
        data: { id: 'd-uuid', code: 'SUM-2026-014', current_step_seq: 1, tenant_id: 't1' },
        error: null,
      },
      users: { data: { firm_role: 'cco', tenant_id: 't1' }, error: null },
      deal_steps: { data: null, error: null },
    });
    const dealsUpdateCalls: unknown[] = [];
    const originalFrom = admin.from;
    admin.from = ((table: string) => {
      const builder = originalFrom(table);
      if (table !== 'deals') return builder;
      const wrapped = { ...(builder as unknown as Record<string, unknown>) };
      const originalUpdate = wrapped.update as (...args: unknown[]) => unknown;
      wrapped.update = (...args: unknown[]) => {
        dealsUpdateCalls.push(args[0]);
        return originalUpdate(...args);
      };
      return wrapped;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    signedIn(admin);

    const res = await PATCH(patch({ currentStepSeq: 99 }), ctx('SUM-2026-014'));

    expect(res.status).toBe(409);
    expect(dealsUpdateCalls).toHaveLength(0);
  });

  it('403 when a non-MD member tries to move the rail backwards', async () => {
    signedIn(
      makeAdmin({
        deals: { data: { id: 'd-uuid', code: 'SUM-2026-014', current_step_seq: 12 }, error: null },
        users: [
          { data: { firm_role: null }, error: null }, // userCanAccessDeal
          { data: { firm_role: null }, error: null }, // userIsDealMd
        ],
        deal_memberships: [
          { data: { id: 'm-1' }, error: null }, // access: is a member
          { data: { deal_role: 'deal_team' }, error: null }, // isMd: not md
        ],
      }),
    );
    const res = await PATCH(patch({ currentStepSeq: 3 }), ctx('SUM-2026-014'));
    expect(res.status).toBe(403);
  });
});
