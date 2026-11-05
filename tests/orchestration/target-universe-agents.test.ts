import { describe, expect, it, vi } from 'vitest';
import { TargetUniverseAgent } from '@/lib/orchestration/agents/target-universe-agent';
import { TargetUniverseReviewAgent } from '@/lib/orchestration/agents/target-universe-review-agent';
import type { AgentInput } from '@/lib/orchestration/contract';
import type { ContextEnvelope, TargetUniverseOutput } from '@/lib/orchestration/types';

function envelope(overrides: Partial<ContextEnvelope> = {}): ContextEnvelope {
  return {
    jobId: 'job-tu-1',
    dealId: 'deal-atlassian',
    actorId: 'actor-md',
    goal: 'Build the target universe',
    completionCondition: 'A reviewed candidate list with fixed fields exists',
    documents: [
      { id: 'd-public', name: 'Market read', classification: 1, body: 'public' },
    ],
    brief: { sellerName: 'Atlassian', sector: 'Software', headline: 'Category-defining collaboration software' },
    ...overrides,
  };
}

function input(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    goal: 'Build the target universe',
    envelope: envelope(),
    completionCondition: 'A reviewed candidate list with fixed fields exists',
    model: 'economy',
    report: vi.fn(),
    ...overrides,
  };
}

describe('TargetUniverseAgent (fake skill)', () => {
  it('returns candidates with the four fixed fields and a summary', async () => {
    const out = await new TargetUniverseAgent().run(input());

    expect(out.status).toBe('complete');
    expect(out.result.candidates.length).toBeGreaterThan(0);
    for (const c of out.result.candidates) {
      expect(c.name).toBeTruthy();
      expect(c.sector).toBeTruthy();
      expect(c.geography).toBeTruthy();
      expect(['public', 'private', 'pe-backed']).toContain(c.ownership);
      expect(Number.isFinite(c.revenueGrowthPct)).toBe(true);
    }
    expect(out.result.summary).toContain('Atlassian');
  });

  it('reads only its envelope and emits one compliance report', async () => {
    const report = vi.fn();
    const out = await new TargetUniverseAgent().run(input({ report }));

    expect(out.auditRecord.saw).toEqual(['d-public']);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({ agent: 'TargetUniverseAgent', saw: ['d-public'] });
  });

  it('carries the routed model tier into the audit record', async () => {
    const out = await new TargetUniverseAgent().run(input({ model: 'standard' }));
    expect(out.auditRecord.modelUsed).toBe('standard');
    expect(out.auditRecord.tokens).toBeGreaterThan(0);
  });
});

describe('TargetUniverseReviewAgent (paired reviewer)', () => {
  function withFindings(output: TargetUniverseOutput): AgentInput {
    return input({ envelope: envelope({ priorFindings: { output } }) });
  }

  const good: TargetUniverseOutput = {
    candidates: [
      { name: 'Salesforce', sector: 'Software', geography: 'US', ownership: 'public', revenueGrowthPct: 11 },
    ],
    summary: 'One qualified candidate.',
  };

  it('approves a complete output', async () => {
    const out = await new TargetUniverseReviewAgent().run(withFindings(good));
    expect(out.status).toBe('complete');
    expect(out.result.approved).toBe(true);
    expect(out.result.issues).toEqual([]);
  });

  it('rejects an empty candidate list', async () => {
    const out = await new TargetUniverseReviewAgent().run(
      withFindings({ candidates: [], summary: 'nothing' }),
    );
    expect(out.result.approved).toBe(false);
    expect(out.result.issues.length).toBeGreaterThan(0);
  });

  it('rejects a candidate missing a fixed field', async () => {
    const out = await new TargetUniverseReviewAgent().run(
      withFindings({
        candidates: [{ name: 'X', sector: '', geography: 'US', ownership: 'public', revenueGrowthPct: 4 }],
        summary: 's',
      }),
    );
    expect(out.result.approved).toBe(false);
    expect(out.result.issues.join(' ')).toMatch(/sector/i);
  });

  it('fails (needs_input) when no prior findings were pushed', async () => {
    const out = await new TargetUniverseReviewAgent().run(input());
    expect(out.status).toBe('needs_input');
  });

  it('emits one compliance report', async () => {
    const report = vi.fn();
    await new TargetUniverseReviewAgent().run({ ...withFindings(good), report });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({ agent: 'TargetUniverseReviewAgent' });
  });
});
