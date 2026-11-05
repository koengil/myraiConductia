import { describe, expect, it } from 'vitest';
import { assembleEnvelope } from '@/lib/orchestration/envelope';
import { DOCUMENT_CLASSIFICATION } from '@/lib/constants/documents';
import { DEAL_ROLE, FIRM_ROLE } from '@/lib/constants/roles';
import type { ActorClearance, DealDocument, Job } from '@/lib/orchestration/types';

const job: Job = {
  id: 'job-1',
  goal: 'Prepare the teaser',
  dealId: 'deal-atlassian',
  requestingActorId: 'actor-md',
  completionCondition: 'A compliance-cleared teaser exists',
  stakes: 'high',
  brief: { sellerName: 'Atlassian', sector: 'Software', headline: 'Category leader' },
};

const docs: DealDocument[] = [
  { id: 'd-public', dealId: 'deal-atlassian', name: 'Market read', classification: DOCUMENT_CLASSIFICATION.PUBLIC, minPhase: 0, body: 'public' },
  { id: 'd-conf', dealId: 'deal-atlassian', name: 'Financials', classification: DOCUMENT_CLASSIFICATION.CONFIDENTIAL, minPhase: 0, body: 'confidential' },
  { id: 'd-mnpi', dealId: 'deal-atlassian', name: 'Board minutes', classification: DOCUMENT_CLASSIFICATION.MNPI, minPhase: 0, body: 'mnpi' },
  { id: 'd-phase2', dealId: 'deal-atlassian', name: 'Data room pack', classification: DOCUMENT_CLASSIFICATION.CONFIDENTIAL, minPhase: 2, body: 'gated' },
  { id: 'd-otherdeal', dealId: 'deal-other', name: 'Other deal doc', classification: DOCUMENT_CLASSIFICATION.PUBLIC, minPhase: 0, body: 'leak' },
];

const dealTeam: ActorClearance = {
  actorId: 'actor-analyst',
  dealId: 'deal-atlassian',
  dealRole: DEAL_ROLE.DEAL_TEAM,
  phase: 0,
};

describe('assembleEnvelope — push-not-pull scope floor', () => {
  it('excludes documents from another deal', () => {
    const env = assembleEnvelope({ job, actor: dealTeam, candidates: docs });
    expect(env.documents.map((d) => d.id)).not.toContain('d-otherdeal');
  });

  it('hides MNPI (class 4) from a non-MD, non-CCO actor', () => {
    const env = assembleEnvelope({ job, actor: dealTeam, candidates: docs });
    expect(env.documents.map((d) => d.id)).not.toContain('d-mnpi');
    // but still sees lower classifications in-phase
    expect(env.documents.map((d) => d.id)).toEqual(
      expect.arrayContaining(['d-public', 'd-conf']),
    );
  });

  it('reveals MNPI to the deal MD', () => {
    const md: ActorClearance = { ...dealTeam, actorId: 'actor-md', dealRole: DEAL_ROLE.MD };
    const env = assembleEnvelope({ job, actor: md, candidates: docs });
    expect(env.documents.map((d) => d.id)).toContain('d-mnpi');
  });

  it('reveals MNPI to a CCO firm-role even when deal role is junior', () => {
    const cco: ActorClearance = { ...dealTeam, firmRole: FIRM_ROLE.CCO };
    const env = assembleEnvelope({ job, actor: cco, candidates: docs });
    expect(env.documents.map((d) => d.id)).toContain('d-mnpi');
  });

  it('gates documents above the actor phase', () => {
    const env = assembleEnvelope({ job, actor: dealTeam, candidates: docs });
    expect(env.documents.map((d) => d.id)).not.toContain('d-phase2');
    const advanced: ActorClearance = { ...dealTeam, phase: 2 };
    const env2 = assembleEnvelope({ job, actor: advanced, candidates: docs });
    expect(env2.documents.map((d) => d.id)).toContain('d-phase2');
  });

  it('strips scope metadata, leaving only what an agent may read', () => {
    const env = assembleEnvelope({ job, actor: dealTeam, candidates: docs });
    const doc = env.documents.find((d) => d.id === 'd-public')!;
    expect(doc).toEqual({ id: 'd-public', name: 'Market read', classification: DOCUMENT_CLASSIFICATION.PUBLIC, body: 'public' });
    expect(doc).not.toHaveProperty('dealId');
    expect(doc).not.toHaveProperty('minPhase');
  });

  it('carries the job goal, completion condition and brief into the envelope', () => {
    const env = assembleEnvelope({ job, actor: dealTeam, candidates: docs });
    expect(env.jobId).toBe('job-1');
    expect(env.dealId).toBe('deal-atlassian');
    expect(env.actorId).toBe('actor-analyst');
    expect(env.goal).toBe('Prepare the teaser');
    expect(env.completionCondition).toBe('A compliance-cleared teaser exists');
    expect(env.brief?.sellerName).toBe('Atlassian');
  });

  it('refuses to assemble for an actor scoped to a different deal than the job', () => {
    const foreign: ActorClearance = { ...dealTeam, dealId: 'deal-other' };
    expect(() => assembleEnvelope({ job, actor: foreign, candidates: docs })).toThrow();
  });
});
