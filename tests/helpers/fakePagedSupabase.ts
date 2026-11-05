import type { SupabaseClient } from '@supabase/supabase-js';

// A fake Supabase client that pages the way PostgREST does: a response holds at most `cap` rows (max_rows, 1000 by
// default), `order(col)` sorts, `gt(col, v)` keeps the rows after a keyset, `in(col, values)` keeps the rows whose
// column is one of them (a row without the column passes), and `limit` and `range` cut the window. Every other
// filter is a no-op: each table answers its fixed rows (the rows RLS or the service role would see).
// An RPC answers through `rpc(name, args)`, and its rows are cut by `range` and the cap the same way.

type Answer = { data: unknown; error: { code?: string; message?: string } | null };

export type PagedFake = {
  db: SupabaseClient;
  /** Each RPC call in order, with its arguments. */
  rpcs: Array<{ name: string; args: Record<string, unknown> }>;
  /** How many reads each table answered. */
  reads: Map<string, number>;
};

export function fakePagedSupabase(
  tables: Record<string, unknown[]>,
  rpc: (name: string, args: Record<string, unknown>) => Answer = () => ({ data: [], error: null }),
  opts: { cap?: number } = {},
): PagedFake {
  const cap = opts.cap ?? 1000;
  const rpcs: PagedFake['rpcs'] = [];
  const reads = new Map<string, number>();

  type State = { sort?: string; after?: [string, string]; within?: Array<[string, Set<unknown>]>; limit?: number; range?: [number, number] };
  function window(rows: unknown[], state: State) {
    let out = [...rows] as Array<Record<string, unknown>>;
    for (const [k, values] of state.within ?? []) out = out.filter((r) => !(k in r) || values.has(r[k]));
    if (state.sort) {
      const k = state.sort;
      out.sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : String(a[k]) > String(b[k]) ? 1 : 0));
    }
    if (state.after) {
      const [k, v] = state.after;
      out = out.filter((r) => String(r[k]) > v);
    }
    if (state.range) out = out.slice(state.range[0], state.range[1] + 1);
    if (state.limit !== undefined) out = out.slice(0, state.limit);
    return out.slice(0, cap);
  }

  const from = (table: string) => {
    const state: State = {};
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'not', 'or', 'is', 'contains']) builder[m] = () => builder;
    builder.in = (col: string, values: unknown[]) => {
      (state.within ??= []).push([col, new Set(values)]);
      return builder;
    };
    builder.order = (col: string) => {
      state.sort ??= col;
      return builder;
    };
    builder.gt = (col: string, v: string) => {
      state.after = [col, v];
      return builder;
    };
    builder.limit = (n: number) => {
      state.limit = n;
      return builder;
    };
    builder.range = (a: number, b: number) => {
      state.range = [a, b];
      return builder;
    };
    builder.delete = () => ({ in: async () => ({ error: null }) });
    builder.maybeSingle = async () => ({ data: window(tables[table] ?? [], state)[0] ?? null, error: null });
    builder.then = (resolve: (v: unknown) => void) => {
      reads.set(table, (reads.get(table) ?? 0) + 1);
      resolve({ data: window(tables[table] ?? [], state), error: null });
    };
    return builder;
  };

  const callRpc = (name: string, args: Record<string, unknown>) => {
    rpcs.push({ name, args });
    const state: { range?: [number, number] } = {};
    const builder: Record<string, unknown> = {};
    builder.order = () => builder;
    builder.range = (a: number, b: number) => {
      state.range = [a, b];
      return builder;
    };
    builder.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
      try {
        const answer = rpc(name, args);
        resolve(Array.isArray(answer.data) ? { ...answer, data: window(answer.data, state) } : answer);
      } catch (e) {
        reject?.(e);
      }
    };
    return builder;
  };

  return { db: { from, rpc: callRpc } as unknown as SupabaseClient, rpcs, reads };
}
