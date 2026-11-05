import { beforeEach, describe, expect, it, vi } from 'vitest';

const BINDING = {
  skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
  versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
  digest: 'a'.repeat(64),
};

const RUN_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';
const STEP_ID = 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6';
const DEAL_STEP_ID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const RAIL_STEP_ID = 'p2-s36';
const RAIL_DEAL_STEP_ID = '1c1c1c1c-1c1c-4c1c-8c1c-1c1c1c1c1c1c';

function railStep(overrides: Record<string, unknown> = {}) {
  return {
    id: RAIL_DEAL_STEP_ID,
    step_id: RAIL_STEP_ID,
    origin: 'rail',
    removed_at: null,
    work: { primary: 'Draft the memo' },
    definition: null,
    assigned_to: null,
    status: 'pending',
    ...overrides,
  };
}

function benchSkill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'weekly-memo',
    origin: 'repo',
    tag: { stageId: 'phase-2', applicationId: 'seq-36' },
    status: 'ok',
    reason: null,
    description: null,
    version: 5,
    model: null,
    modelFrom: 'seed',
    maxModel: null,
    maxEffort: null,
    routingFrom: 'seed',
    tester: null,
    testStatus: 'untested',
    enabled: true,
    sizeBytes: null,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  };
}

type Capabilities = { canAssign: boolean; canComplete: boolean; canEditWork: boolean };

function step(overrides: Record<string, unknown> = {}) {
  return {
    id: DEAL_STEP_ID,
    step_id: STEP_ID,
    origin: 'custom',
    removed_at: null,
    work: { primary: 'Summarise the week' },
    definition: {
      schemaVersion: 1,
      type: 'skill',
      title: 'Weekly project update',
      description: 'Prepare a concise update.',
      inputs: [
        {
          key: 'primary',
          kind: 'text',
          label: 'Input',
          helperText: 'What to emphasise.',
          required: true,
        },
      ],
      skillBinding: BINDING,
    },
    assigned_to: null,
    status: 'pending',
    ...overrides,
  };
}

function storedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    outcome: 'succeeded',
    input: 'Short',
    inputs: { asOf: '2026-09-30' },
    result_text: 'Here is the update.',
    error_message: null,
    actor_id: 'user-1',
    skill_id: BINDING.skillId,
    version_id: BINDING.versionId,
    digest: BINDING.digest,
    cost_usd: 0.12,
    started_at: null,
    created_at: '2026-09-14T10:00:00.000Z',
    ...overrides,
  };
}

function availableVersions() {
  return {
    current: null,
    project: [],
    projectUnavailableReason: null as string | null,
    catalog: [
      {
        reference: { kind: 'mount', name: 'demo', version: 3, digest: 'd'.repeat(64) },
        label: 'v3',
        authorName: null,
        createdAt: null,
        available: true,
        unavailableReason: null,
      },
    ],
  };
}

const state = {
  wall: 'internal' as 'internal' | 'external' | 'error',
  capabilities: { canAssign: false, canComplete: true, canEditWork: true } as
    | Capabilities
    | 'unreadable',
  step: step() as Record<string, unknown> | null,
  runs: [] as Record<string, unknown>[],
  revisions: [] as Record<string, unknown>[],
  revisionsError: null as { code: string; message: string } | null,
  teachings: [] as Record<string, unknown>[],
  teachingsError: null as { code: string; message: string } | null,
  teachingReads: 0,
  documents: [] as Record<string, unknown>[],
  inserted: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  insertError: null as { code: string; message: string } | null,
  queriedStepIds: [] as unknown[],
  documentDealIds: [] as unknown[],
  userLookups: [] as unknown[][],
  benchSkills: [] as Record<string, unknown>[],
  benchVersions: {} as Record<string, { current: number | null; versions: Record<string, unknown>[] }>,
  versions: availableVersions() as ReturnType<typeof availableVersions>,
  benchCalls: 0,
  binding: null as Record<string, unknown> | null,
};

vi.mock('@/lib/skillRun/versions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skillRun/versions')>()),
  readStepVersions: async () => state.versions,
}));

vi.mock('@/lib/flags/requireFlag', () => ({ requireFlag: async () => null }));

vi.mock('@/lib/dataroom/steps', () => ({
  loadDealByIdOrCode: async () => ({ id: 'deal-1', code: 'ATLAS-2026-001' }),
}));

vi.mock('@/lib/api/v1/access', () => ({
  userCanAccessDeal: async () => true,
  classifyInternalUser: async () => state.wall,
  resolveDealStepCapabilities: async () => state.capabilities,
}));

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
  if (table === 'deal_step_skill_runs') {
    return {
      insert: (row: Record<string, unknown>) => {
        state.inserted.push(row);
        return {
          select: () => ({
            single: async () =>
              state.insertError
                ? { data: null, error: state.insertError }
                : { data: { ...row, created_at: '2026-09-14T10:00:00.000Z' }, error: null },
          }),
        };
      },
      select: () => ({
        eq: (_column: string, value: unknown) => {
          state.queriedStepIds.push(value);
          return {
            neq: (column: string, excluded: unknown) => ({
              order: () => ({
                limit: async () => ({
                  data: state.runs.filter((run) => run[column] !== excluded),
                  error: null,
                }),
              }),
            }),
          };
        },
        in: () => ({
          order: async () =>
            state.revisionsError
              ? { data: null, error: state.revisionsError }
              : { data: state.revisions, error: null },
        }),
      }),
    };
  }
  if (table === 'skill_comment_teachings') {
    return {
      select: () => ({
        in: async () => {
          state.teachingReads += 1;
          return state.teachingsError
            ? { data: null, error: state.teachingsError }
            : { data: state.teachings, error: null };
        },
      }),
    };
  }
  if (table === 'deal_step_skill_bindings') {
    return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.binding, error: null }) }) }),
    };
  }
  if (table === 'documents') {
    return {
      select: () => ({
        eq: (_column: string, value: unknown) => {
          state.documentDealIds.push(value);
          return { in: async () => ({ data: state.documents, error: null }) };
        },
      }),
    };
  }
  if (table === 'users') {
    return {
      select: () => ({
        in: async (_column: string, ids: unknown[]) => ({
          data: ((): Record<string, unknown>[] => {
            state.userLookups.push(ids);
            return [
              { id: 'user-1', full_name: 'Storm Duncan', display_name: null, email: 'md@example.test' },
            ];
          })(),
          error: null,
        }),
      }),
    };
  }
  return {
    insert: async (row: Record<string, unknown>) => {
      state.audits.push(row);
      return { error: null };
    },
  };
}

vi.mock('@/lib/api/v1/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: async () => ({
    ok: true,
    user: { id: 'user-1', email: 'md@example.test' },
    admin: { from: (table: string) => builderFor(table) },
  }),
}));

vi.mock('@/lib/ignatious/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ignatious/config')>()),
  readIgnatiousConfig: () => ({
    baseUrl: 'https://plane.test',
    apiKey: 'key',
    tenantId: 'tenant-1',
    leadIdOverride: null,
    benchUrl: 'https://bench.test',
    conductiaBaseUrl: 'https://conductia.test',
  }),
}));

vi.mock('@/lib/ignatious/bench', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ignatious/bench')>()),
  createSkillBench: () => ({
    listSkills: async () => {
      state.benchCalls += 1;
      return { skills: state.benchSkills, defaultModel: null };
    },
    listVersions: async (name: string) => {
      state.benchCalls += 1;
      return state.benchVersions[name] ?? { current: null, versions: [] };
    },
  }),
}));

async function record(body: Record<string, unknown>, stepId: string = STEP_ID) {
  const { POST } = await import('@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route');
  return POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ dealId: 'deal-1', stepId }),
  });
}

async function history() {
  const { GET } = await import('@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route');
  return GET(new Request('http://localhost'), {
    params: Promise.resolve({ dealId: 'deal-1', stepId: STEP_ID }),
  });
}

describe('skill run records', () => {
  beforeEach(() => {
    state.wall = 'internal';
    state.capabilities = { canAssign: false, canComplete: true, canEditWork: true };
    state.step = step();
    state.runs = [];
    state.revisions = [];
    state.revisionsError = null;
    state.teachings = [];
    state.teachingsError = null;
    state.teachingReads = 0;
    state.documents = [];
    state.inserted = [];
    state.audits = [];
    state.insertError = null;
    state.queriedStepIds = [];
    state.documentDealIds = [];
    state.userLookups = [];
    state.benchSkills = [];
    state.benchVersions = {};
    state.versions = availableVersions();
    state.benchCalls = 0;
    state.binding = null;
    vi.resetModules();
  });

  it('stores the binding from the step, not from the request', async () => {
    const response = await record({
      runId: RUN_ID,
      instructions: 'Summarise the week',
      outcome: 'succeeded',
      resultText: 'Here is the update.',
      providerRunId: 'run_9',
      costUsd: 0.12,
      skill: {
        skillId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        versionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        digest: 'b'.repeat(64),
      },
    });

    expect(response.status).toBe(201);
    expect(state.inserted[0]).toMatchObject({
      id: RUN_ID,
      deal_id: 'deal-1',
      deal_step_id: DEAL_STEP_ID,
      actor_id: 'user-1',
      skill_id: BINDING.skillId,
      version_id: BINDING.versionId,
      digest: BINDING.digest,
      outcome: 'succeeded',
      result_text: 'Here is the update.',
      provider_run_id: 'run_9',
    });
    expect(state.audits[0]).toMatchObject({
      action: 'create',
      deal_id: 'deal-1',
      detail: expect.objectContaining({ kind: 'skill_run', runId: RUN_ID, outcome: 'succeeded' }),
    });
  });

  it('stores the inputs and instructions the browser rendered, and drops the cost', async () => {
    const response = await record({
      runId: RUN_ID,
      inputs: { asOf: '2026-09-30' },
      instructions: 'Short',
      outcome: 'succeeded',
      resultText: 'Here is the update.',
      costUsd: 9.99,
    });

    expect(response.status).toBe(201);
    expect(state.inserted[0]).toMatchObject({ input: 'Short', inputs: { asOf: '2026-09-30' } });
    expect(state.inserted[0]).not.toHaveProperty('cost_usd');
  });

  it('no longer refuses a record for a step whose saved work is empty', async () => {
    state.step = step({ work: {} });

    const response = await record({
      runId: RUN_ID,
      outcome: 'succeeded',
      resultText: 'Here is the update.',
    });

    expect(response.status).toBe(201);
  });

  it('never audits the input or the result text', async () => {
    await record({
      runId: RUN_ID,
      instructions: 'secret input',
      outcome: 'succeeded',
      resultText: 'secret result',
    });

    expect(JSON.stringify(state.audits[0])).not.toContain('secret');
  });

  it('refuses a succeeded run with no result text', async () => {
    expect((await record({ runId: RUN_ID, instructions: 'in', outcome: 'succeeded' })).status).toBe(422);
    expect(state.inserted).toHaveLength(0);
  });

  it('returns the stored row when the same run id is replayed', async () => {
    state.insertError = { code: '23505', message: 'duplicate key' };
    state.runs = [storedRun()];

    const response = await record({
      runId: RUN_ID,
      instructions: 'Short',
      inputs: { asOf: '2026-09-30' },
      outcome: 'succeeded',
      resultText: 'Here is the update.',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ run: { id: RUN_ID } });
    expect(state.audits).toHaveLength(0);
  });

  it('conflicts when the same run id carries different inputs', async () => {
    state.insertError = { code: '23505', message: 'duplicate key' };
    state.runs = [storedRun({ inputs: { asOf: '2026-10-01' } })];

    expect(
      (
        await record({
          runId: RUN_ID,
          instructions: 'Short',
          inputs: { asOf: '2026-09-30' },
          outcome: 'succeeded',
          resultText: 'Here is the update.',
        })
      ).status,
    ).toBe(409);
  });

  it('conflicts when the same run id carries different content', async () => {
    state.insertError = { code: '23505', message: 'duplicate key' };
    state.runs = [storedRun({ input: 'a different instruction', result_text: 'a different result' })];

    expect(
      (await record({ runId: RUN_ID, outcome: 'succeeded', resultText: 'out' })).status,
    ).toBe(409);
  });

  it('refuses a caller who cannot edit the step and an external one', async () => {
    state.capabilities = { canAssign: false, canComplete: false, canEditWork: false };
    expect(
      (await record({ runId: RUN_ID, instructions: 'in', outcome: 'succeeded', resultText: 'out' }))
        .status,
    ).toBe(403);

    vi.resetModules();
    state.capabilities = { canAssign: false, canComplete: true, canEditWork: true };
    state.wall = 'external';
    expect(
      (await record({ runId: RUN_ID, instructions: 'in', outcome: 'succeeded', resultText: 'out' }))
        .status,
    ).toBe(403);

    expect(state.inserted).toHaveLength(0);
  });

  it('reads history for that step with the actor and the filed documents', async () => {
    state.runs = [storedRun({ cost_usd: null })];
    state.documents = [
      {
        id: 'doc-1',
        name: 'update.docx',
        folder: 'admin',
        created_at: '2026-09-14T10:01:00.000Z',
        step_skill_run_id: RUN_ID,
      },
      {
        id: 'doc-2',
        name: 'other.docx',
        folder: 'admin',
        created_at: '2026-09-14T10:02:00.000Z',
        step_skill_run_id: 'another-run',
      },
    ];

    const body = (await (await history()).json()) as {
      runs: { id: string; actorName: string; binding: unknown; documents: { id: string }[] }[];
    };

    expect(state.queriedStepIds).toEqual([DEAL_STEP_ID]);
    expect(state.documentDealIds).toEqual(['deal-1']);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]?.actorName).toBe('Storm Duncan');
    expect(body.runs[0]?.binding).toEqual({ kind: 'publication', ...BINDING });
    expect(body.runs[0]?.documents.map((doc) => doc.id)).toEqual(['doc-1']);
  });

  it('reads a run with no instructions saved as a null input, and its rendered inputs', async () => {
    state.runs = [storedRun({ input: null, inputs: { asOf: '2026-09-30' } })];

    const body = (await (await history()).json()) as {
      runs: { input: string | null; inputs: Record<string, unknown> }[];
    };

    expect(body.runs[0]).toMatchObject({ input: null, inputs: { asOf: '2026-09-30' } });
  });

  it('surfaces an imported bench reply with no binding and never looks a null actor up', async () => {
    state.runs = [
      storedRun({
        id: 'imported-run-1',
        actor_id: null,
        source: 'imported',
        skill_id: null,
        version_id: null,
        digest: null,
        cost_usd: null,
      }),
    ];

    const body = (await (await history()).json()) as {
      runs: { id: string; binding: unknown; actorName: string }[];
    };

    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]?.binding).toBeNull();
    expect(state.userLookups.flat()).not.toContain(null);
  });

  it('records the mount reference and model actually used, not the step binding', async () => {
    const response = await record({
      runId: RUN_ID,
      instructions: 'Summarise the week',
      outcome: 'succeeded',
      resultText: 'Here is the update.',
      model: 'sonnet',
      reference: { kind: 'mount', name: 'demo', version: 3, digest: 'd'.repeat(64) },
    });

    expect(response.status).toBe(201);
    expect(state.inserted[0]).toMatchObject({
      skill_id: null,
      version_id: null,
      mount_name: 'demo',
      mount_version: 3,
      digest: 'd'.repeat(64),
      model: 'sonnet',
      source: 'execution',
    });
  });

  it('resolves the live bench mount triple for an unbound rail step and records it', async () => {
    state.step = railStep();
    state.benchSkills = [benchSkill()];
    state.benchVersions = {
      'weekly-memo': {
        current: 5,
        versions: [
          {
            version: 5,
            origin: 'repo',
            updatedAt: '2026-09-01T00:00:00Z',
            updatedBy: null,
            downloadable: true,
            current: true,
            description: null,
            status: 'ok',
            reason: null,
            sha256: 'f'.repeat(64),
            bytesRetained: true,
          },
        ],
      },
    };

    const response = await record(
      { runId: RUN_ID, instructions: 'Draft the memo', outcome: 'succeeded', resultText: 'Draft attached.' },
      RAIL_STEP_ID,
    );

    expect(response.status).toBe(201);
    expect(state.inserted[0]).toMatchObject({
      deal_step_id: RAIL_DEAL_STEP_ID,
      skill_id: null,
      version_id: null,
      mount_name: 'weekly-memo',
      mount_version: 5,
      digest: 'f'.repeat(64),
    });
  });

  it('refuses a reference the step does not offer, so provenance cannot be invented', async () => {
    const response = await record({
      runId: RUN_ID,
      instructions: 'Summarise the week',
      outcome: 'succeeded',
      resultText: 'Here is the update.',
      reference: { kind: 'mount', name: 'other', version: 9, digest: 'e'.repeat(64) },
    });

    expect(response.status).toBe(422);
    expect(state.inserted).toHaveLength(0);
  });

  it('records a bound rail step without asking the bench, so a blip cannot lose the run', async () => {
    state.step = railStep();
    state.binding = {
      kind: 'mount',
      skill_id: null,
      version_id: null,
      mount_name: 'weekly-memo',
      mount_version: 5,
      digest: 'f'.repeat(64),
    };

    const response = await record(
      { runId: RUN_ID, instructions: 'Draft the memo', outcome: 'succeeded', resultText: 'Draft attached.' },
      RAIL_STEP_ID,
    );

    expect(response.status).toBe(201);
    expect(state.inserted[0]).toMatchObject({ mount_name: 'weekly-memo', mount_version: 5 });
    expect(state.benchCalls).toBe(0);
  });

  it('stores the model clamp the bench reported and returns it in history', async () => {
    const response = await record({
      runId: RUN_ID,
      instructions: 'Summarise the week',
      outcome: 'succeeded',
      resultText: 'Here is the update.',
      model: 'haiku',
      clampedFrom: 'opus',
    });

    expect(response.status).toBe(201);
    expect(state.inserted[0]).toMatchObject({ model: 'haiku', clamped_from: 'opus' });
    expect(state.audits[0]?.detail).toMatchObject({ clampedFrom: 'opus' });

    const body = (await response.json()) as { run: { clampedFrom: string | null } };
    expect(body.run.clampedFrom).toBe('opus');
  });

  it('names an imported bench reply rather than showing it as Unknown', async () => {
    state.runs = [
      storedRun({ id: 'imported-run-1', actor_id: null, source: 'imported', digest: null }),
    ];

    const body = (await (await history()).json()) as { runs: { actorName: string }[] };

    expect(body.runs[0]?.actorName).toBe('Imported from the bench');
  });

  it('refuses a reference that is not a valid skill reference', async () => {
    const response = await record({
      runId: RUN_ID,
      instructions: 'in',
      outcome: 'succeeded',
      resultText: 'out',
      reference: { kind: 'nonsense' },
    });

    expect(response.status).toBe(422);
    expect(state.inserted).toHaveLength(0);
  });

  it('keeps history readable on a removed step and refuses an external reader', async () => {
    state.step = step({ removed_at: '2026-09-14T09:00:00Z' });
    state.runs = [storedRun()];
    expect((await history()).status).toBe(200);

    vi.resetModules();
    state.wall = 'external';
    expect((await history()).status).toBe(403);
  });

  it('answers 404 for a step that is not on this deal', async () => {
    state.step = null;
    expect((await history()).status).toBe(404);

    vi.resetModules();
    expect(
      (await record({ runId: RUN_ID, instructions: 'in', outcome: 'succeeded', resultText: 'out' }))
        .status,
    ).toBe(404);
  });

  it('returns the run as its own head when nothing has been revised', async () => {
    state.runs = [storedRun()];

    const body = (await (await history()).json()) as {
      runs: { headId: string; headText: string | null; revisions: unknown[] }[];
    };

    expect(body.runs[0]).toMatchObject({ headId: RUN_ID, headText: 'Here is the update.', revisions: [] });
  });

  it('returns the latest version as the head, with what changed and who changed it', async () => {
    state.runs = [storedRun(), storedRun({ id: 'revision-row', source: 'revision' })];
    state.revisions = [
      {
        id: 'rev-2',
        outcome: 'succeeded',
        inputs: {
          kind: 'edits',
          edits: [{ id: 'e1', kind: 'hand', start: 0, end: 19, status: 'applied', resultStart: 0, resultEnd: 17 }],
        },
        result_text: 'Here is the plan.',
        error_message: null,
        actor_id: 'user-1',
        parent_run_id: RUN_ID,
        root_run_id: RUN_ID,
        created_at: '2026-09-14T11:00:00.000Z',
      },
    ];

    const body = (await (await history()).json()) as {
      runs: {
        id: string;
        resultText: string;
        headId: string;
        headText: string;
        revisions: { id: string; version: number; actorName: string; edits: { before: string }[] }[];
      }[];
    };

    expect(body.runs.map((run) => run.id)).toEqual([RUN_ID]);
    expect(body.runs[0]).toMatchObject({
      resultText: 'Here is the update.',
      headId: 'rev-2',
      headText: 'Here is the plan.',
    });
    expect(body.runs[0]?.revisions[0]).toMatchObject({
      id: 'rev-2',
      version: 2,
      actorName: 'Storm Duncan',
      edits: [{ before: 'Here is the update.' }],
    });
  });

  it('marks a taught comment as sent in history once a message carried it', async () => {
    state.runs = [storedRun(), storedRun({ id: 'revision-row', source: 'revision' })];
    state.revisions = [
      {
        id: 'rev-2',
        outcome: 'succeeded',
        inputs: {
          kind: 'edits',
          edits: [
            {
              id: 'e1',
              kind: 'comment',
              comment: 'Lead with the plan',
              teach: true,
              start: 0,
              end: 19,
              status: 'applied',
              resultStart: 0,
              resultEnd: 17,
            },
          ],
        },
        result_text: 'Here is the plan.',
        error_message: null,
        actor_id: 'user-1',
        parent_run_id: RUN_ID,
        root_run_id: RUN_ID,
        created_at: '2026-09-14T11:00:00.000Z',
      },
    ];
    state.teachings = [
      { revision_run_id: 'rev-2', edit_id: 'e1', draft_id: 'draft-1', kind: 'sent' },
    ];

    const body = (await (await history()).json()) as {
      runs: { revisions: { edits: { teach: boolean; sent: boolean }[] }[] }[];
    };

    expect(body.runs[0]?.revisions[0]?.edits[0]).toMatchObject({ teach: true, sent: true });
  });

  it('does not read teachings when no revision holds a taught edit', async () => {
    state.runs = [storedRun(), storedRun({ id: 'revision-row', source: 'revision' })];
    state.revisions = [
      {
        id: 'rev-2',
        outcome: 'succeeded',
        inputs: {
          kind: 'edits',
          edits: [{ id: 'e1', kind: 'comment', comment: 'Lead with the plan', start: 0, end: 19, status: 'applied', resultStart: 0, resultEnd: 17 }],
        },
        result_text: 'Here is the plan.',
        error_message: null,
        actor_id: 'user-1',
        parent_run_id: RUN_ID,
        root_run_id: RUN_ID,
        created_at: '2026-09-14T11:00:00.000Z',
      },
    ];

    const response = await history();

    expect(response.status).toBe(200);
    expect(state.teachingReads).toBe(0);
  });

  it('answers 500 when the teaching rows cannot be read', async () => {
    state.runs = [storedRun(), storedRun({ id: 'revision-row', source: 'revision' })];
    state.revisions = [
      {
        id: 'rev-2',
        outcome: 'succeeded',
        inputs: { kind: 'edits', edits: [{ id: 'e1', kind: 'comment', comment: 'Lead with the plan', teach: true, start: 0, end: 19, status: 'applied', resultStart: 0, resultEnd: 17 }] },
        result_text: 'Here is the plan.',
        error_message: null,
        actor_id: 'user-1',
        parent_run_id: RUN_ID,
        root_run_id: RUN_ID,
        created_at: '2026-09-14T11:00:00.000Z',
      },
    ];
    state.teachingsError = { code: '57014', message: 'canceling statement' };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await history();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Run history could not be read' });
    log.mockRestore();
  });

  it('answers 500 rather than the first output as the head when revisions cannot be read', async () => {
    state.runs = [storedRun()];
    state.revisionsError = { code: '57014', message: 'canceling statement' };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await history();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Run history could not be read' });
    log.mockRestore();
  });

  it('keeps a newly recorded run recorded when revisions cannot be read', async () => {
    state.revisionsError = { code: '57014', message: 'canceling statement' };

    const response = await record({
      runId: RUN_ID,
      instructions: 'Short',
      inputs: { asOf: '2026-09-30' },
      outcome: 'succeeded',
      resultText: 'Here is the update.',
    });

    expect(response.status).toBe(201);
    expect(state.inserted).toHaveLength(1);
    expect(await response.json()).toMatchObject({
      run: { id: RUN_ID, headId: RUN_ID, revisions: [] },
    });
  });
});
