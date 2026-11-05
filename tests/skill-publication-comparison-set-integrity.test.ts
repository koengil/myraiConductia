import { expect, it } from "vitest";
import { buildComparisonSet } from "@/lib/skillPublication/comparisonSet";
import { ComparisonSetIntegrityError } from "@/lib/skillPublication/comparisonSetIntegrityError";
import {
  DEAL_A,
  OPERATION_ID,
  OP_NEEDS_PLACEMENT,
  OP_PREPARING,
  STEP_ACTIVE,
  dealStepRow,
  fakeAdmin,
  operationRow,
} from "./support/comparisonSetFixtures";

it("throws ComparisonSetIntegrityError for an active step whose operation has an unparseable capability_contract", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [dealStepRow()],
    skill_publication_operations: [
      operationRow({ capability_contract: { purpose: "" } }),
    ],
  });

  await expect(
    buildComparisonSet(admin, { dealId: DEAL_A, operationId: OPERATION_ID }),
  ).rejects.toMatchObject({
    name: "ComparisonSetIntegrityError",
    targetId: STEP_ACTIVE,
    reason: "unparseable_capability_contract",
  });
});

it("throws ComparisonSetIntegrityError for an admitted operation with an unparseable capability_contract", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [],
    skill_publication_operations: [
      operationRow({
        id: OP_NEEDS_PLACEMENT,
        resulting_deal_step_id: null,
        state: "needs_placement",
        capability_contract: { purpose: "" },
      }),
    ],
  });

  await expect(
    buildComparisonSet(admin, { dealId: DEAL_A, operationId: OPERATION_ID }),
  ).rejects.toMatchObject({
    name: "ComparisonSetIntegrityError",
    targetId: OP_NEEDS_PLACEMENT,
    reason: "unparseable_capability_contract",
  });
});

it("throws ComparisonSetIntegrityError for a receipted step whose operation is missing its published binding", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [dealStepRow()],
    skill_publication_operations: [
      operationRow({
        published_skill_id: null,
        published_version_id: null,
        published_digest: null,
      }),
    ],
  });

  await expect(
    buildComparisonSet(admin, { dealId: DEAL_A, operationId: OPERATION_ID }),
  ).rejects.toMatchObject({
    name: "ComparisonSetIntegrityError",
    targetId: STEP_ACTIVE,
    reason: "missing_or_invalid_binding",
  });
});

it("throws ComparisonSetIntegrityError for an admitted operation with a partially set binding", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [],
    skill_publication_operations: [
      operationRow({
        id: OP_PREPARING,
        resulting_deal_step_id: null,
        state: "preparing",
        published_version_id: null,
      }),
    ],
  });

  await expect(
    buildComparisonSet(admin, { dealId: DEAL_A, operationId: OPERATION_ID }),
  ).rejects.toMatchObject({
    name: "ComparisonSetIntegrityError",
    targetId: OP_PREPARING,
    reason: "missing_or_invalid_binding",
  });
});

it("thrown error carries only the target id and reason, no other operation fields", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [dealStepRow()],
    skill_publication_operations: [
      operationRow({ capability_contract: { purpose: "" } }),
    ],
  });

  try {
    await buildComparisonSet(admin, {
      dealId: DEAL_A,
      operationId: OPERATION_ID,
    });
    throw new Error("expected buildComparisonSet to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ComparisonSetIntegrityError);
    expect(Object.keys(error as object).sort()).toEqual([
      "name",
      "reason",
      "targetId",
    ]);
  }
});
