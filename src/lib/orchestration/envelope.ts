// Context envelope assembly — the agent-layer compliance floor (kickoff #5).
//
// The orchestrator assembles the envelope, already filtered by the actor's
// permissions and the document sensitivity level, and pushes it to a sub-agent.
// A sub-agent can only ever see what is in here; it never reaches into a store
// itself. The gating mirrors the rules enforced server-side by
// src/lib/api/v1/access.ts and the documents.classification CHECK — replicated
// here as pure predicates so the spine is hermetic and unit-testable.

import { DOCUMENT_CLASSIFICATION } from '../constants/documents';
import { FIRM_ROLE, DEAL_ROLE } from '../constants/roles';
import type {
  ActorClearance,
  ContextEnvelope,
  DealDocument,
  EnvelopeDocument,
  Job,
} from './types';

/**
 * Class 4 (MNPI) is hidden from every role except the deal MD and the firm CCO
 * — the same rule documents.classification enforces in the migration.
 */
function clearedForClassification(doc: DealDocument, actor: ActorClearance): boolean {
  if (doc.classification < DOCUMENT_CLASSIFICATION.MNPI) return true;
  return actor.dealRole === DEAL_ROLE.MD || actor.firmRole === FIRM_ROLE.CCO;
}

function actorCanSee(doc: DealDocument, actor: ActorClearance): boolean {
  if (doc.dealId !== actor.dealId) return false; // scope gate
  if (actor.phase < doc.minPhase) return false; // phase gate
  return clearedForClassification(doc, actor); // sensitivity gate
}

function toEnvelopeDocument(doc: DealDocument): EnvelopeDocument {
  return {
    id: doc.id,
    name: doc.name,
    classification: doc.classification,
    body: doc.body,
  };
}

export function assembleEnvelope(params: {
  job: Job;
  actor: ActorClearance;
  candidates: DealDocument[];
}): ContextEnvelope {
  const { job, actor, candidates } = params;

  if (actor.dealId !== job.dealId) {
    throw new Error(
      `Actor ${actor.actorId} is scoped to ${actor.dealId}, not the job deal ${job.dealId}`,
    );
  }

  const documents = candidates
    .filter((doc) => actorCanSee(doc, actor))
    .map(toEnvelopeDocument);

  return {
    jobId: job.id,
    dealId: job.dealId,
    actorId: actor.actorId,
    goal: job.goal,
    completionCondition: job.completionCondition,
    documents,
    brief: job.brief,
  };
}
