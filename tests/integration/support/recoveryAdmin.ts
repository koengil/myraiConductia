import type { SupabaseClient } from "@supabase/supabase-js";
import { attachRpc } from "./recoveryAdminAttach";
import { buildFrom } from "./recoveryAdminFrom";
import {
  createRecoveryAdminState,
  type FakeDeal,
  type FakeDealStep,
  type FakeOperationRow,
  type RecoveryAdminState,
} from "./recoveryAdminState";
import { transitionRpc } from "./recoveryAdminTransition";

function readRpc(state: RecoveryAdminState) {
  if (state.authError !== null) return { data: null, error: state.authError };
  return { data: {}, error: null };
}

async function callRpc(
  state: RecoveryAdminState,
  fn: string,
  args: Record<string, unknown>,
) {
  if (fn === "skill_publication_read") return readRpc(state);
  if (fn === "skill_publication_transition") return transitionRpc(state, args);
  if (fn === "skill_publication_attach") return attachRpc(state, args);
  if (fn === "skill_publication_due") return { data: [], error: null };
  return { data: null, error: null };
}

function getOperationOrThrow(
  state: RecoveryAdminState,
  id: string,
): FakeOperationRow {
  const row = state.operations.get(id);
  if (row === undefined) throw new Error(`no fake operation ${id}`);
  return row;
}

function patchOperation(
  state: RecoveryAdminState,
  id: string,
  patch: Partial<FakeOperationRow>,
): void {
  state.operations.set(id, { ...getOperationOrThrow(state, id), ...patch });
}

function setDealStepRemoved(
  state: RecoveryAdminState,
  id: string,
  removedAt: string | null,
): void {
  const step = state.dealSteps.get(id);
  if (step === undefined) throw new Error(`no fake deal step ${id}`);
  state.dealSteps.set(id, { ...step, removed_at: removedAt });
}

export function violatesOneLivePerDraft(
  state: RecoveryAdminState,
  row: FakeOperationRow,
): boolean {
  if (row.state === "failed") return false;
  for (const existing of state.operations.values()) {
    if (existing.id === row.id) continue;
    if (existing.draft_id === row.draft_id && existing.state !== "failed")
      return true;
  }
  return false;
}

function insertOperation(
  state: RecoveryAdminState,
  row: FakeOperationRow,
): void {
  if (violatesOneLivePerDraft(state, row)) {
    throw new Error("skill_publication_one_live_per_draft_idx violated");
  }
  state.operations.set(row.id, row);
}

export type RecoveryAdmin = {
  admin: SupabaseClient;
  insertOperation(row: FakeOperationRow): void;
  insertDealStep(step: FakeDealStep): void;
  insertDeal(id: string, deal: FakeDeal): void;
  insertCandidate(id: string, name: string): void;
  getOperation(id: string): FakeOperationRow;
  patchOperation(id: string, patch: Partial<FakeOperationRow>): void;
  setAuthError(error: { code: string } | null): void;
  failNextAttach(times: number): void;
  loseNextAttachReply(): void;
  setDealStepRemoved(id: string, removedAt: string | null): void;
  dealStepsForRequest(requestId: string): FakeDealStep[];
};

function buildSupabaseLikeAdmin(state: RecoveryAdminState): SupabaseClient {
  return {
    from: buildFrom(state),
    rpc: (fn: string, args: Record<string, unknown>) =>
      callRpc(state, fn, args),
  } as unknown as SupabaseClient;
}

function buildMutationApi(
  state: RecoveryAdminState,
): Omit<RecoveryAdmin, "admin"> {
  return {
    insertOperation: (row) => insertOperation(state, row),
    insertDealStep: (step) => state.dealSteps.set(step.id, step),
    insertDeal: (id, deal) => state.deals.set(id, deal),
    insertCandidate: (id, name) =>
      state.candidates.set(id, { preview: { name } }),
    getOperation: (id) => getOperationOrThrow(state, id),
    patchOperation: (id, patch) => patchOperation(state, id, patch),
    setAuthError: (error) => {
      state.authError = error;
    },
    failNextAttach: (times) => {
      state.attachFailuresRemaining = times;
    },
    loseNextAttachReply: () => {
      state.loseAttachReplyOnce = true;
    },
    setDealStepRemoved: (id, removedAt) =>
      setDealStepRemoved(state, id, removedAt),
    dealStepsForRequest: (requestId) =>
      [...state.dealSteps.values()].filter(
        (step) => step.request_id === requestId,
      ),
  };
}

export function createRecoveryAdmin(): RecoveryAdmin {
  const state = createRecoveryAdminState();
  return { admin: buildSupabaseLikeAdmin(state), ...buildMutationApi(state) };
}
