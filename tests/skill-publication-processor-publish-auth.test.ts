import { expect, it } from "vitest";
import { advancePublishing } from "@/lib/skillPublication/processorPublish";
import {
  COMPARISON_SET_DIGEST,
  baseOperationRow,
  createStatefulAdmin,
  fakeDeps,
  fakeIgnatious,
  publicationReceipt,
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

const publishingOp = (overrides = {}) =>
  baseOperationRow({
    state: "publishing",
    comparison_set_digest: COMPARISON_SET_DIGEST,
    preparation_id: "90000000-0000-4000-8000-000000000001",
    assessment_digest:
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    ...overrides,
  });

it("pauses with access_lost when author access is lost before publish, never calling publish", async () => {
  const stateful = statefulPublishing();
  stateful.setAuthError({ code: "42501" });
  const ignatious = fakeIgnatious({});
  const deps = fakeDeps({ admin: stateful.admin, ignatious });

  const result = await advancePublishing(deps, publishingOp());

  expect(result.progressed).toBe(true);
  expect(stateful.getOperation().status_code).toBe("access_lost");
  expect(ignatious.publish).not.toHaveBeenCalled();
});

it("pauses with feature_disabled before publish when the flag is off, never calling publish", async () => {
  const stateful = statefulPublishing();
  const ignatious = fakeIgnatious({});
  const deps = fakeDeps({
    admin: stateful.admin,
    ignatious,
    isFlagEnabled: async () => false,
  });

  await advancePublishing(deps, publishingOp());

  expect(stateful.getOperation().status_code).toBe("feature_disabled");
  expect(ignatious.publish).not.toHaveBeenCalled();
});

it("calls skill_publication_read immediately before publish, with no transition in between", async () => {
  const stateful = statefulPublishing();
  const ignatious = fakeIgnatious({
    publish: async () => {
      stateful.calls.push({ fn: "ignatious.publish", args: {} });
      return { outcome: "success", body: publicationReceipt() };
    },
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

  const callOrder = stateful.calls.map((call) => call.fn);
  const readIndex = callOrder.indexOf("skill_publication_read");
  const publishIndex = callOrder.indexOf("ignatious.publish");
  expect(readIndex).toBeGreaterThanOrEqual(0);
  expect(publishIndex).toBe(readIndex + 1);
});
