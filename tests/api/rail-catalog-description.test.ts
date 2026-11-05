import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEMPLATE = '11111111-1111-4111-8111-111111111111';

const state = {
  rpcError: null as { code: string; message: string } | null,
  rpcCalls: [] as Array<{ name: string; params: Record<string, unknown> }>,
};

vi.mock('@/lib/rail/railTemplateAccess', () => ({
  requireTemplateActor: async () => ({ ok: true, companyId: 'co-bank' }),
}));

vi.mock('@/lib/api/v1/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: async () => ({
    ok: true,
    user: { id: 'user-1' },
    admin: {
      rpc: async (name: string, params: Record<string, unknown>) => {
        state.rpcCalls.push({ name, params });
        return {
          data: state.rpcError
            ? null
            : { id: TEMPLATE, description: params.p_description, changed: true },
          error: state.rpcError,
        };
      },
    },
  }),
}));

async function describeTemplate(body: unknown, templateId = TEMPLATE) {
  const { PATCH } = await import('@/app/api/v1/rail-catalog/[templateId]/route');
  return PATCH(
    new Request('http://localhost', { method: 'PATCH', body: JSON.stringify(body) }),
    { params: Promise.resolve({ templateId }) },
  );
}

describe('PATCH /api/v1/rail-catalog/[templateId]', () => {
  beforeEach(() => {
    state.rpcError = null;
    state.rpcCalls = [];
  });

  it('saves the description for the caller company', async () => {
    const response = await describeTemplate({ description: 'For carve-outs.' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: TEMPLATE, description: 'For carve-outs.', changed: true });
    expect(state.rpcCalls[0]).toEqual({
      name: 'set_rail_template_description',
      params: {
        p_company_id: 'co-bank',
        p_actor_id: 'user-1',
        p_template_id: TEMPLATE,
        p_description: 'For carve-outs.',
      },
    });
  });

  it.each([{}, { description: 7 }, { description: 'x'.repeat(501) }])(
    'refuses a body that is not a description of at most 500 characters (%j)',
    async (body) => {
      const response = await describeTemplate(body);

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(
        'Keep the description within 500 characters.',
      );
      expect(state.rpcCalls).toHaveLength(0);
    },
  );

  it('answers 409 for the house default', async () => {
    expect((await describeTemplate({ description: 'x' }, 'default')).status).toBe(409);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('answers 404 for a template that is not there', async () => {
    state.rpcError = { code: 'P0003', message: 'template_missing' };

    expect((await describeTemplate({ description: 'x' })).status).toBe(404);
  });
});
