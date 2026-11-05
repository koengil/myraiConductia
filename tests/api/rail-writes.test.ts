import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GATE0_STEP_IDS } from '@/lib/rail/gate0';

const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const APPROVER = '00000000-0000-4000-8000-0000000000a2';

const state = {
  capable: true as boolean | 'unreadable',
  canComplete: true as boolean | 'unreadable',
  canAccess: true,
  stepRow: { assigned_to: ACTOR, status: 'current' } as Record<string, unknown> | null,
  rpcError: null as { code: string; message: string } | null,
  rpcData: { currentStepId: 'step-b', removed: true } as unknown,
  rpcCalls: [] as { name: string; params: Record<string, unknown> }[],
  // The approver's seat read (resolveSkipApprover), keyed off deal_memberships.
  seat: { deal_role: 'deal_team', user: { status: 'active', display_name: 'Avery Lindqvist' } } as unknown,
  seatError: null as { message: string } | null,
  seatUserIds: [] as unknown[],
};

vi.mock('@/lib/api/v1/access', () => ({
  resolveDealStepStructureCapability: async () => state.capable,
  resolveDealStepCapabilities: async () =>
    state.canComplete === 'unreadable'
      ? 'unreadable'
      : { canAssign: false, canComplete: state.canComplete, canEditWork: true },
  userCanAccessDeal: async () => state.canAccess,
}));

vi.mock('@/lib/dataroom/steps', () => ({
  loadDealByIdOrCode: async () => ({ id: 'deal-1', code: 'ATLAS-2026-001' }),
}));

vi.mock('@/lib/api/v1/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: async () => ({
    ok: true,
    user: { id: ACTOR },
    admin: {
      rpc: async (name: string, params: Record<string, unknown>) => {
        state.rpcCalls.push({ name, params });
        return { data: state.rpcData, error: state.rpcError };
      },
      from: (table: string) => {
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        builder.select = chain;
        builder.eq = (column: string, value: unknown) => {
          if (table === 'deal_memberships' && column === 'user_id') state.seatUserIds.push(value);
          return builder;
        };
        builder.maybeSingle = () =>
          Promise.resolve(
            table === 'deal_memberships'
              ? { data: state.seat, error: state.seatError }
              : { data: state.stepRow, error: null },
          );
        return builder;
      },
    },
  }),
}));

async function remove() {
  const { DELETE } = await import('@/app/api/v1/deals/[dealId]/rail/steps/[stepId]/route');
  return DELETE(new Request('http://localhost', { method: 'DELETE' }), {
    params: Promise.resolve({ dealId: 'deal-1', stepId: 'step-a' }),
  });
}

async function restore() {
  const { POST } = await import('@/app/api/v1/deals/[dealId]/rail/steps/[stepId]/restore/route');
  return POST(new Request('http://localhost', { method: 'POST' }), {
    params: Promise.resolve({ dealId: 'deal-1', stepId: 'step-a' }),
  });
}

async function skip(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/v1/deals/[dealId]/rail/steps/[stepId]/skip/route');
  return POST(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ dealId: 'deal-1', stepId: 'step-a' }) },
  );
}

describe('rail write routes', () => {
  beforeEach(() => {
    state.capable = true;
    state.canComplete = true;
    state.canAccess = true;
    state.stepRow = { assigned_to: ACTOR, status: 'current' };
    state.rpcError = null;
    state.rpcData = { currentStepId: 'step-b', removed: true };
    state.rpcCalls = [];
    state.seat = { deal_role: 'deal_team', user: { status: 'active', display_name: 'Avery Lindqvist' } };
    state.seatError = null;
    state.seatUserIds = [];
    vi.resetModules();
  });

  it('refuses a caller without the structure permission', async () => {
    state.capable = false;
    expect((await remove()).status).toBe(403);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('surfaces a permission lookup failure as a server error', async () => {
    state.capable = 'unreadable';
    expect((await remove()).status).toBe(500);
  });

  it('answers a remove from a caller with the structure permission but no deal access as a missing deal', async () => {
    state.canAccess = false;
    const response = await remove();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Deal not found' });
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('passes the protected step ids through to the remove function', async () => {
    await remove();
    const protectedIds = state.rpcCalls[0].params.p_protected_ids as string[];
    expect(protectedIds).toEqual(expect.arrayContaining([...GATE0_STEP_IDS]));
  });

  it('maps a completed-step removal to a conflict', async () => {
    state.rpcError = { code: 'P0003', message: 'step_complete' };
    const response = await remove();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/completed/i);
  });

  it('maps a protected-step removal to a conflict', async () => {
    state.rpcError = { code: 'P0004', message: 'step_protected' };
    const response = await remove();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/required/i);
  });

  it('returns the function result unchanged on success', async () => {
    const response = await remove();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ currentStepId: 'step-b', removed: true });
  });

  it('refuses a restore from a caller without the structure permission', async () => {
    state.capable = false;
    expect((await restore()).status).toBe(403);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('returns the restore function result unchanged on success', async () => {
    state.rpcData = { restored: true };
    const response = await restore();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ restored: true });
  });

  it('lets a member who can complete the step skip it without structure authority', async () => {
    state.capable = false;
    state.rpcData = { currentStepId: 'step-c' };
    const response = await skip({ approverId: APPROVER, reason: 'Handled off platform' });
    expect(response.status).toBe(200);
    expect(state.rpcCalls).toHaveLength(1);
    expect((await remove()).status).toBe(403);
  });

  it('refuses a skip from a caller who cannot complete the step', async () => {
    state.canComplete = false;
    const response = await skip({ approverId: APPROVER, reason: 'Handled off platform' });
    expect(response.status).toBe(403);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('refuses a skip on a step that is not on the deal', async () => {
    state.stepRow = null;
    const response = await skip({ approverId: APPROVER, reason: 'Handled off platform' });
    expect(response.status).toBe(404);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('rejects a skip with a blank reason before calling the function', async () => {
    const response = await skip({ approverId: APPROVER, reason: '   ' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/reason/i);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('skips through rail_skip_step with the verified approver id', async () => {
    const response = await skip({ approverId: APPROVER, reason: 'Handled off platform' });
    expect(response.status).toBe(200);
    expect(state.seatUserIds).toEqual([APPROVER]);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].name).toBe('rail_skip_step');
    expect(state.rpcCalls[0].params).toMatchObject({
      p_deal_id: 'deal-1',
      p_actor_id: ACTOR,
      p_step_id: 'step-a',
      p_approver_id: APPROVER,
      p_reason: 'Handled off platform',
    });
  });

  it('takes the actor as approver when the body names none', async () => {
    const response = await skip({ reason: 'Handled off platform' });
    expect(response.status).toBe(200);
    expect(state.seatUserIds).toEqual([ACTOR]);
    expect(state.rpcCalls[0].params.p_approver_id).toBe(ACTOR);
  });

  it.each([
    ['a seat outside the approver roles', { deal_role: 'read_only', user: { status: 'active' } }],
    ['a suspended approver', { deal_role: 'md', user: { status: 'suspended' } }],
    ['no seat on the deal', null],
  ])('refuses %s with a 400 before calling the function', async (_label, seat) => {
    state.seat = seat;
    const response = await skip({ approverId: APPROVER, reason: 'Handled off platform' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      'The approver must hold an active, eligible seat on this deal',
    );
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('refuses a malformed approver id with a 400 before calling the function', async () => {
    const response = await skip({ approverId: 'Avery Lindqvist', reason: 'Handled off platform' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('skip.approverId must be a user id');
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('answers a failed approver seat read with a 500 before calling the function', async () => {
    state.seatError = { message: 'boom' };
    const response = await skip({ approverId: APPROVER, reason: 'Handled off platform' });
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe('Approver lookup failed');
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('maps a completed-step skip to a conflict', async () => {
    state.rpcError = { code: 'P0003', message: 'step_complete' };
    const response = await skip({ approverId: APPROVER, reason: 'Handled off platform' });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/completed/i);
  });

  it('maps a raised P0001 skip error to a bad request', async () => {
    state.rpcError = { code: 'P0001', message: 'An approver is required' };
    const response = await skip({ approverId: APPROVER, reason: 'Handled off platform' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('An approver is required');
  });

  it('maps a database refusal of the approver to the same 400 as the check', async () => {
    state.rpcError = { code: '42501', message: 'skip_approver_ineligible' };
    const response = await skip({ approverId: APPROVER, reason: 'Handled off platform' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'The approver must hold an active, eligible seat on this deal',
    });
  });

  it('maps a deadlock abort (40P01) to a retryable 409 with a fixed code and no database text', async () => {
    const message = 'deadlock detected: Process 4242 waits for ShareLock on transaction 99';
    state.rpcError = { code: '40P01', message };
    const response = await skip({ approverId: APPROVER, reason: 'Handled off platform' });
    expect(response.status).toBe(409);
    expect(response.headers.get('Retry-After')).toBe('1');
    const body = await response.json();
    expect(body).toEqual({
      error: 'The skip met a concurrent change and was not recorded. Send it again.',
      code: 'skip_retry',
    });
    expect(JSON.stringify(body)).not.toContain(message);
  });

  it.each([
    ['a grant error', '42501', 'permission denied for function rail_skip_approver'],
    ['a stray skip audit', '42501', 'skip_audit_without_skip'],
    ['any other database error', 'XX000', 'internal error near deal_steps'],
  ])('keeps %s a 500 without echoing the database text', async (_label, code, message) => {
    state.rpcError = { code, message };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await skip({ approverId: APPROVER, reason: 'Handled off platform' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'The skip could not be recorded' });
    expect(JSON.stringify(spy.mock.calls)).not.toContain(message);
    spy.mockRestore();
  });

  it('returns the skip function result unchanged on success', async () => {
    state.rpcData = { currentStepId: 'step-c' };
    const response = await skip({ approverId: APPROVER, reason: 'Handled off platform' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ currentStepId: 'step-c' });
  });
});
