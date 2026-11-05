import { describe, expect, it } from 'vitest';
import { InMemoryJobStore } from '@/lib/orchestration/audit';
import { Orchestrator } from '@/lib/orchestration/orchestrator';
import type { CapabilityAgent, AgentInput } from '@/lib/orchestration/contract';
import type { AgentResult, ResearchOutput } from '@/lib/orchestration/types';
import { buildJob, ctx } from './helpers';

/**
 * A rogue agent that reports having seen an artifact it was never handed — a
 * pull the sealed envelope should make impossible. The monitor must halt it.
 */
class RogueResearchAgent implements CapabilityAgent<ResearchOutput> {
  readonly name = 'RogueResearchAgent';
  async run(input: AgentInput): Promise<AgentResult<ResearchOutput>> {
    const saw = [...input.envelope.documents.map((d) => d.id), 'd-mnpi-not-in-envelope'];
    input.report({ agent: this.name, saw, did: 'read board minutes it was never given', why: 'n/a' });
    return {
      result: { comps: [], marketRead: 'leaked' },
      auditRecord: { saw, did: 'pulled out-of-scope data', why: 'n/a', modelUsed: input.model, tokens: 10 },
      status: 'complete',
      completionAssertion: 'n/a',
    };
  }
}

describe('monitor — halts a rogue agent', () => {
  it('transitions to HALTED and produces no artifact when an agent pulls out-of-envelope data', async () => {
    const store = new InMemoryJobStore();
    const orch = new Orchestrator({ store, researchAgent: new RogueResearchAgent() });
    const job = buildJob({ stakes: 'low' }); // skip plan gate to reach RESEARCH directly

    const rec = await orch.start(job, ctx());

    expect(rec.state).toBe('HALTED');
    expect(rec.artifact).toBeUndefined();
    expect(rec.draft).toBeUndefined(); // never reached the draft step
    const halt = rec.events.find((e) => e.type === 'AGENT_HALTED');
    expect(halt?.detail.reason).toContain('d-mnpi-not-in-envelope');
  });

  it('does not meter or audit-report a halted agent as a completed step', async () => {
    const store = new InMemoryJobStore();
    const orch = new Orchestrator({ store, researchAgent: new RogueResearchAgent() });
    const rec = await orch.start(buildJob({ stakes: 'low' }), ctx());
    expect(rec.events.some((e) => e.type === 'AGENT_REPORTED')).toBe(false);
    expect(orch.meter.total()).toBe(0);
  });
});
