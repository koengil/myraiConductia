import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  internal: 'internal' as 'internal' | 'external' | 'error',
  canAccess: true,
  canEditStructure: true as boolean | 'unreadable',
  canSaveTemplate: true as boolean | null,
  dealRow: { current_deal_step_id: 'step-a', bank_id: 'bank-1' } as {
    current_deal_step_id: string | null;
    bank_id: string;
  },
  rows: [] as Record<string, unknown>[],
};

vi.mock('@/lib/api/v1/access', () => ({
  classifyInternalUser: async () => state.internal,
  userCanAccessDeal: async () => state.canAccess,
  resolveDealStepStructureCapability: async () => state.canEditStructure,
}));

vi.mock('@/lib/dataroom/steps', () => ({
  loadDealByIdOrCode: async () => ({ id: 'deal-1', code: 'ATLAS-2026-001' }),
}));

vi.mock('@/lib/api/v1/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: async () => ({
    ok: true,
    user: { id: 'user-1' },
    admin: {
      rpc: async () => ({ data: state.canSaveTemplate, error: null }),
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: state.dealRow, error: null }),
            order: async () => ({ data: state.rows, error: null }),
          }),
        }),
      }),
    },
  }),
}));

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'step-a',
    step_id: 'p1-s7',
    seq: 7,
    status: 'current',
    census_version: 'hv-5x65-2026-07-08',
    phase_index: 1,
    display_order: 1,
    anchor_step_id: null,
    origin: 'catalog',
    definition: null,
    removed_at: null,
    removed_by: null,
    removed_by_user: null,
    skipped_at: null,
    skipped_by: null,
    skipped_by_user: null,
    skip_approver_id: null,
    skip_approver_user: null,
    skip_reason: null,
    assigned_to: null,
    completed_at: null,
    completed_by_user: null,
    work_skip: null,
    ...overrides,
  };
}

async function get() {
  const { GET } = await import('@/app/api/v1/deals/[dealId]/rail/route');
  return GET(new Request('http://localhost/api/v1/deals/deal-1/rail'), {
    params: Promise.resolve({ dealId: 'deal-1' }),
  });
}

describe('GET /api/v1/deals/:dealId/rail', () => {
  beforeEach(() => {
    state.internal = 'internal';
    state.canAccess = true;
    state.canEditStructure = true;
    state.canSaveTemplate = true;
    state.dealRow = { current_deal_step_id: 'step-a', bank_id: 'bank-1' };
    state.rows = [row(), row({ id: 'step-b', step_id: 'p1-s8', seq: 8, display_order: 2 })];
    vi.resetModules();
  });

  it('returns every step with the current step', async () => {
    const body = await (await get()).json();
    expect(body.currentStepId).toBe('step-a');
    expect(body.steps.map((step: { id: string }) => step.id)).toEqual(['step-a', 'step-b']);
  });

  it('includes removed steps, carrying removedAt', async () => {
    state.rows = [
      row(),
      row({ id: 'step-b', step_id: 'p1-s8', display_order: 2, removed_at: '2026-09-09T10:00:00Z' }),
    ];
    const body = await (await get()).json();
    expect(body.steps).toHaveLength(2);
    expect(body.steps[1].removedAt).toBe('2026-09-09T10:00:00Z');
  });

  it('resolves removedBy to an object with the resolved display name', async () => {
    state.rows = [
      row({
        removed_at: '2026-09-09T10:00:00Z',
        removed_by: 'user-2',
        removed_by_user: {
          id: 'user-2',
          display_name: 'Jamie Chen',
          full_name: null,
          email: 'jamie@example.com',
        },
      }),
    ];
    const body = await (await get()).json();
    expect(body.steps[0].removedBy).toEqual({ id: 'user-2', name: 'Jamie Chen' });
  });

  it('reports removedBy as null when the step was never removed', async () => {
    const body = await (await get()).json();
    expect(body.steps[0].removedBy).toBeNull();
  });

  it('maps a skipped step into a skip object, falling back to Banker without a joined user', async () => {
    state.rows = [
      row({
        status: 'skipped',
        skipped_at: '2026-09-09T10:00:00Z',
        skipped_by: 'user-2',
        skip_approver_id: 'user-3',
        skip_reason: 'Handled off platform',
        work_skip: { approverId: 'user-3' },
      }),
    ];
    const body = await (await get()).json();
    expect(body.steps[0].skip).toEqual({
      at: '2026-09-09T10:00:00Z',
      by: 'Banker',
      approver: 'Banker',
      reason: 'Handled off platform',
      approverVerified: true,
    });
  });

  it('resolves the skip approver and actor to their display names, not raw ids', async () => {
    state.rows = [
      row({
        status: 'skipped',
        skipped_at: '2026-09-09T10:00:00Z',
        skipped_by: 'user-2',
        skipped_by_user: {
          id: 'user-2',
          display_name: 'Storm Duncan',
          full_name: null,
          email: 'storm@example.com',
        },
        skip_approver_id: 'user-3',
        skip_approver_user: {
          id: 'user-3',
          display_name: 'Avery Lindqvist',
          full_name: null,
          email: 'avery@example.com',
        },
        skip_reason: 'Handled off platform',
        work_skip: { approverId: 'user-3', approver: 'Avery Lindqvist' },
      }),
    ];
    const body = await (await get()).json();
    expect(body.steps[0].skip).toEqual({
      at: '2026-09-09T10:00:00Z',
      by: 'Storm Duncan',
      approver: 'Avery Lindqvist',
      reason: 'Handled off platform',
      approverVerified: true,
    });
  });

  describe('skips logged before the database wrote the skip columns', () => {
    const completer = {
      id: 'user-2',
      display_name: 'Storm Duncan',
      full_name: null,
      email: 'storm@example.com',
    };

    function legacyRow(legacySkip: unknown, overrides: Record<string, unknown> = {}) {
      return row({
        status: 'skipped',
        skipped_at: null,
        completed_at: '2026-09-01T09:00:00Z',
        completed_by_user: completer,
        work_skip: legacySkip,
        ...overrides,
      });
    }

    it('shows the recorded skip as unverified, naming the completer and the recorded text', async () => {
      state.rows = [
        legacyRow({
          approver: 'Jordan Reyes',
          approverRole: 'md',
          reason: 'Client supplied their own teaser',
          at: '2026-09-01T09:00:00.000Z',
        }),
      ];
      const body = await (await get()).json();
      expect(body.steps[0].skip).toEqual({
        at: '2026-09-01T09:00:00.000Z',
        by: 'Storm Duncan',
        approver: 'Jordan Reyes',
        reason: 'Client supplied their own teaser',
        approverVerified: false,
      });
    });

    it('caps an oversized approver and reason at 120 and 2000 characters', async () => {
      state.rows = [
        legacyRow({ approver: 'A'.repeat(10_000), reason: 'R'.repeat(10_000), at: '2026-09-01T09:00:00Z' }),
      ];
      const { skip } = (await (await get()).json()).steps[0];
      expect(skip.approver).toHaveLength(120);
      expect(skip.reason).toHaveLength(2000);
      expect(skip.approverVerified).toBe(false);
    });

    it('falls back to completed_at when the recorded at is not an ISO timestamp', async () => {
      for (const at of ['yesterday', '10', 20260901, null, { nested: true }]) {
        state.rows = [legacyRow({ approver: 'Jordan Reyes', reason: 'Off platform', at })];
        const { skip } = (await (await get()).json()).steps[0];
        expect(skip.at).toBe('2026-09-01T09:00:00Z');
      }
    });

    it('shows an empty string for a non-string approver or reason, and Banker without a completer', async () => {
      state.rows = [
        legacyRow({ approver: { name: 'x' }, reason: 42, at: '2026-09-01T09:00:00Z' }, { completed_by_user: null }),
      ];
      const { skip } = (await (await get()).json()).steps[0];
      expect(skip).toMatchObject({ approver: '', reason: '', by: 'Banker', approverVerified: false });
    });

    it('returns no other work key and no raw work object', async () => {
      state.rows = [
        legacyRow({ approver: 'Jordan Reyes', reason: 'Off platform', at: '2026-09-01T09:00:00Z', secret: 'x' }),
      ];
      const step = (await (await get()).json()).steps[0];
      expect(Object.keys(step)).not.toContain('work');
      expect(Object.keys(step)).not.toContain('work_skip');
      expect(Object.keys(step.skip).sort()).toEqual(['approver', 'approverVerified', 'at', 'by', 'reason']);
    });

    it('does not invent a skip for a step that is not skipped, or whose work.skip is not an object', async () => {
      state.rows = [
        legacyRow({ approver: 'Jordan Reyes', reason: 'Off platform' }, { status: 'completed' }),
        legacyRow('Jordan Reyes', { id: 'step-b' }),
        legacyRow(['x'], { id: 'step-c' }),
        legacyRow(null, { id: 'step-d' }),
      ];
      const body = await (await get()).json();
      expect(body.steps.map((step: { skip: unknown }) => step.skip)).toEqual([null, null, null, null]);
    });

    it('prefers the column-backed skip over work.skip and marks it verified', async () => {
      state.rows = [
        legacyRow(
          { approverId: 'user-3', approver: 'Typed Name', reason: 'Typed reason' },
          {
            skipped_at: '2026-09-09T10:00:00Z',
            skip_approver_id: 'user-3',
            skip_reason: 'Column reason',
            skip_approver_user: { id: 'user-3', display_name: 'Avery Lindqvist', full_name: null, email: 'a@example.com' },
          },
        ),
      ];
      const { skip } = (await (await get()).json()).steps[0];
      expect(skip).toMatchObject({ approver: 'Avery Lindqvist', reason: 'Column reason', approverVerified: true });
    });
  });

  describe('column-backed skips: verified only when the database checked the approver', () => {
    const approverUser = { id: 'user-3', display_name: 'Avery Lindqvist', full_name: null, email: 'a@example.com' };

    function columnRow(workSkip: unknown, overrides: Record<string, unknown> = {}) {
      return row({
        status: 'skipped',
        skipped_at: '2026-09-09T10:00:00Z',
        skipped_by: 'user-2',
        skip_approver_id: 'aaaaaaaa-0000-4000-8000-000000000003',
        skip_approver_user: approverUser,
        skip_reason: 'Handled off platform',
        work_skip: workSkip,
        ...overrides,
      });
    }

    it('marks a skip verified when work.skip.approverId matches skip_approver_id, in any case', async () => {
      state.rows = [
        columnRow({ approverId: 'aaaaaaaa-0000-4000-8000-000000000003' }),
        columnRow({ approverId: 'AAAAAAAA-0000-4000-8000-000000000003' }, { id: 'step-b' }),
      ];
      const body = await (await get()).json();
      expect(body.steps.map((step: { skip: { approverVerified: boolean } }) => step.skip.approverVerified)).toEqual([
        true,
        true,
      ]);
    });

    it('marks a rail-model skip written before #312 (no approverId) as unverified, keeping the joined name', async () => {
      state.rows = [columnRow({ approver: 'Avery Lindqvist', approverRole: 'md', reason: 'Handled off platform' })];
      const { skip } = (await (await get()).json()).steps[0];
      expect(skip).toEqual({
        at: '2026-09-09T10:00:00Z',
        by: 'Banker',
        approver: 'Avery Lindqvist',
        reason: 'Handled off platform',
        approverVerified: false,
      });
    });

    it('marks a skip unverified when work.skip is missing, not an object, or names another approver', async () => {
      state.rows = [
        columnRow(null),
        columnRow(['aaaaaaaa-0000-4000-8000-000000000003'], { id: 'step-b' }),
        columnRow({ approverId: 'bbbbbbbb-0000-4000-8000-000000000009' }, { id: 'step-c' }),
        columnRow({ approverId: 42 }, { id: 'step-d' }),
        columnRow({ approverId: 'aaaaaaaa-0000-4000-8000-000000000003' }, { id: 'step-e', skip_approver_id: null }),
      ];
      const body = await (await get()).json();
      expect(body.steps.map((step: { skip: { approverVerified: boolean } }) => step.skip.approverVerified)).toEqual([
        false,
        false,
        false,
        false,
        false,
      ]);
    });
  });

  it('returns a null currentStepId rather than an error when there is no current step', async () => {
    state.dealRow = { current_deal_step_id: null, bank_id: 'bank-1' };
    const response = await get();
    expect(response.status).toBe(200);
    expect((await response.json()).currentStepId).toBeNull();
  });

  it('reports whether the caller may change the rail structure', async () => {
    state.canEditStructure = false;
    const body = await (await get()).json();
    expect(body.canEditStructure).toBe(false);
  });

  it('reports whether the caller may save the rail as a template', async () => {
    state.canSaveTemplate = false;
    const body = await (await get()).json();
    expect(body.canSaveTemplate).toBe(false);
  });

  it('answers 500 when the template permission cannot be read', async () => {
    state.canSaveTemplate = null;
    expect((await get()).status).toBe(500);
  });

  it('refuses a caller who is not internal', async () => {
    state.internal = 'external';
    expect((await get()).status).toBe(403);
  });

  it('answers a caller who cannot access the deal as if it did not exist', async () => {
    state.canAccess = false;
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Deal not found' });
  });
});
