import { describe, expect, it } from 'vitest';
import {
  InMemoryJobStore,
  recordEvent,
  reconstruct,
} from '@/lib/orchestration/audit';
import type { AuditEvent, JobRecord } from '@/lib/orchestration/types';

function baseRecord(): JobRecord {
  return {
    job: {
      id: 'job-1',
      goal: 'Prepare the teaser',
      dealId: 'deal-atlassian',
      requestingActorId: 'actor-md',
      completionCondition: 'cleared teaser',
      stakes: 'high',
    },
    state: 'INTERPRET',
    events: [],
  };
}

describe('InMemoryJobStore — durable persistence', () => {
  it('saves and loads a record', async () => {
    const store = new InMemoryJobStore();
    await store.save(baseRecord());
    const loaded = await store.load('job-1');
    expect(loaded?.job.goal).toBe('Prepare the teaser');
  });

  it('returns undefined for an unknown job', async () => {
    const store = new InMemoryJobStore();
    expect(await store.load('nope')).toBeUndefined();
  });

  it('persists a snapshot, not a live reference (mutation does not leak)', async () => {
    const store = new InMemoryJobStore();
    const rec = baseRecord();
    await store.save(rec);
    rec.state = 'FAILED';
    const loaded = await store.load('job-1');
    expect(loaded?.state).toBe('INTERPRET');
  });
});

describe('recordEvent — monotonic sequence', () => {
  it('appends events with incrementing seq', () => {
    const rec = baseRecord();
    recordEvent(rec, 'JOB_CREATED', 'INTERPRET', {});
    recordEvent(rec, 'STATE_ENTERED', 'PLAN', {});
    expect(rec.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(rec.events[1].type).toBe('STATE_ENTERED');
    expect(rec.events[1].state).toBe('PLAN');
  });
});

describe('reconstruct — the run rebuilt from the audit log alone', () => {
  it('recovers states, agent activity, verdict, gates and terminal', () => {
    const events: AuditEvent[] = [
      { seq: 0, jobId: 'job-1', type: 'JOB_CREATED', state: 'INTERPRET', detail: {} },
      { seq: 1, jobId: 'job-1', type: 'STATE_ENTERED', state: 'RESEARCH', detail: {} },
      { seq: 2, jobId: 'job-1', type: 'AGENT_REPORTED', state: 'RESEARCH', detail: { agent: 'ResearchAgent', saw: ['d-public'], did: 'comps', why: 'inputs', model: 'economy', tokens: 1200 } },
      { seq: 3, jobId: 'job-1', type: 'STATE_ENTERED', state: 'DRAFT', detail: {} },
      { seq: 4, jobId: 'job-1', type: 'AGENT_REPORTED', state: 'DRAFT', detail: { agent: 'DraftAgent', saw: ['d-public'], did: 'draft', why: 'artifact', model: 'frontier', tokens: 3400 } },
      { seq: 5, jobId: 'job-1', type: 'COMPLIANCE_VERDICT', state: 'COMPLIANCE_SCREEN', detail: { decision: 'clear' } },
      { seq: 6, jobId: 'job-1', type: 'GATE_AWAITING', state: 'AWAIT_SIGNOFF', detail: { gate: 'signoff' } },
      { seq: 7, jobId: 'job-1', type: 'GATE_APPROVED', state: 'AWAIT_SIGNOFF', detail: { gate: 'signoff' } },
      { seq: 8, jobId: 'job-1', type: 'JOB_COMPLETED', state: 'COMPLETE', detail: {} },
    ];

    const run = reconstruct(events);
    expect(run.jobId).toBe('job-1');
    expect(run.states).toEqual(['INTERPRET', 'RESEARCH', 'DRAFT']);
    expect(run.agents).toEqual([
      { agent: 'ResearchAgent', saw: ['d-public'], did: 'comps', why: 'inputs', model: 'economy', tokens: 1200 },
      { agent: 'DraftAgent', saw: ['d-public'], did: 'draft', why: 'artifact', model: 'frontier', tokens: 3400 },
    ]);
    expect(run.complianceDecision).toBe('clear');
    expect(run.gatesApproved).toEqual(['signoff']);
    expect(run.totalTokens).toBe(4600);
    expect(run.terminal).toBe('COMPLETE');
    expect(run.completed).toBe(true);
  });
});
