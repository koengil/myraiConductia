import { parseAuthoritativePublicationRead } from "@/lib/skillPublication/browserResponse";
import type { PublicationRead } from "@/lib/skillPublication/types";
import { ATTEMPT_STATUS, DRAFT_STATUS } from "./types";
import type { AttemptRead } from "./types";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableRecord(value: unknown): RecordValue | null {
  return isRecord(value) ? value : null;
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeAttempt(value: unknown): AttemptRead | null {
  if (!isRecord(value)) return null;
  const errorCode = string(value.error_code);
  const errorMessage = string(value.error_message);
  return {
    id: string(value.id),
    messageId: string(value.message_id),
    number: number(value.attempt_number),
    status: string(value.status) as AttemptRead["status"],
    responseText: string(value.response_text),
    error:
      errorCode || errorMessage
        ? { code: errorCode, message: errorMessage }
        : null,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= minimum
  );
}

function isNullable(
  value: unknown,
  predicate: (item: unknown) => boolean,
): boolean {
  return value === null || predicate(value);
}

function isPlacement(value: RecordValue): boolean {
  const direct = nullableRecord(value.placement) ?? value;
  const kind = direct.placement_kind;
  const phaseIndex = direct.phase_index;
  const anchorStepId = direct.anchor_deal_step_id;
  if (kind === null) return phaseIndex === null && anchorStepId === null;
  if (!isIntegerAtLeast(phaseIndex, 0)) return false;
  if (kind === "phase_start" || kind === "phase_end")
    return anchorStepId === null;
  return kind === "after" && isNonEmptyString(anchorStepId);
}

export function isAuthoritativeAttempt(value: unknown): value is RecordValue {
  const attempt = nullableRecord(value);
  if (!attempt || !hasAttemptIdentity(attempt) || !hasAttemptResponse(attempt))
    return false;
  return hasAttemptError(attempt);
}

function hasAttemptIdentity(attempt: RecordValue): boolean {
  return (
    isNonEmptyString(attempt.id) &&
    isNonEmptyString(attempt.message_id) &&
    isIntegerAtLeast(attempt.attempt_number, 1) &&
    ATTEMPT_STATUS.includes(attempt.status as (typeof ATTEMPT_STATUS)[number])
  );
}

function hasAttemptResponse(attempt: RecordValue): boolean {
  return typeof attempt.response_text === "string";
}

function hasAttemptError(attempt: RecordValue): boolean {
  const errorCode = attempt.error_code;
  const errorMessage = attempt.error_message;
  return (
    (errorCode === null && errorMessage === null) ||
    (typeof errorCode === "string" && typeof errorMessage === "string")
  );
}

export function isNullableAuthoritativeAttempt(value: unknown): boolean {
  return isNullable(value, isAuthoritativeAttempt);
}

function isMessage(
  value: unknown,
  requireAttempts: boolean,
): value is RecordValue {
  const message = nullableRecord(value);
  if (
    !message ||
    !isNonEmptyString(message.id) ||
    !isIntegerAtLeast(message.ordinal, 1) ||
    typeof message.text !== "string"
  )
    return false;
  return (
    !requireAttempts ||
    (Array.isArray(message.attempts) &&
      message.attempts.every(isAuthoritativeAttempt))
  );
}

function isCandidate(value: unknown): value is RecordValue {
  const candidate = nullableRecord(value);
  if (
    !candidate ||
    !isNonEmptyString(candidate.id) ||
    !isNonEmptyString(candidate.content_digest) ||
    candidate.schema_version !== 1
  )
    return false;
  const preview = nullableRecord(candidate.preview) ?? candidate;
  return (
    typeof preview.name === "string" &&
    typeof preview.purpose === "string" &&
    typeof preview.expected_input === "string" &&
    typeof preview.expected_output === "string"
  );
}

export function isAuthoritativeDraft(value: unknown): value is RecordValue {
  const draft = nullableRecord(value);
  return (
    !!draft &&
    isNonEmptyString(draft.id) &&
    isNonEmptyString(draft.deal_id) &&
    DRAFT_STATUS.includes(draft.status as (typeof DRAFT_STATUS)[number]) &&
    typeof draft.name === "string" &&
    typeof draft.composer_text === "string" &&
    isIntegerAtLeast(draft.edit_revision, 0) &&
    isPlacement(draft) &&
    Array.isArray(draft.messages) &&
    draft.messages.every((message) => isMessage(message, true)) &&
    isNullableAuthoritativeAttempt(draft.active_attempt) &&
    isNullable(draft.candidate, isCandidate)
  );
}

export function authoritativePublicationOf(
  value: unknown,
): { available: false } | PublicationRead | null {
  const draft = nullableRecord(value);
  return draft ? parseAuthoritativePublicationRead(draft.publication) : null;
}

export function isAuthoritativeReceipt(value: unknown): value is RecordValue {
  const receipt = nullableRecord(value);
  if (!receipt || !isAuthoritativeDraft(receipt.draft)) return false;
  if ("message" in receipt && !isMessage(receipt.message, false)) return false;
  if ("attempt" in receipt && !isAuthoritativeAttempt(receipt.attempt))
    return false;
  return true;
}

export function isAuthoritativeConflict(value: unknown): value is RecordValue {
  const detail = nullableRecord(value);
  return (
    !!detail &&
    isAuthoritativeDraft(detail.draft) &&
    "active_attempt" in detail &&
    isNullableAuthoritativeAttempt(detail.active_attempt)
  );
}
