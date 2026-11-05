import {
  hasExactKeys,
  isDigest,
  isIsoDateTime,
  isNonEmptyString,
  isRecord,
  isUuid,
  parseSkillBinding,
  type ParseError,
} from "./parse";
import {
  COMPARISON_TARGET_STATES,
  DUPLICATE_CLASSIFICATIONS,
  DUPLICATE_REASON_CODES,
  type CapabilityContract,
  type ComparisonTarget,
  type ComparisonTargetCandidate,
  type DuplicateMatch,
  type PreparationReceipt,
  type PublicationLookup,
  type PublicationReceipt,
} from "./types";

export { parsePrepareRequest } from "./parsePrepareRequest";

export function parseCapabilityContract(
  value: unknown,
): CapabilityContract | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["purpose", "expectedInput", "expectedOutput"]) ||
    !isNonEmptyString(value.purpose, 2_000) ||
    !isNonEmptyString(value.expectedInput, 2_000) ||
    !isNonEmptyString(value.expectedOutput, 2_000)
  ) {
    return null;
  }
  return {
    purpose: value.purpose,
    expectedInput: value.expectedInput,
    expectedOutput: value.expectedOutput,
  };
}

function parseDuplicateMatch(value: unknown): DuplicateMatch | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "targetId",
      "classification",
      "reasonCode",
      "confidence",
    ]) ||
    !isUuid(value.targetId) ||
    typeof value.classification !== "string" ||
    !DUPLICATE_CLASSIFICATIONS.includes(value.classification as never) ||
    typeof value.reasonCode !== "string" ||
    !DUPLICATE_REASON_CODES.includes(value.reasonCode as never) ||
    typeof value.confidence !== "number" ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    return null;
  }
  return {
    targetId: value.targetId,
    classification: value.classification as DuplicateMatch["classification"],
    reasonCode: value.reasonCode as DuplicateMatch["reasonCode"],
    confidence: value.confidence,
  };
}

function parseMatches(value: unknown): DuplicateMatch[] | null {
  if (!Array.isArray(value)) return null;
  const matches: DuplicateMatch[] = [];
  for (const match of value) {
    const parsedMatch = parseDuplicateMatch(match);
    if (parsedMatch === null) return null;
    matches.push(parsedMatch);
  }
  return matches;
}

function parseComparisonTargetCandidate(
  value: unknown,
): ComparisonTargetCandidate | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["candidateId", "candidateDigest"]) ||
    !isUuid(value.candidateId) ||
    !isDigest(value.candidateDigest)
  ) {
    return null;
  }
  return {
    candidateId: value.candidateId,
    candidateDigest: value.candidateDigest,
  };
}

function isComparisonTargetState(
  value: unknown,
): value is ComparisonTarget["state"] {
  return (
    typeof value === "string" &&
    COMPARISON_TARGET_STATES.includes(value as never)
  );
}

function isValidComparisonTargetBinding(
  state: ComparisonTarget["state"],
  skillBinding: unknown,
  candidate: unknown,
): boolean {
  if (skillBinding === null && candidate === null) return false;
  if ((state === "active" || state === "removed") && skillBinding === null) {
    return false;
  }
  return true;
}

function hasValidComparisonTargetShape(
  value: Record<string, unknown>,
): boolean {
  return (
    hasExactKeys(value, [
      "targetId",
      "state",
      "displayName",
      "capabilityContract",
      "skillBinding",
      "candidate",
    ]) &&
    isUuid(value.targetId) &&
    isComparisonTargetState(value.state) &&
    isNonEmptyString(value.displayName, 100)
  );
}

export function parseComparisonTarget(value: unknown): ComparisonTarget | null {
  if (!isRecord(value) || !hasValidComparisonTargetShape(value)) {
    return null;
  }
  const capabilityContract = parseCapabilityContract(value.capabilityContract);
  const skillBinding =
    value.skillBinding === null ? null : parseSkillBinding(value.skillBinding);
  const candidate =
    value.candidate === null
      ? null
      : parseComparisonTargetCandidate(value.candidate);
  const state = value.state as ComparisonTarget["state"];
  if (
    capabilityContract === null ||
    (value.skillBinding !== null && skillBinding === null) ||
    (value.candidate !== null && candidate === null) ||
    !isValidComparisonTargetBinding(state, skillBinding, candidate)
  ) {
    return null;
  }
  return {
    targetId: value.targetId as string,
    state,
    displayName: value.displayName as string,
    capabilityContract,
    skillBinding,
    candidate,
  };
}

const PREPARATION_ERROR: ParseError = {
  error:
    "A preparation receipt requires operationId, preparationId, digests, a capability contract, and matches.",
};

function hasValidPreparationShape(value: Record<string, unknown>): boolean {
  return (
    hasExactKeys(value, [
      "operationId",
      "preparationId",
      "candidateDigest",
      "capabilityContract",
      "comparisonSetDigest",
      "assessmentDigest",
      "matches",
    ]) &&
    isUuid(value.operationId) &&
    isUuid(value.preparationId) &&
    isDigest(value.candidateDigest) &&
    isDigest(value.comparisonSetDigest) &&
    isDigest(value.assessmentDigest)
  );
}

export function parsePreparationResponse(
  value: unknown,
): PreparationReceipt | ParseError {
  if (!isRecord(value) || !hasValidPreparationShape(value)) {
    return PREPARATION_ERROR;
  }
  const capabilityContract = parseCapabilityContract(value.capabilityContract);
  const matches = parseMatches(value.matches);
  if (capabilityContract === null || matches === null) {
    return PREPARATION_ERROR;
  }
  return {
    operationId: value.operationId as string,
    preparationId: value.preparationId as string,
    candidateDigest: value.candidateDigest as string,
    capabilityContract,
    comparisonSetDigest: value.comparisonSetDigest as string,
    assessmentDigest: value.assessmentDigest as string,
    matches,
  };
}

function hasValidPublicationReceiptShape(
  value: Record<string, unknown>,
): boolean {
  return (
    hasExactKeys(value, [
      "operationId",
      "skillId",
      "versionId",
      "digest",
      "projectId",
      "publishedAt",
    ]) &&
    isUuid(value.operationId) &&
    isUuid(value.skillId) &&
    isUuid(value.versionId) &&
    isDigest(value.digest) &&
    isUuid(value.projectId) &&
    isIsoDateTime(value.publishedAt)
  );
}

export function parsePublicationReceipt(
  value: unknown,
): PublicationReceipt | null {
  if (!isRecord(value) || !hasValidPublicationReceiptShape(value)) {
    return null;
  }
  return {
    operationId: value.operationId as string,
    skillId: value.skillId as string,
    versionId: value.versionId as string,
    digest: value.digest as string,
    projectId: value.projectId as string,
    publishedAt: value.publishedAt as string,
  };
}

const LOOKUP_ERROR: ParseError = {
  error:
    "A publication lookup requires a valid not_published, prepared, or published status.",
};

export function parsePublicationLookup(
  value: unknown,
): PublicationLookup | ParseError {
  if (!isRecord(value) || typeof value.status !== "string") {
    return LOOKUP_ERROR;
  }
  if (value.status === "not_published") {
    return hasExactKeys(value, ["status"])
      ? { status: "not_published" }
      : LOOKUP_ERROR;
  }
  if (value.status === "prepared") {
    if (!hasExactKeys(value, ["status", "preparation"])) return LOOKUP_ERROR;
    const preparation = parsePreparationResponse(value.preparation);
    if ("error" in preparation) return LOOKUP_ERROR;
    return { status: "prepared", preparation };
  }
  if (value.status === "published") {
    if (!hasExactKeys(value, ["status", "publication"])) return LOOKUP_ERROR;
    const publication = parsePublicationReceipt(value.publication);
    if (publication === null) return LOOKUP_ERROR;
    return { status: "published", publication };
  }
  return LOOKUP_ERROR;
}
