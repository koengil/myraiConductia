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
  loadDealByIdOrCode: vi.fn(async () => ({ id: 'd-uuid', code: 'PITCH-2026-001' })),
  stepHasUpload: vi.fn(async () => false),
}));

vi.mock('@/lib/notifications/dealStepNotifications', () => ({
  notifyStepAssigned: vi.fn(async () => undefined),
  notifyStepCompleted: vi.fn(async () => undefined),
}));

import { createSupabaseServerClient, createSupabaseAdminClient } from '@/lib/supabase/server';
import { stepHasUpload } from '@/lib/dataroom/steps';
import { notifyStepCompleted } from '@/lib/notifications/dealStepNotifications';
import { PATCH } from '@/app/api/v1/deals/[dealId]/steps/[stepId]/route';
import { MANUAL_STEP_DEFS } from '@/lib/rail/manualStepDefs';

/*
 * PATCH .../steps/{stepId} with complete:true — step 17 (p1-s21, the pitch
 * deck) declares `uploadRequired`, so the checklist alone must not close it.
 * The panel's upload control is an affordance; this gate is the enforcement.
 */

type Resp = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Resp | Resp[]>, rpcResp?: Resp) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const filters: Array<[string, unknown]> = [];
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const k of ['select', 'is', 'gt', 'in', 'order', 'limit']) builder[k] = chain;
    builder.eq = (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    };
    builder.update = (payload: Record<string, unknown>) => {
      updates.push({ table, payload });
      return builder;
    };
    builder.insert = (payload: unknown) => {
      inserts.push({ table, payload });
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
  return { admin, inserts, updates, filters, rpcCalls };
}

function signedIn(admin: ReturnType<typeof createSupabaseAdminClient>) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: 'u-1', email: 'md@bank.dev' } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

const STEP_ID = 'p1-s21';

const stepRow = {
  id: 'ds-1',
  deal_id: 'd-uuid',
  step_id: STEP_ID,
  seq: 21,
  status: 'current',
  assigned_to: 'u-1',
  assigned_by: 'u-1',
  assigned_at: null,
  completed_by: null,
  completed_at: null,
  completion_note: null,
  work: {},
  updated_at: '2026-09-29T10:00:00.000+00:00',
};

const dealRow = {
  id: 'd-uuid',
  code: 'PITCH-2026-001',
  codename: 'Project Villa',
  tenant_id: 't-1',
  // Same as the actor, so the completion notification path is not exercised.
  mandate_owner_id: 'u-1',
  current_step_seq: 21,
};

const actorRow = { display_name: 'Rob', full_name: null, email: 'md@bank.dev' };

/** Every required checklist field on step 17 answered. */
function completeWork() {
  const work: Record<string, unknown> = {};
  for (const field of MANUAL_STEP_DEFS[STEP_ID].fields) {
    if (field.type === 'checkbox') work[field.id] = true;
    else work[field.id] = 'Answered';
  }
  return work;
}

const ctx = { params: Promise.resolve({ dealId: 'PITCH-2026-001', stepId: STEP_ID }) };
const patch = (body: unknown) =>
  new Request('http://localhost', { method: 'PATCH', body: JSON.stringify(body) });

afterEach(() => {
  vi.clearAllMocks();
});

describe('station 17 completion gate', () => {
  it('declares the pitch deck upload as required', () => {
    expect(MANUAL_STEP_DEFS[STEP_ID].uploadRequired).toBe(true);
    expect(MANUAL_STEP_DEFS[STEP_ID].uploadLabel).toBe('Upload pitch deck');
  });

  it('refuses completion when the step dataroom holds no file', async () => {
    const { admin, rpcCalls } = makeAdmin({
      deal_steps: [{ data: stepRow, error: null }],
      deals: [{ data: dealRow, error: null }],
      users: [{ data: actorRow, error: null }],
    });
    signedIn(admin);
    vi.mocked(stepHasUpload).mockResolvedValue(false);

    const res = await PATCH(patch({ work: completeWork(), complete: true }), ctx);
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/Upload pitch deck is required/);
    // The gate must reject before anything is marked complete.
    expect(rpcCalls).toHaveLength(0);
  });

  it('completes once the deck is filed', async () => {
    const { admin, inserts, updates, rpcCalls } = makeAdmin(
      {
        deal_steps: [{ data: stepRow, error: null }],
        deals: [{ data: dealRow, error: null }],
        users: [{ data: actorRow, error: null }],
      },
      { data: { step: { ...stepRow, status: 'complete' }, currentStepId: "next-step" }, error: null },
    );
    signedIn(admin);
    vi.mocked(stepHasUpload).mockResolvedValue(true);

    const res = await PATCH(patch({ work: completeWork(), complete: true }), ctx);

    expect(res.status).toBe(200);
    // One transaction (#200): the step, its audit rows and the rail advance.
    expect(rpcCalls).toHaveLength(1);
    const { fn, args } = rpcCalls[0];
    expect(fn).toBe('deal_step_save');
    expect(args).toMatchObject({ p_step_id: 'ds-1', p_actor_id: 'u-1', p_advance: true });
    expect((args.p_patch as Record<string, unknown>).status).toBe('complete');
    expect((args.p_audits as Array<{ action: string }>).map((a) => a.action)).toEqual([
      'step_work',
      'complete_step',
    ]);
    // Nothing is written outside that transaction.
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('leaves the optional upload steps ungated', () => {
    // Step 38's own label reads '(optional)': gating it would be a
    // regression, not a fix.
    expect(MANUAL_STEP_DEFS['p3-s42'].requiresUpload).toBe(true);
    expect(MANUAL_STEP_DEFS['p3-s42'].uploadRequired).toBeUndefined();
  });
});

describe('legacy step PATCH against a step that left the rail', () => {
  it('refuses to complete a removed step instead of advancing the cursor', async () => {
    const { admin, rpcCalls } = makeAdmin({
      deal_steps: [{ data: { ...stepRow, removed_at: '2026-09-20T10:00:00Z' }, error: null }],
      deals: [{ data: dealRow, error: null }],
      users: [{ data: actorRow, error: null }],
    });
    signedIn(admin);
    vi.mocked(stepHasUpload).mockResolvedValue(true);

    const res = await PATCH(patch({ work: completeWork(), complete: true }), ctx);
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(409);
    expect(body.error).toBe('That step is not on this project rail');
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('concurrent work saves (#249)', () => {
  it('409s instead of overwriting work saved since the step was read', async () => {
    const { admin, rpcCalls } = makeAdmin(
      {
        deal_steps: [{ data: stepRow, error: null }],
        deals: [{ data: dealRow, error: null }],
        users: [{ data: actorRow, error: null }],
      },
      // The compare-and-set on updated_at no longer matched.
      { data: null, error: { code: 'P0409', message: 'step_changed' } },
    );
    signedIn(admin);

    const res = await PATCH(patch({ work: { notes: 'mine' } }), ctx);

    expect(res.status).toBe(409);
    expect(rpcCalls[0].args.p_expected_updated_at).toBe(stepRow.updated_at);
    // A work save never moves the rail.
    expect(rpcCalls[0].args.p_advance).toBe(false);
  });

  it('neither audits, notifies nor advances the rail when a completing save is refused', async () => {
    const { admin, inserts, updates } = makeAdmin(
      {
        deal_steps: [{ data: stepRow, error: null }],
        deals: [{ data: { ...dealRow, mandate_owner_id: 'md-other' }, error: null }],
        users: [{ data: actorRow, error: null }],
      },
      { data: null, error: { code: 'P0409', message: 'step_changed' } },
    );
    signedIn(admin);
    vi.mocked(stepHasUpload).mockResolvedValue(true);

    const res = await PATCH(patch({ work: completeWork(), complete: true }), ctx);

    expect(res.status).toBe(409);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(notifyStepCompleted).not.toHaveBeenCalled();
  });

  it('fails the request and notifies no one when the transaction is rejected (#200)', async () => {
    const { admin } = makeAdmin(
      {
        deal_steps: [{ data: stepRow, error: null }],
        deals: [{ data: { ...dealRow, mandate_owner_id: 'md-other' }, error: null }],
        users: [{ data: actorRow, error: null }],
      },
      // e.g. an audit_log insert refused inside deal_step_save: all rolled back.
      { data: null, error: { code: '23514', message: 'audit rejected' } },
    );
    signedIn(admin);
    vi.mocked(stepHasUpload).mockResolvedValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await PATCH(patch({ work: completeWork(), complete: true }), ctx);

    expect(res.status).toBe(500);
    expect(notifyStepCompleted).not.toHaveBeenCalled();
  });

  it('notifies the MD only after the transaction commits', async () => {
    const { admin } = makeAdmin(
      {
        deal_steps: [{ data: stepRow, error: null }],
        deals: [{ data: { ...dealRow, mandate_owner_id: 'md-other' }, error: null }],
        users: [{ data: actorRow, error: null }],
      },
      { data: { step: { ...stepRow, status: 'complete' }, currentStepId: "next-step" }, error: null },
    );
    signedIn(admin);
    vi.mocked(stepHasUpload).mockResolvedValue(true);

    const res = await PATCH(patch({ work: completeWork(), complete: true }), ctx);

    expect(res.status).toBe(200);
    expect(notifyStepCompleted).toHaveBeenCalledTimes(1);
  });
  it('returns the committed step when the notification fails afterwards', async () => {
    const { admin } = makeAdmin(
      {
        deal_steps: [{ data: stepRow, error: null }],
        deals: [{ data: { ...dealRow, mandate_owner_id: 'md-other' }, error: null }],
        users: [{ data: actorRow, error: null }],
      },
      { data: { step: { ...stepRow, status: 'complete' }, currentStepId: "next-step" }, error: null },
    );
    signedIn(admin);
    vi.mocked(stepHasUpload).mockResolvedValue(true);
    vi.mocked(notifyStepCompleted).mockRejectedValueOnce(new Error('notifications down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await PATCH(patch({ work: completeWork(), complete: true }), ctx);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { step: { status: string } }).step.status).toBe('complete');
    expect(logged).toHaveBeenCalled();
  });
});

describe('client row version (#200)', () => {
  it("compares against the client's version when it sends one, and returns the new one", async () => {
    const clientVersion = '2026-09-29T09:00:00.000+00:00';
    const saved = { ...stepRow, updated_at: '2026-09-29T11:00:00.000+00:00' };
    const { admin, rpcCalls } = makeAdmin(
      {
        deal_steps: [{ data: stepRow, error: null }],
        deals: [{ data: dealRow, error: null }],
        users: [{ data: actorRow, error: null }],
      },
      { data: { step: saved, currentStepId: "ds-1" }, error: null },
    );
    signedIn(admin);

    const res = await PATCH(
      patch({ work: { notes: 'mine' }, expectedUpdatedAt: clientVersion }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(rpcCalls[0].args.p_expected_updated_at).toBe(clientVersion);
    expect(rpcCalls[0].args.p_advance).toBe(false);
    expect(((await res.json()) as { step: { updatedAt: string } }).step.updatedAt).toBe(
      saved.updated_at,
    );
  });

  it('rejects a version that is not a timestamp', async () => {
    const { admin, rpcCalls } = makeAdmin({});
    signedIn(admin);

    const res = await PATCH(patch({ work: { notes: 'mine' }, expectedUpdatedAt: 'yesterday' }), ctx);

    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });
});


describe('completion snapshot and authoritative cursor', () => {
  it('maps a P0409 through PATCH for completion without work or expectedUpdatedAt', async () => {
    const { admin, rpcCalls } = makeAdmin({
      deal_steps: [{ data: { ...stepRow, work: completeWork() }, error: null }],
      deals: [{ data: dealRow, error: null }], users: [{ data: actorRow, error: null }],
    }, { data: null, error: { code: 'P0409', message: 'step_changed' } });
    signedIn(admin);
    vi.mocked(stepHasUpload).mockResolvedValue(true);
    const res = await PATCH(patch({ complete: true }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('changed') });
    expect(rpcCalls[0].args.p_expected_updated_at).toBe(stepRow.updated_at);
    expect(notifyStepCompleted).not.toHaveBeenCalled();
  });

  it('returns the cursor captured by the save transaction', async () => {
    const { admin } = makeAdmin({
      deal_steps: [{ data: { ...stepRow, work: completeWork() }, error: null }],
      deals: [{ data: dealRow, error: null }], users: [{ data: actorRow, error: null }],
    }, { data: { step: { ...stepRow, status: 'complete' }, currentStepId: 'server-next' }, error: null });
    signedIn(admin);
    vi.mocked(stepHasUpload).mockResolvedValue(true);
    const res = await PATCH(patch({ complete: true }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ step: { status: 'complete' }, currentStepId: 'server-next' });
  });
});
