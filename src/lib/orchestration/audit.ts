// Durable persistence + audit replay (kickoff #3, #6).
//
// Every transition persists state and appends a structured audit event, so a
// job can be resumed, inspected and replayed. The whole run is reconstructable
// from the audit log alone — including what each agent saw, did, why, the model
// used and the token counts. The store is an in-memory implementation for the
// proof; a Supabase-backed JobStore drops in behind the same interface later.

import type {
  AuditEvent,
  AuditEventType,
  GateDecision,
  JobRecord,
  WorkflowState,
} from './types';

export interface JobStore {
  save(record: JobRecord): Promise<void>;
  load(jobId: string): Promise<JobRecord | undefined>;
}

export class InMemoryJobStore implements JobStore {
  private readonly records = new Map<string, JobRecord>();

  async save(record: JobRecord): Promise<void> {
    // Snapshot on write so callers cannot mutate persisted state by reference.
    this.records.set(record.job.id, structuredClone(record));
  }

  async load(jobId: string): Promise<JobRecord | undefined> {
    const found = this.records.get(jobId);
    return found ? structuredClone(found) : undefined;
  }
}

/** Append an audit event with the next monotonic sequence number. */
export function recordEvent(
  record: JobRecord,
  type: AuditEventType,
  state: WorkflowState,
  detail: Record<string, unknown>,
): AuditEvent {
  const event: AuditEvent = {
    seq: record.events.length,
    jobId: record.job.id,
    type,
    state,
    detail,
  };
  record.events.push(event);
  return event;
}

export type ReconstructedAgent = {
  agent: string;
  saw: string[];
  did: string;
  why: string;
  model: string;
  tokens: number;
};

export type ReconstructedRun = {
  jobId: string;
  states: WorkflowState[];
  agents: ReconstructedAgent[];
  complianceDecision?: GateDecision;
  gatesApproved: string[];
  totalTokens: number;
  terminal?: WorkflowState;
  completed: boolean;
};

/** Rebuild a run purely from its ordered audit events. */
export function reconstruct(events: AuditEvent[]): ReconstructedRun {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const jobId = ordered[0]?.jobId ?? '';

  const states: WorkflowState[] = [];
  const agents: ReconstructedAgent[] = [];
  const gatesApproved: string[] = [];
  let complianceDecision: GateDecision | undefined;
  let terminal: WorkflowState | undefined;
  let completed = false;

  for (const e of ordered) {
    switch (e.type) {
      case 'STATE_ENTERED':
        states.push(e.state);
        break;
      case 'AGENT_REPORTED':
        agents.push({
          agent: String(e.detail.agent),
          saw: (e.detail.saw as string[]) ?? [],
          did: String(e.detail.did),
          why: String(e.detail.why),
          model: String(e.detail.model),
          tokens: Number(e.detail.tokens ?? 0),
        });
        break;
      case 'COMPLIANCE_VERDICT':
        complianceDecision = e.detail.decision as GateDecision;
        break;
      case 'GATE_APPROVED':
        gatesApproved.push(String(e.detail.gate));
        break;
      case 'JOB_COMPLETED':
        terminal = e.state;
        completed = true;
        break;
      case 'JOB_TERMINATED':
        terminal = e.state;
        break;
      default:
        break;
    }
  }

  // INTERPRET is the entry state; surface it even though it has no STATE_ENTERED.
  if (ordered.length > 0 && states[0] !== ordered[0].state && ordered[0].type === 'JOB_CREATED') {
    states.unshift(ordered[0].state);
  }

  const totalTokens = agents.reduce((sum, a) => sum + a.tokens, 0);

  return {
    jobId,
    states,
    agents,
    complianceDecision,
    gatesApproved,
    totalTokens,
    terminal,
    completed,
  };
}
