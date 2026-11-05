import type {
  DiscardCommand,
  DraftPatch,
  MessageCommand,
  Placement,
  RetryCommand,
} from "./types";

type ParseError = { error: string };

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return hasOnlyKeys(value, keys) && keys.every((key) => key in value);
}

export function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parsePlacement(value: unknown): Placement | null {
  if (
    !isRecord(value) ||
    !isNonnegativeInteger(value.phaseIndex) ||
    typeof value.kind !== "string"
  ) {
    return null;
  }
  if (
    value.kind === "phase_start" &&
    hasOnlyKeys(value, ["kind", "phaseIndex"])
  ) {
    return { kind: "phase_start", phaseIndex: value.phaseIndex };
  }
  if (
    value.kind === "phase_end" &&
    hasOnlyKeys(value, ["kind", "phaseIndex"])
  ) {
    return { kind: "phase_end", phaseIndex: value.phaseIndex };
  }
  if (
    value.kind === "after" &&
    hasOnlyKeys(value, ["kind", "phaseIndex", "afterStepId"]) &&
    typeof value.afterStepId === "string" &&
    value.afterStepId.trim().length > 0
  ) {
    return {
      kind: "after",
      phaseIndex: value.phaseIndex,
      afterStepId: value.afterStepId,
    };
  }
  return null;
}

export function parseDraftPatch(value: unknown): DraftPatch | ParseError {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "expectedEditRevision",
      "name",
      "placement",
      "composerText",
    ])
  ) {
    return {
      error:
        "A draft patch requires a valid name, placement, composerText, and nonnegative expectedEditRevision.",
    };
  }

  const placement =
    value.placement === null ? null : parsePlacement(value.placement);
  if (
    !isNonnegativeInteger(value.expectedEditRevision) ||
    typeof value.name !== "string" ||
    (value.name.length > 0 && value.name.trim().length === 0) ||
    value.name.length > 100 ||
    (placement === null && value.placement !== null) ||
    typeof value.composerText !== "string" ||
    value.composerText.length > 20_000
  ) {
    return {
      error:
        "A draft patch requires a valid name, placement, composerText, and nonnegative expectedEditRevision.",
    };
  }

  return {
    expectedEditRevision: value.expectedEditRevision,
    name: value.name,
    placement,
    composerText: value.composerText,
  };
}

export function parseMessageCommand(
  value: unknown,
): MessageCommand | ParseError {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["clientMessageId", "expectedEditRevision", "text"]) ||
    typeof value.clientMessageId !== "string" ||
    !UUID.test(value.clientMessageId) ||
    !isNonnegativeInteger(value.expectedEditRevision) ||
    typeof value.text !== "string" ||
    value.text.trim().length === 0 ||
    value.text.length > 20_000
  ) {
    return {
      error:
        "Message text, clientMessageId, and a nonnegative expectedEditRevision are required.",
    };
  }

  return {
    clientMessageId: value.clientMessageId,
    expectedEditRevision: value.expectedEditRevision,
    text: value.text,
  };
}

export function parseRetryCommand(value: unknown): RetryCommand | ParseError {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["retryRequestId"]) ||
    typeof value.retryRequestId !== "string" ||
    !UUID.test(value.retryRequestId)
  ) {
    return { error: "A UUID retryRequestId is required." };
  }
  return { retryRequestId: value.retryRequestId };
}

export function parseDiscardCommand(
  value: unknown,
): DiscardCommand | ParseError {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["expectedEditRevision"]) ||
    !isNonnegativeInteger(value.expectedEditRevision)
  ) {
    return { error: "A nonnegative expectedEditRevision is required." };
  }
  return { expectedEditRevision: value.expectedEditRevision };
}
