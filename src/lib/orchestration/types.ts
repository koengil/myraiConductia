// Orchestration spine — structural types only; no logic.
//
// The Job is the universal primitive both the synchronous copilot and the
// (later) asynchronous sweep agent produce. The spine consumes Jobs and runs
// each through a deterministic workflow state machine whose nodes are leashed
// sub-agents. See docs/03-engineering/orchestration-spine.md and the branch
// kickoff for the eight architecture decisions these types encode.

import type { ComplianceCheckResult } from '../api/types';
import type { DealRole, FirmRole } from '../constants/roles';
import type { DocumentClassification } from '../constants/documents';

/** Stakes split drives autonomy (kickoff #8): high = anything leaving the firm. */
export type Stakes = 'low' | 'high';

/** Model tiers — routing decided by importance, not cost (kickoff #7). */
export type ModelTier = 'frontier' | 'standard' | 'economy';

/**
 * The universal primitive (kickoff #1). The copilot is just the first producer.
 * `completionCondition` is a human-readable, machine-checkable assertion the
 * workflow proves before it may reach COMPLETE.
 */
export type Job = {
  id: string;
  goal: string;
  dealId: string;
  requestingActorId: string;
  completionCondition: string;
  stakes: Stakes;
  brief?: DealBrief;
};

/** A short deal brief stub the draft agent composes a teaser from. Synthetic. */
export type DealBrief = {
  sellerName: string;
  sector: string;
  /** One-line positioning the draft incorporates verbatim. */
  headline: string;
};

/**
 * A candidate document the orchestrator may place into an envelope. Synthetic
 * for this branch (no data room). `classification` + `minPhase` are the
 * sensitivity gates; `dealId` is the scope gate.
 */
export type DealDocument = {
  id: string;
  dealId: string;
  name: string;
  classification: DocumentClassification;
  minPhase: number;
  body: string;
};

/**
 * What the orchestrator knows about the requesting actor's clearance. In
 * production this is resolved through src/lib/api/v1/access.ts over Supabase;
 * here it is passed in so the spine stays pure and hermetic.
 */
export type ActorClearance = {
  actorId: string;
  dealId: string;
  dealRole: DealRole;
  firmRole?: FirmRole;
  phase: number;
};

/** A document as it appears INSIDE an envelope (already cleared for the actor). */
export type EnvelopeDocument = {
  id: string;
  name: string;
  classification: DocumentClassification;
  body: string;
};

/**
 * The sealed context envelope (kickoff #5). The orchestrator assembles it,
 * pre-filtered by the actor's permissions and document sensitivity, and pushes
 * it to a sub-agent. A sub-agent can only ever see what is in here.
 */
export type ContextEnvelope = {
  jobId: string;
  dealId: string;
  actorId: string;
  goal: string;
  completionCondition: string;
  documents: EnvelopeDocument[];
  brief?: DealBrief;
  /**
   * Upstream agent findings the orchestrator pushes forward (e.g. research
   * output handed to the draft step). Already permission-cleared, since it was
   * derived from cleared envelope data. Keeps context pushed, never pulled.
   */
  priorFindings?: Record<string, unknown>;
};

/** Uniform agent contract — result side (kickoff: the agent contract). */
export type AgentStatus = 'complete' | 'needs_input' | 'failed';

/** What an agent saw, did, why — plus model + token spend. Audited per agent. */
export type AgentReport = {
  saw: string[]; // ids of envelope artifacts the agent consumed
  did: string;
  why: string;
  modelUsed: ModelTier;
  tokens: number;
};

export type AgentResult<T = unknown> = {
  result: T;
  auditRecord: AgentReport;
  status: AgentStatus;
  /** Evidence the completion condition is met. */
  completionAssertion: string;
};

/** Research agent output (mock, canned for Atlassian). */
export type ResearchOutput = {
  comps: { name: string; evRevenue: number }[];
  marketRead: string;
};

/** Draft agent output. */
export type DraftOutput = {
  teaser: string;
};

/**
 * Target Universe skill output (mock, canned for Atlassian) — the first
 * RTS-shaped skill run through the spine. The four candidate fields are the
 * fixed output contract agreed at the 2026-07-13 FP/RTS sync; the UI maps
 * this JSON directly (skill-authoring-rules.md rule 2).
 */
export type TargetUniverseCandidate = {
  name: string;
  sector: string;
  geography: string;
  ownership: 'public' | 'private' | 'pe-backed';
  revenueGrowthPct: number;
};

export type TargetUniverseOutput = {
  candidates: TargetUniverseCandidate[];
  summary: string;
};

/**
 * Verdict a paired reviewer agent returns over another skill's output
 * (skill-authoring-rules.md rules 5–6: reviewer gates before a human sees it).
 */
export type SkillReviewVerdict = {
  approved: boolean;
  issues: string[];
};

/** The mandatory reporting channel every agent emits to (kickoff #4). */
export type ComplianceReporter = (entry: ComplianceMonitorEntry) => void;

export type ComplianceMonitorEntry = {
  agent: string;
  saw: string[];
  did: string;
  why: string;
};

/** Workflow states for the "prepare the teaser" skeleton. */
export type WorkflowState =
  | 'INTERPRET'
  | 'PLAN'
  | 'AWAIT_PLAN_CONFIRM'
  | 'RESEARCH'
  | 'DRAFT'
  | 'COMPLIANCE_SCREEN'
  | 'AWAIT_SIGNOFF'
  | 'COMPLETE'
  | 'BLOCKED'
  | 'HALTED'
  | 'FAILED';

export const TERMINAL_STATES: readonly WorkflowState[] = [
  'COMPLETE',
  'BLOCKED',
  'HALTED',
  'FAILED',
] as const;

export function isTerminal(state: WorkflowState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Human approval gates that pause the machine (kickoff #8). */
export type Gate = 'plan' | 'signoff';

/** Compliance pre-send gate decision (kickoff #6). */
export type GateDecision = 'clear' | 'hold' | 'block';

export type AuditEventType =
  | 'JOB_CREATED'
  | 'STATE_ENTERED'
  | 'AGENT_DISPATCHED'
  | 'AGENT_REPORTED'
  | 'COMPLIANCE_VERDICT'
  | 'GATE_AWAITING'
  | 'GATE_APPROVED'
  | 'AGENT_HALTED'
  | 'JOB_COMPLETED'
  | 'JOB_TERMINATED';

/**
 * Structured audit event. Every transition emits one; the whole run is
 * reconstructable from these alone (kickoff #3, #6). The audit trail covers
 * agents, not just users.
 */
export type AuditEvent = {
  seq: number;
  jobId: string;
  type: AuditEventType;
  state: WorkflowState;
  detail: Record<string, unknown>;
};

/** Persisted job record — durable + resumable. */
export type JobRecord = {
  job: Job;
  state: WorkflowState;
  events: AuditEvent[];
  research?: ResearchOutput;
  draft?: DraftOutput;
  compliance?: ComplianceCheckResult;
  /** The final artifact that leaves the firm — set only at COMPLETE. */
  artifact?: string;
  awaitingGate?: Gate;
};
