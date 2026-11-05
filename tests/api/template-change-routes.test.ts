import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

import { MVP_DEAL_RAIL, orderedSteps } from '@/lib/rail/dealRail';
import { GATE0_STEP_IDS } from '@/lib/rail/gate0';
import type { ImportRequest } from '@/lib/railTemplates/types';

const TENANT = '22222222-2222-4222-8222-222222222222';
const REVISION = '33333333-3333-4333-8333-333333333333';
const DIGEST = 'd'.repeat(64);
const FOREIGN = '44444444-4444-4444-8444-444444444444';
const SENTINEL = 'relation "secret_table" does not exist';

const STORED_SET = {
  template: { id: 'template-1', name: 'Standard sell-side' },
  baseRevision: { id: 'revision-1', label: 'v1', savedAt: '2026-09-02T15:00:00.000Z' },
  currentRevision: {
    id: 'revision-2',
    label: 'v2',
    savedAt: '2026-10-02T15:00:00.000Z',
    savedBy: { id: 'user-2', name: 'Avery Lindqvist' },
  },
  changes: [
    {
      id: 'added:custom-fairness',
      kind: 'added',
      title: 'Fairness opinion',
      summary: 'Independent fairness opinion.',
      phaseIndex: 4,
      anchor: { position: 'after', stepId: 'p4-s50' },
      decision: null,
    },
    { id: 'added:p4-s50', kind: 'added', title: null, summary: null, phaseIndex: 4, anchor: null, decision: null },
    { id: 'removed:p5-s53', kind: 'removed', stepId: 'p5-s53', title: null, phaseIndex: 5, decision: 'discarded' },
  ],
};

function catalogue(id: string) {
  const entry = orderedSteps(MVP_DEAL_RAIL).find((step) => step.id === id);
  if (!entry) throw new Error(`missing catalogue step ${id}`);
  return entry;
}

type RpcResult = { data: unknown; error: { code: string; message: string } | null };

const state = {
  flagOn: true,
  skillAuthoring: true,
  wall: 'internal' as 'internal' | 'external' | 'error',
  canAccess: true,
  capable: true as boolean | 'unreadable',
  rpc: {} as Record<string, RpcResult>,
  rpcCalls: [] as { name: string; params: Record<string, unknown> }[],
  importCalls: [] as { requestId: string; request: ImportRequest }[],
  importError: null as Error | null,
  importForeignSkill: false,
};

vi.mock('@/lib/api/v1/requireFlag', () => ({
  requireFlag: async () =>
    state.flagOn ? null : NextResponse.json({ error: 'Not found' }, { status: 404 }),
  isFlagEnabled: async () => state.skillAuthoring,
}));

vi.mock('@/lib/railTemplates/providerClient', () => ({
  importTemplateSkills: async (requestId: string, request: ImportRequest) => {
    state.importCalls.push({ requestId, request });
    if (state.importError) throw state.importError;
    return {
      requestId,
      projectId: request.projectId,
      skills: request.targets.map((target) => ({
        key: target.key,
        binding: {
          skillId: state.importForeignSkill ? FOREIGN : target.skillId,
          versionId: target.versionId,
          digest: DIGEST,
        },
      })),
    };
  },
}));

vi.mock('@/lib/api/v1/access', () => ({
  classifyInternalUser: async () => state.wall,
  userCanAccessDeal: async () => state.canAccess,
  resolveDealStepStructureCapability: async () => state.capable,
}));

vi.mock('@/lib/dataroom/steps', () => ({
  loadDealByIdOrCode: async () => ({ id: 'deal-1', code: 'HARBR-2026-001' }),
}));

vi.mock('@/lib/api/v1/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: async () => ({
    ok: true,
    user: { id: 'user-1' },
    admin: {
      rpc: async (name: string, params: Record<string, unknown>) => {
        state.rpcCalls.push({ name, params });
        return state.rpc[name] ?? { data: null, error: null };
      },
    },
  }),
}));

async function read() {
  const { GET } = await import('@/app/api/v1/deals/[dealId]/rail/template-changes/route');
  return GET(new Request('http://localhost'), { params: Promise.resolve({ dealId: 'deal-1' }) });
}

async function decide(body: unknown, changeId = 'added:custom-fairness') {
  const { POST } = await import(
    '@/app/api/v1/deals/[dealId]/rail/template-changes/[changeId]/decision/route'
  );
  return POST(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ dealId: 'deal-1', changeId }) },
  );
}

function calls() {
  return state.rpcCalls.map((call) => call.name);
}

async function reopen() {
  const { DELETE } = await import(
    '@/app/api/v1/deals/[dealId]/rail/template-changes/[changeId]/decision/route'
  );
  return DELETE(new Request('http://localhost', { method: 'DELETE' }), {
    params: Promise.resolve({ dealId: 'deal-1', changeId: 'removed:p5-s53' }),
  });
}

describe('template change routes', () => {
  beforeEach(() => {
    state.flagOn = true;
    state.skillAuthoring = true;
    state.wall = 'internal';
    state.canAccess = true;
    state.capable = true;
    state.rpc = {
      deal_template_changes: { data: STORED_SET, error: null },
      deal_template_change_skill: {
        data: { tenantId: TENANT, revisionId: REVISION, skillKey: null },
        error: null,
      },
      deal_template_change_decide: { data: STORED_SET, error: null },
      deal_template_change_reopen: { data: { changeId: 'removed:p5-s53', decision: 'reopened' }, error: null },
    };
    state.rpcCalls = [];
    state.importCalls = [];
    state.importError = null;
    state.importForeignSkill = false;
    vi.resetModules();
  });

  it.each([
    ['GET', read],
    ['POST', () => decide({ decision: 'accepted', revisionId: REVISION })],
    ['DELETE', reopen],
  ])('is absent with the flag off (%s)', async (_method, call) => {
    state.flagOn = false;
    expect((await call()).status).toBe(404);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it.each([
    ['GET', read],
    ['POST', () => decide({ decision: 'accepted', revisionId: REVISION })],
    ['DELETE', reopen],
  ])('answers a seated external member as if the route did not exist (%s)', async (_method, call) => {
    state.wall = 'external';
    const response = await call();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('fails closed when the profile cannot be read', async () => {
    state.wall = 'error';
    expect((await read()).status).toBe(500);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it.each([
    ['internal', 'GET', read],
    ['internal', 'POST', () => decide({ decision: 'accepted', revisionId: REVISION })],
    ['internal', 'DELETE', reopen],
    ['external', 'GET', read],
    ['external', 'POST', () => decide({ decision: 'accepted', revisionId: REVISION })],
    ['external', 'DELETE', reopen],
  ] as const)(
    'answers an unseated %s user exactly like a missing deal (%s, D65)',
    async (wall, _method, call) => {
      state.wall = wall;
      state.canAccess = false;
      const response = await call();
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Deal not found' });
      expect(state.rpcCalls).toHaveLength(0);
    },
  );

  it('returns the change set with catalogue titles for house steps', async () => {
    const response = await read();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { changeSet: typeof STORED_SET };
    expect(state.rpcCalls[0].name).toBe('deal_template_changes');
    expect(state.rpcCalls[0].params.p_deal_id).toBe('deal-1');
    expect(state.rpcCalls[0].params.p_protected_ids).toEqual(expect.arrayContaining([...GATE0_STEP_IDS]));
    expect(body.changeSet.changes[0]).toEqual(STORED_SET.changes[0]);
    expect(body.changeSet.changes[1]).toMatchObject({
      title: catalogue('p4-s50').title,
      summary: catalogue('p4-s50').description,
    });
    expect(body.changeSet.changes[2]).toMatchObject({ title: catalogue('p5-s53').title, decision: 'discarded' });
  });

  it('returns a null change set for a deal with nothing to review', async () => {
    state.rpc.deal_template_changes = { data: null, error: null };
    expect(await (await read()).json()).toEqual({ changeSet: null });
  });

  it('answers a read failure with fixed copy', async () => {
    state.rpc.deal_template_changes = { data: null, error: { code: 'XX000', message: SENTINEL } };
    const response = await read();
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('secret_table');
    expect(JSON.parse(text)).toEqual({ error: 'The template changes could not be read. Try again.' });
  });

  it('answers a decision failure with fixed copy', async () => {
    state.rpc.deal_template_change_decide = { data: null, error: { code: 'XX000', message: SENTINEL } };
    const response = await decide({ decision: 'accepted', revisionId: REVISION });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('secret_table');
    expect(JSON.parse(text)).toEqual({ error: 'The decision was not recorded. Try again.' });
  });

  it('answers a skill lookup failure with fixed copy, imports nothing and does not decide', async () => {
    state.rpc.deal_template_change_skill = { data: null, error: { code: 'XX000', message: SENTINEL } };
    const response = await decide({ decision: 'accepted', revisionId: REVISION });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('secret_table');
    expect(JSON.parse(text)).toEqual({ error: 'The decision was not recorded. Try again.' });
    expect(Object.keys(JSON.parse(text))).toEqual(['error']);
    expect(state.importCalls).toHaveLength(0);
    expect(calls()).toEqual(['deal_template_change_skill']);
  });

  it('answers a reopen failure with fixed copy', async () => {
    state.rpc.deal_template_change_reopen = { data: null, error: { code: 'XX000', message: SENTINEL } };
    const response = await reopen();
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('secret_table');
    expect(JSON.parse(text)).toEqual({ error: 'The decision was not reopened. Try again.' });
  });

  it('answers a read failure after a reopen with fixed copy', async () => {
    state.rpc.deal_template_changes = { data: null, error: { code: 'XX000', message: SENTINEL } };
    const response = await reopen();
    expect(response.status).toBe(500);
    expect(calls()).toEqual(['deal_template_change_reopen', 'deal_template_changes']);
    const text = await response.text();
    expect(text).not.toContain('secret_table');
    expect(JSON.parse(text)).toEqual({ error: 'The template changes could not be read. Try again.' });
  });

  it('refuses a decision from a member without structure authority', async () => {
    state.capable = false;
    expect((await decide({ decision: 'accepted', revisionId: REVISION })).status).toBe(403);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('surfaces a permission lookup failure as a server error', async () => {
    state.capable = 'unreadable';
    expect((await decide({ decision: 'accepted', revisionId: REVISION })).status).toBe(500);
  });

  it.each([{ decision: 'reopened' }, { decision: 1 }, {}, null])(
    'rejects a body that is not a decision (%j)',
    async (body) => {
      expect((await decide(body)).status).toBe(400);
      expect(state.rpcCalls).toHaveLength(0);
    },
  );

  it.each([
    ['missing', { decision: 'accepted' }],
    ['null', { decision: 'accepted', revisionId: null }],
    ['a number', { decision: 'accepted', revisionId: 5 }],
    ['not a uuid', { decision: 'accepted', revisionId: 'not-a-uuid' }],
  ])('rejects a decision whose revisionId is %s', async (_label, body) => {
    const response = await decide(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'revisionId must be the template version under review',
    });
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('accepts an added step with no skill without calling the skill service', async () => {
    const response = await decide({ decision: 'accepted', revisionId: REVISION });

    expect(response.status).toBe(200);
    expect(calls()).toEqual(['deal_template_change_skill', 'deal_template_change_decide']);
    expect(state.importCalls).toHaveLength(0);
    expect(state.rpcCalls[0].params).toMatchObject({
      p_deal_id: 'deal-1',
      p_change_id: 'added:custom-fairness',
      p_revision_id: REVISION,
    });
    expect(state.rpcCalls[1].params).toMatchObject({
      p_deal_id: 'deal-1',
      p_actor_id: 'user-1',
      p_change_id: 'added:custom-fairness',
      p_decision: 'accepted',
      p_revision_id: REVISION,
      p_import: null,
    });
    expect(state.rpcCalls[1].params.p_protected_ids).toEqual(expect.arrayContaining([...GATE0_STEP_IDS]));
    const body = (await response.json()) as { changeSet: typeof STORED_SET };
    expect(body.changeSet.template).toEqual(STORED_SET.template);
  });

  it('imports the skill of an added step into the deal, then decides with that import', async () => {
    state.rpc.deal_template_change_skill = {
      data: { tenantId: TENANT, revisionId: REVISION, skillKey: 's0' },
      error: null,
    };

    const response = await decide({ decision: 'accepted', revisionId: REVISION });

    expect(response.status).toBe(200);
    expect(state.importCalls).toHaveLength(1);
    const { requestId, request } = state.importCalls[0];
    expect(request).toMatchObject({ companyId: TENANT, revisionId: REVISION, projectId: 'deal-1' });
    expect(request.targets).toHaveLength(1);
    expect(request.targets[0].key).toBe('s0');
    expect(calls()).toEqual(['deal_template_change_skill', 'deal_template_change_decide']);
    expect(state.rpcCalls[0].params.p_revision_id).toBe(REVISION);
    expect(state.rpcCalls[1].params.p_revision_id).toBe(REVISION);
    expect(state.rpcCalls[1].params.p_import).toEqual({
      requestId,
      key: 's0',
      binding: {
        skillId: request.targets[0].skillId,
        versionId: request.targets[0].versionId,
        digest: DIGEST,
      },
    });
  });

  it('imports nothing for a change that is no longer offered', async () => {
    state.rpc.deal_template_change_skill = { data: null, error: { code: 'P0001', message: 'stale_change' } };

    const response = await decide({ decision: 'accepted', revisionId: REVISION });

    expect(response.status).toBe(409);
    expect(await response.clone().json()).toEqual({ error: 'This change is no longer offered' });
    expect((await response.json()).error).toBe('This change is no longer offered');
    expect(state.importCalls).toHaveLength(0);
    expect(calls()).toEqual(['deal_template_change_skill']);
  });

  it('refuses an added skill step while skills are not enabled, and imports nothing', async () => {
    state.rpc.deal_template_change_skill = {
      data: { tenantId: TENANT, revisionId: REVISION, skillKey: 's0' },
      error: null,
    };
    state.skillAuthoring = false;

    const response = await decide({ decision: 'accepted', revisionId: REVISION });

    expect(response.status).toBe(409);
    expect(await response.clone().json()).toEqual({
      error: 'Skills are not enabled here, so this step was not added.',
      code: 'skill_step_not_added',
    });
    expect((await response.json()).error).toBe('Skills are not enabled here, so this step was not added.');
    expect(state.importCalls).toHaveLength(0);
    expect(calls()).toEqual(['deal_template_change_skill']);
  });

  it.each([
    ['skill_unavailable', 409, 'The skill on this step is no longer available, so the step was not added.'],
    ['provider_unavailable', 503, 'The skill service did not answer, so the step was not added.'],
    ['invalid_command', 500, 'The skill on this step could not be copied, so the step was not added.'],
  ] as const)('leaves the change undecided when the import fails with %s', async (code, status, copy) => {
    state.rpc.deal_template_change_skill = {
      data: { tenantId: TENANT, revisionId: REVISION, skillKey: 's0' },
      error: null,
    };
    const { TemplateError } = await import('@/lib/railTemplates/types');
    state.importError = new TemplateError(code, 'provider words');

    const response = await decide({ decision: 'accepted', revisionId: REVISION });

    expect(response.status).toBe(status);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(copy);
    expect(body.error).not.toContain('—');
    expect(body).toEqual({ error: copy, code: 'skill_step_not_added' });
    expect(calls()).toEqual(['deal_template_change_skill']);
  });

  it('refuses a receipt that names another skill, and does not decide', async () => {
    state.rpc.deal_template_change_skill = {
      data: { tenantId: TENANT, revisionId: REVISION, skillKey: 's0' },
      error: null,
    };
    state.importForeignSkill = true;

    const response = await decide({ decision: 'accepted', revisionId: REVISION });

    expect(response.status).toBe(502);
    expect(await response.clone().json()).toEqual({
      error: 'The skill service returned an answer Conductia could not use, so the step was not added.',
      code: 'skill_step_not_added',
    });
    expect(((await response.json()) as { error: string }).error).toBe(
      'The skill service returned an answer Conductia could not use, so the step was not added.',
    );
    expect(state.importCalls).toHaveLength(1);
    expect(calls()).toEqual(['deal_template_change_skill']);
  });

  it('still accepts a manual added step while skills are not enabled', async () => {
    state.skillAuthoring = false;

    const response = await decide({ decision: 'accepted', revisionId: REVISION });

    expect(response.status).toBe(200);
    expect(state.importCalls).toHaveLength(0);
    expect(calls()).toEqual(['deal_template_change_skill', 'deal_template_change_decide']);
    expect(state.rpcCalls[1].params.p_import).toBeNull();
  });

  it.each([
    ['a discard', { decision: 'discarded', revisionId: REVISION }, 'added:custom-fairness'],
    ['an accepted removal', { decision: 'accepted', revisionId: REVISION }, 'removed:p5-s53'],
  ])('does not look for a skill on %s', async (_label, body, changeId) => {
    const response = await decide(body, changeId);

    expect(response.status).toBe(200);
    expect(calls()).toEqual(['deal_template_change_decide']);
    expect(state.rpcCalls[0].params.p_import).toBeNull();
    expect(state.importCalls).toHaveLength(0);
  });

  it('answers 409 when the change is no longer offered', async () => {
    state.rpc.deal_template_change_decide = { data: null, error: { code: 'P0001', message: 'stale_change' } };
    const response = await decide({ decision: 'discarded', revisionId: REVISION });
    expect(response.status).toBe(409);
    expect(await response.clone().json()).toEqual({ error: 'This change is no longer offered' });
    expect((await response.json()).error).toBe('This change is no longer offered');
  });

  it('reopens a discarded change and returns the change set', async () => {
    const response = await reopen();
    expect(response.status).toBe(200);
    expect(state.rpcCalls.map((call) => call.name)).toEqual([
      'deal_template_change_reopen',
      'deal_template_changes',
    ]);
    expect(state.rpcCalls[0].params).toEqual({
      p_deal_id: 'deal-1',
      p_actor_id: 'user-1',
      p_change_id: 'removed:p5-s53',
    });
    expect(((await response.json()) as { changeSet: unknown }).changeSet).not.toBeNull();
  });

  it('answers 409 for a change that cannot be reopened', async () => {
    state.rpc.deal_template_change_reopen = { data: null, error: { code: 'P0001', message: 'not_reopenable' } };
    const response = await reopen();
    expect(response.status).toBe(409);
    expect(state.rpcCalls).toHaveLength(1);
  });

  it('refuses a reopen from a member without structure authority', async () => {
    state.capable = false;
    expect((await reopen()).status).toBe(403);
    expect(state.rpcCalls).toHaveLength(0);
  });
});
