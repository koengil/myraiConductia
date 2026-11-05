import { expect, it } from "vitest";
import { advancePreparing } from "@/lib/skillPublication/processorPrepare";
import type {
  ComparisonTarget,
  DuplicateMatch,
} from "@/lib/skillPublication/types";
import {
  ADMITTED_OP_ID,
  COMPARISON_SET_DIGEST,
  OPERATION_ID,
  STEP_ACTIVE,
  STEP_REMOVED,
  activeTarget,
  admittedTarget,
  baseOperationRow,
  createStatefulAdmin,
  duplicateMatch,
  fakeDeps,
  fakeIgnatious,
  preparationReceipt,
  removedTarget,
} from "./support/skillPublicationProcessorFixtures";

function statefulPreparing(overrides = {}) {
  return createStatefulAdmin({
    operation: baseOperationRow({ state: "preparing", ...overrides }),
  });
}

async function runPreparing(
  admin: ReturnType<typeof statefulPreparing>["admin"],
  matches: DuplicateMatch[],
  targets: ComparisonTarget[],
) {
  const ignatious = fakeIgnatious({
    prepare: async () => ({
      outcome: "success",
      body: preparationReceipt({ matches }),
    }),
  });
  const deps = fakeDeps({
    admin,
    ignatious,
    buildComparisonSet: async () => ({
      targets,
      comparisonSetDigest: COMPARISON_SET_DIGEST,
    }),
  });
  return advancePreparing(deps, baseOperationRow({ state: "preparing" }));
}

it("pauses in confirmation_required on a similar match against an active step, recording safe matches", async () => {
  const stateful = statefulPreparing();
  const match = duplicateMatch({
    targetId: STEP_ACTIVE,
    classification: "similar",
  });

  const result = await runPreparing(stateful.admin, [match], [activeTarget()]);

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "confirmation_required",
    progressed: true,
  });
  expect(stateful.getOperation().duplicate_matches).toEqual([
    {
      dealStepId: STEP_ACTIVE,
      name: "Other active step",
      classification: "similar",
      reasonCode: "capability_similar",
    },
  ]);
});

it("drops confidence and targetId when recording the R29 safe match", async () => {
  const stateful = statefulPreparing();
  const match = duplicateMatch({ targetId: STEP_ACTIVE, confidence: 0.42 });

  await runPreparing(stateful.admin, [match], [activeTarget()]);

  const stored = stateful.getOperation().duplicate_matches as Record<
    string,
    unknown
  >[];
  expect(stored[0]).not.toHaveProperty("confidence");
  expect(stored[0]).not.toHaveProperty("targetId");
});

const HARD_BLOCK_CASES = [
  [
    "exact",
    "active",
    "duplicate_active",
    () => STEP_ACTIVE,
    () => activeTarget(),
  ],
  [
    "equivalent",
    "active",
    "duplicate_active",
    () => STEP_ACTIVE,
    () => activeTarget(),
  ],
  [
    "exact",
    "removed",
    "duplicate_removed",
    () => STEP_REMOVED,
    () => removedTarget(),
  ],
  [
    "equivalent",
    "removed",
    "duplicate_removed",
    () => STEP_REMOVED,
    () => removedTarget(),
  ],
  ["exact", "admitted", "duplicate_active", () => null, () => admittedTarget()],
  [
    "equivalent",
    "admitted",
    "duplicate_active",
    () => null,
    () => admittedTarget(),
  ],
] as const;

async function expectHardBlock(
  classification: "exact" | "equivalent",
  target: ComparisonTarget,
  expectedCode: string,
  expectedStepId: string | null,
) {
  const stateful = statefulPreparing();
  const match = duplicateMatch({ targetId: target.targetId, classification });

  const result = await runPreparing(stateful.admin, [match], [target]);

  expect(result.state).toBe("failed");
  expect(result.progressed).toBe(true);
  const op = stateful.getOperation();
  expect(op.status_code).toBe(expectedCode);
  expect(op.status_deal_step_id).toBe(expectedStepId);
}

it.each(HARD_BLOCK_CASES)(
  "fails with %s / %s -> %s",
  async (
    classification,
    _targetState,
    expectedCode,
    expectedStepId,
    buildTarget,
  ) => {
    await expectHardBlock(
      classification,
      buildTarget(),
      expectedCode,
      expectedStepId(),
    );
  },
);

it("ignores a similar match against a removed step or an admitted operation", async () => {
  const stateful = statefulPreparing();
  const matches = [
    duplicateMatch({ targetId: STEP_REMOVED, classification: "similar" }),
    duplicateMatch({ targetId: ADMITTED_OP_ID, classification: "similar" }),
  ];

  const result = await runPreparing(stateful.admin, matches, [
    removedTarget(),
    admittedTarget(),
  ]);

  expect(result.state).toBe("publishing");
});
