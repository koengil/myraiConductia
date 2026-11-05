// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { candidateOrigin, candidateOrigins, dealOrigin, latestModelProposal } from '@/lib/discovery/origin';

// The latest-proposal read runs over a fake client that applies eq and in filters to fixed rows. The origin reads go
// through the two definers of 20261023140400_discovery_origin_read.sql (supabase/tests/discovery_model_proposal_accepts.sql
// runs them for real); here they are a fake rpc, and the client refuses every table read, so the origin can never come
// from the candidate rows the caller's RLS shows.

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

type Query = { table: string; limit?: number; eq: Array<[string, unknown]> };

function fakeDb(tables: Tables, failOn?: string, log?: Query[]): SupabaseClient {
  const from = (table: string) => {
    const query: Query = { table, eq: [] };
    log?.push(query);
    const filters: Array<(row: Row) => boolean> = [];
    const order: Array<[string, boolean]> = [];
    let max = Infinity;
    const run = () => {
      if (failOn === table) return { data: null, error: { message: 'boom' } };
      const rows = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
      for (const [column, ascending] of [...order].reverse()) {
        rows.sort((a, b) => (String(a[column] ?? '') < String(b[column] ?? '') ? -1 : String(a[column] ?? '') > String(b[column] ?? '') ? 1 : 0) * (ascending ? 1 : -1));
      }
      return { data: rows.slice(0, max), error: null };
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => (query.eq.push([column, value]), filters.push((row) => row[column] === value), builder),
      in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
      order: (column: string, options?: { ascending?: boolean }) => (order.push([column, options?.ascending !== false]), builder),
      limit: (n: number) => ((max = n), (query.limit = n), builder),
      then: (resolve: (value: unknown) => void) => resolve(run()),
    };
    return builder;
  };
  return { from } as unknown as SupabaseClient;
}

type RpcAnswer = { data: unknown; error: { message: string } | null };

/** A client whose only readable thing is the two origin definers; any table read throws. */
function rpcDb(handlers: {
  candidate_origins?: (ids: string[]) => RpcAnswer;
  deal_origin?: (dealId: string) => RpcAnswer;
}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === 'discovery_candidate_origins' && handlers.candidate_origins) {
      return handlers.candidate_origins(args.p_candidate_ids as string[]);
    }
    if (name === 'discovery_deal_origin' && handlers.deal_origin) return handlers.deal_origin(args.p_deal_id as string);
    throw new Error(`unexpected rpc ${name}`);
  };
  const from = (table: string) => {
    throw new Error(`origin must be read through the definers, not from ${table}`);
  };
  return { db: { rpc, from } as unknown as SupabaseClient, calls };
}

const answers = (...rows: Array<[string, unknown]>): RpcAnswer => ({
  data: rows.map(([candidate_id, origin]) => ({ candidate_id, origin })),
  error: null,
});
const MODEL_KEY = 'model:u:3f0c1f0e-5a4b-4f57-9d8e-0c1f2a3b4c5d:project-kestrel';

describe('candidateOrigins', () => {
  it('asks the definer once for the distinct ids and answers each', async () => {
    const { db, calls } = rpcDb({ candidate_origins: () => answers(['a', 'rules'], ['b', 'model_proposal']) });
    const result = await candidateOrigins(db, ['a', 'b', 'a']);
    expect(result).toEqual({ ok: true, origins: new Map([['a', 'rules'], ['b', 'model_proposal']]) });
    expect(calls).toEqual([{ name: 'discovery_candidate_origins', args: { p_candidate_ids: ['a', 'b'] } }]);
  });

  it('asks nothing for an empty list', async () => {
    const { db, calls } = rpcDb({});
    expect(await candidateOrigins(db, [])).toEqual({ ok: true, origins: new Map() });
    expect(calls).toEqual([]);
  });

  it('asks in chunks of 200, the most the definer takes', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `c${i}`);
    const { db, calls } = rpcDb({ candidate_origins: (asked) => answers(...asked.map((id): [string, unknown] => [id, 'rules'])) });
    const result = await candidateOrigins(db, ids);
    expect(calls.map((c) => (c.args.p_candidate_ids as string[]).length)).toEqual([200, 200, 50]);
    expect(result.ok && result.origins.size).toBe(450);
  });

  it('marks a candidate the definer gave no row for as unknown, never rules', async () => {
    const { db } = rpcDb({ candidate_origins: () => answers(['a', 'rules']) });
    const result = await candidateOrigins(db, ['a', 'b']);
    expect(result).toEqual({ ok: true, origins: new Map([['a', 'rules'], ['b', 'unknown']]) });
  });

  it('marks an answer that is not one of the two words as unknown, and ignores a row for an id it was not asked about', async () => {
    const { db } = rpcDb({ candidate_origins: () => answers(['a', 'maybe'], ['b', null], ['z', 'model_proposal']) });
    const result = await candidateOrigins(db, ['a', 'b']);
    expect(result).toEqual({ ok: true, origins: new Map([['a', 'unknown'], ['b', 'unknown']]) });
  });

  it('fails the whole read when a call fails, instead of answering rules for the rest', async () => {
    const { db } = rpcDb({ candidate_origins: () => ({ data: null, error: { message: 'boom' } }) });
    expect(await candidateOrigins(db, ['a'])).toEqual({ ok: false, error: 'boom' });
  });

  it('fails when a later chunk fails', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `c${i}`);
    let n = 0;
    const { db } = rpcDb({
      candidate_origins: (asked) =>
        ++n === 2 ? { data: null, error: { message: 'second chunk' } } : answers(...asked.map((id): [string, unknown] => [id, 'rules'])),
    });
    expect(await candidateOrigins(db, ids)).toEqual({ ok: false, error: 'second chunk' });
  });
});

describe('candidateOrigin', () => {
  it('is rules only when the database says rules', async () => {
    const { db } = rpcDb({ candidate_origins: () => answers(['c1', 'rules']) });
    expect(await candidateOrigin(db, 'c1')).toEqual({ ok: true, origin: 'rules' });
  });

  it('is model_proposal when the database says so, with no table read of the candidate rows', async () => {
    const { db, calls } = rpcDb({ candidate_origins: () => answers(['c1', 'model_proposal']) });
    expect(await candidateOrigin(db, 'c1')).toEqual({ ok: true, origin: 'model_proposal' });
    expect(calls).toEqual([{ name: 'discovery_candidate_origins', args: { p_candidate_ids: ['c1'] } }]);
  });

  it('is model_proposal for a deal member who is not the finder: the answer does not depend on what the caller reads', async () => {
    // The caller sees none of the candidate rows (from() throws), as a member whose RLS hides the finder's model candidate.
    const { db } = rpcDb({ candidate_origins: () => answers(['promoted', 'model_proposal']) });
    expect(await candidateOrigin(db, 'promoted')).toEqual({ ok: true, origin: 'model_proposal' });
  });

  it('gives the survivor of a merge the same answer to a viewer who sees the model candidate and one who sees only the survivor', async () => {
    // The definer follows the merges without RLS, so both viewers are told model_proposal for the survivor.
    const viewerA = rpcDb({ candidate_origins: (ids) => answers(...ids.map((id): [string, unknown] => [id, 'model_proposal'])) });
    const viewerB = rpcDb({ candidate_origins: (ids) => answers(...ids.map((id): [string, unknown] => [id, 'model_proposal'])) });
    expect(await candidateOrigin(viewerA.db, 'survivor')).toEqual({ ok: true, origin: 'model_proposal' });
    expect(await candidateOrigin(viewerB.db, 'survivor')).toEqual({ ok: true, origin: 'model_proposal' });
  });

  it('fails closed on a candidate the database would not answer for: an error, never rules', async () => {
    const { db } = rpcDb({ candidate_origins: () => answers() });
    const result = await candidateOrigin(db, 'c1');
    expect(result).toEqual({ ok: false, error: 'origin_unavailable' });
    expect(result).not.toMatchObject({ origin: 'rules' });
  });

  it('fails closed on a failed call, a null answer and an unknown word', async () => {
    expect(await candidateOrigin(rpcDb({ candidate_origins: () => ({ data: null, error: { message: 'boom' } }) }).db, 'c1')).toEqual({
      ok: false,
      error: 'boom',
    });
    expect(await candidateOrigin(rpcDb({ candidate_origins: () => ({ data: null, error: null }) }).db, 'c1')).toEqual({
      ok: false,
      error: 'origin_unavailable',
    });
    expect(await candidateOrigin(rpcDb({ candidate_origins: () => answers(['c1', 'unknown']) }).db, 'c1')).toEqual({
      ok: false,
      error: 'origin_unavailable',
    });
  });

  it('never carries a cluster key, even if a row held one', async () => {
    const { db } = rpcDb({
      candidate_origins: () => ({
        data: [{ candidate_id: 'c1', origin: 'model_proposal', cluster_key: MODEL_KEY }],
        error: null,
      }),
    });
    const result = await candidateOrigin(db, 'c1');
    expect(result).toEqual({ ok: true, origin: 'model_proposal' });
    expect(JSON.stringify(result)).not.toContain('model:u:');
    const batch = await candidateOrigins(db, ['c1']);
    expect(JSON.stringify([...(batch.ok ? batch.origins : [])])).not.toContain('model:u:');
  });
});

describe('dealOrigin', () => {
  it('is rules for a deal the database says is rules, asking for that deal only', async () => {
    const { db, calls } = rpcDb({ deal_origin: () => ({ data: 'rules', error: null }) });
    expect(await dealOrigin(db, 'd1')).toEqual({ ok: true, origin: 'rules' });
    expect(calls).toEqual([{ name: 'discovery_deal_origin', args: { p_deal_id: 'd1' } }]);
  });

  it('is model_proposal for a deal member or overseer who is not the finder, with no table read', async () => {
    const { db } = rpcDb({ deal_origin: () => ({ data: 'model_proposal', error: null }) });
    expect(await dealOrigin(db, 'd1')).toEqual({ ok: true, origin: 'model_proposal' });
  });

  it('fails closed when the database would not answer (null), answers an unknown word, or the call fails', async () => {
    expect(await dealOrigin(rpcDb({ deal_origin: () => ({ data: null, error: null }) }).db, 'd1')).toEqual({
      ok: false,
      error: 'origin_unavailable',
    });
    expect(await dealOrigin(rpcDb({ deal_origin: () => ({ data: 'unknown', error: null }) }).db, 'd1')).toEqual({
      ok: false,
      error: 'origin_unavailable',
    });
    expect(await dealOrigin(rpcDb({ deal_origin: () => ({ data: null, error: { message: 'boom' } }) }).db, 'd1')).toEqual({
      ok: false,
      error: 'boom',
    });
  });
});

describe('latestModelProposal', () => {
  const accept = (over: Row): Row => ({
    id: 'r1',
    operation_id: 'op1',
    candidate_id: 'c1',
    state: 'done',
    proposed_step_id: 'p3-s39',
    proposed_phase: 'phase-3',
    placed_count: 3,
    email_count: 4,
    finished_at: '2026-10-23T10:00:00Z',
    ...over,
  });
  const tables = (...rows: Row[]): Tables => ({ discovery_model_proposal_accepts: rows });

  it('answers the finished accept: station, phase and how many emails the model placed there', async () => {
    const result = await latestModelProposal(fakeDb(tables(accept({}))), 'c1');
    expect(result).toEqual({
      ok: true,
      proposal: { requestId: 'r1', stepId: 'p3-s39', phase: 'phase-3', placed: 3, of: 4 },
    });
  });

  it('is null when nothing was accepted, or the caller is not the owner (RLS returns no row)', async () => {
    expect(await latestModelProposal(fakeDb(tables()), 'c1')).toEqual({ ok: true, proposal: null });
  });

  it('ignores a request that has not finished, and one for another candidate', async () => {
    const db = fakeDb(
      tables(accept({ id: 'r-running', state: 'running' }), accept({ id: 'r-other', candidate_id: 'c2' })),
    );
    expect(await latestModelProposal(db, 'c1')).toEqual({ ok: true, proposal: null });
  });

  it('takes the newest accept, not an older one', async () => {
    const db = fakeDb(
      tables(
        accept({ id: 'r-old', operation_id: 'op-old', proposed_step_id: 'p2-s20', proposed_phase: 'phase-2', finished_at: '2026-10-22T10:00:00Z' }),
        accept({ id: 'r-new', operation_id: 'op-new', finished_at: '2026-10-23T11:00:00Z' }),
      ),
    );
    const result = await latestModelProposal(db, 'c1');
    expect(result.ok && result.proposal?.requestId).toBe('r-new');
  });

  it('adds up the counts of one accept that read two sources, and not those of another accept', async () => {
    const db = fakeDb(
      tables(
        accept({ id: 'r-a', placed_count: 2, email_count: 3, finished_at: '2026-10-23T11:00:00Z' }),
        accept({ id: 'r-b', placed_count: 1, email_count: 2, finished_at: '2026-10-23T10:59:00Z' }),
        accept({ id: 'r-old', operation_id: 'op-old', placed_count: 9, email_count: 9, finished_at: '2026-10-21T10:00:00Z' }),
      ),
    );
    expect(await latestModelProposal(db, 'c1')).toEqual({
      ok: true,
      proposal: { requestId: 'r-a', stepId: 'p3-s39', phase: 'phase-3', placed: 3, of: 5 },
    });
  });

  it('is null for a step the rail no longer has, so the page never prints a station that is gone', async () => {
    const db = fakeDb(tables(accept({ proposed_step_id: 'p3-s99' })));
    expect(await latestModelProposal(db, 'c1')).toEqual({ ok: true, proposal: null });
  });

  it('sums every request of the operation, however many: more than 20 sources of one accept', async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      accept({ id: `r-${String(i).padStart(2, '0')}`, placed_count: 1, email_count: 2, finished_at: `2026-10-23T10:${String(i).padStart(2, '0')}:00Z` }),
    );
    const db = fakeDb(tables(...many, accept({ id: 'r-old', operation_id: 'op-old', placed_count: 9, email_count: 9, finished_at: '2026-10-22T10:00:00Z' })));
    const result = await latestModelProposal(db, 'c1');
    expect(result).toEqual({
      ok: true,
      proposal: { requestId: 'r-24', stepId: 'p3-s39', phase: 'phase-3', placed: 25, of: 50 },
    });
  });

  it('reads the newest finished request alone first, then the operation it names', async () => {
    const log: Query[] = [];
    const db = fakeDb(tables(accept({ id: 'r-a' }), accept({ id: 'r-b', finished_at: '2026-10-23T09:00:00Z' })), undefined, log);
    const result = await latestModelProposal(db, 'c1');
    expect(result.ok && result.proposal?.placed).toBe(6);
    expect(log).toHaveLength(2);
    expect(log[0].limit).toBe(1);
    expect(log[1].limit).toBeUndefined();
    expect(log[1].eq).toContainEqual(['operation_id', 'op1']);
    expect(log[1].eq).toContainEqual(['candidate_id', 'c1']);
  });

  it('reports a failed read', async () => {
    expect(await latestModelProposal(fakeDb({}, 'discovery_model_proposal_accepts'), 'c1')).toEqual({
      ok: false,
      error: 'boom',
    });
  });
});
