import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HEAD_MOVED_MESSAGE } from '@/lib/skillRun/applyRevision';
import { STRUCTURE_PROBLEM } from '@/lib/skillRun/revisions';
import { APPLY_DEADLINE_MS } from '@/lib/skillRun/revisionView';

import { fakeAdmin, type FakeAdmin } from '../helpers/skillRunAdmin';

const DEAL_STEP_ID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const STEP_KEY = 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6';
const ROOT_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';
const SECOND_ID = '4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a';
const OTHER_DEAL_STEP_ID = '8e8e8e8e-8e8e-4e8e-8e8e-8e8e8e8e8e8e';
const FAILED_RUN_ID = '6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c6c';
const STRANGER_ID = '7d7d7d7d-7d7d-4d7d-8d7d-7d7d7d7d7d7d';
const TEXT = ['# Memo', '', 'Revenue fell.', '', '- one', '- two'].join('\n');

type Capabilities = { canAssign: boolean; canComplete: boolean; canEditWork: boolean };

const state = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  capabilities: { canAssign: false, canComplete: true, canEditWork: true } as Capabilities,
  store: null as FakeAdmin | null,
  afterTasks: [] as (() => Promise<unknown>)[],
  configured: true,
}));

vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => {
    state.afterTasks.push(task);
  },
}));
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage: async () => ({ error: null }) }));
vi.mock('@/lib/flags/requireFlag', () => ({
  requireFlag: async (key: string) =>
    state.flags[key] ? null : new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
}));
vi.mock('@/lib/dataroom/steps', () => ({
  loadDealByIdOrCode: async () => ({ id: 'deal-1', code: 'ATLAS-2026-001' }),
}));
vi.mock('@/lib/api/v1/access', () => ({
  userCanAccessDeal: async () => true,
  classifyInternalUser: async () => 'internal',
  resolveDealStepCapabilities: async () => state.capabilities,
}));
vi.mock('@/lib/api/v1/http', async (original) => ({
  ...(await original<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: async () => ({
    ok: true,
    user: { id: 'user-1', email: 'md@example.test', companyId: null },
    admin: state.store?.admin,
  }),
}));
vi.mock('@/lib/ignatious/config', async (original) => ({
  ...(await original<typeof import('@/lib/ignatious/config')>()),
  readIgnatiousConfig: () =>
    state.configured
      ? {
          baseUrl: 'https://plane.test',
          apiKey: 'key',
          tenantId: 'tn_demo',
          leadIdOverride: null,
          benchUrl: 'https://bench.test',
          conductiaBaseUrl: 'https://conductia.test',
        }
      : null,
}));

function seed(overrides: { removed?: boolean } = {}): FakeAdmin {
  return fakeAdmin({
    deals: [{ id: 'deal-1', tenant_id: '00000000-0000-4000-8000-00000000000a' }],
    deal_steps: [
      {
        id: DEAL_STEP_ID,
        deal_id: 'deal-1',
        step_id: STEP_KEY,
        removed_at: overrides.removed ? '2026-10-13T08:00:00.000Z' : null,
        definition: { title: 'Weekly update' },
        assigned_to: null,
        status: 'pending',
      },
    ],
    deal_step_skill_runs: [
      {
        id: ROOT_ID,
        deal_step_id: DEAL_STEP_ID,
        source: 'execution',
        outcome: 'succeeded',
        result_text: TEXT,
        skill_id: '2d362e20-0709-4ba0-bbd7-d21831148282',
        version_id: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
        mount_name: null,
        mount_version: null,
        digest: 'a'.repeat(64),
        model: 'sonnet',
        created_at: '2026-10-13T09:00:00.000Z',
      },
      {
        id: FAILED_RUN_ID,
        deal_step_id: DEAL_STEP_ID,
        source: 'execution',
        outcome: 'failed',
        result_text: null,
        created_at: '2026-10-13T08:30:00.000Z',
      },
      {
        id: STRANGER_ID,
        deal_step_id: OTHER_DEAL_STEP_ID,
        source: 'execution',
        outcome: 'succeeded',
        result_text: TEXT,
        skill_id: '2d362e20-0709-4ba0-bbd7-d21831148282',
        version_id: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
        mount_name: null,
        mount_version: null,
        digest: 'b'.repeat(64),
        model: 'sonnet',
        created_at: '2026-10-13T09:30:00.000Z',
      },
    ],
  });
}

async function apply(body: unknown, runId: string = ROOT_ID) {
  const { POST } = await import(
    '@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/route'
  );
  return POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ dealId: 'deal-1', stepId: STEP_KEY, runId }),
  });
}

function revisions() {
  return (state.store?.tables.deal_step_skill_runs ?? []).filter((row) => row.source === 'revision');
}

function audits() {
  return (state.store?.tables.audit_log ?? []).map((row) => row.detail as Record<string, unknown>);
}

const HAND = { kind: 'hand', start: 8, end: 21, text: 'Revenue rose.' };

describe('POST a revision of a run output', () => {
  beforeEach(() => {
    state.flags = { skill_authoring: true, skill_output_revisions: true };
    state.capabilities = { canAssign: false, canComplete: true, canEditWork: true };
    state.store = seed();
    state.afterTasks.length = 0;
    state.configured = true;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('answers 404 while the flag is off', async () => {
    state.flags.skill_output_revisions = false;

    expect((await apply({ parentId: ROOT_ID, edits: [HAND] })).status).toBe(404);
    expect(revisions()).toHaveLength(0);
  });

  it('refuses a caller who cannot edit the step', async () => {
    state.capabilities = { canAssign: false, canComplete: false, canEditWork: false };

    expect((await apply({ parentId: ROOT_ID, edits: [HAND] })).status).toBe(403);
  });

  it('refuses to revise the output of a removed step', async () => {
    state.store = seed({ removed: true });

    expect((await apply({ parentId: ROOT_ID, edits: [HAND] })).status).toBe(409);
  });

  it('answers 500 and writes nothing when the chain cannot be read', async () => {
    state.store?.failReadsFrom.add('deal_step_skill_runs:many');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await apply({ parentId: ROOT_ID, edits: [HAND] });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'The run could not be read' });
    expect(revisions()).toHaveLength(0);
    log.mockRestore();
  });

  it('answers 404 for a run that is not on this step', async () => {
    expect((await apply({ parentId: STRANGER_ID, edits: [HAND] }, STRANGER_ID)).status).toBe(404);
    expect(revisions()).toHaveLength(0);
  });

  it('refuses a run that failed, which has no output to revise', async () => {
    expect((await apply({ parentId: FAILED_RUN_ID, edits: [HAND] }, FAILED_RUN_ID)).status).toBe(409);
  });

  it('answers 409 when the parent is no longer the head', async () => {
    const response = await apply({ parentId: SECOND_ID, edits: [HAND] });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: HEAD_MOVED_MESSAGE });
    expect(revisions()).toHaveLength(0);
  });

  it('refuses an edit that cuts into a block', async () => {
    const response = await apply({ parentId: ROOT_ID, edits: [{ ...HAND, start: 9 }] });

    expect(response.status).toBe(422);
    expect(revisions()).toHaveLength(0);
  });

  it('applies hand edits at once and answers 201 with the revision id', async () => {
    const response = await apply({ parentId: ROOT_ID, edits: [HAND] });
    const body = (await response.json()) as { revisionId: string };

    expect(response.status).toBe(201);
    expect(revisions()).toHaveLength(1);
    expect(revisions()[0]).toMatchObject({
      id: body.revisionId,
      outcome: 'succeeded',
      result_text: ['# Memo', '', 'Revenue rose.', '', '- one', '- two'].join('\n'),
    });
    expect(state.afterTasks).toHaveLength(0);
  });

  it('restores an earlier version as a new revision', async () => {
    const first = (await (await apply({ parentId: ROOT_ID, edits: [HAND] })).json()) as {
      revisionId: string;
    };
    vi.resetModules();

    const response = await apply({ parentId: first.revisionId, restoreOf: ROOT_ID });

    expect(response.status).toBe(201);
    expect(revisions()).toHaveLength(2);
    expect(revisions()[1]).toMatchObject({
      parent_run_id: first.revisionId,
      result_text: TEXT,
      inputs: { kind: 'restore', restoredFrom: ROOT_ID },
    });
  });

  it('refuses to restore the current version, and a version from elsewhere', async () => {
    expect((await apply({ parentId: ROOT_ID, restoreOf: ROOT_ID })).status).toBe(422);

    vi.resetModules();
    expect((await apply({ parentId: ROOT_ID, restoreOf: STRANGER_ID })).status).toBe(404);
    expect(revisions()).toHaveLength(0);
  });

  const COMMENT = { kind: 'comment', start: 8, end: 21, comment: 'It rose 12%. Say so.' };

  function stubBench() {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as { passages: { id: string }[] };
      calls.push(sent);
      const encoder = new TextEncoder();
      const frames = [
        { type: 'replacements', items: [{ id: sent.passages[0]?.id, text: 'Revenue rose 12%.' }] },
        { type: 'done', costUsd: 0.04, model: 'sonnet', skillMounted: true },
      ];
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const frame of frames) {
              controller.enqueue(encoder.encode(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`));
            }
            controller.close();
          },
        }),
      );
    });
    return calls;
  }

  it('answers 202 for a batch with a comment, then records the revision under that id', async () => {
    const calls = stubBench();

    const response = await apply({ parentId: ROOT_ID, edits: [COMMENT] });
    const body = (await response.json()) as { revisionId: string };

    expect(response.status).toBe(202);
    expect(revisions()).toHaveLength(0);
    expect(audits()).toEqual([
      expect.objectContaining({ phase: 'started', revisionId: body.revisionId, edits: { comment: 1 } }),
    ]);

    await Promise.all(state.afterTasks.map((task) => task()));

    expect(calls).toHaveLength(1);
    expect(revisions()[0]).toMatchObject({
      id: body.revisionId,
      outcome: 'succeeded',
      result_text: ['# Memo', '', 'Revenue rose 12%.', '', '- one', '- two'].join('\n'),
    });
  });

  it('names the step on the started audit row without the comment', async () => {
    stubBench();

    await apply({ parentId: ROOT_ID, edits: [COMMENT] });
    await Promise.all(state.afterTasks.map((task) => task()));

    expect(audits().map((detail) => detail.title)).toEqual(['Weekly update', 'Weekly update']);
    expect(JSON.stringify(state.store?.tables.audit_log)).not.toContain('It rose 12%');
  });

  it('sends a mixed batch through the engine path', async () => {
    stubBench();

    const response = await apply({
      parentId: ROOT_ID,
      edits: [COMMENT, { kind: 'hand', start: 23, end: 28, text: '- uno' }],
    });

    expect(response.status).toBe(202);
    await Promise.all(state.afterTasks.map((task) => task()));
    expect(revisions()[0]?.result_text).toBe(
      ['# Memo', '', 'Revenue rose 12%.', '', '- uno', '- two'].join('\n'),
    );
  });

  it('refuses a hand edit that would change the blocks around it and writes nothing', async () => {
    const response = await apply({
      parentId: ROOT_ID,
      edits: [{ kind: 'hand', start: 29, end: 34, text: 'two, rewritten' }],
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: STRUCTURE_PROBLEM });
    expect(revisions()).toHaveLength(0);
  });

  it('refuses a mixed batch whose hand edit would change the blocks around it before it starts', async () => {
    state.configured = false;

    const response = await apply({
      parentId: ROOT_ID,
      edits: [COMMENT, { kind: 'hand', start: 29, end: 34, text: 'two, rewritten' }],
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: STRUCTURE_PROBLEM });
    expect(audits()).toHaveLength(0);
    expect(state.afterTasks).toHaveLength(0);
  });

  it('refuses a mixed batch whose hand edits alone make the output too long before it starts', async () => {
    const long = `# Memo\n\n${'x'.repeat(100_000)}\n\nEnd.`;
    const root = state.store?.tables.deal_step_skill_runs?.find((row) => row.id === ROOT_ID);
    if (root) root.result_text = long;
    const end = long.indexOf('End.');
    state.configured = false;

    const response = await apply({
      parentId: ROOT_ID,
      edits: [
        { kind: 'comment', start: 8, end: 8 + 100_000, comment: 'Tighten this.' },
        { kind: 'hand', start: end, end: end + 4, text: 'y'.repeat(100_000) },
      ],
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'The revised output is too long.' });
    expect(audits()).toHaveLength(0);
    expect(state.afterTasks).toHaveLength(0);
  });

  it('answers 503 and records nothing when the skill service is not configured', async () => {
    state.configured = false;

    const response = await apply({ parentId: ROOT_ID, edits: [COMMENT] });

    expect(response.status).toBe(503);
    expect(audits()).toHaveLength(0);
    expect(state.afterTasks).toHaveLength(0);
  });

  it('does not start the edit when its audit row cannot be written', async () => {
    const calls = stubBench();
    state.store?.failInsertsInto.add('audit_log');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await apply({ parentId: ROOT_ID, edits: [COMMENT] });

    expect(response.status).toBe(500);
    expect(state.afterTasks).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(revisions()).toHaveLength(0);
    log.mockRestore();
  });

  it('lets the client wait longer than the batch may run', async () => {
    const { maxDuration } = await import(
      '@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/route'
    );

    expect(maxDuration * 1000).toBeLessThan(APPLY_DEADLINE_MS);
  });
});
