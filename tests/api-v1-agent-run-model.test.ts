import { beforeEach, describe, expect, it, vi } from 'vitest';

const { recordAiUsage, getRun, gate } = vi.hoisted(() => ({
  recordAiUsage: vi.fn<(admin: unknown, row: unknown) => Promise<{ error: null }>>(async () => ({ error: null })),
  getRun: vi.fn(),
  gate: vi.fn(),
}));
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage, agentRunRequester: async () => 'u-requester' }));
vi.mock('@/lib/ignatious/routeContext', () => ({
  requireIgnatiousDeal: gate,
  executionBelongsToDeal: async () => true,
  actorDisplayName: () => 'MD',
  ignatiousErrorResponse: () => new Response('upstream', { status: 502 }),
}));

import { GET } from '@/app/api/v1/deals/[dealId]/steps/[stepId]/ignatious/route';

/*
 * An agent run's ledger row names the models it called (run.modelIds, served
 * by the control plane since agents-backend PR #139/#147), instead of null.
 */

function poll() {
  return GET(new Request('http://x/api/v1/deals/d-1/steps/p1-s9/ignatious?executionId=ex_1'), {
    params: Promise.resolve({ dealId: 'd-1', stepId: 'p1-s9' }),
  });
}

beforeEach(() => {
  recordAiUsage.mockClear();
  gate.mockResolvedValue({
    ok: true,
    ctx: {
      admin: {},
      user: { id: 'u-poller', email: 'p@bank.test' },
      deal: { id: 'd-1', tenantId: 'tenant-1' },
      plane: { getRun },
    },
  });
});

describe('GET /deals/{id}/steps/{stepId}/ignatious — the ledger row of a finished run', () => {
  it('records the models the run called, bare and joined, for the requester', async () => {
    getRun.mockResolvedValue({
      executionId: 'ex_1',
      status: 'completed',
      costUsd: 0.31,
      modelIds: ['anthropic/claude-sonnet-5', 'anthropic/claude-haiku-5'],
    });
    expect((await poll()).status).toBe(200);
    expect(recordAiUsage.mock.calls[0][1]).toMatchObject({
      source: 'agent_run',
      task: 'p1-s9',
      externalId: 'ex_1',
      actorId: 'u-requester',
      model: 'claude-sonnet-5 + claude-haiku-5',
      costUsd: 0.31,
    });
  });

  it('keeps the model null when the run reports none', async () => {
    getRun.mockResolvedValue({ executionId: 'ex_1', status: 'completed', costUsd: 0.31, modelIds: [] });
    await poll();
    expect(recordAiUsage.mock.calls[0][1]).toMatchObject({ model: null });
  });
});
