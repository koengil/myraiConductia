import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code?: string; message: string } | null };

export type FakeAdmin = {
  admin: SupabaseClient;
  tables: Record<string, Row[]>;
  failInsertsInto: Set<string>;
  failReadsFrom: Set<string>;
};

const CLOCK_START = Date.parse('2026-10-13T10:00:00.000Z');

export function fakeAdmin(seed: Record<string, Row[]> = {}): FakeAdmin {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  const failInsertsInto = new Set<string>();
  const failReadsFrom = new Set<string>();
  let ticks = 0;

  function insertInto(table: string, row: Row): Result {
    if (failInsertsInto.has(table)) return { data: null, error: { code: 'XX000', message: 'insert refused' } };
    const rows = (tables[table] ??= []);
    if (row.id !== undefined && rows.some((existing) => existing.id === row.id)) {
      return { data: null, error: { code: '23505', message: 'duplicate key' } };
    }
    if (
      table === 'deal_step_skill_runs' &&
      row.outcome === 'succeeded' &&
      row.parent_run_id &&
      rows.some(
        (existing) =>
          existing.parent_run_id === row.parent_run_id && existing.outcome === 'succeeded',
      )
    ) {
      return { data: null, error: { code: '23505', message: 'one revision per parent' } };
    }
    ticks += 1;
    const stored = { created_at: new Date(CLOCK_START + ticks * 1000).toISOString(), ...row };
    rows.push(stored);
    return { data: stored, error: null };
  }

  function from(table: string) {
    let rows = [...(tables[table] ?? [])];
    let inserted: Result | null = null;
    const readFailure = (shape: 'one' | 'many'): Result | null =>
      failReadsFrom.has(table) || failReadsFrom.has(`${table}:${shape}`)
        ? { data: null, error: { code: '57014', message: 'read refused' } }
        : null;
    const settle = (): Result => inserted ?? readFailure('many') ?? { data: rows, error: null };
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] === value);
        return builder;
      },
      neq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] !== value);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        rows = rows.filter((row) => values.includes(row[column]));
        return builder;
      },
      order: (column: string, options: { ascending: boolean }) => {
        rows = [...rows].sort((a, b) => {
          const left = String(a[column]);
          const right = String(b[column]);
          return options.ascending ? left.localeCompare(right) : right.localeCompare(left);
        });
        return builder;
      },
      limit: (count: number) => {
        rows = rows.slice(0, count);
        return builder;
      },
      insert: (row: Row) => {
        inserted = insertInto(table, row);
        return builder;
      },
      maybeSingle: async (): Promise<Result> =>
        inserted ?? readFailure('one') ?? { data: rows[0] ?? null, error: null },
      single: async (): Promise<Result> =>
        inserted ??
        readFailure('one') ?? { data: rows[0] ?? null, error: rows[0] ? null : { message: 'no rows' } },
      then: (resolve: (value: Result) => unknown) => Promise.resolve(settle()).then(resolve),
    };
    return builder;
  }

  async function rpc(name: string, args: { p_run: Row; p_audit: Row }): Promise<Result> {
    if (name !== 'record_skill_run_revision') {
      return { data: null, error: { code: '42883', message: `unknown function ${name}` } };
    }
    const run = insertInto('deal_step_skill_runs', args.p_run);
    if (run.error) return run;
    const audit = insertInto('audit_log', {
      actor_id: args.p_run.actor_id,
      action: 'create',
      deal_id: args.p_run.deal_id,
      detail: args.p_audit,
    });
    if (audit.error) {
      tables.deal_step_skill_runs = tables.deal_step_skill_runs.filter((row) => row.id !== args.p_run.id);
      return audit;
    }
    return { data: null, error: null };
  }

  return { admin: { from, rpc } as unknown as SupabaseClient, tables, failInsertsInto, failReadsFrom };
}
