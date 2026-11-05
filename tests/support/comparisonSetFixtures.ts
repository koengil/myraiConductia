import { vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

export const DEAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const DEAL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const OPERATION_ID = "10000000-0000-4000-8000-000000000001";

export const STEP_ACTIVE = "20000000-0000-4000-8000-000000000001";
export const STEP_REMOVED = "20000000-0000-4000-8000-000000000002";
export const STEP_LEGACY = "20000000-0000-4000-8000-000000000003";
export const STEP_OTHER_DEAL = "20000000-0000-4000-8000-000000000004";
export const STEP_IMPORTED = "20000000-0000-4000-8000-000000000005";
export const STEP_CATALOG = "20000000-0000-4000-8000-000000000006";

export const OP_ACTIVE = "30000000-0000-4000-8000-000000000001";
export const OP_REMOVED = "30000000-0000-4000-8000-000000000002";
export const OP_NEEDS_PLACEMENT = "30000000-0000-4000-8000-000000000003";
export const OP_PREPARING = "30000000-0000-4000-8000-000000000004";
export const OP_FAILED = "30000000-0000-4000-8000-000000000005";
export const OP_OTHER_DEAL = "30000000-0000-4000-8000-000000000006";
export const OP_OTHER_DEAL_ADMITTED = "30000000-0000-4000-8000-000000000007";

export const SKILL_ID = "40000000-0000-4000-8000-000000000001";
export const VERSION_ID = "40000000-0000-4000-8000-000000000002";
export const VERSION_ENHANCED = "40000000-0000-4000-8000-000000000003";
export const VERSION_IMPORTED = "40000000-0000-4000-8000-000000000004";
export const IMPORTER_ID = "50000000-0000-4000-8000-000000000003";
export const CANDIDATE_ID = "50000000-0000-4000-8000-000000000001";
export const PROVIDER_CANDIDATE_ID = "50000000-0000-4000-8000-000000000002";

export const PUBLISHED_DIGEST =
  "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
export const CANDIDATE_DIGEST =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
export const DEFINITION_DIGEST =
  "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const ENHANCED_DIGEST =
  "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
export const IMPORTED_DIGEST =
  "abababababababababababababababababababababababababababababababab";

export const OP_NAME = "Deal Summarizer Operation";
export const IMPORT_NAME = "Copied Deal Summarizer";
export const DEFINITION_TITLE = "Deal Summarizer Draft";

export function capabilityContract(purpose: string) {
  return {
    purpose,
    expectedInput: "A reporting period.",
    expectedOutput: "A concise update.",
  };
}

export function skillDefinition(
  binding: Partial<{ skillId: string; versionId: string; digest: string }> = {},
) {
  return {
    schemaVersion: 1,
    type: "skill",
    title: DEFINITION_TITLE,
    description: "Summarizes the deal.",
    inputs: [
      {
        key: "primary",
        kind: "text",
        label: "Input",
        helperText: "A period.",
        required: true,
      },
    ],
    skillBinding: {
      skillId: SKILL_ID,
      versionId: VERSION_ID,
      digest: PUBLISHED_DIGEST,
      ...binding,
    },
  };
}

export function manualDefinition() {
  return { title: "Manual step", description: "Not skill-backed." };
}

export type FakeRow = Record<string, unknown>;

export function fakeAdmin(tables: Record<string, FakeRow[]>) {
  const eqCalls: { table: string; column: string; value: unknown }[] = [];
  const from = vi.fn((table: string) => {
    let rows = tables[table] ?? [];
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn((column: string, value: unknown) => {
        eqCalls.push({ table, column, value });
        rows = rows.filter((row) => row[column] === value);
        return builder;
      }),
      in: vi.fn((column: string, values: unknown[]) => {
        rows = rows.filter((row) => values.includes(row[column]));
        return builder;
      }),
      then: (resolve: (value: unknown) => void) =>
        resolve({ data: rows, error: null }),
    };
    return builder;
  });
  return { admin: { from } as unknown as SupabaseClient, eqCalls };
}

export function dealStepRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: STEP_ACTIVE,
    deal_id: DEAL_A,
    definition: skillDefinition(),
    removed_at: null,
    ...overrides,
  };
}

export function stepBindingRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    deal_step_id: STEP_ACTIVE,
    deal_id: DEAL_A,
    kind: "publication",
    skill_id: SKILL_ID,
    version_id: VERSION_ID,
    digest: PUBLISHED_DIGEST,
    ...overrides,
  };
}

export function importRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    skill_id: SKILL_ID,
    deal_id: DEAL_A,
    version_id: VERSION_IMPORTED,
    digest: IMPORTED_DIGEST,
    name: IMPORT_NAME,
    capability_contract: capabilityContract("Summarize the copied deal."),
    imported_by: IMPORTER_ID,
    created_at: "2026-09-20T09:00:00.000Z",
    ...overrides,
  };
}

export function operationRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: OP_ACTIVE,
    deal_id: DEAL_A,
    name: OP_NAME,
    capability_contract: capabilityContract("Summarize deal status."),
    candidate_id: CANDIDATE_ID,
    provider_candidate_id: PROVIDER_CANDIDATE_ID,
    candidate_digest: CANDIDATE_DIGEST,
    published_skill_id: SKILL_ID,
    published_version_id: VERSION_ID,
    published_digest: PUBLISHED_DIGEST,
    resulting_deal_step_id: STEP_ACTIVE,
    state: "published",
    ...overrides,
  };
}

export function noReceiptAdmittedOperation(
  overrides: Partial<FakeRow> = {},
): FakeRow {
  return operationRow({
    resulting_deal_step_id: null,
    state: "preparing",
    published_skill_id: null,
    published_version_id: null,
    published_digest: null,
    ...overrides,
  });
}

export function isolationFixtures() {
  const withOtherDeal = fakeAdmin({
    deal_steps: [
      dealStepRow(),
      dealStepRow({ id: STEP_OTHER_DEAL, deal_id: DEAL_B }),
    ],
    skill_publication_operations: [
      operationRow(),
      operationRow({
        id: OP_OTHER_DEAL,
        deal_id: DEAL_B,
        resulting_deal_step_id: STEP_OTHER_DEAL,
      }),
      noReceiptAdmittedOperation({
        id: OP_OTHER_DEAL_ADMITTED,
        deal_id: DEAL_B,
      }),
    ],
  });
  const withoutOtherDeal = fakeAdmin({
    deal_steps: [dealStepRow()],
    skill_publication_operations: [operationRow()],
  });
  return { withOtherDeal, withoutOtherDeal };
}

export function orderIndependenceFixtures() {
  const otherOperation = () =>
    operationRow({
      id: OP_NEEDS_PLACEMENT,
      resulting_deal_step_id: null,
      state: "needs_placement",
    });
  const forward = fakeAdmin({
    deal_steps: [dealStepRow()],
    skill_publication_operations: [operationRow(), otherOperation()],
  });
  const reversed = fakeAdmin({
    deal_steps: [dealStepRow()],
    skill_publication_operations: [otherOperation(), operationRow()],
  });
  return { forward, reversed };
}
