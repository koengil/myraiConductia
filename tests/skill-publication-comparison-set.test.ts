import { expect, it } from "vitest";
import { buildComparisonSet } from "@/lib/skillPublication/comparisonSet";
import {
  CANDIDATE_DIGEST,
  DEAL_A,
  DEFINITION_DIGEST,
  DEFINITION_TITLE,
  ENHANCED_DIGEST,
  IMPORTED_DIGEST,
  IMPORT_NAME,
  OPERATION_ID,
  OP_FAILED,
  OP_NEEDS_PLACEMENT,
  OP_PREPARING,
  OP_REMOVED,
  OP_NAME,
  PROVIDER_CANDIDATE_ID,
  PUBLISHED_DIGEST,
  SKILL_ID,
  STEP_ACTIVE,
  STEP_CATALOG,
  STEP_IMPORTED,
  STEP_LEGACY,
  STEP_REMOVED,
  VERSION_ENHANCED,
  VERSION_ID,
  VERSION_IMPORTED,
  capabilityContract,
  dealStepRow,
  fakeAdmin,
  importRow,
  manualDefinition,
  noReceiptAdmittedOperation,
  operationRow,
  skillDefinition,
  stepBindingRow,
} from "./support/comparisonSetFixtures";

it("includes an active step target bound to the version the step selects", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [dealStepRow()],
    skill_publication_operations: [operationRow()],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets).toEqual([
    {
      targetId: STEP_ACTIVE,
      state: "active",
      displayName: OP_NAME,
      capabilityContract: capabilityContract("Summarize deal status."),
      skillBinding: {
        skillId: SKILL_ID,
        versionId: VERSION_ID,
        digest: PUBLISHED_DIGEST,
      },
      candidate: null,
    },
  ]);
});

it("takes displayName from the operation name, never the step definition title", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [dealStepRow()],
    skill_publication_operations: [operationRow({ name: "Overridden Name" })],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets[0].displayName).toBe("Overridden Name");
  expect(result.targets[0].displayName).not.toBe(DEFINITION_TITLE);
});

it("marks a removed step as removed, still bound from published columns", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [
      dealStepRow({ id: STEP_REMOVED, removed_at: "2026-09-10T12:00:00.000Z" }),
    ],
    skill_publication_operations: [
      operationRow({ id: OP_REMOVED, resulting_deal_step_id: STEP_REMOVED }),
    ],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets).toHaveLength(1);
  expect(result.targets[0].state).toBe("removed");
  expect(result.targets[0].targetId).toBe(STEP_REMOVED);
});

it("refuses a skill step bound to a version this deal never recorded", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [
      dealStepRow({ id: STEP_LEGACY, definition: skillDefinition() }),
    ],
    skill_publication_operations: [],
  });

  await expect(
    buildComparisonSet(admin, { dealId: DEAL_A, operationId: OPERATION_ID }),
  ).rejects.toMatchObject({
    name: "ComparisonSetIntegrityError",
    targetId: STEP_LEGACY,
    reason: "missing_or_invalid_binding",
  });
});

it("excludes a removed step whose binding resolves to nothing, keeping the set usable", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [
      dealStepRow(),
      dealStepRow({
        id: STEP_REMOVED,
        removed_at: "2026-09-10T12:00:00.000Z",
        definition: skillDefinition({ digest: DEFINITION_DIGEST }),
      }),
    ],
    skill_publication_operations: [operationRow()],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets).toHaveLength(1);
  expect(result.targets[0].targetId).toBe(STEP_ACTIVE);
});

it("still refuses an active step with an unresolvable binding beside a removed one", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [
      dealStepRow({
        id: STEP_REMOVED,
        removed_at: "2026-09-10T12:00:00.000Z",
        definition: skillDefinition({ digest: DEFINITION_DIGEST }),
      }),
      dealStepRow({ definition: skillDefinition({ digest: DEFINITION_DIGEST }) }),
    ],
    skill_publication_operations: [operationRow()],
  });

  await expect(
    buildComparisonSet(admin, { dealId: DEAL_A, operationId: OPERATION_ID }),
  ).rejects.toMatchObject({
    name: "ComparisonSetIntegrityError",
    targetId: STEP_ACTIVE,
    reason: "missing_or_invalid_binding",
  });
});

it("resolves a valid import even when another step drifts onto the same version id", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [
      dealStepRow({
        definition: skillDefinition({
          versionId: VERSION_IMPORTED,
          digest: IMPORTED_DIGEST,
        }),
      }),
      dealStepRow({
        id: STEP_REMOVED,
        removed_at: "2026-09-10T12:00:00.000Z",
        definition: skillDefinition({
          versionId: VERSION_IMPORTED,
          digest: DEFINITION_DIGEST,
        }),
      }),
    ],
    deal_skill_imports: [importRow()],
    skill_publication_operations: [],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets).toEqual([
    {
      targetId: STEP_ACTIVE,
      state: "active",
      displayName: IMPORT_NAME,
      capabilityContract: capabilityContract("Summarize the copied deal."),
      skillBinding: {
        skillId: SKILL_ID,
        versionId: VERSION_IMPORTED,
        digest: IMPORTED_DIGEST,
      },
      candidate: null,
    },
  ]);
});

it("gives two steps on one imported version a target each", async () => {
  const copied = { versionId: VERSION_IMPORTED, digest: IMPORTED_DIGEST };
  const { admin } = fakeAdmin({
    deal_steps: [
      dealStepRow({ definition: skillDefinition(copied) }),
      dealStepRow({ id: STEP_LEGACY, definition: skillDefinition(copied) }),
    ],
    deal_skill_imports: [importRow()],
    skill_publication_operations: [],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets.map((target) => target.targetId)).toEqual([
    STEP_ACTIVE,
    STEP_LEGACY,
  ]);
  expect(result.targets.every((target) => target.displayName === IMPORT_NAME)).toBe(
    true,
  );
});

it("never lends one step's import metadata to another step on the same version id", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [
      dealStepRow({
        definition: skillDefinition({
          versionId: VERSION_IMPORTED,
          digest: DEFINITION_DIGEST,
        }),
      }),
      dealStepRow({
        id: STEP_IMPORTED,
        definition: skillDefinition({
          versionId: VERSION_IMPORTED,
          digest: IMPORTED_DIGEST,
        }),
      }),
    ],
    deal_skill_imports: [importRow()],
    skill_publication_operations: [],
  });

  await expect(
    buildComparisonSet(admin, { dealId: DEAL_A, operationId: OPERATION_ID }),
  ).rejects.toMatchObject({
    name: "ComparisonSetIntegrityError",
    targetId: STEP_ACTIVE,
    reason: "missing_or_invalid_binding",
  });
});

it("prefers the version a step is explicitly bound to over the one its definition names", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [dealStepRow()],
    deal_step_skill_bindings: [
      stepBindingRow({
        version_id: VERSION_ENHANCED,
        digest: ENHANCED_DIGEST,
      }),
    ],
    skill_publication_operations: [
      operationRow({
        id: OP_REMOVED,
        name: "Enhanced Summarizer",
        capability_contract: capabilityContract("Summarize the enhanced deal."),
        published_version_id: VERSION_ENHANCED,
        published_digest: ENHANCED_DIGEST,
      }),
      operationRow(),
    ],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets).toEqual([
    {
      targetId: STEP_ACTIVE,
      state: "active",
      displayName: "Enhanced Summarizer",
      capabilityContract: capabilityContract("Summarize the enhanced deal."),
      skillBinding: {
        skillId: SKILL_ID,
        versionId: VERSION_ENHANCED,
        digest: ENHANCED_DIGEST,
      },
      candidate: null,
    },
  ]);
});

it("includes a copied step from its import record, with no authoring operation", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [
      dealStepRow({
        id: STEP_IMPORTED,
        definition: skillDefinition({
          versionId: VERSION_IMPORTED,
          digest: IMPORTED_DIGEST,
        }),
      }),
    ],
    deal_skill_imports: [importRow()],
    skill_publication_operations: [],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets).toEqual([
    {
      targetId: STEP_IMPORTED,
      state: "active",
      displayName: IMPORT_NAME,
      capabilityContract: capabilityContract("Summarize the copied deal."),
      skillBinding: {
        skillId: SKILL_ID,
        versionId: VERSION_IMPORTED,
        digest: IMPORTED_DIGEST,
      },
      candidate: null,
    },
  ]);
});

it("includes a catalog step explicitly rebound to a project publication", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [
      dealStepRow({ id: STEP_CATALOG, definition: manualDefinition() }),
    ],
    deal_step_skill_bindings: [
      stepBindingRow({
        deal_step_id: STEP_CATALOG,
        version_id: VERSION_IMPORTED,
        digest: IMPORTED_DIGEST,
      }),
    ],
    deal_skill_imports: [importRow()],
    skill_publication_operations: [],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets).toHaveLength(1);
  expect(result.targets[0]).toMatchObject({
    targetId: STEP_CATALOG,
    state: "active",
    displayName: IMPORT_NAME,
  });
});

it("excludes a skill step rebound to a catalog mount", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [dealStepRow()],
    deal_step_skill_bindings: [
      stepBindingRow({
        kind: "mount",
        skill_id: null,
        version_id: null,
        digest: "c".repeat(64),
      }),
    ],
    skill_publication_operations: [operationRow()],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets).toEqual([]);
});

it("marks a removed copied step removed rather than dropping it", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [
      dealStepRow({
        id: STEP_IMPORTED,
        removed_at: "2026-09-20T12:00:00.000Z",
        definition: skillDefinition({
          versionId: VERSION_IMPORTED,
          digest: IMPORTED_DIGEST,
        }),
      }),
    ],
    deal_skill_imports: [importRow()],
    skill_publication_operations: [],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets).toHaveLength(1);
  expect(result.targets[0].state).toBe("removed");
});

it("ignores an import recorded against another deal", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [
      dealStepRow({
        id: STEP_IMPORTED,
        definition: skillDefinition({
          versionId: VERSION_IMPORTED,
          digest: IMPORTED_DIGEST,
        }),
      }),
    ],
    deal_skill_imports: [importRow({ deal_id: "dddddddd-0000-4000-8000-000000000009" })],
    skill_publication_operations: [],
  });

  await expect(
    buildComparisonSet(admin, { dealId: DEAL_A, operationId: OPERATION_ID }),
  ).rejects.toMatchObject({
    name: "ComparisonSetIntegrityError",
    targetId: STEP_IMPORTED,
    reason: "missing_or_invalid_binding",
  });
});

it("picks the step's own version when two published operations name the step", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [dealStepRow()],
    skill_publication_operations: [
      operationRow(),
      operationRow({
        id: OP_REMOVED,
        name: "Enhanced Summarizer",
        published_version_id: VERSION_ENHANCED,
        published_digest: ENHANCED_DIGEST,
        resulting_deal_step_id: STEP_ACTIVE,
      }),
    ],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets).toHaveLength(1);
  expect(result.targets[0].displayName).toBe(OP_NAME);
  expect(result.targets[0].skillBinding).toEqual({
    skillId: SKILL_ID,
    versionId: VERSION_ID,
    digest: PUBLISHED_DIGEST,
  });
});

it("refuses a step whose definition names a digest no publication carries", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [
      dealStepRow({ definition: skillDefinition({ digest: DEFINITION_DIGEST }) }),
    ],
    skill_publication_operations: [operationRow()],
  });

  await expect(
    buildComparisonSet(admin, { dealId: DEAL_A, operationId: OPERATION_ID }),
  ).rejects.toMatchObject({
    name: "ComparisonSetIntegrityError",
    targetId: STEP_ACTIVE,
    reason: "missing_or_invalid_binding",
  });
});

it("excludes a manual (non-skill) step definition even with an operation row", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [dealStepRow({ definition: manualDefinition() })],
    skill_publication_operations: [operationRow()],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets).toEqual([]);
});

it("includes an admitted operation with a skill binding when a receipt exists", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [],
    skill_publication_operations: [
      operationRow({
        id: OP_NEEDS_PLACEMENT,
        resulting_deal_step_id: null,
        state: "needs_placement",
      }),
    ],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets).toEqual([
    {
      targetId: OP_NEEDS_PLACEMENT,
      state: "admitted",
      displayName: OP_NAME,
      capabilityContract: capabilityContract("Summarize deal status."),
      skillBinding: {
        skillId: SKILL_ID,
        versionId: VERSION_ID,
        digest: PUBLISHED_DIGEST,
      },
      candidate: null,
    },
  ]);
});

it("includes an admitted operation with a candidate when no receipt exists", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [],
    skill_publication_operations: [
      noReceiptAdmittedOperation({ id: OP_PREPARING }),
    ],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets).toEqual([
    {
      targetId: OP_PREPARING,
      state: "admitted",
      displayName: OP_NAME,
      capabilityContract: capabilityContract("Summarize deal status."),
      skillBinding: null,
      candidate: {
        candidateId: PROVIDER_CANDIDATE_ID,
        candidateDigest: CANDIDATE_DIGEST,
      },
    },
  ]);
});

it("takes candidate.candidateId from provider_candidate_id, never candidate_id", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [],
    skill_publication_operations: [
      noReceiptAdmittedOperation({
        id: OP_PREPARING,
        candidate_id: "60000000-0000-4000-8000-000000000001",
        provider_candidate_id: "60000000-0000-4000-8000-000000000002",
      }),
    ],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets[0].candidate?.candidateId).toBe(
    "60000000-0000-4000-8000-000000000002",
  );
});

it("excludes a failed operation from the admitted set", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [],
    skill_publication_operations: [
      operationRow({
        id: OP_FAILED,
        resulting_deal_step_id: null,
        state: "failed",
      }),
    ],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets).toEqual([]);
});

it("excludes the operation being prepared from its own comparison set", async () => {
  const { admin } = fakeAdmin({
    deal_steps: [],
    skill_publication_operations: [
      operationRow({
        id: OPERATION_ID,
        resulting_deal_step_id: null,
        state: "preparing",
      }),
    ],
  });

  const result = await buildComparisonSet(admin, {
    dealId: DEAL_A,
    operationId: OPERATION_ID,
  });

  expect(result.targets).toEqual([]);
});
