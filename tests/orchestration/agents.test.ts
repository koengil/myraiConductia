import { describe, expect, it, vi } from 'vitest';
import { ResearchAgent } from '@/lib/orchestration/agents/research-agent';
import { DraftAgent } from '@/lib/orchestration/agents/draft-agent';
import type { AgentInput } from '@/lib/orchestration/contract';
import type { ContextEnvelope, ResearchOutput } from '@/lib/orchestration/types';

function envelope(overrides: Partial<ContextEnvelope> = {}): ContextEnvelope {
  return {
    jobId: 'job-1',
    dealId: 'deal-atlassian',
    actorId: 'actor-md',
    goal: 'Prepare the teaser',
    completionCondition: 'A compliance-cleared teaser exists',
    documents: [
      { id: 'd-public', name: 'Market read', classification: 1, body: 'public' },
      { id: 'd-conf', name: 'Financials', classification: 3, body: 'confidential' },
    ],
    brief: { sellerName: 'Atlassian', sector: 'Software', headline: 'Category-defining collaboration software' },
    ...overrides,
  };
}

describe('ResearchAgent (mock)', () => {
  it('returns canned comps and a market read, on the economy tier', async () => {
    const report = vi.fn();
    const input: AgentInput = {
      goal: 'Pull comps and a market read',
      envelope: envelope(),
      completionCondition: 'Comps + market read present',
      model: 'economy',
      report,
    };
    const out = await new ResearchAgent().run(input);

    expect(out.status).toBe('complete');
    expect(out.result.comps.length).toBeGreaterThan(0);
    expect(out.result.marketRead).toContain('Atlassian');
    expect(out.auditRecord.modelUsed).toBe('economy');
    expect(out.auditRecord.tokens).toBeGreaterThan(0);
    expect(out.auditRecord.saw).toEqual(['d-public', 'd-conf']);
    expect(out.completionAssertion).toBeTruthy();
  });

  it('emits exactly one entry on the mandatory compliance channel', async () => {
    const report = vi.fn();
    await new ResearchAgent().run({
      goal: 'g',
      envelope: envelope(),
      completionCondition: 'c',
      model: 'economy',
      report,
    });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({ agent: 'ResearchAgent' });
  });
});

describe('DraftAgent (mock)', () => {
  const research: ResearchOutput = {
    comps: [{ name: 'Salesforce', evRevenue: 7.1 }],
    marketRead: 'Atlassian sits in a durable category.',
  };

  it('composes a teaser from the brief and pushed research, on the frontier tier', async () => {
    const report = vi.fn();
    const out = await new DraftAgent().run({
      goal: 'Draft the teaser',
      envelope: envelope({ priorFindings: { research } }),
      completionCondition: 'A teaser draft exists',
      model: 'frontier',
      report,
    });

    expect(out.status).toBe('complete');
    expect(out.result.teaser).toContain('Atlassian');
    expect(out.result.teaser).toContain('Salesforce');
    expect(out.auditRecord.modelUsed).toBe('frontier');
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('incorporates the brief headline verbatim so compliance can screen it', async () => {
    const out = await new DraftAgent().run({
      goal: 'Draft the teaser',
      envelope: envelope({
        brief: { sellerName: 'Atlassian', sector: 'Software', headline: 'I guarantee the board seat stays with the founder.' },
        priorFindings: { research },
      }),
      completionCondition: 'A teaser draft exists',
      model: 'frontier',
      report: vi.fn(),
    });
    expect(out.result.teaser).toContain('I guarantee the board seat stays with the founder.');
  });
});
