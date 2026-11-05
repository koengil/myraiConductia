// Single-skill execution path — the spike seam for "run one skill on a deal".
//
// The Orchestrator (orchestrator.ts) drives multi-state workflow skeletons;
// this runner is the one-step case the FP/RTS sync asked for: dispatch a skill,
// gate its output through the paired reviewer, and return the reviewed JSON.
// It reuses the same governance parts — sealed envelope (envelope.ts), the
// supervisor's out-of-envelope monitor, and structured audit events — so a
// skill run is exactly as leashed as a workflow step. When multi-skill
// workflows generalize, this folds into the Orchestrator as a one-step
// skeleton; the CapabilityAgent contract is identical on both paths.

import { assembleEnvelope } from './envelope';
import { selectModel } from './model-router';
import { ComplianceSupervisor } from './compliance/supervisor';
import type { CapabilityAgent } from './contract';
import type {
  ActorClearance,
  AuditEventType,
  ComplianceMonitorEntry,
  DealDocument,
  Job,
  SkillReviewVerdict,
} from './types';

export type SkillRunStatus = 'complete' | 'halted' | 'rejected' | 'failed';

/** Structured audit event for a single-skill run (same event vocabulary as the spine). */
export type SkillRunEvent = {
  seq: number;
  jobId: string;
  type: AuditEventType;
  detail: Record<string, unknown>;
};

export type SkillRunRecord<T = unknown> = {
  job: Job;
  status: SkillRunStatus;
  events: SkillRunEvent[];
  output?: T;
  review?: SkillReviewVerdict;
};

export type SkillRunParams<T> = {
  job: Job;
  actor: ActorClearance;
  candidates: DealDocument[];
  skill: CapabilityAgent<T>;
  reviewer: CapabilityAgent<SkillReviewVerdict>;
  supervisor?: ComplianceSupervisor;
};

export async function runSkillOnce<T>(params: SkillRunParams<T>): Promise<SkillRunRecord<T>> {
  const { job, actor, candidates, skill, reviewer } = params;
  const supervisor = params.supervisor ?? new ComplianceSupervisor();

  const record: SkillRunRecord<T> = { job, status: 'failed', events: [] };
  let seq = 0;
  const emit = (type: AuditEventType, detail: Record<string, unknown> = {}) => {
    record.events.push({ seq: seq++, jobId: job.id, type, detail });
  };

  emit('JOB_CREATED', {
    goal: job.goal,
    dealId: job.dealId,
    actor: job.requestingActorId,
    stakes: job.stakes,
  });

  // Skill runs are internal data-capture steps: routed like research.
  const model = selectModel({ step: 'research', stakes: job.stakes });

  const dispatch = async <R>(
    agent: CapabilityAgent<R>,
    priorFindings?: Record<string, unknown>,
  ): Promise<{ ok: true; result: R } | { ok: false; halted: boolean; reason?: string }> => {
    const envelope = assembleEnvelope({ job, actor, candidates });
    if (priorFindings) envelope.priorFindings = priorFindings;
    const allowed = envelope.documents.map((d) => d.id);

    emit('AGENT_DISPATCHED', { agent: agent.name, model, envelopeDocs: allowed });

    const seen: ComplianceMonitorEntry[] = [];
    const result = await agent.run({
      goal: job.goal,
      envelope,
      completionCondition: job.completionCondition,
      model,
      report: (entry) => seen.push(entry),
    });

    for (const entry of seen) {
      const verdict = supervisor.inspect(entry, allowed);
      if (verdict.halt) {
        emit('AGENT_HALTED', { agent: agent.name, reason: verdict.reason });
        return { ok: false, halted: true, reason: verdict.reason };
      }
    }

    if (result.status !== 'complete') {
      return { ok: false, halted: false };
    }

    emit('AGENT_REPORTED', {
      agent: agent.name,
      saw: result.auditRecord.saw,
      did: result.auditRecord.did,
      why: result.auditRecord.why,
      model: result.auditRecord.modelUsed,
      tokens: result.auditRecord.tokens,
      completionAssertion: result.completionAssertion,
    });
    return { ok: true, result: result.result };
  };

  const skillOut = await dispatch<T>(skill);
  if (!skillOut.ok) {
    record.status = skillOut.halted ? 'halted' : 'failed';
    emit('JOB_TERMINATED', {
      step: 'skill',
      reason: skillOut.halted ? skillOut.reason : 'skill did not complete',
    });
    return record;
  }
  record.output = skillOut.result;

  const reviewOut = await dispatch<SkillReviewVerdict>(reviewer, { output: skillOut.result });
  if (!reviewOut.ok) {
    record.status = reviewOut.halted ? 'halted' : 'failed';
    if (reviewOut.halted) record.output = undefined; // a halted run surfaces nothing
    emit('JOB_TERMINATED', {
      step: 'review',
      reason: reviewOut.halted ? reviewOut.reason : 'reviewer did not complete',
    });
    return record;
  }
  record.review = reviewOut.result;

  if (!reviewOut.result.approved) {
    record.status = 'rejected';
    emit('JOB_TERMINATED', { step: 'review', reason: 'reviewer rejected the output', issues: reviewOut.result.issues });
    return record;
  }

  record.status = 'complete';
  emit('JOB_COMPLETED', { candidateFields: 'sector/geography/ownership/growth' });
  return record;
}
