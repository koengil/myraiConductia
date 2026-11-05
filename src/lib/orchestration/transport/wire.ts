// Wire format for running a skill over HTTP — the CapabilityAgent contract
// serialized, nothing more. This is the E2E communication seam the FP/RTS
// sync asked us to prove: the platform POSTs the sealed envelope out, the
// skill service returns the structured result back.
//
// The one non-obvious field is `reports`: the in-process contract gives every
// agent a mandatory report side-channel to the compliance supervisor. Over
// HTTP the channel cannot be a callback, so the service collects the entries
// and returns them; the client replays them locally. The monitor therefore
// governs a remote skill exactly as it governs an in-process one — a remote
// skill that saw beyond its envelope is still halted.

import type {
  AgentReport,
  AgentStatus,
  ComplianceMonitorEntry,
  ContextEnvelope,
  ModelTier,
} from '../types';

export type SkillWireRequest = {
  /** Registry id of the skill to run (e.g. 'target-universe'). */
  skill: string;
  goal: string;
  envelope: ContextEnvelope;
  completionCondition: string;
  model: ModelTier;
};

export type SkillWireResponse<T = unknown> = {
  result: T;
  auditRecord: AgentReport;
  status: AgentStatus;
  completionAssertion: string;
  /** Report-channel entries emitted remotely, replayed by the client. */
  reports: ComplianceMonitorEntry[];
};
