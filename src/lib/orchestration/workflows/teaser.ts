// The "Prepare the teaser/pitch" workflow skeleton.
//
// The orchestrator is deterministic code, not an LLM planner: at INTERPRET it
// selects one of these pre-built skeletons for the job and runs it. The
// intelligence lives in the nodes (the sub-agents), not in the conductor. This
// is the part a regulator scrutinises, so it stays readable and inspectable.
// One skeleton is proven first; more producers/workflows slot in beside it.

import type { Job } from '../types';

export type WorkflowStepName = 'research' | 'draft';

export type WorkflowSkeleton = {
  name: string;
  steps: readonly WorkflowStepName[];
  /** Output leaves the firm, so a human sign-off gates COMPLETE. */
  externalFacing: boolean;
};

export const TEASER_WORKFLOW: WorkflowSkeleton = {
  name: 'prepare-teaser',
  steps: ['research', 'draft'],
  externalFacing: true,
};

/** Bind a job to a pre-built skeleton. Null = no skeleton matches the goal. */
export function selectWorkflow(job: Job): WorkflowSkeleton | null {
  return /teaser|pitch/i.test(job.goal) ? TEASER_WORKFLOW : null;
}
