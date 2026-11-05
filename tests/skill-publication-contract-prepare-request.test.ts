import { describe, expect, it } from "vitest";
import { parsePrepareRequest } from "@/lib/skillPublication/parseService";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const RESERVED_SKILL_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const DIGEST =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function validCapabilityContract() {
  return {
    purpose: "Summarize deal status.",
    expectedInput: "A reporting period.",
    expectedOutput: "A concise update.",
  };
}

function validPrepareRequest(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: CANDIDATE_ID,
    candidateDigest: DIGEST,
    candidateName: "Weekly project update",
    reservedSkillId: RESERVED_SKILL_ID,
    companyId: COMPANY_ID,
    projectId: PROJECT_ID,
    displayName: "Weekly project update",
    capabilityContract: validCapabilityContract(),
    comparisonSetDigest: DIGEST,
    targets: [],
    ...overrides,
  };
}

const PREPARE_REQUEST_ERROR = {
  error:
    "A prepare request requires candidateId, candidateDigest, candidateName, reservedSkillId, companyId, projectId, displayName, a capability contract, comparisonSetDigest, and targets.",
};

function omit<T extends Record<string, unknown>>(
  obj: T,
  key: keyof T,
): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...obj };
  delete rest[key as string];
  return rest;
}

const PREPARE_REQUEST_REJECTIONS: Array<[string, Record<string, unknown>]> = [
  ["a missing candidateName key", omit(validPrepareRequest(), "candidateName")],
  ["a blank candidateName", validPrepareRequest({ candidateName: " " })],
  [
    "an over-length candidateName",
    validPrepareRequest({ candidateName: "a".repeat(101) }),
  ],
  ["a non-string candidateName", validPrepareRequest({ candidateName: 42 })],
  ["an unknown field", { ...validPrepareRequest(), unexpected: true }],
];

describe("parsePrepareRequest", () => {
  it("accepts an exact prepare request", () => {
    expect(parsePrepareRequest(validPrepareRequest())).toEqual(
      validPrepareRequest(),
    );
  });

  it("accepts a candidateName at the 100 character bound", () => {
    const request = validPrepareRequest({ candidateName: "a".repeat(100) });
    expect(parsePrepareRequest(request)).toEqual(request);
  });

  it.each(PREPARE_REQUEST_REJECTIONS)(
    "rejects a prepare request with %s",
    (_reason, request) => {
      expect(parsePrepareRequest(request)).toEqual(PREPARE_REQUEST_ERROR);
    },
  );
});
