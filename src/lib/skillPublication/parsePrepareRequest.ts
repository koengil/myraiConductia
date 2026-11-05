import {
  hasExactKeys,
  isDigest,
  isNonEmptyString,
  isRecord,
  isUuid,
  type ParseError,
} from "./parse";
import { parseCapabilityContract, parseComparisonTarget } from "./parseService";
import type { ComparisonTarget, PrepareRequest } from "./types";

const PREPARE_REQUEST_ERROR: ParseError = {
  error:
    "A prepare request requires candidateId, candidateDigest, candidateName, reservedSkillId, companyId, projectId, displayName, a capability contract, comparisonSetDigest, and targets.",
};

function hasValidPrepareRequestShape(value: Record<string, unknown>): boolean {
  return (
    hasExactKeys(value, [
      "candidateId",
      "candidateDigest",
      "candidateName",
      "reservedSkillId",
      "companyId",
      "projectId",
      "displayName",
      "capabilityContract",
      "comparisonSetDigest",
      "targets",
    ]) &&
    isUuid(value.candidateId) &&
    isDigest(value.candidateDigest) &&
    isNonEmptyString(value.candidateName, 100) &&
    isUuid(value.reservedSkillId) &&
    isUuid(value.companyId) &&
    isUuid(value.projectId) &&
    isNonEmptyString(value.displayName, 100) &&
    isDigest(value.comparisonSetDigest) &&
    Array.isArray(value.targets)
  );
}

function parsePrepareRequestTargets(
  value: unknown[],
): ComparisonTarget[] | null {
  const targets: ComparisonTarget[] = [];
  for (const target of value) {
    const parsedTarget = parseComparisonTarget(target);
    if (parsedTarget === null) return null;
    targets.push(parsedTarget);
  }
  return targets;
}

export function parsePrepareRequest(
  value: unknown,
): PrepareRequest | ParseError {
  if (!isRecord(value) || !hasValidPrepareRequestShape(value)) {
    return PREPARE_REQUEST_ERROR;
  }
  const capabilityContract = parseCapabilityContract(value.capabilityContract);
  const targets = parsePrepareRequestTargets(value.targets as unknown[]);
  if (capabilityContract === null || targets === null) {
    return PREPARE_REQUEST_ERROR;
  }
  return {
    candidateId: value.candidateId as string,
    candidateDigest: value.candidateDigest as string,
    candidateName: value.candidateName as string,
    reservedSkillId: value.reservedSkillId as string,
    companyId: value.companyId as string,
    projectId: value.projectId as string,
    displayName: value.displayName as string,
    capabilityContract,
    comparisonSetDigest: value.comparisonSetDigest as string,
    targets,
  };
}
