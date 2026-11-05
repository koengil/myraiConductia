import { describe, expect, it } from 'vitest';
import { InMemoryJobStore, reconstruct } from '@/lib/orchestration/audit';
import { Orchestrator } from '@/lib/orchestration/orchestrator';
import { buildJob, ctx } from './helpers';

describe('audit — the run is reconstructable from the log alone', () => {
  it('replays a full happy run: states, agent activity, verdict, gates, tokens, terminal', async () => {
    const store = new InMemoryJobStore();
    const orch = new Orchestrator({ store });
    const job = buildJob();

    await orch.start(job, ctx());
    await orch.approve(job.id, 'plan', ctx());
    const rec = await orch.approve(job.id, 'signoff', ctx());

    // Reconstruct using ONLY the audit events — not the record's other fields.
    const run = reconstruct(rec.events);

    expect(run.states).toEqual(['INTERPRET', 'PLAN', 'RESEARCH', 'DRAFT', 'COMPLIANCE_SCREEN']);

    // Every agent's saw / did / why / model / tokens survived into the log.
    expect(run.agents.map((a) => a.agent)).toEqual(['ResearchAgent', 'DraftAgent']);
    for (const a of run.agents) {
      expect(a.saw.length).toBeGreaterThan(0);
      expect(a.did).toBeTruthy();
      expect(a.why).toBeTruthy();
      expect(['frontier', 'standard', 'economy']).toContain(a.model);
      expect(a.tokens).toBeGreaterThan(0);
    }

    expect(run.complianceDecision).toBe('clear');
    expect(run.gatesApproved).toEqual(['plan', 'signoff']);
    expect(run.totalTokens).toBe(orch.meter.total());
    expect(run.terminal).toBe('COMPLETE');
    expect(run.completed).toBe(true);
  });

  it('replays a blocked run as terminated-not-completed', async () => {
    const store = new InMemoryJobStore();
    const orch = new Orchestrator({ store });
    const job = buildJob({
      brief: { sellerName: 'Atlassian', sector: 'Software', headline: 'I guarantee the board seat.' },
    });
    await orch.start(job, ctx());
    const rec = await orch.approve(job.id, 'plan', ctx());

    const run = reconstruct(rec.events);
    expect(run.complianceDecision).toBe('block');
    expect(run.terminal).toBe('BLOCKED');
    expect(run.completed).toBe(false);
  });
});
