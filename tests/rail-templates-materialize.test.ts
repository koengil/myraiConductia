import { describe, expect, it } from "vitest";

import {
  leftOutCatalogSteps,
  materializeRail,
} from "@/lib/railTemplates/materialize";
import {
  DIGEST_ONE_OFF,
  DIGEST_ORIGINAL,
  DIGEST_SELECTED,
  SEEDED_ID_A,
  SEEDED_ID_B,
  SEEDED_ID_C,
  VERSION_ONE_OFF,
  VERSION_ORIGINAL,
  VERSION_SELECTED,
  binding,
  catalogStep,
  customStep,
  manifestFixture,
  manifestOf,
  publishedSkill,
  skillDefinition,
} from "./support/railTemplateFixtures";

const IMPORTED = binding(VERSION_SELECTED, DIGEST_SELECTED);

describe("materializeRail", () => {
  it("allocates independent custom identities", () => {
    const manifest = manifestFixture();

    const a = materializeRail(manifest, { t0: SEEDED_ID_A }, {});
    const b = materializeRail(manifest, { t0: SEEDED_ID_B }, {});

    expect(a[0].stepId).toBe(`custom:${a[0].id}`);
    expect(a[0].id).not.toBe(b[0].id);
    expect(a[0].definition).toEqual(b[0].definition);
  });

  it("keeps catalog identity and order across materializations", () => {
    const manifest = manifestOf(
      [catalogStep(), customStep()],
      "test",
    );

    const a = materializeRail(
      manifest,
      { t0: SEEDED_ID_A, t1: SEEDED_ID_B },
      {},
    );
    const b = materializeRail(
      manifest,
      { t0: SEEDED_ID_B, t1: SEEDED_ID_C },
      {},
    );

    expect(a.map((step) => step.stepId)).toEqual([
      "p1-s10",
      `custom:${SEEDED_ID_B}`,
    ]);
    expect(b.map((step) => step.stepId)).toEqual([
      "p1-s10",
      `custom:${SEEDED_ID_C}`,
    ]);
    expect(a.map((step) => step.origin)).toEqual(["catalog", "custom"]);
    expect(a.map((step) => step.displayOrder)).toEqual([1, 2]);
    expect(b.map((step) => step.displayOrder)).toEqual([1, 2]);
    expect(a.map((step) => step.seq)).toEqual([10, null]);
    expect(a[1].id).not.toBe(b[1].id);
  });

  it("binds the selected skill version, never the original or a one-off run", () => {
    const manifest = manifestOf(
      [
        customStep({
          definition: skillDefinition(
            binding(VERSION_ORIGINAL, DIGEST_ORIGINAL),
          ),
          effectiveSkill: publishedSkill(VERSION_SELECTED, DIGEST_SELECTED),
        }),
        customStep({
          id: SEEDED_ID_C,
          displayOrder: 20,
          definition: skillDefinition(binding(VERSION_ONE_OFF, DIGEST_ONE_OFF)),
          effectiveSkill: publishedSkill(VERSION_SELECTED, DIGEST_SELECTED),
        }),
      ],
      "test",
    );

    const seeded = materializeRail(
      manifest,
      { t0: SEEDED_ID_A, t1: SEEDED_ID_B },
      { s0: IMPORTED },
    );

    expect(seeded.map((step) => step.binding)).toEqual([IMPORTED, IMPORTED]);
    expect(seeded[0].definition).toEqual({
      schemaVersion: 1,
      type: "skill",
      title: "Weekly memo",
      description: "Draft a memo",
      inputs: [
        {
          key: "primary",
          kind: "text",
          label: "Input",
          helperText: "A reporting period.",
          required: true,
        },
      ],
      skillBinding: IMPORTED,
    });
    expect(JSON.stringify(seeded)).not.toContain(VERSION_ONE_OFF);
    expect(JSON.stringify(seeded)).not.toContain(VERSION_ORIGINAL);
  });

  it("seeds a catalog step with a null definition and an explicit binding", () => {
    const manifest = manifestOf(
      [
        catalogStep({
          definition: skillDefinition(
            binding(VERSION_ORIGINAL, DIGEST_ORIGINAL),
          ),
          effectiveSkill: publishedSkill(VERSION_SELECTED, DIGEST_SELECTED),
        }),
      ],
      "test",
    );

    const seeded = materializeRail(
      manifest,
      { t0: SEEDED_ID_A },
      { s0: IMPORTED },
    );

    expect(seeded[0].definition).toBeNull();
    expect(seeded[0].binding).toEqual(IMPORTED);
    expect(seeded[0].stepId).toBe("p1-s10");
  });

  it("keeps a rebound custom manual step manual with an explicit binding", () => {
    const manifest = manifestOf(
      [
        customStep({
          effectiveSkill: publishedSkill(VERSION_SELECTED, DIGEST_SELECTED),
        }),
      ],
      "test",
    );

    const seeded = materializeRail(
      manifest,
      { t0: SEEDED_ID_A },
      { s0: IMPORTED },
    );

    expect(seeded[0].definition).toEqual({
      title: "Weekly memo",
      description: "Draft a memo",
    });
    expect(seeded[0].binding).toEqual(IMPORTED);
  });

  it("rejects a missing or reused identity", () => {
    const manifest = manifestOf(
      [catalogStep(), customStep()],
      "test",
    );

    expect(() => materializeRail(manifest, { t0: SEEDED_ID_A }, {})).toThrow(
      "invalid_step_identity",
    );
    expect(() =>
      materializeRail(manifest, { t0: SEEDED_ID_A, t1: SEEDED_ID_A }, {}),
    ).toThrow("invalid_step_identity");
  });

  it("rejects a missing skill import", () => {
    const manifest = manifestOf(
      [
        customStep({
          definition: skillDefinition(
            binding(VERSION_ORIGINAL, DIGEST_ORIGINAL),
          ),
          effectiveSkill: publishedSkill(VERSION_SELECTED, DIGEST_SELECTED),
        }),
      ],
      "test",
    );

    expect(() => materializeRail(manifest, { t0: SEEDED_ID_A }, {})).toThrow(
      "missing_skill_import",
    );
  });

  it("omits removed steps and seeds skipped active steps", () => {
    const manifest = manifestOf(
      [
        customStep({
          displayOrder: 1,
          status: "skipped",
          skip: {
            at: "2026-09-01",
            by: "storm",
            approver: "compliance",
            reason: "Not required",
          },
          definition: { title: "Skipped memo", description: "Draft a memo" },
        }),
        customStep({
          id: "removed",
          displayOrder: 2,
          removedAt: "2026-09-01",
          removedBy: { id: "storm", name: "Storm Duncan" },
          definition: { title: "Removed memo", description: "Draft a memo" },
        }),
      ],
      "test",
    );

    const seeded = materializeRail(manifest, { t0: SEEDED_ID_A }, {});

    expect(seeded).toEqual([
      {
        id: SEEDED_ID_A,
        stepId: `custom:${SEEDED_ID_A}`,
        seq: null,
        origin: "custom",
        phaseIndex: 2,
        displayOrder: 1,
        definition: { title: "Skipped memo", description: "Draft a memo" },
        binding: null,
      },
    ]);
  });
});

describe("leftOutCatalogSteps", () => {
  const standard = [
    { stepId: "p1-s1", seq: 1, phaseIndex: 1, displayOrder: 1 },
    { stepId: "p1-s2", seq: 2, phaseIndex: 1, displayOrder: 2 },
    { stepId: "p1-s3", seq: 3, phaseIndex: 1, displayOrder: 3 },
    { stepId: "p2-s4", seq: 4, phaseIndex: 2, displayOrder: 4 },
    { stepId: "p2-s5", seq: 5, phaseIndex: 2, displayOrder: 5 },
  ];

  it("returns each standard step the saved rail leaves out, after the active steps", () => {
    const manifest = manifestOf(
      [
        catalogStep({ id: "a", stepId: "p1-s1", seq: 1, displayOrder: 1 }),
        catalogStep({ id: "b", stepId: "p1-s3", seq: 3, displayOrder: 2 }),
        customStep({ id: "c", phaseIndex: 2, displayOrder: 3 }),
        catalogStep({ id: "d", stepId: "p2-s5", seq: 5, phaseIndex: 2, displayOrder: 4 }),
      ],
      "test",
    );

    const left = leftOutCatalogSteps(
      manifest,
      { t0: "id-s1", t1: "id-s3", t2: "id-custom", t3: "id-s5" },
      standard,
    );

    expect(left).toEqual([
      { stepId: "p1-s2", seq: 2, phaseIndex: 1, displayOrder: 5, anchorId: "id-s1" },
      { stepId: "p2-s4", seq: 4, phaseIndex: 2, displayOrder: 6, anchorId: null },
    ]);
  });

  it("leaves out nothing when the saved rail keeps every standard station", () => {
    const manifest = manifestOf(
      standard.map((row) =>
        catalogStep({ id: row.stepId, stepId: row.stepId, seq: row.seq, phaseIndex: row.phaseIndex, displayOrder: row.displayOrder }),
      ),
      "test",
    );

    expect(leftOutCatalogSteps(manifest, {}, standard)).toEqual([]);
  });
});
