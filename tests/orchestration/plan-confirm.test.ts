import { describe, expect, it } from 'vitest';
import { InMemoryJobStore } from '@/lib/orchestration/audit';
import { Orchestrator } from '@/lib/orchestration/orchestrator';
import { buildJob, ctx } from './helpers';

describe('plan-confirm — high-stakes halts until explicit approval', () => {
  it('halts at AWAIT_PLAN_CONFIRM and does not run any agent yet', async () => {
    const store = new InMemoryJobStore();
    const orch = new Orchestrator({ store });
    const job = buildJob({ stakes: 'high' });

    const rec = await orch.start(job, ctx());
    expect(rec.state).toBe('AWAIT_PLAN_CONFIRM');
    expect(rec.awaitingGate).toBe('plan');
    expect(rec.research).toBeUndefined();
    expect(rec.draft).toBeUndefined();
  });

  it('resume() will not advance a job that is awaiting a human gate', async () => {
    const store = new InMemoryJobStore();
    const orch = new Orchestrator({ store });
    const job = buildJob({ stakes: 'high' });
    await orch.start(job, ctx());
    const rec = await orch.resume(job.id, ctx());
    expect(rec.state).toBe('AWAIT_PLAN_CONFIRM');
  });

  it('advances only on explicit approve("plan")', async () => {
    const store = new InMemoryJobStore();
    const orch = new Orchestrator({ store });
    const job = buildJob({ stakes: 'high' });
    await orch.start(job, ctx());
    const rec = await orch.approve(job.id, 'plan', ctx());
    expect(rec.research).toBeDefined();
    expect(rec.state).toBe('AWAIT_SIGNOFF');
  });

  it('survives a process restart: a fresh orchestrator resumes from the store', async () => {
    const store = new InMemoryJobStore();
    const job = buildJob({ stakes: 'high' });

    // Instance 1 starts the job and persists the pause at the plan gate.
    await new Orchestrator({ store }).start(job, ctx());

    // Instance 2 — a different process — loads the persisted state and approves.
    const orch2 = new Orchestrator({ store });
    const loaded = await orch2.load(job.id);
    expect(loaded?.state).toBe('AWAIT_PLAN_CONFIRM');

    const rec = await orch2.approve(job.id, 'plan', ctx());
    const final = await orch2.approve(job.id, 'signoff', ctx());
    expect(rec.state).toBe('AWAIT_SIGNOFF');
    expect(final.state).toBe('COMPLETE');
  });

  it('a low-stakes job skips the plan gate but still signs off external output', async () => {
    const store = new InMemoryJobStore();
    const orch = new Orchestrator({ store });
    const job = buildJob({ stakes: 'low' });
    const rec = await orch.start(job, ctx());
    // No plan gate; ran straight to the external-facing sign-off.
    expect(rec.state).toBe('AWAIT_SIGNOFF');
    expect(rec.draft).toBeDefined();
  });

  it('rejects approving a gate the job is not awaiting', async () => {
    const store = new InMemoryJobStore();
    const orch = new Orchestrator({ store });
    const job = buildJob({ stakes: 'high' });
    await orch.start(job, ctx());
    await expect(orch.approve(job.id, 'signoff', ctx())).rejects.toThrow();
  });
});
