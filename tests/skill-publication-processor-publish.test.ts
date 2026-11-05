import { expect, it } from "vitest";
import { ComparisonSetIntegrityError } from "@/lib/skillPublication/comparisonSetIntegrityError";
import { advancePublishing } from "@/lib/skillPublication/processorPublish";
import { MAX_PUBLISH_ATTEMPTS } from "@/lib/skillPublication/processorTiming";
import {
  COMPARISON_SET_DIGEST,
  DEAL_ID,
  DRAFT_ID,
  NOW,
  OPERATION_ID,
  OPERATION_NAME,
  OTHER_COMPARISON_SET_DIGEST,
  OTHER_STEP_ID,
  STEP_ACTIVE,
  STEP_REMOVED,
  TENANT_ID,
  VERSION_ID,
  activeTarget,
  admittedTarget,
  baseOperationRow,
  createStatefulAdmin,
  fakeDeps,
  fakeIgnatious,
  publicationReceipt,
  removedTarget,
} from "./support/skillPublicationProcessorFixtures";

function statefulPublishing(overrides = {}) {
  return createStatefulAdmin({
    operation: baseOperationRow({
      state: "publishing",
      comparison_set_digest: COMPARISON_SET_DIGEST,
      preparation_id: "90000000-0000-4000-8000-000000000001",
      assessment_digest:
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      ...overrides,
    }),
  });
}

function statefulEnhancement() {
  return createStatefulAdmin({
    operation: baseOperationRow({
      state: "publishing",
      comparison_set_digest: COMPARISON_SET_DIGEST,
      preparation_id: "90000000-0000-4000-8000-000000000001",
      assessment_digest:
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    }),
    drafts: { [DRAFT_ID]: { basis_deal_step_id: STEP_ACTIVE } },
  });
}

const publishingOp = (overrides = {}) =>
  baseOperationRow({
    state: "publishing",
    comparison_set_digest: COMPARISON_SET_DIGEST,
    preparation_id: "90000000-0000-4000-8000-000000000001",
    assessment_digest:
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    ...overrides,
  });

it("moves publishing to attaching and stores the receipt on success", async () => {
  const stateful = statefulPublishing();
  const ignatious = fakeIgnatious({
    publish: async () => ({ outcome: "success", body: publicationReceipt() }),
  });
  const deps = fakeDeps({
    admin: stateful.admin,
    ignatious,
    buildComparisonSet: async () => ({
      targets: [],
      comparisonSetDigest: COMPARISON_SET_DIGEST,
    }),
  });

  const result = await advancePublishing(deps, publishingOp());

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "attaching",
    progressed: true,
  });
  const op = stateful.getOperation();
  expect(op.published_skill_id).toBe(publicationReceipt().skillId);
  expect(op.published_version_id).toBe(VERSION_ID);
  expect(op.published_digest).toBe(publicationReceipt().digest);
});

it("sends companyId as the deal's tenant_id, projectId as the deal id", async () => {
  const stateful = statefulPublishing();
  const ignatious = fakeIgnatious({
    publish: async () => ({ outcome: "success", body: publicationReceipt() }),
  });
  const deps = fakeDeps({
    admin: stateful.admin,
    ignatious,
    buildComparisonSet: async () => ({
      targets: [],
      comparisonSetDigest: COMPARISON_SET_DIGEST,
    }),
  });

  await advancePublishing(deps, publishingOp());

  expect(ignatious.publish).toHaveBeenCalledWith(
    OPERATION_ID,
    expect.objectContaining({ companyId: TENANT_ID, projectId: DEAL_ID }),
    expect.objectContaining({ correlationId: expect.any(String) }),
  );
});

it("goes back to preparing without publishing when the comparison-set digest changed", async () => {
  const stateful = statefulPublishing();
  const ignatious = fakeIgnatious({});
  const deps = fakeDeps({
    admin: stateful.admin,
    ignatious,
    buildComparisonSet: async () => ({
      targets: [],
      comparisonSetDigest: OTHER_COMPARISON_SET_DIGEST,
    }),
  });

  const result = await advancePublishing(deps, publishingOp());

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "preparing",
    progressed: true,
  });
  expect(ignatious.publish).not.toHaveBeenCalled();
});

it("stays publishing with backoff, without publishing, on a comparison-set integrity error", async () => {
  const stateful = statefulPublishing({ attempt_count: 0 });
  const ignatious = fakeIgnatious({});
  const deps = fakeDeps({
    admin: stateful.admin,
    ignatious,
    buildComparisonSet: async () => {
      throw new ComparisonSetIntegrityError(
        STEP_ACTIVE,
        "missing_or_invalid_binding",
      );
    },
  });

  const result = await advancePublishing(
    deps,
    publishingOp({ attempt_count: 0 }),
  );

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "publishing",
    progressed: true,
  });
  expect(ignatious.publish).not.toHaveBeenCalled();
  const op = stateful.getOperation();
  expect(op.attempt_count).toBe(0);
  expect(op.next_retry_at).toBe(new Date(NOW.getTime() + 5_000).toISOString());
});

it("times out publish into reconciling, with backoff", async () => {
  const stateful = statefulPublishing();
  const ignatious = fakeIgnatious({
    publish: async () => ({ outcome: "timeout_or_network" }),
  });
  const deps = fakeDeps({ admin: stateful.admin, ignatious });

  const result = await advancePublishing(deps, publishingOp());

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "reconciling",
    progressed: true,
  });
  const op = stateful.getOperation();
  expect(op.attempt_count).toBe(1);
  expect(op.next_retry_at).toBe(new Date(NOW.getTime() + 5_000).toISOString());
});

it("treats a publish 409 as ambiguous, moving to reconciling", async () => {
  const stateful = statefulPublishing();
  const ignatious = fakeIgnatious({
    publish: async () => ({ outcome: "http_error", status: 409, code: null }),
  });
  const deps = fakeDeps({ admin: stateful.admin, ignatious });

  const result = await advancePublishing(deps, publishingOp());

  expect(result.state).toBe("reconciling");
});

it("treats an invalid_response after publish as ambiguous, moving to reconciling", async () => {
  const stateful = statefulPublishing();
  const ignatious = fakeIgnatious({
    publish: async () => ({ outcome: "invalid_response" }),
  });
  const deps = fakeDeps({ admin: stateful.admin, ignatious });

  const result = await advancePublishing(deps, publishingOp());

  expect(result.state).toBe("reconciling");
});

it.each([404, 422] as const)(
  "fails with candidate_invalid on a publish %s",
  async (status) => {
    const stateful = statefulPublishing();
    const ignatious = fakeIgnatious({
      publish: async () => ({ outcome: "http_error", status, code: null }),
    });
    const deps = fakeDeps({ admin: stateful.admin, ignatious });

    const result = await advancePublishing(deps, publishingOp());

    expect(result).toEqual({
      publicationId: OPERATION_ID,
      state: "failed",
      progressed: true,
    });
    expect(stateful.getOperation().status_code).toBe("candidate_invalid");
  },
);

const RETRYABLE_PUBLISH_OUTCOMES = [
  ["401", { outcome: "http_error", status: 401, code: null }],
  ["500", { outcome: "http_error", status: 500, code: null }],
  ["429 (unlisted)", { outcome: "http_error", status: 429, code: null }],
  ["unconfigured", { outcome: "unconfigured" }],
] as const;

it.each(RETRYABLE_PUBLISH_OUTCOMES)(
  "stays publishing with exact backoff and a single attempt increment on %s",
  async (_label, outcome) => {
    const stateful = statefulPublishing({ attempt_count: 0 });
    const ignatious = fakeIgnatious({ publish: async () => outcome as never });
    const deps = fakeDeps({ admin: stateful.admin, ignatious });

    const result = await advancePublishing(
      deps,
      publishingOp({ attempt_count: 0 }),
    );

    expect(result).toEqual({
      publicationId: OPERATION_ID,
      state: "publishing",
      progressed: true,
    });
    const op = stateful.getOperation();
    expect(op.attempt_count).toBe(1);
    expect(op.next_retry_at).toBe(
      new Date(NOW.getTime() + 5_000).toISOString(),
    );
    expect(op.status_code).not.toBe("candidate_invalid");
    expect(op.status_code).not.toBe("candidate_stale");
  },
);

const NAME_COLLISION_CASES = [
  [
    "active",
    "duplicate_active",
    () => STEP_ACTIVE,
    () => activeTarget({ displayName: OPERATION_NAME }),
  ],
  [
    "removed",
    "duplicate_removed",
    () => STEP_REMOVED,
    () => removedTarget({ displayName: OPERATION_NAME }),
  ],
  [
    "admitted",
    "duplicate_active",
    () => null,
    () => admittedTarget({ displayName: OPERATION_NAME }),
  ],
] as const;

it.each(NAME_COLLISION_CASES)(
  "rechecks normalized-name collisions before publish, %s -> %s",
  async (_label, expectedCode, expectedStepId, buildTarget) => {
    const stateful = statefulPublishing();
    const ignatious = fakeIgnatious({});
    const target = buildTarget();
    const deps = fakeDeps({
      admin: stateful.admin,
      ignatious,
      buildComparisonSet: async () => ({
        targets: [target],
        comparisonSetDigest: COMPARISON_SET_DIGEST,
      }),
    });

    const result = await advancePublishing(deps, publishingOp());

    expect(result).toEqual({
      publicationId: OPERATION_ID,
      state: "failed",
      progressed: true,
    });
    const op = stateful.getOperation();
    expect(op.status_code).toBe(expectedCode);
    expect(op.status_deal_step_id).toBe(expectedStepId());
    expect(ignatious.publish).not.toHaveBeenCalled();
  },
);

it("lets an enhancement publish past its own step's name", async () => {
  const stateful = statefulEnhancement();
  const ignatious = fakeIgnatious({
    publish: async () => ({ outcome: "success", body: publicationReceipt() }),
  });
  const deps = fakeDeps({
    admin: stateful.admin,
    ignatious,
    buildComparisonSet: async () => ({
      targets: [
        activeTarget({ targetId: STEP_ACTIVE, displayName: OPERATION_NAME }),
      ],
      comparisonSetDigest: COMPARISON_SET_DIGEST,
    }),
  });

  const result = await advancePublishing(
    deps,
    publishingOp({ draft_id: DRAFT_ID }),
  );

  expect(stateful.getOperation().status_code).not.toBe("duplicate_active");
  expect(ignatious.publish).toHaveBeenCalled();
  expect(result.state).toBe("attaching");
});

it("still blocks an enhancement on a different step's name", async () => {
  const stateful = statefulEnhancement();
  const ignatious = fakeIgnatious({});
  const deps = fakeDeps({
    admin: stateful.admin,
    ignatious,
    buildComparisonSet: async () => ({
      targets: [
        activeTarget({ targetId: OTHER_STEP_ID, displayName: OPERATION_NAME }),
      ],
      comparisonSetDigest: COMPARISON_SET_DIGEST,
    }),
  });

  const result = await advancePublishing(
    deps,
    publishingOp({ draft_id: DRAFT_ID }),
  );

  expect(stateful.getOperation().status_code).toBe("duplicate_active");
  expect(ignatious.publish).not.toHaveBeenCalled();
  expect(result.state).toBe("failed");
});

it("fails as publish_exhausted without publishing once the attempt cap is reached (#249)", async () => {
  const stateful = statefulPublishing({ attempt_count: MAX_PUBLISH_ATTEMPTS });
  let published = false;
  const ignatious = fakeIgnatious({
    publish: async () => {
      published = true;
      return { outcome: "http_error", status: 500, code: null };
    },
  });
  const deps = fakeDeps({ admin: stateful.admin, ignatious });

  const result = await advancePublishing(
    deps,
    publishingOp({ attempt_count: MAX_PUBLISH_ATTEMPTS }),
  );

  expect(result.state).toBe("failed");
  expect(published).toBe(false);
  expect(stateful.getOperation().status_code).toBe("publish_exhausted");
});

it("still publishes one attempt below the cap", async () => {
  const stateful = statefulPublishing({ attempt_count: MAX_PUBLISH_ATTEMPTS - 1 });
  const ignatious = fakeIgnatious({
    publish: async () => ({ outcome: "http_error", status: 500, code: null }),
  });
  const deps = fakeDeps({ admin: stateful.admin, ignatious });

  const result = await advancePublishing(
    deps,
    publishingOp({ attempt_count: MAX_PUBLISH_ATTEMPTS - 1 }),
  );

  expect(result.state).toBe("publishing");
});
