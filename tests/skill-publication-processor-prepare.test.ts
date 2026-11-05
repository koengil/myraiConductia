import { expect, it } from "vitest";
import { advancePreparing } from "@/lib/skillPublication/processorPrepare";
import { ComparisonSetIntegrityError } from "@/lib/skillPublication/comparisonSetIntegrityError";
import {
  ASSESSMENT_DIGEST,
  CANDIDATE_ID,
  COMPARISON_SET_DIGEST,
  DEAL_ID,
  NOW,
  OPERATION_ID,
  PREPARATION_ID,
  STEP_ACTIVE,
  TENANT_ID,
  baseOperationRow,
  createStatefulAdmin,
  fakeDeps,
  fakeIgnatious,
  preparationReceipt,
} from "./support/skillPublicationProcessorFixtures";

function statefulPreparing(overrides = {}) {
  const stateful = createStatefulAdmin({
    operation: baseOperationRow({ state: "preparing", ...overrides }),
  });
  return stateful;
}

it("moves preparing to publishing and records preparation fields on a clean assessment", async () => {
  const stateful = statefulPreparing();
  const ignatious = fakeIgnatious({
    prepare: async () => ({ outcome: "success", body: preparationReceipt() }),
  });
  const deps = fakeDeps({
    admin: stateful.admin,
    ignatious,
    buildComparisonSet: async () => ({
      targets: [],
      comparisonSetDigest: COMPARISON_SET_DIGEST,
    }),
  });

  const result = await advancePreparing(
    deps,
    baseOperationRow({ state: "preparing" }),
  );

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "publishing",
    progressed: true,
  });
  const op = stateful.getOperation();
  expect(op.preparation_id).toBe(PREPARATION_ID);
  expect(op.assessment_digest).toBe(ASSESSMENT_DIGEST);
  expect(op.comparison_set_digest).toBe(COMPARISON_SET_DIGEST);
  // Publishing starts with its own attempt budget (#249).
  expect(op.attempt_count).toBe(0);
});

it("does not spend the publish budget on preparation retries (#249)", async () => {
  const stateful = statefulPreparing({ attempt_count: 25 });
  const deps = fakeDeps({
    admin: stateful.admin,
    ignatious: fakeIgnatious({
      prepare: async () => ({ outcome: "success", body: preparationReceipt() }),
    }),
    buildComparisonSet: async () => ({
      targets: [],
      comparisonSetDigest: COMPARISON_SET_DIGEST,
    }),
  });

  await advancePreparing(
    deps,
    baseOperationRow({ state: "preparing", attempt_count: 25 }),
  );

  expect(stateful.getOperation().state).toBe("publishing");
  expect(stateful.getOperation().attempt_count).toBe(0);
});

it("sends companyId as the deal's tenant_id, projectId as the deal id, and an untrimmed candidateName", async () => {
  const stateful = createStatefulAdmin({
    operation: baseOperationRow({ state: "preparing" }),
    candidates: {
      [CANDIDATE_ID]: { preview: { name: " Weekly project update " } },
    },
  });
  const ignatious = fakeIgnatious({
    prepare: async () => ({ outcome: "success", body: preparationReceipt() }),
  });
  const deps = fakeDeps({
    admin: stateful.admin,
    ignatious,
    buildComparisonSet: async () => ({
      targets: [],
      comparisonSetDigest: COMPARISON_SET_DIGEST,
    }),
  });

  await advancePreparing(deps, baseOperationRow({ state: "preparing" }));

  expect(ignatious.prepare).toHaveBeenCalledWith(
    OPERATION_ID,
    expect.objectContaining({
      companyId: TENANT_ID,
      projectId: DEAL_ID,
      candidateName: " Weekly project update ",
    }),
    expect.objectContaining({ correlationId: expect.any(String) }),
  );
});

it("fails with candidate_invalid when the frozen preview name is blank, without calling prepare", async () => {
  const stateful = createStatefulAdmin({
    operation: baseOperationRow({ state: "preparing" }),
    candidates: { [CANDIDATE_ID]: { preview: { name: "  " } } },
  });
  const ignatious = fakeIgnatious({});
  const deps = fakeDeps({ admin: stateful.admin, ignatious });

  const result = await advancePreparing(
    deps,
    baseOperationRow({ state: "preparing" }),
  );

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "failed",
    progressed: true,
  });
  expect(stateful.getOperation().status_code).toBe("candidate_invalid");
  expect(ignatious.prepare).not.toHaveBeenCalled();
});

it("fails with candidate_invalid when the frozen preview name exceeds 100 characters", async () => {
  const stateful = createStatefulAdmin({
    operation: baseOperationRow({ state: "preparing" }),
    candidates: { [CANDIDATE_ID]: { preview: { name: "x".repeat(101) } } },
  });
  const deps = fakeDeps({ admin: stateful.admin });

  const result = await advancePreparing(
    deps,
    baseOperationRow({ state: "preparing" }),
  );

  expect(result.state).toBe("failed");
  expect(stateful.getOperation().status_code).toBe("candidate_invalid");
});

it("stays preparing with backoff, without incrementing attempt_count, on a comparison-set integrity error", async () => {
  const stateful = statefulPreparing({ attempt_count: 2 });
  const deps = fakeDeps({
    admin: stateful.admin,
    buildComparisonSet: async () => {
      throw new ComparisonSetIntegrityError(
        STEP_ACTIVE,
        "missing_or_invalid_binding",
      );
    },
  });

  const result = await advancePreparing(
    deps,
    baseOperationRow({ state: "preparing", attempt_count: 2 }),
  );

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "preparing",
    progressed: true,
  });
  const op = stateful.getOperation();
  expect(op.attempt_count).toBe(2);
  expect(op.next_retry_at).toBe(new Date(NOW.getTime() + 15_000).toISOString());
});

it("pauses on access loss without incrementing attempt_count, setting a 300s retry", async () => {
  const stateful = statefulPreparing({ attempt_count: 1 });
  stateful.setAuthError({ code: "42501" });
  const deps = fakeDeps({ admin: stateful.admin });

  const result = await advancePreparing(
    deps,
    baseOperationRow({ state: "preparing", attempt_count: 1 }),
  );

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "preparing",
    progressed: true,
  });
  const op = stateful.getOperation();
  expect(op.status_code).toBe("access_lost");
  expect(op.attempt_count).toBe(1);
  expect(op.next_retry_at).toBe(
    new Date(NOW.getTime() + 300_000).toISOString(),
  );
});

it("pauses with feature_disabled when the flag is off", async () => {
  const stateful = statefulPreparing();
  const deps = fakeDeps({
    admin: stateful.admin,
    isFlagEnabled: async () => false,
  });

  const result = await advancePreparing(
    deps,
    baseOperationRow({ state: "preparing" }),
  );

  expect(result.progressed).toBe(true);
  expect(stateful.getOperation().status_code).toBe("feature_disabled");
});

it("clears a pause status code once access and the flag are restored", async () => {
  const stateful = statefulPreparing({ status_code: "access_lost" });
  const ignatious = fakeIgnatious({
    prepare: async () => ({
      outcome: "success",
      body: preparationReceipt({ matches: [] }),
    }),
  });
  const deps = fakeDeps({ admin: stateful.admin, ignatious });

  await advancePreparing(
    deps,
    baseOperationRow({ state: "preparing", status_code: "access_lost" }),
  );

  expect(stateful.getOperation().status_code).toBeNull();
});

const RETRYABLE_PREPARE_OUTCOMES = [
  ["timeout_or_network", { outcome: "timeout_or_network" }],
  ["unconfigured", { outcome: "unconfigured" }],
  ["invalid_response", { outcome: "invalid_response" }],
  ["401", { outcome: "http_error", status: 401, code: null }],
  ["500", { outcome: "http_error", status: 500, code: null }],
  ["400 (unlisted)", { outcome: "http_error", status: 400, code: null }],
] as const;

it.each(RETRYABLE_PREPARE_OUTCOMES)(
  "stays preparing with backoff on a %s prepare outcome",
  async (_label, outcome) => {
    const stateful = statefulPreparing({ attempt_count: 0 });
    const ignatious = fakeIgnatious({ prepare: async () => outcome as never });
    const deps = fakeDeps({ admin: stateful.admin, ignatious });

    const result = await advancePreparing(
      deps,
      baseOperationRow({ state: "preparing" }),
    );

    expect(result).toEqual({
      publicationId: OPERATION_ID,
      state: "preparing",
      progressed: true,
    });
    const op = stateful.getOperation();
    expect(op.attempt_count).toBe(1);
    expect(op.next_retry_at).toBe(
      new Date(NOW.getTime() + 5_000).toISOString(),
    );
  },
);

const TERMINAL_PREPARE_OUTCOMES = [
  [404, "candidate_invalid"],
  [422, "candidate_invalid"],
  [409, "candidate_stale"],
] as const;

it.each(TERMINAL_PREPARE_OUTCOMES)(
  "fails with %s -> %s on a prepare http_error",
  async (status, expectedCode) => {
    const stateful = statefulPreparing();
    const ignatious = fakeIgnatious({
      prepare: async () => ({ outcome: "http_error", status, code: null }),
    });
    const deps = fakeDeps({ admin: stateful.admin, ignatious });

    const result = await advancePreparing(
      deps,
      baseOperationRow({ state: "preparing" }),
    );

    expect(result).toEqual({
      publicationId: OPERATION_ID,
      state: "failed",
      progressed: true,
    });
    expect(stateful.getOperation().status_code).toBe(expectedCode);
  },
);

it("computes the bounded backoff schedule from attempt_count", async () => {
  const schedule = [
    [0, 5_000],
    [1, 15_000],
    [2, 60_000],
    [3, 300_000],
    [4, 900_000],
    [10, 900_000],
  ] as const;

  for (const [attemptCount, expectedMs] of schedule) {
    const stateful = statefulPreparing({ attempt_count: attemptCount });
    const ignatious = fakeIgnatious({
      prepare: async () => ({ outcome: "timeout_or_network" }),
    });
    const deps = fakeDeps({ admin: stateful.admin, ignatious });

    await advancePreparing(
      deps,
      baseOperationRow({ state: "preparing", attempt_count: attemptCount }),
    );

    expect(stateful.getOperation().next_retry_at).toBe(
      new Date(NOW.getTime() + expectedMs).toISOString(),
    );
  }
});

it("returns progressed: false when another processor already changed the state", async () => {
  const raced = createStatefulAdmin({
    operation: baseOperationRow({ state: "confirmation_required" }),
  });
  const ignatious = fakeIgnatious({
    prepare: async () => ({
      outcome: "success",
      body: preparationReceipt({ matches: [] }),
    }),
  });
  const deps = fakeDeps({ admin: raced.admin, ignatious });

  const result = await advancePreparing(
    deps,
    baseOperationRow({ state: "preparing" }),
  );

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "preparing",
    progressed: false,
  });
});
