import type { OperationRow, ProcessorDeps } from "./processorTypes";
import { dbFailure } from '@/lib/errors/upstream';

export type AuthorizationCheck =
  | { authorized: true }
  | { authorized: false; code: "access_lost" | "feature_disabled" };

const ACCESS_LOST_RPC_CODES = new Set(["42501", "P0002"]);

export async function checkAuthorization(
  deps: ProcessorDeps,
  op: OperationRow,
): Promise<AuthorizationCheck> {
  const { error } = await deps.admin.rpc("skill_publication_read", {
    p_actor_id: op.actor_id,
    p_deal_id: op.deal_id,
    p_publication_id: op.id,
    p_correlation_id: deps.correlationId(),
  });
  if (error) {
    if (ACCESS_LOST_RPC_CODES.has(String(error.code))) {
      return { authorized: false, code: "access_lost" };
    }
    throw dbFailure("Skill publication read", error);
  }

  const flagEnabled = await deps.isFlagEnabled("skill_authoring");
  if (!flagEnabled) {
    return { authorized: false, code: "feature_disabled" };
  }

  return { authorized: true };
}
