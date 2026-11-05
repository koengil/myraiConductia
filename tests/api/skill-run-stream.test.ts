import { beforeEach, describe, expect, it, vi } from 'vitest';

// The ledger write runs in after(); the tests collect and await it (#155).
const ledger = vi.hoisted(() => ({
  afterTasks: [] as Promise<unknown>[],
  rows: [] as Record<string, unknown>[],
  signals: [] as (AbortSignal | undefined)[],
}));
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => {
    ledger.afterTasks.push(task());
  },
}));
vi.mock('@/lib/ai/usage', async (original) => ({
  ...(await original<typeof import('@/lib/ai/usage')>()),
  recordAiUsage: async (_admin: unknown, row: Record<string, unknown>) => {
    ledger.rows.push(row);
    return { error: null };
  },
}));

const BINDING = {
  skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
  versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
  digest: 'a'.repeat(64),
};

const RUN_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';
const STEP_ID = 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6';
const RAIL_STEP_ID = 'p2-s36';
const RAIL_DEAL_STEP_ID = '1c1c1c1c-1c1c-4c1c-8c1c-1c1c1c1c1c1c';

function railStep(): Record<string, unknown> {
  return {
    id: RAIL_DEAL_STEP_ID,
    step_id: RAIL_STEP_ID,
    origin: 'rail',
    removed_at: null,
    work: { primary: 'Draft the memo' },
    definition: null,
    assigned_to: null,
    status: 'pending',
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

function freshStep(): Record<string, unknown> {
  return {
    id: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
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
  };
}

function defaultVersions() {
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
  flagOff: false,
  canAccess: true,
  configured: true,
  wall: 'internal' as 'internal' | 'external' | 'error',
  capabilities: { canAssign: false, canComplete: true, canEditWork: true } as
    | Capabilities
    | 'unreadable',
  step: freshStep() as Record<string, unknown> | null,
  binding: null as Record<string, unknown> | null,
  dealTenantId: 'tenant-a-uuid' as string | null,
  started: [] as Record<string, unknown>[],
  minted: [] as Record<string, unknown>[],
  audited: [] as Record<string, unknown>[],
  rebinds: [] as unknown[],
  versions: defaultVersions() as ReturnType<typeof defaultVersions>,
  benchSkills: [] as Record<string, unknown>[],
  benchVersions: {} as Record<string, { current: number | null; versions: Record<string, unknown>[] }>,
  benchResponse: null as Response | null,
};

vi.mock('@/lib/flags/requireFlag', () => ({
  requireFlag: async () =>
    state.flagOff ? new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }) : null,
}));

vi.mock('@/lib/dataroom/steps', () => ({
  loadDealByIdOrCode: async () => ({ id: 'deal-1', code: 'ATLAS-2026-001' }),
}));

vi.mock('@/lib/api/v1/access', () => ({
  userCanAccessDeal: async () => state.canAccess,
  classifyInternalUser: async () => state.wall,
  resolveDealStepCapabilities: async () => state.capabilities,
}));

function builderFor(table: string) {
  const insert = async (payload: Record<string, unknown>) => {
    if (table === 'audit_log') state.audited.push(payload);
    return { data: null, error: null };
  };
  if (table === 'deals') {
    return {
      insert,
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { tenant_id: state.dealTenantId }, error: null }),
        }),
      }),
    };
  }
  if (table === 'deal_step_skill_bindings') {
    return {
      insert,
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.binding, error: null }) }) }),
    };
  }
  return {
    insert,
    select: () => ({
      eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.step, error: null }) }) }),
    }),
  };
}

vi.mock('@/lib/api/v1/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: async () => ({
    ok: true,
    user: { id: 'user-1', email: 'md@example.test' },
    admin: {
      from: (table: string) => builderFor(table),
      rpc: async (name: string, args: unknown) => {
        state.rebinds.push({ name, args });
        return { data: null, error: null };
      },
    },
  }),
}));

vi.mock('@/lib/skillRun/versions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skillRun/versions')>()),
  readStepVersions: async () => state.versions,
}));

vi.mock('@/lib/ignatious/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ignatious/config')>()),
  readIgnatiousConfig: () =>
    state.configured
      ? {
          baseUrl: 'https://plane.test',
          apiKey: 'key',
          tenantId: 'tenant-1',
          leadIdOverride: null,
          benchUrl: 'https://bench.test',
          conductiaBaseUrl: 'https://conductia.test',
        }
      : null,
}));

vi.mock('@/lib/ignatious/jwt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ignatious/jwt')>();
  return {
    ...actual,
    mintTriggerToken: (claims: Record<string, unknown>) => {
      state.minted.push(claims);
      return 'minted-token';
    },
  };
});

vi.mock('@/lib/ignatious/bench', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ignatious/bench')>()),
  createSkillBench: () => ({
    listSkills: async () => ({ skills: state.benchSkills, defaultModel: null }),
    listVersions: async (name: string) =>
      state.benchVersions[name] ?? { current: null, versions: [] },
    startSkillRun: async (body: Record<string, unknown>, signal?: AbortSignal) => {
      state.started.push(body);
      ledger.signals.push(signal);
      if (state.benchResponse) return state.benchResponse;
      return new Response('event: text\ndata: {"type":"text","text":"hi"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  }),
}));

async function start(body: Record<string, unknown>, stepId: string = STEP_ID) {
  const { POST } = await import(
    '@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/stream/route'
  );
  return POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ dealId: 'deal-1', stepId }),
  });
}

async function postStreamRaw(body: Record<string, unknown>) {
  return start(body);
}

async function postStream(body: Record<string, unknown>, stepId: string = STEP_ID) {
  const response = await start(body, stepId);
  if (response.status !== 200) {
    throw new Error(`expected 200, got ${response.status}: ${await response.text()}`);
  }
  return { response, sent: state.started[state.started.length - 1]!, rebinds: state.rebinds };
}

describe('POST skill-runs/stream', () => {
  beforeEach(() => {
    state.flagOff = false;
    state.canAccess = true;
    state.configured = true;
    state.wall = 'internal';
    state.capabilities = { canAssign: false, canComplete: true, canEditWork: true };
    state.step = freshStep();
    state.binding = null;
    state.dealTenantId = 'tenant-a-uuid';
    state.started = [];
    state.minted = [];
    state.audited = [];
    state.rebinds = [];
    state.versions = defaultVersions();
    state.benchSkills = [];
    state.benchVersions = {};
    state.benchResponse = null;
    ledger.afterTasks = [];
    ledger.rows = [];
    ledger.signals = [];
    vi.resetModules();
  });

  function sse(events: Record<string, unknown>[]): Response {
    const body = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  it('records the run on the AI spend ledger once, against the deal, the person and the step (#155)', async () => {
    state.benchResponse = sse([
      { type: 'ready', model: 'anthropic/claude-sonnet-5' },
      { type: 'run', runId: 'bench-run-1' },
      { type: 'text', text: 'Drafted.' },
      { type: 'done', costUsd: 0.0312, model: 'claude-sonnet-5' },
    ]);
    const { response } = await postStream({ runId: RUN_ID });
    expect(await response.text()).toContain('"text":"Drafted."');
    await Promise.all(ledger.afterTasks);
    const ledgerId = (state.audited[0]?.detail as { ledgerId?: string } | undefined)?.ledgerId;
    expect(ledgerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ledgerId).not.toBe(RUN_ID);
    expect(ledger.rows).toEqual([
      {
        tenantId: 'tenant-a-uuid',
        dealId: 'deal-1',
        actorId: 'user-1',
        source: 'skill_run',
        task: STEP_ID,
        externalId: ledgerId,
        model: 'claude-sonnet-5',
        costUsd: 0.0312,
      },
    ]);
  });

  it('keys each run on the ledger by its own server id, so a reused runId is still recorded', async () => {
    state.benchResponse = sse([{ type: 'done', costUsd: 0.01, model: 'claude-haiku-5' }]);
    await (await postStream({ runId: RUN_ID })).response.text();
    state.benchResponse = sse([{ type: 'done', costUsd: 0.02, model: 'claude-haiku-5' }]);
    await (await postStream({ runId: RUN_ID })).response.text();
    await Promise.all(ledger.afterTasks);
    const keys = ledger.rows.map((row) => row.externalId);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it('records the run even when the browser stops reading', async () => {
    // As the skill bench sends it: no ready frame, the model on done.
    state.benchResponse = sse([{ type: 'run', runId: 'bench-run-2' }, { type: 'done', costUsd: 0.01, model: 'claude-haiku-5' }]);
    const { response } = await postStream({ runId: RUN_ID });
    await response.body?.cancel();
    await Promise.all(ledger.afterTasks);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ source: 'skill_run', costUsd: 0.01, model: 'claude-haiku-5' });
  });

  it('stops the bench run when the banker cancels, and writes no row for it', async () => {
    // Cancel (and closing the tab) aborts this request; the route forwards
    // that to the bench, so a cancelled run stops spending. The bench sends no
    // done frame for it, so its partial cost is not on the ledger (Issue #155).
    const { POST } = await import(
      '@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/stream/route'
    );
    const controller = new AbortController();
    let bench!: ReadableStreamDefaultController<Uint8Array>;
    state.benchResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          bench = c;
          c.enqueue(new TextEncoder().encode('event: run\ndata: {"type":"run","runId":"bench-run-3"}\n\n'));
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
    const response = await POST(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify({ runId: RUN_ID }), signal: controller.signal }),
      { params: Promise.resolve({ dealId: 'deal-1', stepId: STEP_ID }) },
    );
    expect(response.status).toBe(200);
    const forwarded = ledger.signals.at(-1);
    expect(forwarded?.aborted).toBe(false);
    // As the bench does: an aborted fetch errors the body it was streaming.
    forwarded?.addEventListener('abort', () => bench.error(new DOMException('aborted', 'AbortError')));
    controller.abort();
    expect(forwarded?.aborted).toBe(true);
    await response.text().catch(() => undefined);
    await Promise.allSettled(ledger.afterTasks);
    expect(ledger.rows).toEqual([]);
  });

  it('writes nothing for a run that never finished', async () => {
    state.benchResponse = sse([{ type: 'text', text: 'partial' }, { type: 'error', message: 'bench failed' }]);
    const { response } = await postStream({ runId: RUN_ID });
    await response.text();
    await Promise.all(ledger.afterTasks);
    expect(ledger.rows).toEqual([]);
  });

  it('sends the binding read from the step, and the rendered inputs and instructions', async () => {
    const response = await start({
      runId: RUN_ID,
      inputs: { asOf: '2026-09-30' },
      instructions: 'Short',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(state.started).toHaveLength(1);
    expect(state.started[0]).toMatchObject({
      runId: RUN_ID,
      skill: { kind: 'publication', ...BINDING },
      inputs: { asOf: '2026-09-30' },
      instructions: 'Short',
      leadId: 'ATLAS-2026-001',
      tenantId: 'tenant-1',
      token: 'minted-token',
    });
  });

  it('defaults to no inputs and no instructions', async () => {
    await start({ runId: RUN_ID });

    expect(state.started[0]).toMatchObject({ inputs: {}, instructions: null });
  });

  it('refuses inputs that do not map names to text, numbers or booleans', async () => {
    const response = await start({ runId: RUN_ID, inputs: { a: { b: 1 } } });

    expect(response.status).toBe(422);
    expect(state.started).toHaveLength(0);
  });

  it('ignores a client-supplied version', async () => {
    await start({
      runId: RUN_ID,
      skill: {
        kind: 'publication',
        skillId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        versionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        digest: 'b'.repeat(64),
      },
      instructions: 'a different instruction',
    });

    expect(state.started[0]?.skill).toEqual({ kind: 'publication', ...BINDING });
    expect(state.started[0]?.instructions).toBe('a different instruction');
  });

  it('mints a token scoped to this deal, run and step', async () => {
    await start({ runId: RUN_ID });

    expect(state.minted[0]).toMatchObject({
      dealId: 'deal-1',
      conductiaTenantId: 'tenant-a-uuid',
      userId: 'user-1',
      userEmail: 'md@example.test',
    });
  });

  it('refuses to mint an unscoped token for a deal with no tenant (PL-02)', async () => {
    state.dealTenantId = null;
    const res = await start({ runId: RUN_ID });

    expect(res.status).toBe(500);
    expect(state.minted).toHaveLength(0);
    expect(state.started).toHaveLength(0);
  });

  it('audits the trigger before the run is proxied', async () => {
    await start({ runId: RUN_ID });

    expect(state.audited).toHaveLength(1);
    expect(state.audited[0]).toMatchObject({
      actor_id: 'user-1',
      action: 'create',
      deal_id: 'deal-1',
      detail: {
        kind: 'skill_run',
        stepKey: STEP_ID,
        runId: RUN_ID,
        reference: { kind: 'publication', ...BINDING },
      },
    });
  });

  it('audits the version a one-off run actually names, not the step binding', async () => {
    await start({
      runId: RUN_ID,
      version: { kind: 'mount', name: 'demo', version: 3, digest: 'd'.repeat(64) },
    });

    expect(state.audited[0]).toMatchObject({
      detail: { reference: { kind: 'mount', name: 'demo', version: 3, digest: 'd'.repeat(64) } },
    });
  });

  it('leaves no audit row when the run is refused before it starts', async () => {
    state.capabilities = { canAssign: false, canComplete: false, canEditWork: false };

    expect((await start({ runId: RUN_ID })).status).toBe(403);
    expect(state.audited).toHaveLength(0);
  });

  it('refuses a run id that is not a uuid', async () => {
    expect((await start({ runId: 'nope' })).status).toBe(422);
    expect(state.started).toHaveLength(0);
  });

  it('refuses a removed step and a catalog step', async () => {
    state.step = { ...freshStep(), removed_at: '2026-09-14T00:00:00Z' };
    expect((await start({ runId: RUN_ID })).status).toBe(409);

    vi.resetModules();
    state.step = { ...freshStep(), origin: 'catalog' };
    expect((await start({ runId: RUN_ID })).status).toBe(409);

    expect(state.started).toHaveLength(0);
  });

  it('no longer refuses a step whose saved work is empty', async () => {
    state.step = { ...freshStep(), work: {} };

    expect((await start({ runId: RUN_ID })).status).toBe(200);
  });

  it('refuses an external user, for whom a step work product is off limits', async () => {
    state.wall = 'external';
    expect((await start({ runId: RUN_ID })).status).toBe(403);
    expect(state.started).toHaveLength(0);
  });

  it('refuses a step that is not on this deal', async () => {
    state.step = null;
    expect((await start({ runId: RUN_ID })).status).toBe(404);
  });

  it('refuses a caller who cannot edit the step, and hides the deal from one with no deal access', async () => {
    state.capabilities = { canAssign: false, canComplete: false, canEditWork: false };
    expect((await start({ runId: RUN_ID })).status).toBe(403);

    vi.resetModules();
    state.capabilities = { canAssign: false, canComplete: true, canEditWork: true };
    state.canAccess = false;
    expect((await start({ runId: RUN_ID })).status).toBe(404);

    expect(state.started).toHaveLength(0);
  });

  it('answers 404 with the flag off and 503 with no skill service configured', async () => {
    state.flagOff = true;
    expect((await start({ runId: RUN_ID })).status).toBe(404);

    vi.resetModules();
    state.flagOff = false;
    state.configured = false;
    expect((await start({ runId: RUN_ID })).status).toBe(503);

    expect(state.started).toHaveLength(0);
  });

  it('runs the step binding when no version is supplied', async () => {
    const { sent } = await postStream({ runId: RUN_ID });
    expect(sent.skill).toEqual({ kind: 'publication', ...BINDING });
  });

  it('runs a supplied version without changing the binding', async () => {
    const { sent, rebinds } = await postStream({
      runId: RUN_ID,
      version: { kind: 'mount', name: 'demo', version: 3, digest: 'd'.repeat(64) },
    });
    expect(sent.skill).toEqual({ kind: 'mount', name: 'demo', version: 3, digest: 'd'.repeat(64) });
    expect(rebinds).toHaveLength(0);
  });

  it('refuses a version that is not available for this step', async () => {
    const response = await postStreamRaw({
      runId: RUN_ID,
      version: { kind: 'mount', name: 'other', version: 9, digest: 'e'.repeat(64) },
    });
    expect(response.status).toBe(422);
  });

  it('runs the bound version without asking the lineage, so an outage cannot block it', async () => {
    state.versions = { ...defaultVersions(), project: [], projectUnavailableReason: 'unreadable' };

    const { sent } = await postStream({
      runId: RUN_ID,
      version: { kind: 'publication', ...BINDING },
    });

    expect(sent.skill).toEqual({ kind: 'publication', ...BINDING });
  });

  it('answers 502, not 422, when the lineage cannot be read for a different version', async () => {
    state.versions = { ...defaultVersions(), projectUnavailableReason: 'unreadable' };

    const response = await postStreamRaw({
      runId: RUN_ID,
      version: { kind: 'mount', name: 'demo', version: 3, digest: 'd'.repeat(64) },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'unreadable' });
  });

  it('forwards the chosen model', async () => {
    const { sent } = await postStream({ runId: RUN_ID, model: 'sonnet' });
    expect(sent.model).toBe('sonnet');
  });

  it('runs a mount-bound step without a publication', async () => {
    state.binding = {
      kind: 'mount',
      skill_id: null,
      version_id: null,
      mount_name: 'demo',
      mount_version: 3,
      digest: 'd'.repeat(64),
    };
    const { sent } = await postStream({ runId: RUN_ID });
    expect(sent.skill).toEqual({ kind: 'mount', name: 'demo', version: 3, digest: 'd'.repeat(64) });
  });

  it('resolves the live bench mount triple for an unbound rail step and runs it', async () => {
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

    const { sent } = await postStream(
      { runId: RUN_ID, inputs: { asOf: '2026-09-30' }, instructions: 'Draft the memo' },
      RAIL_STEP_ID,
    );
    expect(sent.skill).toEqual({ kind: 'mount', name: 'weekly-memo', version: 5, digest: 'f'.repeat(64) });
    expect(sent.inputs).toEqual({ asOf: '2026-09-30' });
    expect(sent.instructions).toBe('Draft the memo');
  });

  it('passes a bench 422 through with the same status and body', async () => {
    const problemBody = {
      error: {
        code: 'validation',
        message: 'm',
        detail: { problems: [{ name: 'asOf', message: 'required' }] },
      },
    };
    state.benchResponse = new Response(JSON.stringify(problemBody), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    });

    const response = await start({ runId: RUN_ID });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual(problemBody);
  });
});
