import type {
  FakeOperationRow,
  RecoveryAdminState,
} from "./recoveryAdminState";

type PatchLike = Record<string, unknown>;
type RpcResult = { data: unknown; error: { message: string } | null };

const PATCH_COLUMN_MAP: Record<string, keyof FakeOperationRow> = {
  statusCode: "status_code",
  statusDealStepId: "status_deal_step_id",
  nextRetryAt: "next_retry_at",
  attemptCount: "attempt_count",
  comparisonSetDigest: "comparison_set_digest",
  preparationId: "preparation_id",
  assessmentDigest: "assessment_digest",
  duplicateMatches: "duplicate_matches",
  publishedSkillId: "published_skill_id",
  publishedVersionId: "published_version_id",
  publishedDigest: "published_digest",
};

const RECEIPT_PATCH_KEYS = [
  "publishedSkillId",
  "publishedVersionId",
  "publishedDigest",
] as const;

export function violatesReceiptImmutability(
  row: FakeOperationRow,
  patch: PatchLike,
): boolean {
  if (row.published_version_id === null) return false;
  return RECEIPT_PATCH_KEYS.some((key) => {
    const column = PATCH_COLUMN_MAP[key];
    return key in patch && patch[key] !== row[column];
  });
}

function applyPatch(
  row: FakeOperationRow,
  nextState: string,
  patch: PatchLike,
): FakeOperationRow {
  const next: FakeOperationRow = {
    ...row,
    state: nextState as FakeOperationRow["state"],
  };
  for (const [patchKey, column] of Object.entries(PATCH_COLUMN_MAP)) {
    if (patchKey in patch) {
      (next as Record<string, unknown>)[column] = patch[patchKey];
    }
  }
  return next;
}

export function transitionRpc(
  state: RecoveryAdminState,
  args: Record<string, unknown>,
): RpcResult {
  const publicationId = args.p_publication_id as string;
  const row = state.operations.get(publicationId);
  if (row === undefined) return { data: null, error: null };
  const expectedStates = args.p_expected_states as string[];
  if (!expectedStates.includes(row.state)) return { data: null, error: null };
  const patch = args.p_patch as PatchLike;
  if (violatesReceiptImmutability(row, patch)) {
    return {
      data: null,
      error: {
        message: "skill_publication_operations published receipt changed",
      },
    };
  }
  const next = applyPatch(row, args.p_next_state as string, patch);
  state.operations.set(publicationId, next);
  return { data: { ...next }, error: null };
}
