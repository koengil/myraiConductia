import { beforeEach, describe, expect, it, vi } from 'vitest';

const { applyPresearchToLead, filters, rows, plane } = vi.hoisted(() => ({
  applyPresearchToLead: vi.fn(),
  filters: [] as string[],
  // maybeSingle answers, in call order: latest applied memo, newest unapplied run.
  rows: [] as unknown[],
  plane: {
    getRun: vi.fn(async () => ({
      executionId: 'exec-1',
      status: 'completed',
      artifacts: [{ path: 'memo.md' }],
      costUsd: null,
    })),
    getArtifact: vi.fn(async () => ({ text: async () => '**Nathan Ellery** — CEO' })),
  },
}));

function query(): Record<string, unknown> {
  const builder: Record<string, unknown> = {};
  for (const k of ['select', 'eq', 'is', 'not', 'order', 'limit']) {
    builder[k] = (...args: unknown[]) => {
      filters.push(`${k}(${args.map(String).join(',')})`);
      return builder;
    };
  }
  builder.maybeSingle = async () => ({ data: rows.shift() ?? null, error: null });
  return builder;
}

vi.mock('@/lib/ignatious/applyPresearch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ignatious/applyPresearch')>()),
  applyPresearchToLead,
}));
vi.mock('@/lib/ai/usage', () => ({ agentRunRequester: vi.fn(), recordAiUsage: vi.fn() }));
vi.mock('@/lib/ignatious/routeContext', () => ({
  actorDisplayName: vi.fn(),
  executionBelongsToCompany: async () => true,
  ignatiousErrorResponse: (error: unknown) => Response.json({ error: String(error) }, { status: 500 }),
  requireIgnatiousCompany: async () => ({
    ok: true,
    ctx: {
      admin: { from: () => query() },
      plane,
      user: { id: 'u1' },
      company: { id: 'c1', tenantId: 't1', registeredByCompanyId: null },
    },
  }),
}));

import { GET } from '@/app/api/v1/companies/[companyId]/presearch/route';
import { PresearchApplyExhausted, PresearchApplyPending, PresearchApplyRetryScheduled } from '@/lib/ignatious/applyPresearch';

const context = { params: Promise.resolve({ companyId: 'c1' }) };
const poll = () => GET(new Request('http://x/api/v1/companies/c1/presearch?executionId=exec-1'), context);

describe('presearch GET apply state (#249)', () => {
  beforeEach(() => {
    filters.length = 0;
    rows.length = 0;
    applyPresearchToLead.mockReset();
    plane.getArtifact.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('reports the apply when the memo was applied', async () => {
    applyPresearchToLead.mockImplementation(async ({ memo }) => {
      expect(plane.getArtifact).not.toHaveBeenCalled();
      expect(await memo()).toBe('**Nathan Ellery** — CEO');
      return { peopleAdded: 1, alreadyApplied: false };
    });
    const body = await (await poll()).json();
    expect(body).toMatchObject({
      status: 'completed',
      applied: { peopleAdded: 1 },
      applying: false,
      applyFailed: null,
    });
  });

  it('reports applying only while another apply holds the claim', async () => {
    applyPresearchToLead.mockRejectedValue(new PresearchApplyPending('presearch apply already in progress'));
    const body = await (await poll()).json();
    expect(body).toMatchObject({ applied: null, applying: true, applyFailed: null });
  });

  it('reports scheduled backoff without claiming an apply is running', async () => {
    applyPresearchToLead.mockRejectedValue(new PresearchApplyRetryScheduled('retry scheduled'));
    expect(await (await poll()).json()).toMatchObject({ applied: null, applying: false, applyFailed: 'retrying' });
  });

  it('reports a failed apply as retrying, not applying', async () => {
    applyPresearchToLead.mockRejectedValue(new Error('presearch stakeholders unreadable: down'));
    const body = await (await poll()).json();
    expect(body).toMatchObject({ applied: null, applying: false, applyFailed: 'retrying' });
  });

  it('reports a run whose attempts are spent as terminal', async () => {
    applyPresearchToLead.mockRejectedValue(new PresearchApplyExhausted(5));
    const body = await (await poll()).json();
    expect(body).toMatchObject({ applied: null, applying: false, applyFailed: 'terminal' });
  });

  const latest = async () => (await GET(new Request('http://x/api/v1/companies/c1/presearch'), context)).json();

  it('does not resume a terminal run on reload', async () => {
    rows.push(null, { execution_id: 'exec-1', created_at: '2026-09-29T11:00:00Z', attempts: 5 });
    expect(await latest()).toMatchObject({ pending: null });
  });

  it('returns only an applied memo as the latest', async () => {
    await latest();
    expect(filters).toContain('not(completed_at,is,null)');
  });

  it('returns a newer unapplied run as pending so the client resumes it', async () => {
    rows.push(
      { execution_id: 'exec-0', memo_md: 'old', created_at: '2026-09-29T10:00:00Z' },
      { execution_id: 'exec-1', created_at: '2026-09-29T11:00:00Z' },
    );
    expect(await latest()).toMatchObject({ latest: { execution_id: 'exec-0' }, pending: { execution_id: 'exec-1' } });
  });

  it('does not resume an unapplied run older than the applied memo', async () => {
    rows.push(
      { execution_id: 'exec-2', memo_md: 'new', created_at: '2026-09-29T12:00:00Z' },
      { execution_id: 'exec-1', created_at: '2026-09-29T11:00:00Z' },
    );
    expect(await latest()).toMatchObject({ pending: null });
  });
});
