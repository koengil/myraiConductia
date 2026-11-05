import {
  hasExactKeys,
  hasOnlyKeys,
  isNonnegativeInteger,
  isRecord,
  parsePlacement,
  UUID,
} from "@/lib/skillAuthoring/parse";
import type {
  DuplicateDecisionCommand,
  PlacementCommand,
  PublishCommand,
  SkillBinding,
  SkillStepDefinitionV1,
} from "./types";

export type ParseError = { error: string };

export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export { hasExactKeys, hasOnlyKeys, isNonnegativeInteger, isRecord };

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

export function isNonEmptyString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

export function isIsoDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_DATE_TIME.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function parseSkillBinding(value: unknown): SkillBinding | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["skillId", "versionId", "digest"]) ||
    !isUuid(value.skillId) ||
    !isUuid(value.versionId) ||
    !isDigest(value.digest)
  ) {
    return null;
  }
  return {
    skillId: value.skillId,
    versionId: value.versionId,
    digest: value.digest,
  };
}

export function parsePublishCommand(
  value: unknown,
): PublishCommand | ParseError {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "requestId",
      "expectedEditRevision",
      "candidateId",
      "candidateDigest",
    ]) ||
    !isUuid(value.requestId) ||
    !isNonnegativeInteger(value.expectedEditRevision) ||
    !isUuid(value.candidateId) ||
    !isDigest(value.candidateDigest)
  ) {
    return {
      error:
        "A publish command requires a UUID requestId, nonnegative expectedEditRevision, UUID candidateId, and a SHA-256 candidateDigest.",
    };
  }
  return {
    requestId: value.requestId,
    expectedEditRevision: value.expectedEditRevision,
    candidateId: value.candidateId,
    candidateDigest: value.candidateDigest,
  };
}

export function parseDuplicateDecisionCommand(
  value: unknown,
): DuplicateDecisionCommand | ParseError {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "expectedRevision",
      "assessmentDigest",
      "decision",
    ]) ||
    !isNonnegativeInteger(value.expectedRevision) ||
    !isDigest(value.assessmentDigest) ||
    (value.decision !== "confirm" && value.decision !== "decline")
  ) {
    return {
      error:
        "A duplicate decision requires a nonnegative expectedRevision, a SHA-256 assessmentDigest, and a confirm or decline decision.",
    };
  }
  return {
    expectedRevision: value.expectedRevision,
    assessmentDigest: value.assessmentDigest,
    decision: value.decision,
  };
}

export function parsePlacementCommand(
  value: unknown,
): PlacementCommand | ParseError {
  const placement = isRecord(value) ? parsePlacement(value.placement) : null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["expectedRevision", "placement"]) ||
    !isNonnegativeInteger(value.expectedRevision) ||
    placement === null
  ) {
    return {
      error:
        "A placement command requires a nonnegative expectedRevision and a valid placement.",
    };
  }
  return { expectedRevision: value.expectedRevision, placement };
}

function parseSkillStepInput(
  value: unknown,
): SkillStepDefinitionV1["inputs"][number] | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["key", "kind", "label", "helperText", "required"]) ||
    value.key !== "primary" ||
    value.kind !== "text" ||
    value.label !== "Input" ||
    !isNonEmptyString(value.helperText, 2_000) ||
    value.required !== true
  ) {
    return null;
  }
  return {
    key: "primary",
    kind: "text",
    label: "Input",
    helperText: value.helperText,
    required: true,
  };
}

const SKILL_STEP_DEFINITION_ERROR: ParseError = {
  error:
    "A skill step definition requires schemaVersion 1, title, description, exactly one primary input, and a skill binding.",
};

function hasValidSkillStepShape(
  value: Record<string, unknown>,
): value is Record<string, unknown> & {
  title: string;
  description: string;
  inputs: unknown[];
} {
  return (
    hasExactKeys(value, [
      "schemaVersion",
      "type",
      "title",
      "description",
      "inputs",
      "skillBinding",
    ]) &&
    value.schemaVersion === 1 &&
    value.type === "skill" &&
    isNonEmptyString(value.title, 200) &&
    isNonEmptyString(value.description, 2_000) &&
    Array.isArray(value.inputs) &&
    value.inputs.length === 1
  );
}

export function parseSkillStepDefinitionV1(
  value: unknown,
): SkillStepDefinitionV1 | ParseError {
  if (!isRecord(value) || !hasValidSkillStepShape(value)) {
    return SKILL_STEP_DEFINITION_ERROR;
  }
  const input = parseSkillStepInput(value.inputs[0]);
  const skillBinding = parseSkillBinding(value.skillBinding);
  if (input === null || skillBinding === null) {
    return SKILL_STEP_DEFINITION_ERROR;
  }
  return {
    schemaVersion: 1,
    type: "skill",
    title: value.title,
    description: value.description,
    inputs: [input],
    skillBinding,
  };
}
