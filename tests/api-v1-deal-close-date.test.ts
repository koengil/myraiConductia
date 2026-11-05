import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { PATCH } from '@/app/api/v1/deals/[dealId]/route';
import { DEAL_FEE_USD_MAX } from '@/lib/validation/inputPolicy';

/*
 * PATCH /api/v1/deals/{dealId} — the Book graduation fields (#191): target
 * close date (field 1), fee and schedule status (fields 2-3) are real
 * columns, set by the deal MD (or admin), one audit 'update' row per field.
 * The Book reads them; the fixture values are no longer consulted.
 */

type Resp = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Resp | Resp[]>) {
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const k of ['select', 'eq']) builder[k] = chain;
    builder.update = (payload: Record<string, unknown>) => {
      updates.push({ table, payload });
      return builder;
    };
    builder.insert = (payload: Record<string, unknown>) => {
      inserts.push({ table, payload });
      return builder;
    };
    builder.single = () => Promise.resolve(resp);
    builder.maybeSingle = () => Promise.resolve(resp);
    builder.then = (f: (v: Resp) => unknown) => Promise.resolve(resp).then(f);
    return builder;
  };
  const admin = { from } as unknown as ReturnType<typeof createSupabaseAdminClient>;
  return { admin, inserts, updates };
}

function signedIn(admin: ReturnType<typeof createSupabaseAdminClient>) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: 'u-1', email: 'u@bank.dev' } }, error: null }),
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

type DealRow = {
  id: string;
  code: string;
  status: string;
  target_close_date: string | null;
  /** PostgREST may hand a bigint back as a string; the route normalises it. */
  fee_usd: number | string | null;
  schedule_status: string | null;
  lifecycle_category?: string;
};
const dealRow: DealRow = {
  id: 'd-uuid',
  code: 'MESAX-2026-413',
  status: 'active',
  target_close_date: null,
  fee_usd: null,
  schedule_status: null,
  lifecycle_category: 'live',
};
const mdTables = () => ({
  deals: [
    { data: dealRow, error: null }, // resolve
    { data: { tenant_id: 't-1' }, error: null }, // userCanAccessDeal tenant check (#7)
    { data: { ...dealRow, target_close_date: '2026-10-09' }, error: null }, // update().select().single()
  ],
  users: [
    { data: { status: 'active' }, error: null }, // requireApiUser
    { data: { firm_role: null, tenant_id: 't-1' }, error: null }, // userCanAccessDeal
    { data: { firm_role: null, tenant_id: 't-1' }, error: null }, // userIsDealMd
  ],
  deal_memberships: [
    { data: { id: 'm-1' }, error: null }, // member
    { data: { deal_role: 'md' }, error: null }, // md seat
  ],
  audit_log: { data: null, error: null },
});

afterEach(() => vi.clearAllMocks());

describe('PATCH /api/v1/deals/{dealId} — target close date', () => {
  it('400 on a malformed date or a missing field', async () => {
    signedIn(makeAdmin({}).admin);
    expect((await PATCH(patch({ targetCloseDate: 'next friday' }), ctx('MESAX-2026-413'))).status).toBe(400);
    expect((await PATCH(patch({ targetCloseDate: '2026-13-45' }), ctx('MESAX-2026-413'))).status).toBe(400);
    expect((await PATCH(patch({}), ctx('MESAX-2026-413'))).status).toBe(400);
  });

  it('400 on a date outside the bookable window', async () => {
    signedIn(makeAdmin({}).admin);
    expect((await PATCH(patch({ targetCloseDate: '1900-01-01' }), ctx('MESAX-2026-413'))).status).toBe(400);
    expect((await PATCH(patch({ targetCloseDate: '9999-12-31' }), ctx('MESAX-2026-413'))).status).toBe(400);
  });

  it('400 on a fee past the ceiling, and never in developer vocabulary', async () => {
    signedIn(makeAdmin({}).admin);
    expect((await PATCH(patch({ feeUsd: DEAL_FEE_USD_MAX + 1 }), ctx('MESAX-2026-413'))).status).toBe(400);
    const res = await PATCH(patch({ feeUsd: -1 }), ctx('MESAX-2026-413'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toMatch(/feeUsd|2\^53|null/);
  });

  it('404 when the deal code does not resolve', async () => {
    signedIn(makeAdmin({ deals: { data: null, error: null } }).admin);
    const res = await PATCH(patch({ targetCloseDate: '2026-10-09' }), ctx('NOPE-2026-1'));
    expect(res.status).toBe(404);
  });

  it('403 for a member who does not hold the MD seat', async () => {
    const t = mdTables();
    t.deal_memberships[1] = { data: { deal_role: 'deal_team' }, error: null };
    const { admin, updates } = makeAdmin(t);
    signedIn(admin);
    const res = await PATCH(patch({ targetCloseDate: '2026-10-09' }), ctx('MESAX-2026-413'));
    expect(res.status).toBe(403);
    // The MD guard, not the access guard: both answer 403, and the access
    // predicate is exactly what drifted under this test in #7.
    expect(await res.json()).toEqual({ error: 'Only the deal MD can set the Book fields' });
    expect(updates).toHaveLength(0);
  });

  it('the MD sets the date; the change is audited as update with from/to', async () => {
    const { admin, updates, inserts } = makeAdmin(mdTables());
    signedIn(admin);
    const res = await PATCH(patch({ targetCloseDate: '2026-10-09' }), ctx('MESAX-2026-413'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deal: { code: 'MESAX-2026-413', targetCloseDate: '2026-10-09', feeUsd: null, scheduleStatus: null, lifecycleCategory: 'live' },
    });
    expect(updates).toEqual([{ table: 'deals', payload: { target_close_date: '2026-10-09' } }]);
    // audit_log rows travel as one batched insert (an array), one row per field.
    const batch = inserts.find((i) => i.table === 'audit_log')?.payload as unknown as Array<Record<string, unknown>>;
    expect(batch).toHaveLength(1);
    expect(batch[0].action).toBe('update');
    expect(batch[0].deal_id).toBe('d-uuid');
    expect(batch[0].detail).toEqual({ field: 'target_close_date', from: null, to: '2026-10-09' });
  });

  it('null clears the date (the MD withdrew the target)', async () => {
    const t = mdTables();
    t.deals = [
      { data: { ...dealRow, target_close_date: '2026-10-09' }, error: null },
      { data: { tenant_id: 't-1' }, error: null },
      { data: dealRow, error: null },
    ];
    const { admin, updates, inserts } = makeAdmin(t);
    signedIn(admin);
    const res = await PATCH(patch({ targetCloseDate: null }), ctx('MESAX-2026-413'));
    expect(res.status).toBe(200);
    expect(updates[0].payload).toEqual({ target_close_date: null });
    const batch = inserts[0].payload as unknown as Array<{ detail: Record<string, unknown> }>;
    expect(batch[0].detail.from).toBe('2026-10-09');
  });

  it('400 when no Book field is in the body, or fee/schedule fail validation', async () => {
    signedIn(makeAdmin({}).admin);
    expect((await PATCH(patch({ somethingElse: 1 }), ctx('MESAX-2026-413'))).status).toBe(400);
    expect((await PATCH(patch({ feeUsd: -5 }), ctx('MESAX-2026-413'))).status).toBe(400);
    expect((await PATCH(patch({ feeUsd: 1.5 }), ctx('MESAX-2026-413'))).status).toBe(400);
    expect((await PATCH(patch({ feeUsd: '5100000' }), ctx('MESAX-2026-413'))).status).toBe(400);
    expect((await PATCH(patch({ feeUsd: 1e20 }), ctx('MESAX-2026-413'))).status).toBe(400); // beyond bigint / safe integer
    expect((await PATCH(patch({ scheduleStatus: 'behind' }), ctx('MESAX-2026-413'))).status).toBe(400);
    // The category is NOT NULL in the schema and must be one of Storm's seven.
    expect((await PATCH(patch({ lifecycleCategory: null }), ctx('MESAX-2026-413'))).status).toBe(400);
    expect((await PATCH(patch({ lifecycleCategory: 'Live Deals' }), ctx('MESAX-2026-413'))).status).toBe(400);
  });

  it('the MD sets fee and schedule together; one audit row per field, from/to typed', async () => {
    const t = mdTables();
    t.deals[0] = { data: { ...dealRow, fee_usd: '1900000', schedule_status: 'on_time' }, error: null };
    t.deals[2] = { data: { ...dealRow, fee_usd: 5100000, schedule_status: 'ahead' }, error: null };
    const { admin, updates, inserts } = makeAdmin(t);
    signedIn(admin);
    const res = await PATCH(patch({ feeUsd: 5100000, scheduleStatus: 'ahead' }), ctx('MESAX-2026-413'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deal: { code: 'MESAX-2026-413', targetCloseDate: null, feeUsd: 5100000, scheduleStatus: 'ahead', lifecycleCategory: 'live' },
    });
    expect(updates).toEqual([{ table: 'deals', payload: { fee_usd: 5100000, schedule_status: 'ahead' } }]);
    // ONE batched insert carries both rows: the trail is all-or-nothing per request.
    const auditInserts = inserts.filter((i) => i.table === 'audit_log');
    expect(auditInserts).toHaveLength(1);
    const audits = (auditInserts[0].payload as unknown as Array<{ detail: unknown }>).map((r) => r.detail);
    expect(audits).toEqual([
      // A numeric column may come back as a string from PostgREST; the audit carries a number.
      { field: 'fee_usd', from: 1900000, to: 5100000 },
      { field: 'schedule_status', from: 'on_time', to: 'ahead' },
    ]);
  });

  it('null withdraws the fee without touching the other fields', async () => {
    const t = mdTables();
    t.deals[0] = { data: { ...dealRow, fee_usd: 1900000 }, error: null };
    t.deals[2] = { data: dealRow, error: null };
    const { admin, updates, inserts } = makeAdmin(t);
    signedIn(admin);
    const res = await PATCH(patch({ feeUsd: null }), ctx('MESAX-2026-413'));
    expect(res.status).toBe(200);
    expect(updates).toEqual([{ table: 'deals', payload: { fee_usd: null } }]);
    const auditInserts = inserts.filter((i) => i.table === 'audit_log');
    expect(auditInserts).toHaveLength(1);
    const rows = auditInserts[0].payload as unknown as Array<{ detail: unknown }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toEqual({ field: 'fee_usd', from: 1900000, to: null });
  });

  it('the MD moves the deal to another lifecycle category; audited with from/to, and Mandate hold pauses the work', async () => {
    const t = mdTables();
    t.deals[2] = { data: { ...dealRow, lifecycle_category: 'mandate_hold' }, error: null };
    const { admin, updates, inserts } = makeAdmin(t);
    signedIn(admin);
    const res = await PATCH(patch({ lifecycleCategory: 'mandate_hold' }), ctx('MESAX-2026-413'));
    expect(res.status).toBe(200);
    expect((await res.json()).deal.lifecycleCategory).toBe('mandate_hold');
    expect(updates).toEqual([
      { table: 'deals', payload: { lifecycle_category: 'mandate_hold', status: 'paused' } },
    ]);
    const rows = inserts.find((i) => i.table === 'audit_log')?.payload as unknown as Array<{ detail: unknown }>;
    expect(rows.map((r) => r.detail)).toEqual([
      { field: 'lifecycle_category', from: 'live', to: 'mandate_hold' },
      { field: 'status', from: 'active', to: 'paused' },
    ]);
  });
});

/*
 * Storm's ruling (2026-09-01, answer 4): the Book category drives the deal's
 * working status. Closed, Terminated and Lost end the work; Mandate hold
 * pauses it; moving back to Live reactivates a paused or closed deal. Pitch
 * and prospect carry no ruling, and an intake deal is never advanced by a
 * category save.
 */
describe('PATCH /api/v1/deals/{dealId} — the category drives the status', () => {
  const run = async (
    category: string,
    currentStatus: string,
    currentCategory = 'live',
  ) => {
    const t = mdTables();
    t.deals[0] = { data: { ...dealRow, status: currentStatus, lifecycle_category: currentCategory }, error: null };
    t.deals[2] = { data: { ...dealRow, status: currentStatus, lifecycle_category: category }, error: null };
    const { admin, updates, inserts } = makeAdmin(t);
    signedIn(admin);
    const res = await PATCH(patch({ lifecycleCategory: category }), ctx('MESAX-2026-413'));
    expect(res.status).toBe(200);
    const auditDetails = (
      inserts.find((i) => i.table === 'audit_log')?.payload as unknown as Array<{ detail: unknown }>
    ).map((r) => r.detail);
    return { payload: updates[0].payload, auditDetails };
  };

  it('Closed, Terminated and Lost close the working status', async () => {
    for (const category of ['closed', 'terminated', 'lost']) {
      const { payload, auditDetails } = await run(category, 'active');
      expect(payload).toEqual({ lifecycle_category: category, status: 'closed' });
      expect(auditDetails[1]).toEqual({ field: 'status', from: 'active', to: 'closed' });
      vi.clearAllMocks();
    }
  });

  it('moving back to Live reactivates a paused or a closed deal', async () => {
    for (const currentStatus of ['paused', 'closed']) {
      const { payload, auditDetails } = await run('live', currentStatus, 'mandate_hold');
      expect(payload).toEqual({ lifecycle_category: 'live', status: 'active' });
      expect(auditDetails[1]).toEqual({ field: 'status', from: currentStatus, to: 'active' });
      vi.clearAllMocks();
    }
  });

  it('a category save never touches an intake deal, in either direction', async () => {
    for (const category of ['live', 'closed', 'terminated', 'lost', 'mandate_hold']) {
      const { payload, auditDetails } = await run(category, 'intake', 'pitch');
      expect(payload).toEqual({ lifecycle_category: category });
      expect(auditDetails).toHaveLength(1);
      vi.clearAllMocks();
    }
  });

  it('saving the category a deal already matches leaves the status alone', async () => {
    const { payload, auditDetails } = await run('closed', 'closed', 'terminated');
    expect(payload).toEqual({ lifecycle_category: 'closed' });
    expect(auditDetails).toHaveLength(1);
  });

  it('409 in banker vocabulary when reactivation collides with an active code name', async () => {
    const t = mdTables();
    t.deals[0] = { data: { ...dealRow, status: 'closed', lifecycle_category: 'mandate_hold' }, error: null };
    t.deals[2] = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "deals_codename_unique_active"' } } as unknown as (typeof t.deals)[number];
    const { admin } = makeAdmin(t);
    signedIn(admin);
    const res = await PATCH(patch({ lifecycleCategory: 'live' }), ctx('MESAX-2026-413'));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Code name is already in use on a live deal');
    expect(body.error).not.toMatch(/duplicate|constraint|23505/);
  });

  it('pitch and prospect carry no ruling and leave the status alone', async () => {
    for (const category of ['pitch', 'prospect']) {
      const { payload, auditDetails } = await run(category, 'active');
      expect(payload).toEqual({ lifecycle_category: category });
      expect(auditDetails).toHaveLength(1);
      vi.clearAllMocks();
    }
  });
});
