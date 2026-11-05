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
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { PATCH } from '@/app/api/v1/deals/[dealId]/members/[userId]/route';

/*
 * Phase control (spec-v3 criterion 12): MD-only, monotonic raise, idempotent
 * retries, flag-off parity. Disclosure never goes backwards.
 */

type Resp = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Resp | Resp[]>) {
  const updates: Array<{ table: string; values: unknown }> = [];
  const inserts: Array<{ table: string; row: unknown }> = [];
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
    builder.limit = chain;
    builder.single = terminal;
    builder.maybeSingle = terminal;
    builder.update = (values: unknown) => {
      updates.push({ table, values });
      return builder;
    };
    builder.insert = (row: unknown) => {
      inserts.push({ table, row });
      return builder;
    };
    builder.then = (onFulfilled: (v: Resp) => unknown) =>
      Promise.resolve(resp).then(onFulfilled);
    return builder;
  };
  return {
    admin: { from } as unknown as ReturnType<typeof createSupabaseAdminClient>,
    updates,
    inserts,
  };
}

function signedInMd(admin: ReturnType<typeof createSupabaseAdminClient>) {
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

const activeStatus: Resp = { data: { status: 'active' }, error: null };
const notFirmAdmin: Resp = { data: { firm_role: null }, error: null };
const mdSeatProbe: Resp = { data: { deal_role: 'md' }, error: null };

function seatAtPhase(phase: number): Resp {
  return { data: { id: 'seat-1', access_scope: {}, phase }, error: null };
}

function req(body: unknown): Request {
  return new Request('http://localhost/api/v1/deals/d1/members/u1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function ctx() {
  return { params: Promise.resolve({ dealId: 'd1', userId: 'u1' }) };
}

/** users: requireApiUser status, then userIsDealMd firm_role probe.
 *  deal_memberships: userIsDealMd seat probe, then the target seat. */
function standardTables(targetSeat: Resp): Record<string, Resp | Resp[]> {
  return {
    // Routes resolve the deal code/UUID first (resolveDealRef).
    deals: { data: { id: 'd1', code: 'PRJRA' }, error: null },
    users: [activeStatus, notFirmAdmin],
    deal_memberships: [mdSeatProbe, targetSeat],
    audit_log: { data: null, error: null },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('PATCH member phase', () => {
  it('raises the phase and audits {from, to}', async () => {
    const { admin, updates, inserts } = makeAdmin(standardTables(seatAtPhase(0)));
    signedInMd(admin);
    const res = await PATCH(req({ phase: 2 }), ctx());
    expect(res.status).toBe(200);
    expect(updates).toEqual([{ table: 'deal_memberships', values: { phase: 2 } }]);
    const audit = inserts.find((i) => i.table === 'audit_log');
    const rows = audit?.row as Array<{ detail: { from: number; to: number; reason: string } }>;
    expect(rows[0].detail).toMatchObject({ reason: 'phase_raised', from: 0, to: 2 });
  });

  it('409s a downgrade — disclosure is monotonic', async () => {
    const { admin, updates } = makeAdmin(standardTables(seatAtPhase(2)));
    signedInMd(admin);
    const res = await PATCH(req({ phase: 1 }), ctx());
    expect(res.status).toBe(409);
    expect(updates).toHaveLength(0);
  });

  it('equal phase is an idempotent no-op (safe fan-out retry)', async () => {
    const { admin, updates, inserts } = makeAdmin(standardTables(seatAtPhase(2)));
    signedInMd(admin);
    const res = await PATCH(req({ phase: 2 }), ctx());
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it('rejects the phase field when platform_onboarding is off (parity)', async () => {
    // The handler reads the flag twice when off: once to skip deal-code
    // resolution (flag-off parity) and once to reject the phase field.
    vi.mocked(isFlagEnabled).mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    const { admin } = makeAdmin(standardTables(seatAtPhase(0)));
    signedInMd(admin);
    const res = await PATCH(req({ phase: 1 }), ctx());
    expect(res.status).toBe(400);
  });

  it('preserves the pre-existing delegation path untouched', async () => {
    const { admin, updates, inserts } = makeAdmin(standardTables(seatAtPhase(0)));
    signedInMd(admin);
    const res = await PATCH(req({ canManageMembers: true }), ctx());
    expect(res.status).toBe(200);
    expect(updates).toEqual([
      { table: 'deal_memberships', values: { access_scope: { can_manage_members: true } } },
    ]);
    const rows = (inserts[0].row as Array<{ detail: { reason: string } }>);
    expect(rows[0].detail.reason).toBe('delegate_manage_members');
  });

  it('non-MD actors stay 403', async () => {
    // A seated deal_team member knows the deal exists, so the refusal stays a
    // 403 rather than the unseated caller's 404 (decision-log D65). The last
    // users/deal_memberships reads are that visibility probe.
    const { admin } = makeAdmin({
      deals: { data: { id: 'd1', code: 'PRJRA', tenant_id: 't1' }, error: null },
      users: [activeStatus, notFirmAdmin, { data: { firm_role: null, tenant_id: 't1' }, error: null }],
      deal_memberships: [
        { data: { deal_role: 'deal_team' }, error: null },
        { data: { id: 'seat-1' }, error: null },
      ],
    });
    signedInMd(admin);
    const res = await PATCH(req({ phase: 1 }), ctx());
    expect(res.status).toBe(403);
  });
});
