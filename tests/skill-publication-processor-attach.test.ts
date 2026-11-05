import { expect, it } from "vitest";
import { advanceAttaching } from "@/lib/skillPublication/processorAttach";
import {
  NOW,
  OPERATION_ID,
  RESULTING_STEP_ID,
  baseOperationRow,
  createStatefulAdmin,
  fakeDeps,
} from "./support/skillPublicationProcessorFixtures";

function attachingOp(overrides = {}) {
  return baseOperationRow({ state: "attaching", ...overrides });
}

it("reports published when the attach RPC's returned view says published", async () => {
  const stateful = createStatefulAdmin({
    operation: attachingOp(),
    attachResponse: {
      data: { state: "published", resultingDealStepId: RESULTING_STEP_ID },
      error: null,
    },
  });
  const deps = fakeDeps({ admin: stateful.admin });

  const result = await advanceAttaching(deps, attachingOp());

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "published",
    progressed: true,
  });
});

it("reports needs_placement when the attach RPC's returned view says the anchor is gone", async () => {
  const stateful = createStatefulAdmin({
    operation: attachingOp(),
    attachResponse: { data: { state: "needs_placement" }, error: null },
  });
  const deps = fakeDeps({ admin: stateful.admin });

  const result = await advanceAttaching(deps, attachingOp());

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "needs_placement",
    progressed: true,
  });
});

it("reports reconciling when the attach RPC's returned view says the receipt conflicted", async () => {
  const stateful = createStatefulAdmin({
    operation: attachingOp(),
    attachResponse: { data: { state: "reconciling" }, error: null },
  });
  const deps = fakeDeps({ admin: stateful.admin });

  const result = await advanceAttaching(deps, attachingOp());

  expect(result.state).toBe("reconciling");
});

it("stays attaching with backoff on a transient attach RPC error", async () => {
  const stateful = createStatefulAdmin({
    operation: attachingOp({ attempt_count: 0 }),
    attachResponse: { data: null, error: { message: "connection reset" } },
  });
  const deps = fakeDeps({ admin: stateful.admin });

  const result = await advanceAttaching(
    deps,
    attachingOp({ attempt_count: 0 }),
  );

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "attaching",
    progressed: true,
  });
  const op = stateful.getOperation();
  expect(op.attempt_count).toBe(1);
  expect(op.next_retry_at).toBe(new Date(NOW.getTime() + 5_000).toISOString());
});

it("stays attaching with backoff when the RPC returns null data and no error", async () => {
  const stateful = createStatefulAdmin({
    operation: attachingOp({ attempt_count: 0 }),
    attachResponse: { data: null, error: null },
  });
  const deps = fakeDeps({ admin: stateful.admin });

  const result = await advanceAttaching(
    deps,
    attachingOp({ attempt_count: 0 }),
  );

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "attaching",
    progressed: true,
  });
  const op = stateful.getOperation();
  expect(op.attempt_count).toBe(1);
  expect(op.next_retry_at).toBe(new Date(NOW.getTime() + 5_000).toISOString());
});

it("attaches even when the original author has lost access, per service reconciliation", async () => {
  const stateful = createStatefulAdmin({
    operation: attachingOp(),
    attachResponse: { data: { state: "published" }, error: null },
    authError: { code: "42501" },
  });
  const deps = fakeDeps({ admin: stateful.admin });

  const result = await advanceAttaching(deps, attachingOp());

  expect(result.state).toBe("published");
});
