import { afterEach, expect, it, vi } from "vitest";
import { createPublicationProcessor } from "@/lib/skillPublication/processor";
import {
  NOW,
  baseOperationRow,
  fakeDeps,
} from "./support/skillPublicationProcessorFixtures";
import { createBatchAdmin } from "./support/skillPublicationProcessorBatchAdmin";

const ID_1 = "10000000-0000-4000-8000-0000000000a1";
const ID_2 = "10000000-0000-4000-8000-0000000000a2";
const ID_3 = "10000000-0000-4000-8000-0000000000a3";

afterEach(() => {
  vi.restoreAllMocks();
});

it("rejects a due list that is not an array of strings", async () => {
  const admin = createBatchAdmin({ rows: {}, dueIds: [] });
  admin.admin.rpc = (async (fn: string) => {
    if (fn === "skill_publication_due")
      return { data: [1, "abc"], error: null };
    return { data: null, error: null };
  }) as never;
  const deps = fakeDeps({ admin: admin.admin });
  const processor = createPublicationProcessor(deps);

  await expect(processor.processDuePublications()).rejects.toThrow();
});

function threeRowBatch() {
  return createBatchAdmin({
    rows: {
      [ID_1]: baseOperationRow({
        id: ID_1,
        state: "preparing",
      }) as unknown as Record<string, unknown>,
      [ID_2]: baseOperationRow({
        id: ID_2,
        state: "published",
      }) as unknown as Record<string, unknown>,
      [ID_3]: baseOperationRow({
        id: ID_3,
        state: "confirmation_required",
      }) as unknown as Record<string, unknown>,
    },
    throwingReadIds: new Set([ID_1]),
    dueIds: [ID_1, ID_2, ID_3],
  });
}

it("still drives rows 2 and 3 when row 1 throws", async () => {
  const batch = threeRowBatch();
  const deps = fakeDeps({ admin: batch.admin });
  const processor = createPublicationProcessor(deps);

  const results = await processor.processDuePublications();

  expect(results).toEqual([
    { publicationId: ID_1, state: "preparing", progressed: false },
    { publicationId: ID_2, state: "published", progressed: false },
    { publicationId: ID_3, state: "confirmation_required", progressed: false },
  ]);
});

it("gives the throwing row a 300s retry when its state was known, without incrementing attempt_count", async () => {
  const batch = threeRowBatch();
  const deps = fakeDeps({ admin: batch.admin });
  const processor = createPublicationProcessor(deps);

  await processor.processDuePublications();

  const row = batch.getRow(ID_1);
  expect(row.next_retry_at).toBe(
    new Date(NOW.getTime() + 300_000).toISOString(),
  );
  expect(row.attempt_count).toBe(0);
});

it("logs only safe fields for a row that throws", async () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const batch = threeRowBatch();
  const deps = fakeDeps({ admin: batch.admin });
  const processor = createPublicationProcessor(deps);

  await processor.processDuePublications();

  const loggedLines = logSpy.mock.calls.map((call) =>
    JSON.parse(call[0] as string),
  );
  const errorLog = loggedLines.find(
    (line) => line.reasonCode === "processor_error",
  );
  expect(errorLog).toEqual({
    publicationId: ID_1,
    state: "preparing",
    reasonCode: "processor_error",
    correlationId: expect.any(String),
  });
});
