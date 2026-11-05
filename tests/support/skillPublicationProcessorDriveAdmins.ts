import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CANDIDATE_NAME,
  TENANT_ID,
  baseOperationRow,
} from "./skillPublicationProcessorFixtures";

function noProgressSelectEq(
  opRow: Record<string, unknown>,
  table: string,
  column: string,
  value: unknown,
) {
  if (table === "skill_publication_operations") {
    return Promise.resolve({
      data: opRow[column] === value ? [opRow] : [],
      error: null,
    });
  }
  if (table === "deals") {
    return Promise.resolve({ data: [{ tenant_id: TENANT_ID }], error: null });
  }
  if (table === "skill_authoring_candidates") {
    return Promise.resolve({
      data: [{ preview: { name: CANDIDATE_NAME } }],
      error: null,
    });
  }
  return Promise.resolve({ data: [], error: null });
}

export function noProgressAdmin(): SupabaseClient {
  const opRow = baseOperationRow({
    state: "preparing",
  }) as unknown as Record<string, unknown>;
  const from = (table: string) => ({
    select: () => ({
      eq: (column: string, value: unknown) =>
        noProgressSelectEq(opRow, table, column, value),
    }),
  });
  const rpc = async (fn: string) => {
    if (fn === "skill_publication_read") return { data: {}, error: null };
    return { data: null, error: null };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

function multiRowSelectEq(
  rows: Record<string, Record<string, unknown>>,
  table: string,
  column: string,
  value: unknown,
) {
  if (table === "skill_publication_operations" && column === "id") {
    const row = rows[value as string];
    return Promise.resolve({ data: row ? [row] : [], error: null });
  }
  return Promise.resolve({ data: [], error: null });
}

export function multiRowAdmin(
  publishedIds: string[],
  dueIds: string[],
): SupabaseClient {
  const rows: Record<string, Record<string, unknown>> = {};
  for (const id of publishedIds)
    rows[id] = baseOperationRow({ id, state: "published" });
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const from = (table: string) => ({
    select: () => ({
      eq: (column: string, value: unknown) =>
        multiRowSelectEq(rows, table, column, value),
    }),
  });
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (fn === "skill_publication_due") return { data: dueIds, error: null };
    return { data: null, error: null };
  };
  return { from, rpc, __calls: calls } as unknown as SupabaseClient;
}
