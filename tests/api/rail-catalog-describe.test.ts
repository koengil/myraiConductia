import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEMPLATE = '11111111-1111-4111-8111-111111111111';
const STEP = '22222222-2222-4222-8222-222222222222';

const state = {
  rpcError: null as { code: string; message: string } | null,
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
      rpc: async () => ({
        data: state.rpcError ? null : { id: STEP, description: 'Ranks buyers.' },
        error: state.rpcError,
      }),
    },
  }),
}));

async function describeStep(description: string) {
  const { PATCH } = await import(
    '@/app/api/v1/rail-catalog/[templateId]/steps/[stepRowId]/route'
  );
  return PATCH(
    new Request('http://localhost', { method: 'PATCH', body: JSON.stringify({ description }) }),
    { params: Promise.resolve({ templateId: TEMPLATE, stepRowId: STEP }) },
  );
}

describe('PATCH /api/v1/rail-catalog/[templateId]/steps/[stepRowId]', () => {
  beforeEach(() => {
    state.rpcError = null;
  });

  it('saves a description', async () => {
    const response = await describeStep('Ranks buyers.');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: STEP, description: 'Ranks buyers.' });
  });

  it('says what a skill step needs when its description is refused', async () => {
    state.rpcError = { code: 'P0001', message: 'skill_step_description' };

    const response = await describeStep('');

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'A skill step needs a description of 1 to 2,000 characters.',
    );
  });

  it('keeps the length message for any other refused description', async () => {
    state.rpcError = { code: 'P0001', message: 'template_step' };

    const response = await describeStep('Too long in the database.');

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'Keep the description within 4000 characters.',
    );
  });
});
