import { describe, expect, it } from "vitest";
import { parseComparisonTarget } from "@/lib/skillPublication/parseService";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const SKILL_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const CANDIDATE_ID = "44444444-4444-4444-8444-444444444444";
const DIGEST =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function validCapabilityContract() {
  return {
    purpose: "Summarize deal status.",
    expectedInput: "A reporting period.",
    expectedOutput: "A concise update.",
  };
}

function validSkillBinding() {
  return { skillId: SKILL_ID, versionId: VERSION_ID, digest: DIGEST };
}

function validCandidate() {
  return { candidateId: CANDIDATE_ID, candidateDigest: DIGEST };
}

function baseTarget(overrides: Record<string, unknown> = {}) {
  return {
    targetId: TARGET_ID,
    state: "active",
    displayName: "Weekly project update",
    capabilityContract: validCapabilityContract(),
    skillBinding: validSkillBinding(),
    candidate: null,
    ...overrides,
  };
}

describe("parseComparisonTarget acceptance", () => {
  it("accepts an active target with a live skill binding and no candidate", () => {
    const target = baseTarget();
    expect(parseComparisonTarget(target)).toEqual(target);
  });

  it("accepts an admitted target with only a candidate (rule: admitted requires candidate when skillBinding is null)", () => {
    const target = baseTarget({
      state: "admitted",
      skillBinding: null,
      candidate: validCandidate(),
    });
    expect(parseComparisonTarget(target)).toEqual(target);
  });

  it("accepts an admitted target with a live skill binding and no candidate", () => {
    const target = baseTarget({ state: "admitted" });
    expect(parseComparisonTarget(target)).toEqual(target);
  });
});

describe("parseComparisonTarget rejection: binding rules", () => {
  it("rejects an active target with no skill binding (rule: active/removed carry skillBinding)", () => {
    const target = baseTarget({
      skillBinding: null,
      candidate: validCandidate(),
    });
    expect(parseComparisonTarget(target)).toBeNull();
  });

  it("rejects a removed target with no skill binding (rule: active/removed carry skillBinding)", () => {
    const target = baseTarget({
      state: "removed",
      skillBinding: null,
      candidate: validCandidate(),
    });
    expect(parseComparisonTarget(target)).toBeNull();
  });

  it("rejects an admitted target with neither skillBinding nor candidate (rule: both null is rejected)", () => {
    const target = baseTarget({
      state: "admitted",
      skillBinding: null,
      candidate: null,
    });
    expect(parseComparisonTarget(target)).toBeNull();
  });
});

describe("parseComparisonTarget rejection: shape", () => {
  it("rejects a malformed candidate", () => {
    const target = baseTarget({
      state: "admitted",
      skillBinding: null,
      candidate: { candidateId: "not-a-uuid", candidateDigest: DIGEST },
    });
    expect(parseComparisonTarget(target)).toBeNull();
  });

  it("rejects a target missing the candidate key entirely", () => {
    const target = baseTarget();
    delete (target as Record<string, unknown>).candidate;
    expect(parseComparisonTarget(target)).toBeNull();
  });

  it("rejects a target with an unknown field", () => {
    expect(parseComparisonTarget(baseTarget({ unexpected: true }))).toBeNull();
  });
});
