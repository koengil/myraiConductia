import { beforeEach, describe, expect, it, vi } from 'vitest';

const BINDING = {
  skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
  versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
  digest: 'a'.repeat(64),
};

const STEP_ID = 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6';
const DEAL_STEP_ID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const LINEAGE_VERSION_ID = '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6';
const RAIL_STEP_ID = 'p1-s9';
const RAIL_STEP_UUID = '1c1c1c1c-1c1c-4c1c-8c1c-1c1c1c1c1c1c';

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

function railStep(overrides: Record<string, unknown> = {}) {
  return {
    id: RAIL_STEP_UUID,
    step_id: RAIL_STEP_ID,
    origin: 'rail',
    removed_at: null,
    work: { primary: 'Draft the briefing' },
    definition: null,
    assigned_to: null,
    status: 'pending',
    ...overrides,
  };
}

function benchSkill(overrides: Record<string, unknown> = {}) {
  return {
    name: 'md-briefing',
    origin: 'repo' as const,
    tag: { stageId: 'phase-1', applicationId: 'seq-9' },
    status: 'ok' as const,
    reason: null,
    description: null,
    version: 3,
    model: null,
    modelFrom: 'seed' as const,
    maxModel: null,
    maxEffort: null,
    routingFrom: 'seed' as const,
    tester: null,
    testStatus: 'untested' as const,
    enabled: true,
    sizeBytes: null,
    updatedAt: null,
    updatedBy: null,
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
  lineage: [] as { versionId: string; digest: string; publishedAt: string }[],
  lineageUnavailable: false,
  operations: [] as Record<string, unknown>[],
  imports: [] as Record<string, unknown>[],
  users: [] as Record<string, unknown>[],
  ignatiousConfig: null as Record<string, unknown> | null,
  skills: [] as Record<string, unknown>[],
  versionsByName: {} as Record<string, { current: number | null; versions: Record<string, unknown>[] }>,
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

vi.mock('@/lib/ignatious/config', () => ({
  readIgnatiousConfig: () => state.ignatiousConfig,
}));

vi.mock('@/lib/ignatious/bench', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ignatious/bench')>()),
  createSkillBench: () => ({
    listSkills: async () => ({ skills: state.skills, defaultModel: null }),
    listVersions: async (name: string) =>
      state.versionsByName[name] ?? { current: null, versions: [] },
  }),
  listPublicationLineage: async () => {
    if (state.lineageUnavailable) throw new Error('unreachable');
    return state.lineage;
  },
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
  if (table === 'deal_step_skill_bindings') {
    return {
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: state.binding, error: null }) }),
      }),
    };
  }
  if (table === 'skill_publication_operations') {
    return rowsBuilder(state.operations);
  }
  if (table === 'deal_skill_imports') {
    return rowsBuilder(state.imports);
  }
  if (table === 'users') {
    return { select: () => ({ in: async () => ({ data: state.users, error: null }) }) };
  }
  throw new Error(`Unexpected table ${table}`);
}

function rowsBuilder(rows: Record<string, unknown>[]) {
  let current = rows;
  const self = {
    select: () => self,
    eq: (column: string, value: unknown) => {
      current = current.filter((row) => row[column] === value);
      return self;
    },
    in: (column: string, values: unknown[]) => {
      current = current.filter((row) => values.includes(row[column]));
      return self;
    },
    maybeSingle: async () => ({ data: current[0] ?? null, error: null }),
    then: (resolve: (value: unknown) => void) =>
      resolve({ data: current, error: null }),
  };
  return self;
}

function publicationOperation(overrides: Record<string, unknown> = {}) {
  return {
    deal_id: 'deal-1',
    published_skill_id: BINDING.skillId,
    published_version_id: LINEAGE_VERSION_ID,
    published_digest: BINDING.digest,
    name: 'Weekly project update',
    capability_contract: {
      purpose: 'Summarise weekly filings',
      expectedInput: 'A filing PDF',
      expectedOutput: 'A one-paragraph summary',
    },
    actor_id: 'user-1',
    created_at: '2026-09-12T00:00:00Z',
    ...overrides,
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

async function versions(stepId: string = STEP_ID) {
  const { GET } = await import(
    '@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-versions/route'
  );
  return GET(new Request('http://localhost'), {
    params: Promise.resolve({ dealId: 'deal-1', stepId }),
  });
}

describe('skill version picker payload', () => {
  beforeEach(() => {
    state.wall = 'internal';
    state.capabilities = { canAssign: false, canComplete: true, canEditWork: true };
    state.step = step();
    state.binding = null;
    state.lineage = [];
    state.lineageUnavailable = false;
    state.operations = [];
    state.imports = [];
    state.users = [];
    state.ignatiousConfig = null;
    state.skills = [];
    state.versionsByName = {};
    vi.resetModules();
  });

  it('refuses a non-internal user', async () => {
    state.wall = 'external';
    expect((await versions()).status).toBe(403);
  });

  it('answers 404 for an unknown step', async () => {
    state.step = null;
    expect((await versions()).status).toBe(404);
  });

  it('returns the grouped version list for an internal user on a bound step', async () => {
    state.lineage = [
      { versionId: LINEAGE_VERSION_ID, digest: BINDING.digest, publishedAt: '2026-09-12T00:00:00Z' },
    ];
    state.operations = [publicationOperation()];
    state.users = [
      { id: 'user-1', full_name: 'Storm Duncan', display_name: null, email: 'md@example.test' },
    ];

    const response = await versions();
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      current: unknown;
      project: unknown[];
      projectUnavailableReason: string | null;
      catalog: unknown[];
    };
    expect(body).toHaveProperty('current');
    expect(body).toHaveProperty('project');
    expect(body).toHaveProperty('projectUnavailableReason');
    expect(body).toHaveProperty('catalog');
    expect(body.current).toEqual({ kind: 'publication', ...BINDING });
    expect(body.project).toEqual([
      {
        reference: { kind: 'publication', ...BINDING },
        label: 'v1',
        authorName: 'Storm Duncan',
        createdAt: '2026-09-12T00:00:00Z',
        available: true,
        unavailableReason: null,
      },
    ]);
    expect(body.projectUnavailableReason).toBeNull();
    expect(body.catalog).toEqual([]);
  });

  it('degrades to a null author when the publishing actor has no matching user row', async () => {
    state.lineage = [
      { versionId: LINEAGE_VERSION_ID, digest: BINDING.digest, publishedAt: '2026-09-12T00:00:00Z' },
    ];
    state.operations = [publicationOperation({ actor_id: 'gone-user' })];
    state.users = [];

    const response = await versions();
    expect(response.status).toBe(200);

    const body = (await response.json()) as { project: { authorName: string | null }[] };
    expect(body.project).toHaveLength(1);
    expect(body.project[0]?.authorName).toBeNull();
  });

  it('names why the project lineage is unavailable instead of showing an empty list', async () => {
    state.lineageUnavailable = true;

    const response = await versions();
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      project: unknown[];
      projectUnavailableReason: string | null;
    };
    expect(body.project).toEqual([]);
    expect(body.projectUnavailableReason).toBe(
      "This project's skill version history could not be read.",
    );
  });

  it('returns the firm-catalog versions and the mount binding for a rail step bound to a catalog skill', async () => {
    state.step = railStep();
    state.ignatiousConfig = { benchUrl: 'http://bench.test', apiKey: 'key' };
    state.skills = [benchSkill()];
    state.versionsByName = {
      'md-briefing': {
        current: 3,
        versions: [
          {
            version: 3,
            origin: 'repo',
            updatedAt: '2026-09-10T00:00:00Z',
            updatedBy: 'ops@example.test',
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

    const response = await versions(RAIL_STEP_ID);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      current: unknown;
      project: unknown[];
      projectUnavailableReason: string | null;
      catalog: unknown[];
    };
    expect(body.current).toEqual({ kind: 'mount', name: 'md-briefing', version: 3, digest: 'f'.repeat(64) });
    expect(body.catalog).toEqual([
      {
        reference: { kind: 'mount', name: 'md-briefing', version: 3, digest: 'f'.repeat(64) },
        label: 'v3',
        authorName: 'ops@example.test',
        createdAt: '2026-09-10T00:00:00Z',
        available: true,
        unavailableReason: null,
      },
    ]);
    expect(body.project).toEqual([]);
    expect(body.projectUnavailableReason).toBeNull();
  });

  it('reads the ancestor capability contract for a publication-bound step', async () => {
    state.lineage = [
      { versionId: LINEAGE_VERSION_ID, digest: BINDING.digest, publishedAt: '2026-09-12T00:00:00Z' },
    ];
    state.operations = [publicationOperation()];

    const response = await versions();
    expect(response.status).toBe(200);

    const body = (await response.json()) as { ancestorContract: unknown };
    expect(body.ancestorContract).toEqual({
      purpose: 'Summarise weekly filings',
      expectedInput: 'A filing PDF',
      expectedOutput: 'A one-paragraph summary',
    });
  });

  it('returns a null ancestor contract when no matching publication operation is stored', async () => {
    state.lineage = [
      { versionId: LINEAGE_VERSION_ID, digest: BINDING.digest, publishedAt: '2026-09-12T00:00:00Z' },
    ];

    const response = await versions();
    expect(response.status).toBe(200);

    const body = (await response.json()) as { ancestorContract: unknown };
    expect(body.ancestorContract).toBeNull();
  });

  it('returns a null ancestor contract for a catalog mount, which has no stored capability contract', async () => {
    state.step = railStep();
    state.ignatiousConfig = { benchUrl: 'http://bench.test', apiKey: 'key' };
    state.skills = [benchSkill()];
    state.versionsByName = {
      'md-briefing': {
        current: 3,
        versions: [
          {
            version: 3,
            origin: 'repo',
            updatedAt: '2026-09-10T00:00:00Z',
            updatedBy: 'ops@example.test',
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
    state.operations = [
      publicationOperation({
        capability_contract: {
          purpose: 'Should never be read for a mount basis',
          expectedInput: 'x',
          expectedOutput: 'y',
        },
      }),
    ];

    const response = await versions(RAIL_STEP_ID);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { ancestorContract: unknown };
    expect(body.ancestorContract).toBeNull();
  });
});
