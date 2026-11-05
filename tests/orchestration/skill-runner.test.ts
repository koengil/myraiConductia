import { describe, expect, it } from 'vitest';
import { runSkillOnce } from '@/lib/orchestration/skill-runner';
import { TargetUniverseAgent } from '@/lib/orchestration/agents/target-universe-agent';
import { TargetUniverseReviewAgent } from '@/lib/orchestration/agents/target-universe-review-agent';
import type { CapabilityAgent, AgentInput } from '@/lib/orchestration/contract';
import type { AgentResult, TargetUniverseOutput } from '@/lib/orchestration/types';
import { DOCUMENT_CLASSIFICATION } from '@/lib/constants/documents';
import { DEAL_ROLE } from '@/lib/constants/roles';
import { buildJob, MD_ACTOR, DOCUMENTS } from './helpers';

function tuJob() {
  return buildJob({
    id: 'job-tu-1',
    goal: 'Build the target universe for Atlassian',
    completionCondition: 'A reviewed candidate list with fixed fields exists',
    stakes: 'low',
  });
}

/** A rogue skill that reports having seen a document outside its envelope. */
class RogueSkill implements CapabilityAgent<TargetUniverseOutput> {
  readonly name = 'RogueSkill';
  async run(input: AgentInput): Promise<AgentResult<TargetUniverseOutput>> {
    input.report({
      agent: this.name,
      saw: [...input.envelope.documents.map((d) => d.id), 'd-mnpi-stolen'],
      did: 'Peeked outside the envelope.',
      why: 'rogue',
    });
    return {
      result: { candidates: [], summary: 'stolen' },
      auditRecord: { saw: ['d-mnpi-stolen'], did: 'peek', why: 'rogue', modelUsed: input.model, tokens: 1 },
      status: 'complete',
      completionAssertion: 'peeked',
    };
  }
}

describe('runSkillOnce — the single-skill execution path', () => {
  it('runs skill then reviewer and completes with the reviewed output', async () => {
    const run = await runSkillOnce({
      job: tuJob(),
      actor: MD_ACTOR,
      candidates: DOCUMENTS,
      skill: new TargetUniverseAgent(),
      reviewer: new TargetUniverseReviewAgent(),
    });

    expect(run.status).toBe('complete');
    expect(run.output?.candidates.length).toBeGreaterThan(0);
    expect(run.review?.approved).toBe(true);

    const types = run.events.map((e) => e.type);
    expect(types).toContain('JOB_CREATED');
    expect(types.filter((t) => t === 'AGENT_DISPATCHED')).toHaveLength(2);
    expect(types.filter((t) => t === 'AGENT_REPORTED')).toHaveLength(2);
    expect(types).toContain('JOB_COMPLETED');
  });

  it('halts a skill whose reported saw exceeds its envelope', async () => {
    const run = await runSkillOnce({
      job: tuJob(),
      actor: MD_ACTOR,
      candidates: DOCUMENTS,
      skill: new RogueSkill(),
      reviewer: new TargetUniverseReviewAgent(),
    });

    expect(run.status).toBe('halted');
    expect(run.output).toBeUndefined();
    expect(run.events.map((e) => e.type)).toContain('AGENT_HALTED');
  });

  it('marks the run rejected when the reviewer disapproves', async () => {
    class EmptySkill implements CapabilityAgent<TargetUniverseOutput> {
      readonly name = 'EmptySkill';
      async run(input: AgentInput): Promise<AgentResult<TargetUniverseOutput>> {
        return {
          result: { candidates: [], summary: '' },
          auditRecord: { saw: [], did: 'nothing', why: 'stub', modelUsed: input.model, tokens: 1 },
          status: 'complete',
          completionAssertion: 'empty',
        };
      }
    }

    const run = await runSkillOnce({
      job: tuJob(),
      actor: MD_ACTOR,
      candidates: DOCUMENTS,
      skill: new EmptySkill(),
      reviewer: new TargetUniverseReviewAgent(),
    });

    expect(run.status).toBe('rejected');
    expect(run.review?.approved).toBe(false);
    expect(run.output).toEqual({ candidates: [], summary: '' });
  });

  it('withholds MNPI documents from the skill envelope for an uncleared actor', async () => {
    const analyst = { ...MD_ACTOR, actorId: 'actor-analyst', dealRole: DEAL_ROLE.DEAL_TEAM };
    const docs = [
      ...DOCUMENTS,
      { id: 'd-mnpi', dealId: 'deal-atlassian', name: 'Board minutes', classification: DOCUMENT_CLASSIFICATION.MNPI, minPhase: 0, body: 'mnpi' },
    ];

    const run = await runSkillOnce({
      job: tuJob(),
      actor: analyst,
      candidates: docs,
      skill: new TargetUniverseAgent(),
      reviewer: new TargetUniverseReviewAgent(),
    });

    expect(run.status).toBe('complete');
    const dispatched = run.events.find((e) => e.type === 'AGENT_DISPATCHED');
    expect(dispatched?.detail.envelopeDocs).toEqual(['d-public', 'd-conf']);
  });

  it('fails the run when the skill does not complete', async () => {
    class StuckSkill implements CapabilityAgent<TargetUniverseOutput> {
      readonly name = 'StuckSkill';
      async run(input: AgentInput): Promise<AgentResult<TargetUniverseOutput>> {
        return {
          result: { candidates: [], summary: '' },
          auditRecord: { saw: [], did: 'stalled', why: 'stub', modelUsed: input.model, tokens: 0 },
          status: 'needs_input',
          completionAssertion: 'stalled',
        };
      }
    }

    const run = await runSkillOnce({
      job: tuJob(),
      actor: MD_ACTOR,
      candidates: DOCUMENTS,
      skill: new StuckSkill(),
      reviewer: new TargetUniverseReviewAgent(),
    });

    expect(run.status).toBe('failed');
    expect(run.events.map((e) => e.type)).toContain('JOB_TERMINATED');
  });
});
