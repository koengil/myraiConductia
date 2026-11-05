import {
  hasExactKeys,
  isDigest,
  isNonEmptyString,
  isNonnegativeInteger,
  isRecord,
  isUuid,
  parseSkillBinding,
} from "./parse";
import {
  DUPLICATE_CLASSIFICATIONS,
  DUPLICATE_REASON_CODES,
  PUBLICATION_ERROR_CODES,
  PUBLICATION_STATES,
  type PublicationError,
  type PublicationRead,
  type PublicationResult,
  type SafeDuplicateMatch,
} from "./types";

function parseSafeDuplicateMatch(value: unknown): SafeDuplicateMatch | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "dealStepId",
      "name",
      "classification",
      "reasonCode",
    ]) ||
    (value.dealStepId !== null && !isUuid(value.dealStepId)) ||
    !isNonEmptyString(value.name, 100) ||
    typeof value.classification !== "string" ||
    !DUPLICATE_CLASSIFICATIONS.includes(value.classification as never) ||
    typeof value.reasonCode !== "string" ||
    !DUPLICATE_REASON_CODES.includes(value.reasonCode as never)
  ) {
    return null;
  }
  return {
    dealStepId: value.dealStepId as string | null,
    name: value.name,
    classification:
      value.classification as SafeDuplicateMatch["classification"],
    reasonCode: value.reasonCode as SafeDuplicateMatch["reasonCode"],
  };
}

function parseSafeDuplicateMatches(
  value: unknown,
): SafeDuplicateMatch[] | null {
  if (!Array.isArray(value)) return null;
  const matches: SafeDuplicateMatch[] = [];
  for (const match of value) {
    const parsed = parseSafeDuplicateMatch(match);
    if (parsed === null) return null;
    matches.push(parsed);
  }
  return matches;
}

function parsePublicationError(value: unknown): PublicationError | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["code", "dealStepId"]) ||
    typeof value.code !== "string" ||
    !PUBLICATION_ERROR_CODES.includes(value.code as never) ||
    (value.dealStepId !== null && !isUuid(value.dealStepId))
  ) {
    return null;
  }
  return {
    code: value.code as PublicationError["code"],
    dealStepId: value.dealStepId as string | null,
  };
}

function parsePublicationResult(value: unknown): PublicationResult | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["stepId", "skillBinding"]) ||
    !isUuid(value.stepId)
  ) {
    return null;
  }
  const skillBinding = parseSkillBinding(value.skillBinding);
  if (skillBinding === null) return null;
  return { stepId: value.stepId, skillBinding };
}

function hasValidPublicationReadShape(value: Record<string, unknown>): boolean {
  return (
    hasExactKeys(value, [
      "available",
      "id",
      "state",
      "revision",
      "matches",
      "error",
      "result",
      "assessmentDigest",
    ]) &&
    value.available === true &&
    isUuid(value.id) &&
    typeof value.state === "string" &&
    PUBLICATION_STATES.includes(value.state as never) &&
    isNonnegativeInteger(value.revision)
  );
}

function buildPublicationRead(
  value: Record<string, unknown>,
): PublicationRead | undefined {
  const matches = parseSafeDuplicateMatches(value.matches);
  if (matches === null) return undefined;
  const error =
    value.error === null ? null : parsePublicationError(value.error);
  if (value.error !== null && error === null) return undefined;
  const result =
    value.result === null ? null : parsePublicationResult(value.result);
  if (value.result !== null && result === null) return undefined;
  const state = value.state as PublicationRead["state"];
  if ((state === "published") !== (result !== null)) return undefined;
  const assessmentDigest = value.assessmentDigest;
  if (assessmentDigest !== null && !isDigest(assessmentDigest))
    return undefined;
  if ((state === "confirmation_required") !== (assessmentDigest !== null))
    return undefined;
  return {
    available: true,
    id: value.id as string,
    state,
    revision: value.revision as number,
    matches,
    error,
    result,
    assessmentDigest: assessmentDigest as string | null,
  };
}

export function parsePublicationRead(
  value: unknown,
): { available: false } | PublicationRead | undefined {
  if (!isRecord(value)) return undefined;
  if (hasExactKeys(value, ["available"])) {
    return value.available === false ? { available: false } : undefined;
  }
  return hasValidPublicationReadShape(value)
    ? buildPublicationRead(value)
    : undefined;
}
