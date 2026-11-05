// Shared fixtures for the orchestrator path tests. Not a suite itself (no
// .test suffix), so vitest does not collect it.

import { DOCUMENT_CLASSIFICATION } from '@/lib/constants/documents';
import { DEAL_ROLE } from '@/lib/constants/roles';
import type { ActorClearance, DealDocument, Job } from '@/lib/orchestration/types';
import type { RunContext } from '@/lib/orchestration/orchestrator';

export function buildJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    goal: 'Prepare the teaser for Atlassian',
    dealId: 'deal-atlassian',
    requestingActorId: 'actor-md',
    completionCondition: 'A compliance-cleared teaser exists',
    stakes: 'high',
    brief: {
      sellerName: 'Atlassian',
      sector: 'Software',
      headline: 'Category-defining collaboration software.',
      ...(overrides.brief ?? {}),
    },
    ...overrides,
  };
}

export const MD_ACTOR: ActorClearance = {
  actorId: 'actor-md',
  dealId: 'deal-atlassian',
  dealRole: DEAL_ROLE.MD,
  phase: 1,
};

export const DOCUMENTS: DealDocument[] = [
  { id: 'd-public', dealId: 'deal-atlassian', name: 'Market read', classification: DOCUMENT_CLASSIFICATION.PUBLIC, minPhase: 0, body: 'public' },
  { id: 'd-conf', dealId: 'deal-atlassian', name: 'Financials', classification: DOCUMENT_CLASSIFICATION.CONFIDENTIAL, minPhase: 0, body: 'confidential' },
];

export function ctx(
  actor: ActorClearance = MD_ACTOR,
  documents: DealDocument[] = DOCUMENTS,
): RunContext {
  return { actor, documents };
}
