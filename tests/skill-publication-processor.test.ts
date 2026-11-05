import { expect, it } from "vitest";
import { createPublicationProcessor } from "@/lib/skillPublication/processor";
import { advancePreparing } from "@/lib/skillPublication/processorPrepare";
import {
  ASSESSMENT_DIGEST,
  COMPARISON_SET_DIGEST,
  NOW,
  OPERATION_ID,
  OTHER_COMPARISON_SET_DIGEST,
  PREPARATION_ID,
  activeTarget,
  baseOperationRow,
  createStatefulAdmin,
  duplicateMatch,
  fakeDeps,
  fakeIgnatious,
  preparationReceipt,
  publicationReceipt,
} from "./support/skillPublicationProcessorFixtures";
import {
  multiRowAdmin,
  noProgressAdmin,
} from "./support/skillPublicationProcessorDriveAdmins";

const NO_OP_STATES = [
  "confirmation_required",
  "needs_placement",
  "published",
  "failed",
] as const;

it.each(NO_OP_STATES)(
  "advancePublication is a no-op on %s, returning progressed: false",
  async (state) => {
    const stateful = createStatefulAdmin({
      operation: baseOperationRow({ state }),
    });
    const deps = fakeDeps({ admin: stateful.admin });
    const processor = createPublicationProcessor(deps);

    const result = await processor.advancePublication(OPERATION_ID);

    expect(result).toEqual({
      publicationId: OPERATION_ID,
      state,
      progressed: false,
    });
  },
);

it("drives the full chain from preparing to published in one call", async () => {
  const stateful = createStatefulAdmin({
    operation: baseOperationRow({ state: "preparing" }),
    attachResponse: { data: { state: "published" }, error: null },
  });
  const ignatious = fakeIgnatious({
    prepare: async () => ({ outcome: "success", body: preparationReceipt() }),
    publish: async () => ({ outcome: "success", body: publicationReceipt() }),
  });
  const deps = fakeDeps({ admin: stateful.admin, ignatious });
  const processor = createPublicationProcessor(deps);

  const result = await processor.drivePublication(OPERATION_ID);

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "published",
    progressed: true,
  });
});

it("stops driving after one step when no progress is made", async () => {
  const admin = noProgressAdmin();
  const deps = fakeDeps({ admin });
  const processor = createPublicationProcessor(deps);

  const result = await processor.drivePublication(OPERATION_ID);

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "preparing",
    progressed: false,
  });
});

it("stops driving as soon as a retry is scheduled in the future", async () => {
  const stateful = createStatefulAdmin({
    operation: baseOperationRow({ state: "preparing" }),
  });
  const ignatious = fakeIgnatious({
    prepare: async () => ({ outcome: "timeout_or_network" }),
  });
  const deps = fakeDeps({ admin: stateful.admin, ignatious });
  const processor = createPublicationProcessor(deps);

  const result = await processor.drivePublication(OPERATION_ID);

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "preparing",
    progressed: true,
  });
  expect(ignatious.prepare).toHaveBeenCalledTimes(1);
});

it("stops driving once user action is required", async () => {
  const stateful = createStatefulAdmin({
    operation: baseOperationRow({ state: "preparing" }),
  });
  const target = activeTarget();
  const match = duplicateMatch({
    targetId: target.targetId,
    classification: "similar",
  });
  const ignatious = fakeIgnatious({
    prepare: async () => ({
      outcome: "success",
      body: preparationReceipt({ matches: [match] }),
    }),
  });
  const deps = fakeDeps({
    admin: stateful.admin,
    ignatious,
    buildComparisonSet: async () => ({
      targets: [target],
      comparisonSetDigest: COMPARISON_SET_DIGEST,
    }),
  });
  const processor = createPublicationProcessor(deps);

  const result = await processor.drivePublication(OPERATION_ID);

  expect(result.state).toBe("confirmation_required");
  expect(ignatious.prepare).toHaveBeenCalledTimes(1);
});

it("stops driving at the step cap even while state keeps changing, without ever retrying", async () => {
  const stateful = createStatefulAdmin({
    operation: baseOperationRow({ state: "preparing" }),
  });
  const ignatious = fakeIgnatious({
    prepare: async () => ({ outcome: "success", body: preparationReceipt() }),
  });
  const deps = fakeDeps({
    admin: stateful.admin,
    ignatious,
    buildComparisonSet: async () => ({
      targets: [],
      comparisonSetDigest: OTHER_COMPARISON_SET_DIGEST,
    }),
  });
  const processor = createPublicationProcessor(deps);

  const result = await processor.drivePublication(OPERATION_ID, 4);

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "preparing",
    progressed: true,
  });
  expect(ignatious.prepare).toHaveBeenCalledTimes(2);
  expect(ignatious.publish).not.toHaveBeenCalled();
  expect(stateful.getOperation().next_retry_at).toBeNull();
});

it("a publish timeout ends the drive with exactly one publish and zero lookups", async () => {
  const stateful = createStatefulAdmin({
    operation: baseOperationRow({
      state: "publishing",
      preparation_id: PREPARATION_ID,
      assessment_digest: ASSESSMENT_DIGEST,
      comparison_set_digest: COMPARISON_SET_DIGEST,
    }),
  });
  const ignatious = fakeIgnatious({
    publish: async () => ({ outcome: "timeout_or_network" }),
  });
  const deps = fakeDeps({
    admin: stateful.admin,
    ignatious,
    buildComparisonSet: async () => ({
      targets: [],
      comparisonSetDigest: COMPARISON_SET_DIGEST,
    }),
  });
  const processor = createPublicationProcessor(deps);

  const result = await processor.drivePublication(OPERATION_ID);

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "reconciling",
    progressed: true,
  });
  expect(ignatious.publish).toHaveBeenCalledTimes(1);
  expect(ignatious.lookup).not.toHaveBeenCalled();
});

it("a row whose next_retry_at is in the future makes no remote call", async () => {
  const futureRetry = new Date(NOW.getTime() + 60_000).toISOString();
  const stateful = createStatefulAdmin({
    operation: baseOperationRow({
      state: "preparing",
      next_retry_at: futureRetry,
    }),
  });
  const ignatious = fakeIgnatious({});
  const deps = fakeDeps({ admin: stateful.admin, ignatious });
  const processor = createPublicationProcessor(deps);

  const result = await processor.drivePublication(OPERATION_ID);

  expect(result).toEqual({
    publicationId: OPERATION_ID,
    state: "preparing",
    progressed: false,
  });
  expect(ignatious.prepare).not.toHaveBeenCalled();
  expect(ignatious.publish).not.toHaveBeenCalled();
  expect(ignatious.lookup).not.toHaveBeenCalled();
});

it("processDuePublications drives each due id, in the order returned, up to the limit", async () => {
  const idA = "10000000-0000-4000-8000-0000000000a1";
  const idB = "10000000-0000-4000-8000-0000000000b2";
  const admin = multiRowAdmin([idA, idB], [idA, idB]);
  const deps = fakeDeps({ admin });
  const processor = createPublicationProcessor(deps);

  const results = await processor.processDuePublications(5);

  expect(results).toEqual([
    { publicationId: idA, state: "published", progressed: false },
    { publicationId: idB, state: "published", progressed: false },
  ]);
});

it("processDuePublications forwards the requested limit to skill_publication_due", async () => {
  const admin = multiRowAdmin([], []);
  const calls = (
    admin as unknown as {
      __calls: { fn: string; args: Record<string, unknown> }[];
    }
  ).__calls;
  const deps = fakeDeps({ admin });
  const processor = createPublicationProcessor(deps);

  await processor.processDuePublications(7);

  expect(calls).toEqual([
    { fn: "skill_publication_due", args: { p_limit: 7 } },
  ]);
});

it("a losing processor's stale predicate write returns progressed: false, without corrupting the winner's state", async () => {
  const stateful = createStatefulAdmin({
    operation: baseOperationRow({ state: "preparing" }),
  });
  const staleSnapshot = baseOperationRow({ state: "preparing" });
  const ignatiousA = fakeIgnatious({
    prepare: async () => ({ outcome: "success", body: preparationReceipt() }),
  });
  const depsA = fakeDeps({ admin: stateful.admin, ignatious: ignatiousA });

  const resultA =
    await createPublicationProcessor(depsA).advancePublication(OPERATION_ID);
  expect(resultA).toEqual({
    publicationId: OPERATION_ID,
    state: "publishing",
    progressed: true,
  });

  const ignatiousB = fakeIgnatious({
    prepare: async () => ({ outcome: "success", body: preparationReceipt() }),
  });
  const depsB = fakeDeps({ admin: stateful.admin, ignatious: ignatiousB });
  const resultB = await advancePreparing(depsB, staleSnapshot);

  expect(resultB).toEqual({
    publicationId: OPERATION_ID,
    state: "preparing",
    progressed: false,
  });
  expect(stateful.getOperation().state).toBe("publishing");
});
