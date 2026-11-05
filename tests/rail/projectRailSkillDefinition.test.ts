import { describe, it, expect } from "vitest";
import { projectServerRail } from "@/lib/rail/projectRail";

const VALID_SKILL_DEFINITION = {
  schemaVersion: 1,
  type: "skill",
  title: "Buyer screen",
  description: "Screens buyers",
  inputs: [
    {
      key: "primary",
      kind: "text",
      label: "Input",
      helperText: "Deal context",
      required: true,
    },
  ],
  skillBinding: {
    skillId: "a1000000-0000-4000-8000-000000000001",
    versionId: "b1000000-0000-4000-8000-000000000001",
    digest: "a".repeat(64),
  },
};

function railWith(
  definition: unknown,
): Parameters<typeof projectServerRail>[0] {
  return {
    currentStepId: null,
    canEditStructure: true,
    canSaveTemplate: false,
    phases: [],
    steps: [
      {
        id: "srv-1",
        stepId: "custom:abc",
        origin: "custom",
        phaseIndex: 1,
        displayOrder: 1,
        seq: null,
        status: "pending",
        definition,
        anchorStepId: null,
        removedAt: null,
        removedBy: null,
        skip: null,
      },
    ],
  };
}

function parsedDefinition(definition: unknown) {
  return projectServerRail(railWith(definition)).steps[0].definition;
}

function withBinding(
  overrides: Partial<(typeof VALID_SKILL_DEFINITION)["skillBinding"]>,
) {
  return {
    ...VALID_SKILL_DEFINITION,
    skillBinding: { ...VALID_SKILL_DEFINITION.skillBinding, ...overrides },
  };
}

describe("projectServerRail strict skill definition parsing", () => {
  it("keeps a valid skill definition intact", () => {
    expect(parsedDefinition(VALID_SKILL_DEFINITION)).toEqual(
      VALID_SKILL_DEFINITION,
    );
  });

  it("rejects malformed, untyped or non-skill-typed skill candidates as null, never as manual", () => {
    const rejectedVariants = [
      withBinding({ digest: "not-a-digest" }),
      withBinding({ versionId: "not-a-uuid" }),
      { ...VALID_SKILL_DEFINITION, inputs: [] },
      { skillBinding: VALID_SKILL_DEFINITION.skillBinding },
      { ...VALID_SKILL_DEFINITION, type: "other" },
    ];

    for (const variant of rejectedVariants) {
      expect(parsedDefinition(variant)).toBeNull();
    }
  });

  it("keeps a manual definition unchanged", () => {
    const manual = {
      title: "Weekly update",
      description: "Turns notes into an update.",
    };

    expect(parsedDefinition(manual)).toEqual(manual);
  });
});
