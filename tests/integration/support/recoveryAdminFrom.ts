import { TABLE } from "@/lib/constants/tables";
import type { RecoveryAdminState } from "./recoveryAdminState";

type SelectResult = Promise<{ data: unknown[]; error: null }>;

function matchOperations(
  state: RecoveryAdminState,
  column: string,
  value: unknown,
): unknown[] {
  const rows = [...state.operations.values()];
  if (column === "id") return rows.filter((row) => row.id === value);
  if (column === "deal_id") {
    return rows.filter((row) => row.deal_id === value);
  }
  return [];
}

function matchDealSteps(
  state: RecoveryAdminState,
  column: string,
  value: unknown,
): unknown[] {
  if (column !== "deal_id") return [];
  return [...state.dealSteps.values()].filter((row) => row.deal_id === value);
}

function matchDeals(state: RecoveryAdminState, value: unknown): unknown[] {
  const deal = state.deals.get(value as string);
  return deal ? [{ tenant_id: deal.tenant_id }] : [];
}

function matchCandidates(state: RecoveryAdminState, value: unknown): unknown[] {
  const candidate = state.candidates.get(value as string);
  return candidate ? [candidate] : [];
}

function selectEq(
  state: RecoveryAdminState,
  table: string,
  column: string,
  value: unknown,
): SelectResult {
  if (table === TABLE.SKILL_PUBLICATION_OPERATIONS) {
    return Promise.resolve({
      data: matchOperations(state, column, value),
      error: null,
    });
  }
  if (table === TABLE.DEAL_STEPS) {
    return Promise.resolve({
      data: matchDealSteps(state, column, value),
      error: null,
    });
  }
  if (table === TABLE.DEALS) {
    return Promise.resolve({ data: matchDeals(state, value), error: null });
  }
  if (table === TABLE.SKILL_AUTHORING_CANDIDATES) {
    return Promise.resolve({
      data: matchCandidates(state, value),
      error: null,
    });
  }
  return Promise.resolve({ data: [], error: null });
}

export function buildFrom(state: RecoveryAdminState) {
  return (table: string) => ({
    select: () => ({
      eq: (column: string, value: unknown) =>
        selectEq(state, table, column, value),
    }),
  });
}
