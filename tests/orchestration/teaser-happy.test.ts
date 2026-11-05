import { describe, expect, it } from 'vitest';
import { InMemoryJobStore } from '@/lib/orchestration/audit';
import { Orchestrator } from '@/lib/orchestration/orchestrator';
import { buildJob, ctx } from './helpers';

describe('teaser — happy path to COMPLETE', () => {
  it('runs a high-stakes job through plan-confirm and signoff to COMPLETE', async () => {
    const store = new InMemoryJobStore();
    const orch = new Orchestrator({ store });
    const job = buildJob();

    let rec = await orch.start(job, ctx());
    expect(rec.state).toBe('AWAIT_PLAN_CONFIRM');

    rec = await orch.approve(job.id, 'plan', ctx());
    expect(rec.state).toBe('AWAIT_SIGNOFF');
    expect(rec.compliance?.verdict).toBe('compliant');
    expect(rec.draft?.teaser).toContain('Atlassian');
    expect(rec.artifact).toBeUndefined(); // nothing leaves until signoff

    rec = await orch.approve(job.id, 'signoff', ctx());
    expect(rec.state).toBe('COMPLETE');
    expect(rec.artifact).toContain('Atlassian');
    expect(rec.artifact).toContain('Salesforce'); // research fed the draft
  });

  it('scopes the job to one deal and one requesting actor', async () => {
    const store = new InMemoryJobStore();
    const orch = new Orchestrator({ store });
    const job = buildJob();
    await orch.start(job, ctx());
    await orch.approve(job.id, 'plan', ctx());
    const rec = await orch.approve(job.id, 'signoff', ctx());
    expect(rec.job.dealId).toBe('deal-atlassian');
    expect(rec.job.requestingActorId).toBe('actor-md');
  });

  it('meters token spend per agent as a first-class metric', async () => {
    const store = new InMemoryJobStore();
    const orch = new Orchestrator({ store });
    const job = buildJob();
    await orch.start(job, ctx());
    await orch.approve(job.id, 'plan', ctx());
    expect(orch.meter.byAgent('ResearchAgent')).toBeGreaterThan(0);
    expect(orch.meter.byAgent('DraftAgent')).toBeGreaterThan(0);
    expect(orch.meter.total()).toBe(orch.meter.byAgent('ResearchAgent') + orch.meter.byAgent('DraftAgent'));
  });
});
