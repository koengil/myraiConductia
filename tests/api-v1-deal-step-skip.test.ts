import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

vi.mock('@/lib/api/v1/access', () => ({
  classifyInternalUser: vi.fn(async () => 'internal'),
  userCanAccessDeal: vi.fn(async () => true),
  userIsDealMd: vi.fn(async () => true),
  resolveDealStepCapabilities: vi.fn(async () => ({
    canAssign: true,
    canComplete: true,
    canEditWork: true,
  })),
}));

vi.mock('@/lib/dataroom/steps', () => ({
  loadDealByIdOrCode: vi.fn(async () => ({ id: DEAL_ID, code: 'PITCH-2026-001' })),
  stepHasUpload: vi.fn(async () => false),
}));

vi.mock('@/lib/notifications/dealStepNotifications', () => ({
  notifyStepAssigned: vi.fn(async () => undefined),
  notifyStepCompleted: vi.fn(async () => undefined),
}));

import { createSupabaseServerClient, createSupabaseAdminClient } from '@/lib/supabase/server';
import { resolveDealStepCapabilities } from '@/lib/api/v1/access';
import { PATCH } from '@/app/api/v1/deals/[dealId]/steps/[stepId]/route';

/*
 * PATCH .../steps/{stepKey} with { skip } — the logged skip (project_rail_model
 * off). #312: the approver is a user id the server verifies against this deal's
 * seats; its name and role come from the database, never from the body.
 */

type Resp = { data: unknown; error: unknown };

const DEAL_ID = '00000000-0000-4000-8000-0000000000d1';
const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const LEGAL = '00000000-0000-4000-8000-0000000000b2';
const TEAM = '00000000-0000-4000-8000-0000000000b3';

function makeAdmin(tables: Record<string, Resp[]>, rpcResp?: Resp) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const filters: Array<{ table: string; column: string; value: unknown }> = [];
  const from = (table: string) => {
    const resp: Resp = tables[table]?.shift() ?? { data: null, error: null };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const k of ['select', 'is', 'gt', 'in', 'order', 'limit']) builder[k] = chain;
    builder.eq = (column: string, value: unknown) => {
      filters.push({ table, column, value });
      return builder;
    };
    builder.single = () => Promise.resolve(resp);
    builder.maybeSingle = () => Promise.resolve(resp);
    builder.then = (f: (v: Resp) => unknown) => Promise.resolve(resp).then(f);
    return builder;
  };
  const rpc = (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    return Promise.resolve(rpcResp ?? { data: null, error: null });
  };
  const admin = { from, rpc } as unknown as ReturnType<typeof createSupabaseAdminClient>;
  return { admin, rpcCalls, filters };
}

function signedIn(admin: ReturnType<typeof createSupabaseAdminClient>) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: ACTOR, email: 'md@bank.dev' } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

const STEP_ID = 'p1-s10';

const stepRow = {
  id: 'ds-10',
  deal_id: DEAL_ID,
  step_id: STEP_ID,
  seq: 10,
  status: 'current',
  assigned_to: ACTOR,
  assigned_by: ACTOR,
  assigned_at: null,
  completed_by: null,
  completed_at: null,
  completion_note: null,
  work: {},
  updated_at: '2026-10-16T10:00:00.000+00:00',
};

const dealRow = {
  id: DEAL_ID,
  code: 'PITCH-2026-001',
  codename: 'Project Villa',
  tenant_id: 't-1',
  mandate_owner_id: ACTOR,
  current_step_seq: 10,
};

const seat = (dealRole: string, user: Record<string, unknown> = {}): Resp => ({
  data: {
    deal_role: dealRole,
    user: { status: 'active', display_name: 'Priya Mehta', full_name: null, email: 'p@bank.dev', ...user },
  },
  error: null,
});

/**
 * The reads in route order: requireApiUser's profile, the step, the deal, the
 * actor's name, then (skip only) the approver's seat.
 */
function tables(over: { step?: Record<string, unknown>; seat?: Resp } = {}): Record<string, Resp[]> {
  return {
    users: [
      { data: { status: 'active', company_id: 'c-1' }, error: null },
      { data: { display_name: 'Storm Duncan', full_name: null, email: 'md@bank.dev' }, error: null },
    ],
    deal_steps: [{ data: { ...stepRow, ...over.step }, error: null }],
    deals: [{ data: dealRow, error: null }],
    deal_memberships: over.seat ? [over.seat] : [],
  };
}

const saved: Resp = {
  data: { step: { ...stepRow, status: 'skipped' }, currentStepId: 'ds-10' },
  error: null,
};

const ctx = { params: Promise.resolve({ dealId: 'PITCH-2026-001', stepId: STEP_ID }) };
const patch = (body: unknown) =>
  new Request('http://localhost', { method: 'PATCH', body: JSON.stringify(body) });

afterEach(() => {
  vi.clearAllMocks();
});

describe('logged skip: who may skip', () => {
  it('403s when the caller cannot complete the step', async () => {
    vi.mocked(resolveDealStepCapabilities).mockResolvedValueOnce({
      canAssign: false,
      canComplete: false,
      canEditWork: false,
    });
    const { admin, rpcCalls } = makeAdmin(tables({ seat: seat('legal') }));
    signedIn(admin);

    const res = await PATCH(patch({ skip: { approverId: LEGAL, reason: 'Off platform' } }), ctx);

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('Not permitted to skip this step');
    expect(rpcCalls).toHaveLength(0);
  });

  it('409s when the step is already closed', async () => {
    const { admin, rpcCalls } = makeAdmin(tables({ step: { status: 'skipped' }, seat: seat('legal') }));
    signedIn(admin);

    const res = await PATCH(patch({ skip: { approverId: LEGAL, reason: 'Off platform' } }), ctx);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('Step is already closed');
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('logged skip: the approver is verified on the server (#312)', () => {
  const INELIGIBLE = 'The approver must hold an active, eligible seat on this deal';

  it.each([
    ['a malformed approverId', 'Free Text', undefined, 'skip.approverId must be a user id'],
    ['no seat on the deal', LEGAL, { data: null, error: null }, INELIGIBLE],
    ['an inactive user', LEGAL, seat('legal', { status: 'suspended' }), INELIGIBLE],
    ['a read_only seat', LEGAL, seat('read_only'), INELIGIBLE],
  ])('400s %s and writes nothing', async (_label, approverId, seatResp, message) => {
    const { admin, rpcCalls } = makeAdmin(tables({ seat: seatResp }));
    signedIn(admin);

    const res = await PATCH(patch({ skip: { approverId, reason: 'Off platform' } }), ctx);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(message);
    expect(rpcCalls).toHaveLength(0);
  });

  it('500s when the seat read fails, and writes nothing', async () => {
    const { admin, rpcCalls } = makeAdmin(
      tables({ seat: { data: null, error: { code: 'XX000', message: 'boom' } } }),
    );
    signedIn(admin);

    const res = await PATCH(patch({ skip: { approverId: LEGAL, reason: 'Off platform' } }), ctx);

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('Approver lookup failed');
    expect(rpcCalls).toHaveLength(0);
  });

  it('records the named seat holder from the database on the step and the audit row', async () => {
    const { admin, rpcCalls, filters } = makeAdmin(
      tables({ seat: seat('deal_team', { display_name: 'Avery Lindqvist' }) }),
      saved,
    );
    signedIn(admin);

    const res = await PATCH(patch({ skip: { approverId: TEAM, reason: ' Off platform ' } }), ctx);

    expect(res.status).toBe(200);
    expect(filters.filter((f) => f.table === 'deal_memberships')).toEqual([
      { table: 'deal_memberships', column: 'deal_id', value: DEAL_ID },
      { table: 'deal_memberships', column: 'user_id', value: TEAM },
    ]);
    expect(rpcCalls).toHaveLength(1);
    const { fn, args } = rpcCalls[0];
    expect(fn).toBe('deal_step_save');
    expect(args).toMatchObject({ p_step_id: 'ds-10', p_actor_id: ACTOR, p_advance: false });
    const p = args.p_patch as Record<string, unknown>;
    expect(p).toMatchObject({ status: 'skipped', completed_by: ACTOR, completion_note: 'Off platform' });
    expect((p.work as { skip: unknown }).skip).toEqual({
      approverId: TEAM,
      approver: 'Avery Lindqvist',
      approverRole: 'deal_team',
      reason: 'Off platform',
      at: expect.any(String),
    });
    const audits = args.p_audits as Array<{ action: string; detail: Record<string, unknown> }>;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'advance',
      detail: {
        kind: 'skip',
        stepId: STEP_ID,
        seq: 10,
        approverId: TEAM,
        approver: 'Avery Lindqvist',
        approverRole: 'deal_team',
        reason: 'Off platform',
      },
    });
  });

  it('takes the actor as approver when the body names none', async () => {
    const { admin, rpcCalls, filters } = makeAdmin(
      tables({ seat: seat('md', { display_name: 'Storm Duncan' }) }),
      saved,
    );
    signedIn(admin);

    const res = await PATCH(patch({ skip: { reason: 'Off platform' } }), ctx);

    expect(res.status).toBe(200);
    expect(filters).toContainEqual({ table: 'deal_memberships', column: 'user_id', value: ACTOR });
    const skip = ((rpcCalls[0].args.p_patch as Record<string, unknown>).work as { skip: unknown }).skip;
    expect(skip).toMatchObject({ approverId: ACTOR, approver: 'Storm Duncan', approverRole: 'md' });
  });

  it('ignores a stale tab that still sends a free-text approver', async () => {
    const { admin, rpcCalls } = makeAdmin(
      tables({ seat: seat('md', { display_name: 'Storm Duncan' }) }),
      saved,
    );
    signedIn(admin);

    const res = await PATCH(
      patch({ skip: { approver: 'Free Text', approverRole: 'MD', reason: 'Off platform' } }),
      ctx,
    );

    expect(res.status).toBe(200);
    const { p_patch, p_audits } = rpcCalls[0].args;
    expect(JSON.stringify(p_patch)).not.toContain('Free Text');
    expect(JSON.stringify(p_audits)).not.toContain('Free Text');
    expect((p_audits as Array<{ detail: Record<string, unknown> }>)[0].detail).toMatchObject({
      approverId: ACTOR,
      approver: 'Storm Duncan',
      approverRole: 'md',
    });
  });

  it('sends the verified approver id and the reason as explicit columns', async () => {
    const { admin, rpcCalls } = makeAdmin(
      tables({ seat: seat('deal_team', { display_name: 'Avery Lindqvist' }) }),
      saved,
    );
    signedIn(admin);

    const res = await PATCH(patch({ skip: { approverId: TEAM, reason: ' Off platform ' } }), ctx);

    expect(res.status).toBe(200);
    expect(rpcCalls[0].args.p_patch).toMatchObject({
      skip_approver_id: TEAM,
      skip_reason: 'Off platform',
    });
  });

  it('sends the actor as the explicit approver when the body names none', async () => {
    const { admin, rpcCalls } = makeAdmin(
      tables({ seat: seat('md', { display_name: 'Storm Duncan' }) }),
      saved,
    );
    signedIn(admin);

    const res = await PATCH(patch({ skip: { reason: 'Off platform' } }), ctx);

    expect(res.status).toBe(200);
    expect(rpcCalls[0].args.p_patch).toMatchObject({ skip_approver_id: ACTOR });
  });
});

describe('logged skip: the database refuses the approver after the check (#312)', () => {
  it('maps a deadlock abort (40P01) to a retryable 409 with a fixed code and no database text', async () => {
    const message = 'deadlock detected: Process 4242 waits for ShareLock on transaction 99';
    const { admin, rpcCalls } = makeAdmin(tables({ seat: seat('legal') }), {
      data: null,
      error: { code: '40P01', message },
    });
    signedIn(admin);

    const res = await PATCH(patch({ skip: { approverId: LEGAL, reason: 'Off platform' } }), ctx);

    expect(res.status).toBe(409);
    expect(res.headers.get('Retry-After')).toBe('1');
    const body = await res.json();
    expect(body).toEqual({
      error: 'The skip met a concurrent change and was not recorded. Send it again.',
      code: 'skip_retry',
    });
    expect(JSON.stringify(body)).not.toContain(message);
    expect(rpcCalls).toHaveLength(1);
  });

  it('maps 42501 skip_approver_ineligible to the same 400 as the check', async () => {
    const { admin, rpcCalls } = makeAdmin(
      tables({ seat: seat('legal') }),
      { data: null, error: { code: '42501', message: 'skip_approver_ineligible' } },
    );
    signedIn(admin);

    const res = await PATCH(patch({ skip: { approverId: LEGAL, reason: 'Off platform' } }), ctx);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'The approver must hold an active, eligible seat on this deal',
    });
    expect(rpcCalls).toHaveLength(1);
  });

  it.each([
    ['a grant error', 'permission denied for function rail_skip_approver'],
    ['a stray skip audit', 'skip_audit_without_skip'],
  ])('keeps any other 42501 a 500: %s', async (_label, message) => {
    const { admin } = makeAdmin(tables({ seat: seat('legal') }), {
      data: null,
      error: { code: '42501', message },
    });
    signedIn(admin);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await PATCH(patch({ skip: { approverId: LEGAL, reason: 'Off platform' } }), ctx);

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(message);
    spy.mockRestore();
  });
});

describe('work patches never write work.skip (#312)', () => {
  const stored = {
    approverId: LEGAL,
    approver: 'Priya Mehta',
    approverRole: 'legal',
    reason: 'Off platform',
    at: '2026-10-16T09:00:00.000Z',
  };
  const forged = { approver: 'Anyone', approverRole: 'md', reason: 'Forged' };

  it('refuses a work patch that only carries skip on an open step', async () => {
    const { admin, rpcCalls } = makeAdmin(tables());
    signedIn(admin);

    const res = await PATCH(patch({ work: { skip: forged } }), ctx);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('No supported patch fields provided');
    expect(rpcCalls).toHaveLength(0);
  });

  it('drops skip and saves the other fields on an open step', async () => {
    const { admin, rpcCalls } = makeAdmin(tables({ step: { work: { notes: 'old' } } }), saved);
    signedIn(admin);

    const res = await PATCH(patch({ work: { notes: 'new', skip: forged } }), ctx);

    expect(res.status).toBe(200);
    const { p_patch, p_audits } = rpcCalls[0].args;
    expect((p_patch as Record<string, unknown>).work).toEqual({ notes: 'new' });
    expect(p_audits).toEqual([{ action: 'step_work', detail: { stepId: STEP_ID, fields: ['notes'] } }]);
  });

  it('keeps the verified record on a skipped step, forged or echoed', async () => {
    const { admin, rpcCalls } = makeAdmin(
      tables({ step: { status: 'skipped', work: { notes: 'old', skip: stored } } }),
      saved,
    );
    signedIn(admin);

    const res = await PATCH(patch({ work: { notes: 'new', skip: forged } }), ctx);

    expect(res.status).toBe(200);
    const work = (rpcCalls[0].args.p_patch as Record<string, unknown>).work;
    expect(work).toEqual({ notes: 'new', skip: stored });
    expect(JSON.stringify(rpcCalls[0].args)).not.toContain('Anyone');
  });
});
