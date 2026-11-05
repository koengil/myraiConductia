import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GATE0_STEP_IDS } from '@/lib/rail/gate0';
import { TemplateError } from '@/lib/railTemplates/types';

const TEMPLATE = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const CANDIDATE = '33333333-3333-4333-8333-333333333333';
const DIGEST = 'a'.repeat(64);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Actor = { ok: true; companyId: string } | { ok: false; status: number; error: string };
type RpcResult = { data: unknown; error: { code: string; message: string } | null };

const SKILL = {
  key: 's0',
  name: 'Buyer long list',
  contract: { purpose: 'p', expectedInput: 'i', expectedOutput: 'o' },
  source: { kind: 'candidate', candidateId: CANDIDATE, digest: DIGEST },
};

function checked(skills: unknown[]): RpcResult {
  return {
    data: {
      tenantId: TENANT,
      manifest: { schemaVersion: 2, censusVersion: 'c', steps: [], skills },
    },
    error: null,
  };
}

const PUBLISHED = { templateId: 'tpl-1', revisionId: 'rev-3', version: 3, stepCount: 61, skillCount: 0 };

const state = {
  actor: { ok: true, companyId: 'co-bank' } as Actor,
  skillAuthoring: true,
  rpc: {} as Record<string, RpcResult>,
  rpcCalls: [] as Array<{ name: string; params: Record<string, unknown> }>,
  retainCalls: [] as Array<{ revisionId: string; request: Record<string, unknown> }>,
  retainError: null as Error | null,
};

vi.mock('@/lib/rail/railTemplateAccess', () => ({
  requireTemplateActor: async () => state.actor,
}));

vi.mock('@/lib/api/v1/requireFlag', () => ({
  isFlagEnabled: async () => state.skillAuthoring,
}));

vi.mock('@/lib/railTemplates/providerClient', () => ({
  retainTemplateSkills: async (revisionId: string, request: Record<string, unknown>) => {
    state.retainCalls.push({ revisionId, request });
    if (state.retainError) throw state.retainError;
    return { revisionId, assets: [{ key: 's0', packageDigest: DIGEST }] };
  },
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

async function publish(templateId = TEMPLATE) {
  const { POST } = await import('@/app/api/v1/rail-catalog/[templateId]/publish/route');
  return POST(new Request('http://localhost', { method: 'POST' }), {
    params: Promise.resolve({ templateId }),
  });
}

function calls() {
  return state.rpcCalls.map((call) => call.name);
}

describe('POST /api/v1/rail-catalog/[templateId]/publish', () => {
  beforeEach(() => {
    state.actor = { ok: true, companyId: 'co-bank' };
    state.skillAuthoring = true;
    state.rpc = {
      rail_catalog_publish_check: checked([]),
      publish_rail_template: {
        data: PUBLISHED,
        error: null,
      },
    };
    state.rpcCalls = [];
    state.retainCalls = [];
    state.retainError = null;
  });

  it('refuses a caller who cannot configure rail templates', async () => {
    state.actor = { ok: false, status: 403, error: 'Not permitted to configure rail templates.' };

    const response = await publish();

    expect(response.status).toBe(403);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it.each(['default', 'not-a-template'])('answers 404 for %s without publishing', async (templateId) => {
    const response = await publish(templateId);

    expect(response.status).toBe(404);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('publishes a draft with no skills without calling the skill service', async () => {
    const response = await publish();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PUBLISHED);
    expect(calls()).toEqual(['rail_catalog_publish_check', 'publish_rail_template']);
    expect(state.retainCalls).toHaveLength(0);
    expect(state.rpcCalls[0].params).toMatchObject({ p_template_id: TEMPLATE, p_company_id: 'co-bank' });
    expect(state.rpcCalls[0].params.p_protected_ids).toEqual(expect.arrayContaining([...GATE0_STEP_IDS]));
    expect(state.rpcCalls[1].params).toMatchObject({
      p_template_id: TEMPLATE,
      p_company_id: 'co-bank',
      p_actor_id: 'user-1',
      p_revision_id: null,
      p_receipt: null,
    });
    expect(state.rpcCalls[1].params.p_protected_ids).toEqual(expect.arrayContaining([...GATE0_STEP_IDS]));
  });

  it('retains the skills under a new revision id, then publishes with that id and the receipt', async () => {
    state.rpc.rail_catalog_publish_check = checked([SKILL]);

    const response = await publish();

    expect(response.status).toBe(200);
    expect(state.retainCalls).toHaveLength(1);
    const { revisionId, request } = state.retainCalls[0];
    expect(revisionId).toMatch(UUID);
    expect(request).toEqual({ companyId: TENANT, skills: [{ key: 's0', source: SKILL.source }] });
    expect(calls()).toEqual(['rail_catalog_publish_check', 'publish_rail_template']);
    expect(state.rpcCalls[1].params).toMatchObject({
      p_revision_id: revisionId,
      p_receipt: { revisionId, assets: [{ key: 's0', packageDigest: DIGEST }] },
    });
    expect(state.rpcCalls[1].params.p_protected_ids).toEqual(expect.arrayContaining([...GATE0_STEP_IDS]));
  });

  it.each([
    ['nothing_to_publish', 'P0002', 'There are no changes to publish.'],
    ['name_taken', 'P0002', 'Another saved rail in this company already uses this name.'],
    [
      'missing_protected_step',
      'P0004',
      'This template is missing a step every deal needs, so it cannot be published.',
    ],
  ])('answers 409 for %s from the check, before any copy is made', async (message, code, copy) => {
    state.rpc.rail_catalog_publish_check = { data: null, error: { code, message } };

    const response = await publish();

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(copy);
    expect(body.error).not.toContain('—');
    expect(state.retainCalls).toHaveLength(0);
    expect(calls()).toEqual(['rail_catalog_publish_check']);
  });

  it.each(['template_removed', 'template_missing'])('answers 404 for %s', async (message) => {
    state.rpc.rail_catalog_publish_check = { data: null, error: { code: 'P0003', message } };

    const response = await publish();

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe('Template not found.');
  });

  it('refuses a draft with skills while skills are not enabled, and copies nothing', async () => {
    state.rpc.rail_catalog_publish_check = checked([SKILL]);
    state.skillAuthoring = false;

    const response = await publish();

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe(
      'Skills are not enabled here, so this template was not published.',
    );
    expect(state.retainCalls).toHaveLength(0);
    expect(calls()).toEqual(['rail_catalog_publish_check']);
  });

  it('answers 409 and publishes nothing when a skill is no longer available', async () => {
    state.rpc.rail_catalog_publish_check = checked([SKILL]);
    state.retainError = new TemplateError('skill_unavailable', 'gone');

    const response = await publish();

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe(
      'A skill on this template is no longer available, so it was not published.',
    );
    expect(calls()).toEqual(['rail_catalog_publish_check']);
  });

  it('answers 503 and publishes nothing when the skill service does not answer', async () => {
    state.rpc.rail_catalog_publish_check = checked([SKILL]);
    state.retainError = new TemplateError('provider_unavailable', 'down');

    const response = await publish();

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe(
      'The skill service did not answer, so nothing was published.',
    );
    expect(calls()).toEqual(['rail_catalog_publish_check']);
  });

  it('answers 409 when the draft changed between the check and the publish', async () => {
    state.rpc.rail_catalog_publish_check = checked([SKILL]);
    state.rpc.publish_rail_template = { data: null, error: { code: 'P0002', message: 'draft_changed' } };

    const response = await publish();

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe(
      'This template changed while it was being published. Publish again.',
    );
  });

  it('answers 409 when the publish itself finds the name taken', async () => {
    state.rpc.publish_rail_template = { data: null, error: { code: 'P0002', message: 'name_taken' } };

    const response = await publish();

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe(
      'Another saved rail in this company already uses this name.',
    );
    expect(calls()).toEqual(['rail_catalog_publish_check', 'publish_rail_template']);
  });

  it('answers 500 for a check it cannot read, and copies nothing', async () => {
    state.rpc.rail_catalog_publish_check = {
      data: { tenantId: TENANT, manifest: { skills: 'nope' } },
      error: null,
    };

    const response = await publish();

    expect(response.status).toBe(500);
    expect(state.retainCalls).toHaveLength(0);
    expect(calls()).toEqual(['rail_catalog_publish_check']);
  });

  it('answers 500 for a check whose skill source it cannot read, and copies nothing', async () => {
    state.rpc.rail_catalog_publish_check = checked([
      { ...SKILL, source: { kind: 'candidate', candidateId: 'not-a-uuid', digest: DIGEST } },
    ]);

    const response = await publish();

    expect(response.status).toBe(500);
    expect(state.retainCalls).toHaveLength(0);
    expect(calls()).toEqual(['rail_catalog_publish_check']);
  });

  it('answers 502 when the skill service returns an answer that cannot be used', async () => {
    state.rpc.rail_catalog_publish_check = checked([SKILL]);
    state.retainError = new TemplateError('provider_unavailable', 'bad receipt', 502);

    const response = await publish();

    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toBe(
      'The skill service returned an answer Conductia could not use, so nothing was published.',
    );
    expect(calls()).toEqual(['rail_catalog_publish_check']);
  });

  it('answers 500 when the skills cannot be copied for another reason', async () => {
    state.rpc.rail_catalog_publish_check = checked([SKILL]);
    state.retainError = new TemplateError('invalid_command', 'refused');

    const response = await publish();

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toBe(
      'The skills on this template could not be copied, so nothing was published.',
    );
    expect(calls()).toEqual(['rail_catalog_publish_check']);
  });

  it('answers 500 for an unexpected database error without repeating its text', async () => {
    state.rpc.publish_rail_template = {
      data: null,
      error: { code: 'XX000', message: 'connection lost to db-internal-7' },
    };

    const response = await publish();

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain('connection lost');
    expect(JSON.parse(body)).toEqual({ error: 'The template was not published. Try again.' });
  });

  it('answers 500 for an unexpected error from the publish check without repeating its text', async () => {
    state.rpc.rail_catalog_publish_check = {
      data: null,
      error: { code: 'XX000', message: 'connection lost to db-internal-7' },
    };

    const response = await publish();

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain('connection lost');
    expect(JSON.parse(body)).toEqual({ error: 'The template was not published. Try again.' });
    expect(calls()).toEqual(['rail_catalog_publish_check']);
    expect(state.retainCalls).toHaveLength(0);
  });
});
