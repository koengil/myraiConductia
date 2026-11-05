// The orchestration spine — a deterministic, durable, resumable state machine.
//
// The orchestrator is inspectable code, not an LLM planner. It selects a
// pre-built workflow skeleton for a Job and runs it as an explicit state
// machine. Every transition persists state and emits a structured audit event,
// so a job can be resumed, inspected and replayed. The conductor is dumb on
// purpose; the intelligence lives in the leashed sub-agents it dispatches.
//
// Flow (kickoff "Prepare the teaser"):
//   INTERPRET -> PLAN -> [AWAIT_PLAN_CONFIRM] -> RESEARCH -> DRAFT
//             -> COMPLIANCE_SCREEN -> [AWAIT_SIGNOFF] -> COMPLETE
//   Terminals: BLOCKED (compliance hard stop), HALTED (monitor killed a rogue
//   agent), FAILED.

import { assembleEnvelope } from './envelope';
import { InMemoryJobStore, recordEvent, type JobStore } from './audit';
import { selectModel, TokenMeter } from './model-router';
import { ComplianceSupervisor } from './compliance/supervisor';
import { ResearchAgent } from './agents/research-agent';
import { DraftAgent } from './agents/draft-agent';
import { selectWorkflow } from './workflows/teaser';
import type { CapabilityAgent } from './contract';
import {
  isTerminal,
  type ActorClearance,
  type ComplianceMonitorEntry,
  type DealDocument,
  type DraftOutput,
  type Gate,
  type Job,
  type JobRecord,
  type ResearchOutput,
  type WorkflowState,
} from './types';

/**
 * The orchestrator's view of the world for a run: the requesting actor's
 * clearance and the candidate documents it may push. In production both are
 * re-resolved from Supabase via src/lib/api/v1/access.ts on every call; here
 * they are passed in so the spine stays pure (and so resume re-supplies them).
 */
export type RunContext = {
  actor: ActorClearance;
  documents: DealDocument[];
};

export type OrchestratorOptions = {
  store?: JobStore;
  supervisor?: ComplianceSupervisor;
  researchAgent?: CapabilityAgent<ResearchOutput>;
  draftAgent?: CapabilityAgent<DraftOutput>;
};

type DispatchOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; halted: true; reason?: string }
  | { ok: false; halted: false };

export class Orchestrator {
  readonly meter = new TokenMeter();
  private readonly store: JobStore;
  private readonly supervisor: ComplianceSupervisor;
  private readonly research: CapabilityAgent<ResearchOutput>;
  private readonly draft: CapabilityAgent<DraftOutput>;

  constructor(opts: OrchestratorOptions = {}) {
    this.store = opts.store ?? new InMemoryJobStore();
    this.supervisor = opts.supervisor ?? new ComplianceSupervisor();
    this.research = opts.researchAgent ?? new ResearchAgent();
    this.draft = opts.draftAgent ?? new DraftAgent();
  }

  /** Produce + run a Job until it pauses at a gate or reaches a terminal. */
  async start(job: Job, ctx: RunContext): Promise<JobRecord> {
    const record: JobRecord = { job, state: 'INTERPRET', events: [] };
    recordEvent(record, 'JOB_CREATED', 'INTERPRET', {
      goal: job.goal,
      dealId: job.dealId,
      actor: job.requestingActorId,
      stakes: job.stakes,
    });
    await this.store.save(record);
    return this.drive(record, ctx);
  }

  /** Advance past a human gate on explicit approval. */
  async approve(jobId: string, gate: Gate, ctx: RunContext): Promise<JobRecord> {
    const record = await this.mustLoad(jobId);
    if (record.awaitingGate !== gate) {
      throw new Error(`Job ${jobId} is not awaiting "${gate}" (awaiting: ${record.awaitingGate ?? 'none'})`);
    }
    recordEvent(record, 'GATE_APPROVED', record.state, { gate });
    record.awaitingGate = undefined;

    if (gate === 'plan') {
      this.enter(record, 'RESEARCH');
      return this.drive(record, ctx);
    }
    // signoff: the artifact may now leave the firm.
    this.complete(record);
    await this.store.save(record);
    return record;
  }

  /** Re-hydrate and continue a persisted job (durability/resumability proof). */
  async resume(jobId: string, ctx: RunContext): Promise<JobRecord> {
    const record = await this.mustLoad(jobId);
    if (isTerminal(record.state) || record.awaitingGate) return record;
    return this.drive(record, ctx);
  }

  async load(jobId: string): Promise<JobRecord | undefined> {
    return this.store.load(jobId);
  }

  // --- internals ---------------------------------------------------------

  private async mustLoad(jobId: string): Promise<JobRecord> {
    const record = await this.store.load(jobId);
    if (!record) throw new Error(`Unknown job ${jobId}`);
    return record;
  }

  /** Run states until we pause at a gate or hit a terminal. */
  private async drive(record: JobRecord, ctx: RunContext): Promise<JobRecord> {
    let guard = 0;
    while (!isTerminal(record.state) && record.awaitingGate === undefined) {
      if (guard++ > 64) throw new Error('orchestrator loop guard tripped');
      await this.runState(record, ctx);
    }
    await this.store.save(record);
    return record;
  }

  private async runState(record: JobRecord, ctx: RunContext): Promise<void> {
    switch (record.state) {
      case 'INTERPRET': {
        const wf = selectWorkflow(record.job);
        if (!wf) {
          this.terminate(record, 'FAILED', { reason: 'No workflow skeleton matches the goal' });
          return;
        }
        this.enter(record, 'PLAN', { workflow: wf.name });
        return;
      }

      case 'PLAN': {
        const plan = {
          research: selectModel({ step: 'research', stakes: record.job.stakes }),
          draft: selectModel({ step: 'draft', stakes: record.job.stakes }),
        };
        // High-stakes jobs surface the plan for a one-tap confirm before running.
        if (record.job.stakes === 'high') {
          this.awaitGate(record, 'plan', 'AWAIT_PLAN_CONFIRM', { plan });
          return;
        }
        this.enter(record, 'RESEARCH', { plan });
        return;
      }

      case 'RESEARCH': {
        const out = await this.dispatch<ResearchOutput>(record, ctx, 'research', this.research);
        if (!out.ok) {
          this.terminate(record, out.halted ? 'HALTED' : 'FAILED', {
            step: 'research',
            reason: out.halted ? out.reason : 'research agent did not complete',
          });
          return;
        }
        record.research = out.result;
        this.enter(record, 'DRAFT');
        return;
      }

      case 'DRAFT': {
        const out = await this.dispatch<DraftOutput>(record, ctx, 'draft', this.draft, {
          research: record.research,
        });
        if (!out.ok) {
          this.terminate(record, out.halted ? 'HALTED' : 'FAILED', {
            step: 'draft',
            reason: out.halted ? out.reason : 'draft agent did not complete',
          });
          return;
        }
        record.draft = out.result;
        this.enter(record, 'COMPLIANCE_SCREEN');
        return;
      }

      case 'COMPLIANCE_SCREEN': {
        const teaser = record.draft?.teaser ?? '';
        const outcome = this.supervisor.gate(teaser);
        record.compliance = outcome.result;
        recordEvent(record, 'COMPLIANCE_VERDICT', 'COMPLIANCE_SCREEN', {
          decision: outcome.decision,
          verdict: outcome.result.verdict,
          reasons: outcome.result.reasons,
          rewrite: outcome.result.rewrite,
        });
        if (outcome.decision === 'block') {
          this.terminate(record, 'BLOCKED', {
            reasons: outcome.result.reasons,
            rewrite: outcome.result.rewrite,
          });
          return;
        }
        // clear or hold: an external-facing artifact requires human sign-off.
        const wf = selectWorkflow(record.job);
        if (wf?.externalFacing || record.job.stakes === 'high') {
          this.awaitGate(record, 'signoff', 'AWAIT_SIGNOFF', { decision: outcome.decision });
          return;
        }
        this.complete(record);
        return;
      }

      default:
        throw new Error(`No handler for state ${record.state}`);
    }
  }

  private async dispatch<T>(
    record: JobRecord,
    ctx: RunContext,
    step: 'research' | 'draft',
    agent: CapabilityAgent<T>,
    priorFindings?: Record<string, unknown>,
  ): Promise<DispatchOutcome<T>> {
    const model = selectModel({ step, stakes: record.job.stakes });
    const envelope = assembleEnvelope({
      job: record.job,
      actor: ctx.actor,
      candidates: ctx.documents,
    });
    if (priorFindings) envelope.priorFindings = priorFindings;

    const allowed = envelope.documents.map((d) => d.id);
    recordEvent(record, 'AGENT_DISPATCHED', record.state, {
      agent: agent.name,
      model,
      envelopeDocs: allowed,
    });

    const seen: ComplianceMonitorEntry[] = [];
    const result = await agent.run({
      goal: record.job.goal,
      envelope,
      completionCondition: record.job.completionCondition,
      model,
      report: (entry) => seen.push(entry),
    });

    // Continuous monitor: an agent may only ever have seen what it was given.
    for (const entry of seen) {
      const verdict = this.supervisor.inspect(entry, allowed);
      if (verdict.halt) {
        recordEvent(record, 'AGENT_HALTED', record.state, { agent: agent.name, reason: verdict.reason });
        return { ok: false, halted: true, reason: verdict.reason };
      }
    }

    if (result.status !== 'complete') {
      return { ok: false, halted: false };
    }

    recordEvent(record, 'AGENT_REPORTED', record.state, {
      agent: agent.name,
      saw: result.auditRecord.saw,
      did: result.auditRecord.did,
      why: result.auditRecord.why,
      model: result.auditRecord.modelUsed,
      tokens: result.auditRecord.tokens,
      completionAssertion: result.completionAssertion,
    });
    this.meter.record({
      agent: agent.name,
      dealId: record.job.dealId,
      actorId: record.job.requestingActorId,
      model: result.auditRecord.modelUsed,
      tokens: result.auditRecord.tokens,
    });
    return { ok: true, result: result.result };
  }

  private enter(record: JobRecord, state: WorkflowState, detail: Record<string, unknown> = {}): void {
    record.state = state;
    recordEvent(record, 'STATE_ENTERED', state, detail);
  }

  private awaitGate(record: JobRecord, gate: Gate, state: WorkflowState, detail: Record<string, unknown> = {}): void {
    record.state = state;
    record.awaitingGate = gate;
    recordEvent(record, 'GATE_AWAITING', state, { gate, ...detail });
  }

  private complete(record: JobRecord): void {
    record.artifact = record.draft?.teaser;
    record.state = 'COMPLETE';
    recordEvent(record, 'JOB_COMPLETED', 'COMPLETE', {
      artifactChars: record.artifact?.length ?? 0,
    });
  }

  private terminate(record: JobRecord, state: WorkflowState, detail: Record<string, unknown>): void {
    record.state = state;
    recordEvent(record, 'JOB_TERMINATED', state, detail);
  }
}
