import type { SupabaseClient } from "@supabase/supabase-js";

export type BatchRow = Record<string, unknown>;

export type BatchAdminOptions = {
  rows: Record<string, BatchRow>;
  throwingReadIds?: Set<string>;
  dueIds?: string[];
};

function applyMinimalPatch(
  row: BatchRow,
  nextState: string,
  patch: Record<string, unknown>,
) {
  row.state = nextState;
  if ("nextRetryAt" in patch) row.next_retry_at = patch.nextRetryAt;
  if ("attemptCount" in patch) row.attempt_count = patch.attemptCount;
  if ("statusCode" in patch) row.status_code = patch.statusCode;
}

function transitionRpc(
  rows: Record<string, BatchRow>,
  args: Record<string, unknown>,
) {
  const id = args.p_publication_id as string;
  const row = rows[id];
  if (!row) return { data: null, error: null };
  const expectedStates = args.p_expected_states as string[];
  if (!expectedStates.includes(row.state as string)) {
    return { data: null, error: null };
  }
  applyMinimalPatch(
    row,
    args.p_next_state as string,
    args.p_patch as Record<string, unknown>,
  );
  return { data: { ...row }, error: null };
}

function buildFrom(rows: Record<string, BatchRow>) {
  return (table: string) => ({
    select: () => ({
      eq: (column: string, value: unknown) => {
        if (table === "skill_publication_operations" && column === "id") {
          const row = rows[value as string];
          return Promise.resolve({ data: row ? [row] : [], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
    }),
  });
}

function buildRpc(
  rows: Record<string, BatchRow>,
  throwingReadIds: Set<string>,
  dueIds: string[],
  calls: { fn: string; args: Record<string, unknown> }[],
) {
  return async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (fn === "skill_publication_read") {
      const id = args.p_publication_id as string;
      if (throwingReadIds.has(id)) throw new Error("boom");
      return { data: {}, error: null };
    }
    if (fn === "skill_publication_transition") return transitionRpc(rows, args);
    if (fn === "skill_publication_due") return { data: dueIds, error: null };
    return { data: null, error: null };
  };
}

export function createBatchAdmin(options: BatchAdminOptions) {
  const rows = options.rows;
  const throwingReadIds = options.throwingReadIds ?? new Set<string>();
  const dueIds = options.dueIds ?? Object.keys(rows);
  const calls: { fn: string; args: Record<string, unknown> }[] = [];

  return {
    admin: {
      from: buildFrom(rows),
      rpc: buildRpc(rows, throwingReadIds, dueIds, calls),
    } as unknown as SupabaseClient,
    calls,
    getRow: (id: string) => rows[id],
  };
}
