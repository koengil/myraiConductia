import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * A debrief's runs must stay reachable through the company runs routes.
 *
 * PL-05 bound every company run route to a CREATE `agent_run` audit row
 * carrying the executionId (executionBelongsToCompany). The debrief trigger
 * wrote only an UPLOAD row with the ids under sourceExecutionId and
 * twinExecutionId, so every poll, answer and cancel of a debrief run answered
 * 404 "No run on this lead" right after the 202.
 *
 * The rows the debrief POST writes feed the real binder here: one in-memory
 * audit_log, the real executionBelongsToCompany, only the gate mocked.
 */

type Row = { actor_id: string; action: string; detail: Record<string, unknown> };

const store = vi.hoisted(() => ({ auditRows: [] as Row[], executions: [] as string[] }));

function containsDetail(detail: Record<string, unknown>, match: Record<string, unknown>) {
  return Object.entries(match).every(([k, v]) => detail?.[k] === v);
}

function auditTable() {
  const filters: Array<(row: Row) => boolean> = [];
  const query = {
    select: () => query,
    eq: (col: keyof Row, value: unknown) => {
      filters.push((row) => row[col] === value);
      return query;
    },
    contains: (_col: 'detail', match: Record<string, unknown>) => {
      filters.push((row) => containsDetail(row.detail, match));
      return query;
    },
    limit: () => query,
    maybeSingle: async () => {
      const hit = store.auditRows.find((row) => filters.every((f) => f(row)));
      return { data: hit ? { id: 'a-1' } : null, error: null };
    },
    insert: async (rows: Row | Row[]) => {
      store.auditRows.push(...(Array.isArray(rows) ? rows : [rows]));
      return { error: null };
    },
  };
  return query;
}

const admin = { from: vi.fn(() => auditTable()) };

const plane = {
  triggerSkill: vi.fn(async ({ agentName }: { agentName: string }) => {
    const executionId = `exec_${agentName}_${store.executions.length + 1}`;
    store.executions.push(executionId);
    return { executionId, status: 'accepted' };
  }),
  getRun: vi.fn(async (executionId: string) => ({ executionId, status: 'running' })),
  cancelRun: vi.fn(async (executionId: string) => ({ executionId, status: 'cancelled' })),
  answerRun: vi.fn(async (executionId: string) => ({ executionId, status: 'running' })),
};

vi.mock('@/lib/ignatious/routeContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ignatious/routeContext')>();
  return {
    ...actual,
    actorDisplayName: vi.fn(async () => 'Storm Duncan'),
    requireIgnatiousCompany: vi.fn(async (companyId: string) => ({
      ok: true,
      ctx: {
        user: { id: 'u-md', email: 'md@bank.test' },
        admin,
        company: { id: companyId, name: 'Atlassian', tenantId: 't-bank', registeredByCompanyId: null },
        config: { tenantId: 'ignatious-handle' },
        plane,
      },
    })),
  };
});

vi.mock('@/lib/conductia/documents', () => ({
  persistLeadDocument: vi.fn(async () => ({ documentId: 'doc-1' })),
}));

vi.mock('@/lib/ignatious/jwt', () => ({
  mintTriggerToken: vi.fn(() => 'token'),
  sourceIntelligenceScopes: vi.fn(() => []),
  digitalTwinScopes: vi.fn(() => []),
}));

import { POST as postDebrief } from '@/app/api/v1/companies/[companyId]/debrief/route';
import { DELETE as cancelRun, GET as getRun } from '@/app/api/v1/companies/[companyId]/runs/route';
import { POST as answerRun } from '@/app/api/v1/companies/[companyId]/runs/input/route';

const params = (companyId: string) => ({ params: Promise.resolve({ companyId }) });

async function fileDebrief(companyId: string, runTwins = true) {
  const response = await postDebrief(
    new Request(`http://test/api/v1/companies/${companyId}/debrief`, {
      method: 'POST',
      body: JSON.stringify({
        text: 'The founder wants a strategic buyer and will not take a PE recap this year.',
        runTwins,
      }),
    }),
    params(companyId),
  );
  expect(response.status).toBe(202);
  return (await response.json()) as {
    sourceRun: { executionId: string };
    twinRun: { executionId: string } | null;
  };
}

const runUrl = (companyId: string, executionId: string) =>
  `http://test/api/v1/companies/${companyId}/runs?executionId=${encodeURIComponent(executionId)}`;

beforeEach(() => {
  store.auditRows.length = 0;
  store.executions.length = 0;
  vi.clearAllMocks();
});

describe('debrief runs through the company runs routes', () => {
  it('polls, answers and cancels both runs a debrief started', async () => {
    const { sourceRun, twinRun } = await fileDebrief('c-1');
    expect(twinRun).not.toBeNull();

    for (const executionId of [sourceRun.executionId, twinRun!.executionId]) {
      expect((await getRun(new Request(runUrl('c-1', executionId)), params('c-1'))).status).toBe(200);

      const answered = await answerRun(
        new Request('http://test/api/v1/companies/c-1/runs/input', {
          method: 'POST',
          body: JSON.stringify({ executionId, answers: [{ questionId: 'q1', answer: 'Yes' }] }),
        }),
        params('c-1'),
      );
      expect(answered.status).toBe(202);

      const cancelled = await cancelRun(
        new Request(runUrl('c-1', executionId), { method: 'DELETE' }),
        params('c-1'),
      );
      expect(cancelled.status).toBe(200);
    }
  });

  it("still refuses another company's debrief run", async () => {
    const { sourceRun } = await fileDebrief('c-2');

    const response = await getRun(new Request(runUrl('c-1', sourceRun.executionId)), params('c-1'));
    expect(response.status).toBe(404);
    expect(plane.getRun).not.toHaveBeenCalled();

    const answered = await answerRun(
      new Request('http://test/api/v1/companies/c-1/runs/input', {
        method: 'POST',
        body: JSON.stringify({ executionId: sourceRun.executionId, answers: [] }),
      }),
      params('c-1'),
    );
    expect(answered.status).toBe(404);
    expect(plane.answerRun).not.toHaveBeenCalled();
  });

  it('writes one CREATE agent_run row per started run, beside the UPLOAD row', async () => {
    const { sourceRun, twinRun } = await fileDebrief('c-1');

    const creates = store.auditRows.filter((row) => row.action === 'create');
    expect(creates.map((row) => row.detail.executionId)).toEqual([
      sourceRun.executionId,
      twinRun!.executionId,
    ]);
    for (const row of creates) {
      expect(row.actor_id).toBe('u-md');
      expect(row.detail).toMatchObject({ kind: 'agent_run', companyId: 'c-1', documentId: 'doc-1' });
    }
    expect(store.auditRows.filter((row) => row.action === 'upload')).toHaveLength(1);
  });

  it('writes no twin row when the twin builder is not run', async () => {
    const { twinRun } = await fileDebrief('c-1', false);
    expect(twinRun).toBeNull();
    expect(store.auditRows.filter((row) => row.action === 'create')).toHaveLength(1);
  });
});
