// The uniform capability-agent contract.
//
// Every capability — an in-house mock today, a third-party PowerPoint or
// financial-modeling agent later — conforms to this one interface, so the
// orchestrator does not care whose agent it is. The agent does NO fetching:
// everything it may ever see is in the pushed envelope (kickoff #5). This is
// the seam where real agents plug in with zero spine changes.

import type {
  AgentResult,
  ComplianceReporter,
  ContextEnvelope,
  ModelTier,
} from './types';

export type AgentInput = {
  goal: string;
  envelope: ContextEnvelope;
  completionCondition: string;
  /** The tier the orchestrator routed this step to (kickoff #7). */
  model: ModelTier;
  /** Mandatory side channel to the compliance supervisor (kickoff #4). */
  report: ComplianceReporter;
};

export interface CapabilityAgent<T = unknown> {
  readonly name: string;
  run(input: AgentInput): Promise<AgentResult<T>>;
}
