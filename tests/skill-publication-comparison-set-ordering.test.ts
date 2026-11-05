import { expect, it } from "vitest";
import { buildComparisonSet } from "@/lib/skillPublication/comparisonSet";
import {
  DEAL_A,
  OPERATION_ID,
  OP_OTHER_DEAL,
  OP_OTHER_DEAL_ADMITTED,
  STEP_OTHER_DEAL,
  dealStepRow,
  fakeAdmin,
  isolationFixtures,
  operationRow,
  orderIndependenceFixtures,
} from "./support/comparisonSetFixtures";

it("never reveals another deal's same-named active step or admitted operation, and its digest is unaffected", async () => {
  const { withOtherDeal, withoutOtherDeal } = isolationFixtures();

  const result = await buildComparisonSet(withOtherDeal.admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });
  const baseline = await buildComparisonSet(withoutOtherDeal.admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets).toHaveLength(1);
  expect(result.targets.every((t) => t.targetId !== STEP_OTHER_DEAL)).toBe(
    true,
  );
  expect(result.targets.every((t) => t.targetId !== OP_OTHER_DEAL)).toBe(true);
  expect(
    result.targets.every((t) => t.targetId !== OP_OTHER_DEAL_ADMITTED),
  ).toBe(true);
  expect(result.comparisonSetDigest).toBe(baseline.comparisonSetDigest);
  expect(
    withOtherDeal.eqCalls.every(
      (call) => call.column === "deal_id" && call.value === DEAL_A,
    ),
  ).toBe(true);
});

it("sorts targets by targetId using code-unit comparison", async () => {
  const highId = "90000000-0000-4000-8000-000000000001";
  const lowId = "10000000-0000-4000-8000-000000000099";
  const { admin } = fakeAdmin({
    deal_steps: [],
    skill_publication_operations: [
      operationRow({
        id: highId,
        resulting_deal_step_id: null,
        state: "needs_placement",
      }),
      operationRow({
        id: lowId,
        resulting_deal_step_id: null,
        state: "needs_placement",
      }),
    ],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets.map((t) => t.targetId)).toEqual([lowId, highId]);
});

it("produces a stable digest independent of input row order", async () => {
  const { forward, reversed } = orderIndependenceFixtures();

  const forwardResult = await buildComparisonSet(forward.admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });
  const reversedResult = await buildComparisonSet(reversed.admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(forwardResult.comparisonSetDigest).toBe(
    reversedResult.comparisonSetDigest,
  );
});

it("pins the full canonical digest for a known comparison set", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [dealStepRow()],
    skill_publication_operations: [operationRow()],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.comparisonSetDigest).toBe(
    "137b2b170bc0ebac7e7d21589a9d4a20352bef8fb7a0c36e59c871ce5c6b0691",
  );
});
