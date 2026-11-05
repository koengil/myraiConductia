import type {
  DuplicateReasonCode,
  PublicationErrorCode,
  PublicationState,
} from "@/lib/skillPublication/types";
import type { PublicationClientErrorKind } from "@/lib/skillAuthoring/publicationClient";
import type { PublicationConflictCode } from "@/lib/skillPublication/types";

const PUBLICATION_STATE_LABEL: Partial<Record<PublicationState, string>> = {
  preparing: "Checking project",
  publishing: "Publishing skill",
  attaching: "Adding step",
  reconciling: "Finishing in background",
  needs_placement: "Choose a new position",
};

export const RECONCILING_DETAIL =
  "Conductia is confirming the outcome. This finishes automatically.";
export const RECEIPT_CONFLICT_DETAIL =
  "This save is held for review. It will not resolve on its own.";

export function publicationStateLabel(state: PublicationState): string | null {
  return PUBLICATION_STATE_LABEL[state] ?? null;
}

const PUBLICATION_ERROR_MESSAGE: Record<PublicationErrorCode, string> = {
  candidate_invalid:
    "This candidate is no longer valid. Correct the draft and save again.",
  candidate_stale:
    "The draft changed since saving started. Save again.",
  duplicate_active: "An active step already covers this skill.",
  duplicate_removed: "A removed step already covered this skill.",
  duplicate_declined:
    "The duplicate match was declined. Save again once the draft is corrected.",
  access_lost: "You no longer have permission to publish this skill.",
  feature_disabled: "Saving skills is not available right now.",
  anchor_removed: "The chosen position was removed. Choose a new position.",
  receipt_conflict: RECEIPT_CONFLICT_DETAIL,
  step_removed:
    "The step this skill improves was removed, so this enhancement cannot be saved.",
  publish_exhausted:
    "Saving kept failing and was stopped. Save again to retry.",
};

export function publicationErrorMessage(code: PublicationErrorCode): string {
  return PUBLICATION_ERROR_MESSAGE[code];
}

const DUPLICATE_REASON_MESSAGE: Record<DuplicateReasonCode, string> = {
  identity_match: "Same skill identity",
  name_match: "Same step name",
  contract_match: "Same input and output contract",
  capability_equivalent: "Equivalent capability",
  capability_similar: "Similar capability",
};

export function duplicateReasonMessage(code: DuplicateReasonCode): string {
  return DUPLICATE_REASON_MESSAGE[code];
}

const COMMAND_ERROR_KIND_MESSAGE: Record<PublicationClientErrorKind, string> = {
  conflict: "This save changed since your last action. Save again.",
  validation: "This request was not valid. Correct the draft and try again.",
  forbidden: "You no longer have permission to publish this skill.",
  not_found: "This save could not be found. Reopen the draft.",
  network:
    "The request did not reach Conductia. Check your connection and try again.",
  unknown: "This request could not be completed. Try again.",
};

const COMMAND_CONFLICT_CODE_MESSAGE: Partial<
  Record<PublicationConflictCode, string>
> = {
  idempotency_conflict:
    "This action was already applied under a different request. Reopen the draft.",
  stale_edit_revision:
    "The draft changed since this action started. Reopen the draft.",
  stale_candidate:
    "The candidate changed since this action started. Save again.",
  generation_active: "Finish the current response before this action.",
  publication_exists: "A save is already in progress for this draft.",
  stale_publication_revision:
    "This save changed since your last action. Reopen the draft.",
  assessment_mismatch:
    "The duplicate assessment changed. Reopen the draft and decide again.",
  placement_not_allowed:
    "That position is not allowed. Choose another position.",
};

export const PLACEMENT_VALIDATION_DETAIL =
  "That position is no longer available. Choose another position.";

export function commandErrorMessage(
  kind: PublicationClientErrorKind,
  code: PublicationConflictCode | null,
  isPlacementContext = false,
): string {
  if (isPlacementContext && kind === "validation")
    return PLACEMENT_VALIDATION_DETAIL;
  const codeMessage = code ? COMMAND_CONFLICT_CODE_MESSAGE[code] : undefined;
  return codeMessage ?? COMMAND_ERROR_KIND_MESSAGE[kind];
}

export const CONFIRM_DUPLICATE_PROMPT =
  "These existing steps look similar. Confirm to save anyway, or decline to revise the draft.";

export const CONFIRM_SAVE_ANYWAY_LABEL = "Save anyway";
export const DECLINE_MATCH_LABEL = "Decline and revise";
export const FOCUS_EXISTING_STEP_LABEL = "Focus existing step";
export const RESTORE_EXISTING_STEP_LABEL = "Restore existing step";
export const RESTORE_FAILED_DETAIL =
  "This step could not be restored. Try again.";
export const PUBLISHED_SUMMARY_LABEL = "Published. This step is on the rail.";
