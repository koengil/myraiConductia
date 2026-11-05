import { randomUUID } from "node:crypto";
import { skillStepDefinition } from "./recoveryFixtures";
import type {
  FakeDealStep,
  FakeOperationRow,
  RecoveryAdminState,
} from "./recoveryAdminState";

function anchorRemoved(
  state: RecoveryAdminState,
  row: FakeOperationRow,
): boolean {
  if (row.placement_kind !== "after") return false;
  const anchor = row.anchor_deal_step_id
    ? state.dealSteps.get(row.anchor_deal_step_id)
    : undefined;
  return anchor === undefined || anchor.removed_at !== null;
}

function receiptMismatch(row: FakeOperationRow): boolean {
  return (
    row.published_skill_id !== row.reserved_skill_id ||
    row.published_version_id === null ||
    row.published_digest === null ||
    row.published_digest !== row.candidate_digest
  );
}

function existingStep(
  state: RecoveryAdminState,
  row: FakeOperationRow,
): FakeDealStep | null {
  for (const step of state.dealSteps.values()) {
    if (step.request_id === row.id) return step;
  }
  return null;
}

function createStep(
  state: RecoveryAdminState,
  row: FakeOperationRow,
): FakeDealStep {
  const contract = row.capability_contract as {
    purpose: string;
    expectedInput: string;
  };
  const definition = skillStepDefinition(
    row.name,
    contract.purpose,
    contract.expectedInput,
    {
      skillId: row.published_skill_id as string,
      versionId: row.published_version_id as string,
      digest: row.published_digest as string,
    },
  );
  const step: FakeDealStep = {
    id: randomUUID(),
    deal_id: row.deal_id,
    definition,
    removed_at: null,
    request_id: row.id,
  };
  state.dealSteps.set(step.id, step);
  return step;
}

function markPublished(
  state: RecoveryAdminState,
  row: FakeOperationRow,
  stepId: string,
): FakeOperationRow {
  const next: FakeOperationRow = {
    ...row,
    state: "published",
    revision: row.revision + 1,
    status_code: null,
    status_deal_step_id: null,
    resulting_deal_step_id: stepId,
  };
  state.operations.set(row.id, next);
  return next;
}

type AttachRpcResult = { data: unknown; error: { message: string } | null };

function moveToState(
  state: RecoveryAdminState,
  row: FakeOperationRow,
  nextState: FakeOperationRow["state"],
  statusCode: string,
): AttachRpcResult {
  const next: FakeOperationRow = {
    ...row,
    state: nextState,
    status_code: statusCode,
  };
  state.operations.set(row.id, next);
  return { data: { state: next.state }, error: null };
}

function attachGuardResult(
  state: RecoveryAdminState,
  row: FakeOperationRow,
): AttachRpcResult | null {
  if (state.attachFailuresRemaining > 0) {
    state.attachFailuresRemaining -= 1;
    return { data: null, error: { message: "transient_attach_failure" } };
  }
  if (receiptMismatch(row))
    return moveToState(state, row, "reconciling", "receipt_conflict");
  if (anchorRemoved(state, row))
    return moveToState(state, row, "needs_placement", "anchor_removed");
  return null;
}

export function attachRpc(
  state: RecoveryAdminState,
  args: Record<string, unknown>,
): AttachRpcResult {
  const publicationId = args.p_publication_id as string;
  const row = state.operations.get(publicationId);
  if (row === undefined) return { data: null, error: { message: "not_found" } };
  if (row.state !== "attaching")
    return { data: { state: row.state }, error: null };

  const guarded = attachGuardResult(state, row);
  if (guarded !== null) return guarded;

  const step = existingStep(state, row) ?? createStep(state, row);
  if (state.loseAttachReplyOnce) {
    state.loseAttachReplyOnce = false;
    return { data: null, error: { message: "simulated lost attach reply" } };
  }
  const published = markPublished(state, row, step.id);
  return { data: { state: published.state }, error: null };
}
