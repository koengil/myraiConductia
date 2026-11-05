import { describe, expect, it } from "vitest";

import {
  buildRailDraft,
  type DraftSkill,
  type DraftSourceStep,
} from "@/lib/railTemplates/railDraft";

const PROTECTED = new Set(["p1-s7"]);
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const SKILL_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const CANDIDATE_ID = "33333333-3333-4333-8333-333333333333";

const CONTRACT = {
  purpose: "Ranks strategic buyers.",
  expectedInput: "The sector and size of the target.",
  expectedOutput: "A ranked list of buyers.",
};

function published(digest = DIGEST_A): DraftSkill {
  return {
    reference: { kind: "publication", skillId: SKILL_ID, versionId: VERSION_ID, digest },
    name: "Buyer long list",
    contract: CONTRACT,
  };
}

function house(overrides: Partial<DraftSourceStep> = {}): DraftSourceStep {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    stepId: "p1-s7",
    origin: "catalog",
    seq: 1,
    phaseIndex: 1,
    displayOrder: 1,
    definition: null,
    templateStepKey: "p1-s7",
    skill: null,
    ...overrides,
  };
}

function manual(overrides: Partial<DraftSourceStep> = {}): DraftSourceStep {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000002",
    stepId: "custom:aaaaaaaa-0000-4000-8000-000000000002",
    origin: "custom",
    seq: null,
    phaseIndex: 1,
    displayOrder: 2,
    definition: { title: "Team memo", description: "Added by the team." },
    templateStepKey: null,
    skill: null,
    ...overrides,
  };
}

function skillStep(overrides: Partial<DraftSourceStep> = {}): DraftSourceStep {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000003",
    stepId: "custom:aaaaaaaa-0000-4000-8000-000000000003",
    origin: "custom",
    seq: null,
    phaseIndex: 2,
    displayOrder: 3,
    definition: {
      schemaVersion: 1,
      type: "skill",
      title: "Buyer long list",
      description: "Ranks strategic buyers.",
      inputs: [
        { key: "primary", kind: "text", label: "Input", helperText: "Sector and size.", required: true },
      ],
      skillBinding: { skillId: SKILL_ID, versionId: VERSION_ID, digest: DIGEST_A },
    },
    templateStepKey: "custom-44444444-4444-4444-8444-444444444444",
    skill: published(),
    ...overrides,
  };
}

function skillDefinition(description: string): Record<string, unknown> {
  return { ...(skillStep().definition as Record<string, unknown>), description };
}

const OPTIONS = { protectedIds: PROTECTED, mintStepId: () => "custom-minted" };

describe("buildRailDraft", () => {
  it("maps house, manual and skill steps in the deal's order", () => {
    const draft = buildRailDraft([skillStep(), manual(), house()], null, OPTIONS);

    expect(draft.steps).toEqual([
      {
        dealStepId: "aaaaaaaa-0000-4000-8000-000000000001",
        stepId: "p1-s7",
        origin: "catalog",
        seq: 1,
        phaseIndex: 1,
        definition: null,
      },
      {
        dealStepId: "aaaaaaaa-0000-4000-8000-000000000002",
        stepId: "custom-minted",
        origin: "custom",
        seq: null,
        phaseIndex: 1,
        definition: { title: "Team memo", description: "Added by the team." },
      },
      {
        dealStepId: "aaaaaaaa-0000-4000-8000-000000000003",
        stepId: "custom-44444444-4444-4444-8444-444444444444",
        origin: "custom",
        seq: null,
        phaseIndex: 2,
        definition: {
          schemaVersion: 1,
          type: "skill",
          title: "Buyer long list",
          description: "Ranks strategic buyers.",
          inputs: [
            { key: "primary", kind: "text", label: "Input", helperText: "Sector and size.", required: true },
          ],
          skill: { name: "Buyer long list", contract: CONTRACT, source: published().reference },
        },
      },
    ]);
    expect(draft.skills).toEqual([{ key: "s0", source: published().reference }]);
  });

  it("leaves a house step without a chosen skill unpinned, and carries a chosen one", () => {
    const plain = buildRailDraft([house()], null, OPTIONS);
    expect(plain.steps[0].definition).toBeNull();
    expect(plain.skills).toEqual([]);

    const chosen = buildRailDraft(
      [
        house({
          skill: {
            reference: { kind: "mount", name: "deal-teaser", version: 3, digest: DIGEST_B },
            name: "deal-teaser",
            contract: CONTRACT,
          },
        }),
      ],
      null,
      OPTIONS,
    );
    expect(chosen.steps[0].definition).toEqual({
      skill: {
        name: "deal-teaser",
        contract: CONTRACT,
        source: { kind: "mount", name: "deal-teaser", version: 3, digest: DIGEST_B },
      },
    });
    expect(chosen.skills).toEqual([
      { key: "s0", source: { kind: "mount", name: "deal-teaser", version: 3, digest: DIGEST_B } },
    ]);
  });

  it("keys one skill per distinct source, in step order", () => {
    const draft = buildRailDraft(
      [
        house(),
        skillStep({ id: "aaaaaaaa-0000-4000-8000-000000000004", displayOrder: 2, templateStepKey: "custom-a" }),
        skillStep({
          id: "aaaaaaaa-0000-4000-8000-000000000005",
          displayOrder: 3,
          templateStepKey: "custom-b",
          skill: published(DIGEST_B),
        }),
        skillStep({ id: "aaaaaaaa-0000-4000-8000-000000000006", displayOrder: 4, templateStepKey: "custom-c" }),
      ],
      null,
      OPTIONS,
    );

    expect(draft.skills.map((skill) => [skill.key, skill.source.digest])).toEqual([
      ["s0", DIGEST_A],
      ["s1", DIGEST_B],
    ]);
  });

  it("keeps the template's own skill block when the deal's copy has the digest the template retained", () => {
    const kept = {
      name: "Buyer long list",
      contract: CONTRACT,
      source: { kind: "candidate", candidateId: CANDIDATE_ID, digest: DIGEST_A },
    };
    const draft = buildRailDraft(
      [house(), skillStep()],
      [
        { stepId: "p1-s7", skill: null, retainedDigest: null },
        { stepId: "custom-44444444-4444-4444-8444-444444444444", skill: kept, retainedDigest: DIGEST_A },
      ],
      OPTIONS,
    );

    expect((draft.steps[1].definition as { skill: unknown }).skill).toEqual(kept);
    expect(draft.skills).toEqual([{ key: "s0", source: kept.source }]);
  });

  it("takes the deal's skill when its digest is not the one the template retained", () => {
    const draft = buildRailDraft(
      [house(), skillStep({ skill: published(DIGEST_B) })],
      [
        {
          stepId: "custom-44444444-4444-4444-8444-444444444444",
          skill: {
            name: "Buyer long list",
            contract: CONTRACT,
            source: { kind: "candidate", candidateId: CANDIDATE_ID, digest: DIGEST_A },
          },
          retainedDigest: DIGEST_A,
        },
      ],
      OPTIONS,
    );

    expect(draft.skills).toEqual([{ key: "s0", source: published(DIGEST_B).reference }]);
  });

  it.each([
    ["spaces around 4,000 characters", `  ${"x".repeat(4000)}  `],
    ["4,000 emoji", "🙂".repeat(4000)],
  ])("accepts a manual description of %s", (_name, description) => {
    const draft = buildRailDraft(
      [house(), manual({ definition: { title: "Team memo", description } })],
      null,
      OPTIONS,
    );

    expect(draft.steps).toHaveLength(2);
  });

  it("accepts descriptions at the catalog's limits", () => {
    const draft = buildRailDraft(
      [
        house(),
        manual({ definition: { title: "Team memo", description: "x".repeat(4000) } }),
        skillStep({ definition: skillDefinition("x".repeat(2000)) }),
      ],
      null,
      OPTIONS,
    );

    expect(draft.steps).toHaveLength(3);
  });

  it.each([
    ["empty_rail", []],
    ["unstructured_rail", [house({ phaseIndex: null })]],
    ["invalid_step_order", [house({ displayOrder: 0 })]],
    ["duplicate_catalog_step", [house(), house({ id: "aaaaaaaa-0000-4000-8000-000000000009", displayOrder: 2 })]],
    ["missing_protected_step", [house({ stepId: "p1-s10", templateStepKey: "p1-s10" })]],
    ["unsupported_definition", [house(), manual({ definition: { title: "No description" } })]],
    ["skill_unavailable", [house(), skillStep({ skill: null })]],
    ["skill_step_description", [house(), skillStep({ definition: skillDefinition("   ") })]],
    ["skill_step_description", [house(), skillStep({ definition: skillDefinition("x".repeat(2001)) })]],
    ["step_description_too_long", [house(), manual({ definition: { title: "Team memo", description: "x".repeat(4001) } })]],
    ["step_description_too_long", [house(), manual({ definition: { title: "Team memo", description: "x".repeat(4000) + "\n" } })]],
    [
      "duplicate_step_key",
      [
        house(),
        manual({ templateStepKey: "custom-same" }),
        manual({ id: "aaaaaaaa-0000-4000-8000-000000000008", displayOrder: 3, templateStepKey: "custom-same" }),
      ],
    ],
  ] as const)("refuses a rail with %s", (code, steps) => {
    expect(() => buildRailDraft([...steps], null, OPTIONS)).toThrow(code);
  });
});
