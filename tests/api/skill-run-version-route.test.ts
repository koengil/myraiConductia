import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeAdmin, type FakeAdmin } from '../helpers/skillRunAdmin';

const DEAL_STEP_ID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const STEP_KEY = 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6';
const ROOT_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';
const SECOND_ID = '4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a';
const FAILED_ID = '5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b';

const state = {
  flags: { skill_authoring: true, skill_output_revisions: true } as Record<string, boolean>,
  wall: 'internal' as 'internal' | 'external',
  store: null as FakeAdmin | null,
};

vi.mock('@/lib/flags/requireFlag', () => ({
  requireFlag: async (key: string) =>
    state.flags[key] ? null : new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
}));
vi.mock('@/lib/dataroom/steps', () => ({
  loadDealByIdOrCode: async () => ({ id: 'deal-1', code: 'ATLAS-2026-001' }),
}));
vi.mock('@/lib/api/v1/access', () => ({
  userCanAccessDeal: async () => true,
  classifyInternalUser: async () => state.wall,
  resolveDealStepCapabilities: async () => ({ canAssign: false, canComplete: true, canEditWork: true }),
}));
vi.mock('@/lib/api/v1/http', async (original) => ({
  ...(await original<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: async () => ({
    ok: true,
    user: { id: 'user-1', email: 'md@example.test', companyId: null },
    admin: state.store?.admin,
  }),
}));

function seed(): FakeAdmin {
  return fakeAdmin({
    deal_steps: [
      { id: DEAL_STEP_ID, deal_id: 'deal-1', step_id: STEP_KEY, removed_at: null, definition: { title: 'Weekly update' }, assigned_to: null, status: 'pending' },
    ],
    deal_step_skill_runs: [
      { id: ROOT_ID, deal_step_id: DEAL_STEP_ID, source: 'execution', outcome: 'succeeded', result_text: 'First output.', created_at: '2026-10-13T09:00:00.000Z' },
      { id: SECOND_ID, deal_step_id: DEAL_STEP_ID, source: 'revision', outcome: 'succeeded', result_text: 'Second output.', parent_run_id: ROOT_ID, root_run_id: ROOT_ID, inputs: { kind: 'edits', edits: [] }, actor_id: 'user-1', created_at: '2026-10-13T09:01:00.000Z' },
      { id: FAILED_ID, deal_step_id: DEAL_STEP_ID, source: 'revision', outcome: 'failed', result_text: null, parent_run_id: SECOND_ID, root_run_id: ROOT_ID, inputs: { kind: 'edits', edits: [] }, actor_id: 'user-1', created_at: '2026-10-13T09:02:00.000Z' },
    ],
  });
}

async function read(revisionId: string, runId: string = ROOT_ID) {
  const { GET } = await import(
    '@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/[revisionId]/route'
  );
  return GET(new Request('http://localhost'), {
    params: Promise.resolve({ dealId: 'deal-1', stepId: STEP_KEY, runId, revisionId }),
  });
}

describe('GET one version of a run output', () => {
  beforeEach(() => {
    state.flags = { skill_authoring: true, skill_output_revisions: true };
    state.wall = 'internal';
    state.store = seed();
    vi.resetModules();
  });

  it('returns the text of the run itself and of a later version', async () => {
    expect(await (await read(ROOT_ID)).json()).toEqual({ id: ROOT_ID, text: 'First output.' });
    expect(await (await read(SECOND_ID)).json()).toEqual({ id: SECOND_ID, text: 'Second output.' });
  });

  it('answers 404 for a failed attempt, which is not a version', async () => {
    expect((await read(FAILED_ID)).status).toBe(404);
  });

  it('answers 404 while the flag is off', async () => {
    state.flags.skill_output_revisions = false;

    expect((await read(ROOT_ID)).status).toBe(404);
  });

  it('answers 500 when the chain cannot be read', async () => {
    state.store?.failReadsFrom.add('deal_step_skill_runs:many');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await read(ROOT_ID);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'The version could not be read' });
    log.mockRestore();
  });

  it('refuses a reader outside the firm', async () => {
    state.wall = 'external';

    expect((await read(ROOT_ID)).status).toBe(403);
  });
});
