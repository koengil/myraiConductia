// Agent orchestrator spine — public surface.
//
// The runtime that turns a banker request (a Job) into a governed sequence of
// sub-agent steps, with compliance supervision, scoped context envelopes, and
// explicit human sign-off. One workflow ("Prepare the teaser") is proven end to
// end; the agent contract is the seam where real capability agents plug in.

export * from './types';
export type { AgentInput, CapabilityAgent } from './contract';
export { assembleEnvelope } from './envelope';
export { selectModel, TokenMeter, type TokenSpend, type WorkflowStep } from './model-router';
export { ComplianceSupervisor, type GateOutcome, type MonitorVerdict } from './compliance/supervisor';
export { ResearchAgent } from './agents/research-agent';
export { DraftAgent } from './agents/draft-agent';
export { TargetUniverseAgent } from './agents/target-universe-agent';
export { TargetUniverseReviewAgent } from './agents/target-universe-review-agent';
export {
  runSkillOnce,
  type SkillRunParams,
  type SkillRunRecord,
  type SkillRunEvent,
  type SkillRunStatus,
} from './skill-runner';
export { HttpSkillAgent, type HttpSkillAgentOptions } from './transport/http-skill-agent';
export type { SkillWireRequest, SkillWireResponse } from './transport/wire';
export { selectWorkflow, TEASER_WORKFLOW, type WorkflowSkeleton } from './workflows/teaser';
export {
  InMemoryJobStore,
  recordEvent,
  reconstruct,
  type JobStore,
  type ReconstructedRun,
} from './audit';
export { Orchestrator, type OrchestratorOptions, type RunContext } from './orchestrator';
