import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SKILL_SERVICE_UNAVAILABLE_MESSAGE } from '@/lib/ignatious/failure';

const AVAILABLE = { kind: 'mount', name: 'demo', version: 3, digest: 'd'.repeat(64) } as const;

const STEP_ID = 'p1-s9';
const DEAL_STEP_ID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const CURRENT_SKILL_ID = '2d362e20-0709-4ba0-bbd7-d21831148282';
const CURRENT_VERSION_ID = '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6';
const OTHER_SKILL_ID = '2d362e20-0709-4ba0-bbd7-d21831148283';

type Capabilities = { canAssign: boolean; canComplete: boolean; canEditWork: boolean };

function step(overrides: Record<string, unknown> = {}) {
  return {
    id: DEAL_STEP_ID,
    step_id: STEP_ID,
    origin: 'rail',
    removed_at: null,
    work: { primary: 'Draft the briefing' },
    definition: null,
    assigned_to: null,
    status: 'pending',
    ...overrides,
  };
}

const state = {
  wall: 'internal' as 'internal' | 'external' | 'error',
  capabilities: { canAssign: false, canComplete: true, canEditWork: true } as
    | Capabilities
    | 'unreadable',
  step: step() as Record<string, unknown> | null,
  binding: null as Record<string, unknown> | null,
  current: null as Record<string, unknown> | null,
  project: [] as unknown[],
  projectUnavailableReason: null as string | null,
  catalog: [
    {
      reference: AVAILABLE,
      label: 'v3',
      authorName: null,
      createdAt: null,
      available: true,
      unavailableReason: null,
    },
  ] as unknown[],
  rpcError: null as { message: string } | null,
  versionsError: null as Error | null,
};

vi.mock('@/lib/flags/requireFlag', () => ({ requireFlag: async () => null }));

vi.mock('@/lib/dataroom/steps', () => ({
  loadDealByIdOrCode: async () => ({ id: 'deal-1', code: 'ATLAS-2026-001' }),
}));

vi.mock('@/lib/api/v1/access', () => ({
  userCanAccessDeal: async () => true,
  classifyInternalUser: async () => state.wall,
  resolveDealStepCapabilities: async () => state.capabilities,
}));

vi.mock('@/lib/skillRun/versions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skillRun/versions')>()),
  readStepVersions: async () => {
    if (state.versionsError) throw state.versionsError;
    return {
      current: state.current,
      project: state.project,
      projectUnavailableReason: state.projectUnavailableReason,
      catalog: state.catalog,
    };
  },
}));

const rpc = vi.fn(async () => ({ data: null, error: state.rpcError }));

function builderFor(table: string) {
  if (table === 'deal_steps') {
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: state.step, error: null }) }),
        }),
      }),
    };
  }
  throw new Error(`Unexpected table ${table}`);
}

vi.mock('@/lib/api/v1/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: async () => ({
    ok: true,
    user: { id: 'user-1', email: 'md@example.test' },
    admin: { from: (table: string) => builderFor(table), rpc },
  }),
}));

async function put(overrides: { capabilities?: Capabilities; reference: unknown }) {
  if (overrides.capabilities) state.capabilities = overrides.capabilities;
  const { PUT } = await import('@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-binding/route');
  return PUT(
    new Request('http://localhost', {
      method: 'PUT',
      body: JSON.stringify({ reference: overrides.reference }),
    }),
    { params: Promise.resolve({ dealId: 'deal-1', stepId: STEP_ID }) },
  );
}

async function putCapturingRpc(overrides: { reference: unknown }) {
  const response = await put(overrides);
  return { response, rpc };
}

describe('PUT skill-binding', () => {
  beforeEach(() => {
    state.wall = 'internal';
    state.capabilities = { canAssign: false, canComplete: true, canEditWork: true };
    state.step = step();
    state.binding = null;
    state.current = null;
    state.project = [];
    state.projectUnavailableReason = null;
    state.catalog = [
      {
        reference: AVAILABLE,
        label: 'v3',
        authorName: null,
        createdAt: null,
        available: true,
        unavailableReason: null,
      },
    ];
    state.rpcError = null;
    state.versionsError = null;
    rpc.mockClear();
    vi.resetModules();
  });

  it("refuses a user who cannot edit the step's work", async () => {
    const response = await put({ capabilities: { canAssign: false, canComplete: true, canEditWork: false }, reference: AVAILABLE });
    expect(response.status).toBe(403);
  });

  it('refuses a version that is not available for this step', async () => {
    const response = await put({
      reference: { kind: 'mount', name: 'other', version: 9, digest: 'e'.repeat(64) },
    });
    expect(response.status).toBe(422);
  });

  it('refuses an older repo-seeded catalog version with the reason the picker showed', async () => {
    const older = { kind: 'mount', name: 'demo', version: 1, digest: 'f'.repeat(64) } as const;
    state.catalog = [
      ...state.catalog,
      {
        reference: older,
        label: 'v1',
        authorName: 'repo',
        createdAt: '2026-08-01T00:00:00Z',
        available: false,
        unavailableReason:
          'This catalog version shipped with a deployment that is gone, so its bytes are not here.',
      },
    ];

    const response = await put({ reference: older });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error:
        'This catalog version shipped with a deployment that is gone, so its bytes are not here.',
    });
  });

  it('refuses a body that is not a skill reference', async () => {
    const response = await put({ reference: { kind: 'nonsense' } });
    expect(response.status).toBe(422);
  });

  it('rebinds the step and answers with the new binding', async () => {
    const { response, rpc: rpcSpy } = await putCapturingRpc({ reference: AVAILABLE });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ binding: AVAILABLE });
    expect(rpcSpy).toHaveBeenCalledWith(
      'rail_rebind_step',
      expect.objectContaining({ p_reference: AVAILABLE, p_source: 'selection' }),
    );
  });

  it('refuses a reference naming the same skill as the unreadable lineage with 502', async () => {
    state.current = {
      kind: 'publication',
      skillId: CURRENT_SKILL_ID,
      versionId: CURRENT_VERSION_ID,
      digest: 'c'.repeat(64),
    };
    state.projectUnavailableReason = "This project's skill version history could not be read.";
    const sameSkillRef = {
      kind: 'publication',
      skillId: CURRENT_SKILL_ID,
      versionId: '11111111-1111-4111-8111-111111111111',
      digest: 'a'.repeat(64),
    };

    const response = await put({ reference: sameSkillRef });
    expect(response.status).toBe(502);
  });

  it('refuses a reference naming a different skill than the unreadable lineage with 422', async () => {
    state.current = {
      kind: 'publication',
      skillId: CURRENT_SKILL_ID,
      versionId: CURRENT_VERSION_ID,
      digest: 'c'.repeat(64),
    };
    state.projectUnavailableReason = "This project's skill version history could not be read.";
    const differentSkillRef = {
      kind: 'publication',
      skillId: OTHER_SKILL_ID,
      versionId: '22222222-2222-4222-8222-222222222222',
      digest: 'b'.repeat(64),
    };

    const response = await put({ reference: differentSkillRef });
    expect(response.status).toBe(422);
  });

  it('surfaces a bench outage as the standard skill-service error response', async () => {
    const { IgnatiousRequestError } = await import('@/lib/ignatious/control-plane');
    state.versionsError = new IgnatiousRequestError(503, 'Bench unreachable');

    const response = await put({ reference: AVAILABLE });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: SKILL_SERVICE_UNAVAILABLE_MESSAGE });
  });
});
