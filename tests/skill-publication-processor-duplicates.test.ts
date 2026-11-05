import { expect, it } from "vitest";
import {
  decideDuplicates,
  normalizedNameCollision,
} from "@/lib/skillPublication/processorDuplicates";
import {
  ADMITTED_OP_ID,
  STEP_ACTIVE,
  STEP_REMOVED,
  activeTarget,
  admittedTarget,
  duplicateMatch,
  removedTarget,
} from "./support/skillPublicationProcessorFixtures";

const LOWER_ACTIVE_ID = "10000000-0000-4000-8000-000000000001";
const HIGHER_ACTIVE_ID = "20000000-0000-4000-8000-000000000009";

it.each([
  ["removed-then-active", [STEP_REMOVED, STEP_ACTIVE]],
  ["active-then-removed", [STEP_ACTIVE, STEP_REMOVED]],
])(
  "picks the active-step block over a removed-step block regardless of order (%s)",
  async (_label, order) => {
    const targets = [removedTarget(), activeTarget()];
    const matches = order.map((id) =>
      duplicateMatch({ targetId: id, classification: "exact" }),
    );

    const decision = decideDuplicates(matches, targets);

    expect(decision).toEqual({
      kind: "block",
      block: { code: "duplicate_active", dealStepId: STEP_ACTIVE },
    });
  },
);

it.each([
  ["admitted-then-removed", [ADMITTED_OP_ID, STEP_REMOVED]],
  ["removed-then-admitted", [STEP_REMOVED, ADMITTED_OP_ID]],
])(
  "picks the admitted-operation block over a removed-step block regardless of order (%s)",
  async (_label, order) => {
    const targets = [removedTarget(), admittedTarget()];
    const matches = order.map((id) =>
      duplicateMatch({ targetId: id, classification: "equivalent" }),
    );

    const decision = decideDuplicates(matches, targets);

    expect(decision).toEqual({
      kind: "block",
      block: { code: "duplicate_active", dealStepId: null },
    });
  },
);

it.each([
  ["lower-then-higher", [LOWER_ACTIVE_ID, HIGHER_ACTIVE_ID]],
  ["higher-then-lower", [HIGHER_ACTIVE_ID, LOWER_ACTIVE_ID]],
])(
  "breaks a same-priority tie by the lower code-unit targetId, regardless of order (%s)",
  async (_label, order) => {
    const targets = [
      activeTarget({ targetId: LOWER_ACTIVE_ID }),
      activeTarget({ targetId: HIGHER_ACTIVE_ID }),
    ];
    const matches = order.map((id) =>
      duplicateMatch({ targetId: id, classification: "exact" }),
    );

    const decision = decideDuplicates(matches, targets);

    expect(decision).toEqual({
      kind: "block",
      block: { code: "duplicate_active", dealStepId: LOWER_ACTIVE_ID },
    });
  },
);

it("normalizedNameCollision picks admitted over removed, in either order", async () => {
  const name = "Same Name";
  const admitted = admittedTarget({ displayName: name });
  const removed = removedTarget({ displayName: name });

  expect(normalizedNameCollision(name, [admitted, removed])).toEqual({
    code: "duplicate_active",
    dealStepId: null,
  });
  expect(normalizedNameCollision(name, [removed, admitted])).toEqual({
    code: "duplicate_active",
    dealStepId: null,
  });
});

it("normalizedNameCollision picks active over removed, in either order", async () => {
  const name = "Same Name";
  const active = activeTarget({ displayName: name });
  const removed = removedTarget({ displayName: name });

  expect(normalizedNameCollision(name, [active, removed])).toEqual({
    code: "duplicate_active",
    dealStepId: STEP_ACTIVE,
  });
  expect(normalizedNameCollision(name, [removed, active])).toEqual({
    code: "duplicate_active",
    dealStepId: STEP_ACTIVE,
  });
});
