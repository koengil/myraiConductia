import { describe, it, expect } from "vitest";
import {
  skillBindingForStep,
  type ProjectRailStep,
} from "@/lib/rail/projectRail";

const SKILL_ID = "a1000000-0000-4000-8000-000000000001";
const VERSION_V1 = "b1000000-0000-4000-8000-000000000001";
const VERSION_V2 = "b1000000-0000-4000-8000-000000000002";
const DIGEST_V1 = "a".repeat(64);
const DIGEST_V2 = "b".repeat(64);
const EXPECTED_V1_BINDING = {
  skillId: SKILL_ID,
  versionId: VERSION_V1,
  digest: DIGEST_V1,
};

const SKILL_DEFINITION = {
  schemaVersion: 1 as const,
  type: "skill" as const,
  title: "Buyer screen",
  description: "Screens buyers",
  inputs: [
    {
      key: "primary" as const,
      kind: "text" as const,
      label: "Input" as const,
      helperText: "Deal context",
      required: true as const,
    },
  ] as const,
  skillBinding: EXPECTED_V1_BINDING,
};

function skillStep(overrides: Partial<ProjectRailStep> = {}): ProjectRailStep {
  return {
    id: "step-1",
    stepId: "custom:abc",
    origin: "custom",
    phaseIndex: 1,
    displayOrder: 1,
    seq: null,
    status: "pending",
    definition: SKILL_DEFINITION,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    ...overrides,
  };
}

const STALE_LIBRARY_V2_BINDING = {
  skillId: SKILL_ID,
  versionId: VERSION_V2,
  digest: DIGEST_V2,
};

const STALE_LIBRARY_BY_NAME = new Map([
  ["Buyer screen", STALE_LIBRARY_V2_BINDING],
]);

describe("skill-backed step definition pin", () => {
  it("resolves the pinned v1 version id and digest, not the newer v2 binding a name lookup in the library would return for the same title", () => {
    expect(STALE_LIBRARY_BY_NAME.get("Buyer screen")).toEqual(
      STALE_LIBRARY_V2_BINDING,
    );

    const binding = skillBindingForStep(skillStep());

    expect(binding).toEqual(EXPECTED_V1_BINDING);
    expect(binding).not.toEqual(STALE_LIBRARY_V2_BINDING);
  });

  it("returns null for manual, missing, invalid or untyped definitions", () => {
    const manual = {
      title: "Weekly update",
      description: "Turns notes into an update.",
    };
    const invalid = {
      ...SKILL_DEFINITION,
      inputs: [],
    } as unknown as ProjectRailStep["definition"];
    const untypedBinding = {
      skillBinding: EXPECTED_V1_BINDING,
    } as unknown as ProjectRailStep["definition"];

    for (const definition of [manual, null, invalid, untypedBinding]) {
      expect(skillBindingForStep(skillStep({ definition }))).toBeNull();
    }
  });
});
