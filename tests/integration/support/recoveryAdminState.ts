import type { OperationRow } from "@/lib/skillPublication/processorTypes";

export type FakeOperationRow = OperationRow & {
  draft_id: string;
  revision: number;
  reserved_step_key: string;
  published_skill_id: string | null;
  published_version_id: string | null;
  published_digest: string | null;
  resulting_deal_step_id: string | null;
  phase_index: number;
  placement_kind: "phase_start" | "phase_end" | "after";
  anchor_deal_step_id: string | null;
  status_deal_step_id: string | null;
  duplicate_matches: unknown;
};

export type FakeDealStep = {
  id: string;
  deal_id: string;
  definition: unknown;
  removed_at: string | null;
  request_id: string | null;
};

export type FakeDeal = { tenant_id: string };
export type FakeCandidate = { preview: { name: string } };

export type RecoveryAdminState = {
  operations: Map<string, FakeOperationRow>;
  dealSteps: Map<string, FakeDealStep>;
  deals: Map<string, FakeDeal>;
  candidates: Map<string, FakeCandidate>;
  authError: { code: string } | null;
  attachFailuresRemaining: number;
  loseAttachReplyOnce: boolean;
};

export function createRecoveryAdminState(): RecoveryAdminState {
  return {
    operations: new Map(),
    dealSteps: new Map(),
    deals: new Map(),
    candidates: new Map(),
    authError: null,
    attachFailuresRemaining: 0,
    loseAttachReplyOnce: false,
  };
}
