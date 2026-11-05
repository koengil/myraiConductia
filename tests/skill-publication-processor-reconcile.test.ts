import { expect, it } from "vitest";
import { advanceReconciling } from "@/lib/skillPublication/processorReconcile";
import {
  NOW,
  OPERATION_ID,
  VERSION_ID,
  baseOperationRow,
  createStatefulAdmin,
  fakeDeps,
  fakeIgnatious,
  publicationReceipt,
  publishedLookup,
} from "./support/skillPublicationProcessorFixtures";

function reconcilingOp(overrides = {}) {
  return baseOperationRow({ state: "reconciling", ...overrides });
}

function statefulReconciling(overrides = {}) {
  return createStatefulAdmin({ operation: reconcilingOp(overrides) });
}

it("stores the live receipt and moves to attaching when lookup proves the frozen operation published", async () => {
  const stateful = statefulReconciling();
  const ignatious = fakeIgnatious({
    lookup: async () => ({ outcome: "success", body: publishedLookup() }),
  });
  const deps = fakeDeps({ admin: stateful.admin, ignatious });

  const result = await advanceReconciling(deps, reconcilingOp());

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

it("holds reconciling with receipt_conflict, never storing a value, when the skill id diverges", async () => {
  const stateful = statefulReconciling();
  const conflicting = publishedLookup({
    skillId: "99999999-0000-4000-8000-000000000009",
  });
  const ignatious = fakeIgnatious({
    lookup: async () => ({ outcome: "success", body: conflicting }),
  });
  const deps = fakeDeps({ admin: stateful.admin, ignatious });

  const result = await advanceReconciling(deps, reconcilingOp());

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "reconciling",
    progressed: true,
  });
  const op = stateful.getOperation();
  expect(op.status_code).toBe("receipt_conflict");
  expect(op.next_retry_at).toBe(
    new Date(NOW.getTime() + 900_000).toISOString(),
  );
  expect(op.published_skill_id).toBeNull();
});

it("clears a leftover receipt_conflict status code once a matching receipt arrives", async () => {
  const stateful = statefulReconciling({ status_code: "receipt_conflict" });
  const ignatious = fakeIgnatious({
    lookup: async () => ({ outcome: "success", body: publishedLookup() }),
  });
  const deps = fakeDeps({ admin: stateful.admin, ignatious });

  const result = await advanceReconciling(
    deps,
    reconcilingOp({ status_code: "receipt_conflict" }),
  );

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "attaching",
    progressed: true,
  });
  expect(stateful.getOperation().status_code).toBeNull();
});

it("holds reconciling with receipt_conflict when the digest diverges", async () => {
  const stateful = statefulReconciling();
  const conflicting = publishedLookup({
    digest: "2222222222222222222222222222222222222222222222222222222222222222",
  });
  const ignatious = fakeIgnatious({
    lookup: async () => ({ outcome: "success", body: conflicting }),
  });
  const deps = fakeDeps({ admin: stateful.admin, ignatious });

  const result = await advanceReconciling(deps, reconcilingOp());

  expect(stateful.getOperation().status_code).toBe("receipt_conflict");
  expect(result.progressed).toBe(true);
});

it("goes back to publishing when lookup proves not_published and access still allows it", async () => {
  const stateful = statefulReconciling();
  const ignatious = fakeIgnatious({
    lookup: async () => ({
      outcome: "success",
      body: { status: "not_published" },
    }),
  });
  const deps = fakeDeps({ admin: stateful.admin, ignatious });

  const result = await advanceReconciling(deps, reconcilingOp());

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "publishing",
    progressed: true,
  });
});

it("goes back to publishing when lookup returns a prepared status and access still allows it", async () => {
  const stateful = statefulReconciling();
  const ignatious = fakeIgnatious({
    lookup: async () => ({
      outcome: "success",
      body: {
        status: "prepared",
        preparation: {
          operationId: OPERATION_ID,
          preparationId: "90000000-0000-4000-8000-000000000001",
          candidateDigest:
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          capabilityContract: {
            purpose: "p",
            expectedInput: "i",
            expectedOutput: "o",
          },
          comparisonSetDigest:
            "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          assessmentDigest:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          matches: [],
        },
      },
    }),
  });
  const deps = fakeDeps({ admin: stateful.admin, ignatious });

  const result = await advanceReconciling(deps, reconcilingOp());

  expect(result.state).toBe("publishing");
});

it("pauses reconciling when not_published is proven but access is lost", async () => {
  const stateful = statefulReconciling();
  stateful.setAuthError({ code: "P0002" });
  const ignatious = fakeIgnatious({
    lookup: async () => ({
      outcome: "success",
      body: { status: "not_published" },
    }),
  });
  const deps = fakeDeps({ admin: stateful.admin, ignatious });

  const result = await advanceReconciling(deps, reconcilingOp());

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "reconciling",
    progressed: true,
  });
  const op = stateful.getOperation();
  expect(op.status_code).toBe("access_lost");
  expect(op.next_retry_at).toBe(
    new Date(NOW.getTime() + 300_000).toISOString(),
  );
});

it("pauses reconciling when not_published is proven but the flag is off", async () => {
  const stateful = statefulReconciling();
  const ignatious = fakeIgnatious({
    lookup: async () => ({
      outcome: "success",
      body: { status: "not_published" },
    }),
  });
  const deps = fakeDeps({
    admin: stateful.admin,
    ignatious,
    isFlagEnabled: async () => false,
  });

  const result = await advanceReconciling(deps, reconcilingOp());

  expect(stateful.getOperation().status_code).toBe("feature_disabled");
  expect(result.state).toBe("reconciling");
});

it("keeps looking up on a timeout, never treating it as proof of not_published", async () => {
  const stateful = statefulReconciling();
  const ignatious = fakeIgnatious({
    lookup: async () => ({ outcome: "timeout_or_network" }),
  });
  const deps = fakeDeps({ admin: stateful.admin, ignatious });

  const result = await advanceReconciling(deps, reconcilingOp());

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "reconciling",
    progressed: true,
  });
  const op = stateful.getOperation();
  expect(op.status_code).not.toBe("candidate_invalid");
  expect(op.state).toBe("reconciling");
  expect(op.next_retry_at).toBe(new Date(NOW.getTime() + 5_000).toISOString());
});

it("keeps looking up on an invalid_response after lookup, with backoff", async () => {
  const stateful = statefulReconciling();
  const ignatious = fakeIgnatious({
    lookup: async () => ({ outcome: "invalid_response" }),
  });
  const deps = fakeDeps({ admin: stateful.admin, ignatious });

  const result = await advanceReconciling(deps, reconcilingOp());

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "reconciling",
    progressed: true,
  });
  const op = stateful.getOperation();
  expect(op.next_retry_at).toBe(new Date(NOW.getTime() + 5_000).toISOString());
});

it("keeps looking up regardless of access or flag state while the outcome is ambiguous", async () => {
  const stateful = statefulReconciling();
  stateful.setAuthError({ code: "42501" });
  const ignatious = fakeIgnatious({
    lookup: async () => ({ outcome: "timeout_or_network" }),
  });
  const deps = fakeDeps({
    admin: stateful.admin,
    ignatious,
    isFlagEnabled: async () => false,
  });

  const result = await advanceReconciling(deps, reconcilingOp());

  expect(result.state).toBe("reconciling");
  expect(ignatious.lookup).toHaveBeenCalledTimes(1);
});
