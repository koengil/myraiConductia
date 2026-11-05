// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { supabaseExtractStore } from '@/lib/discovery/extract/store';

import { fakePagedSupabase } from '../helpers/fakePagedSupabase';

// Which definer the worker reads its assessment inputs through (#173 G-07 audit S2). The audience-tagged one
// (20261023130100) sits beside the shared-only discovery_assessment_inputs, which keeps its shape so a worker
// image from before that migration never feeds a team row into a shared assessment. A worker that runs ahead of
// the migration falls back to the shared-only one.

function fakeDb(tables: Record<string, unknown[]>, rpc: Parameters<typeof fakePagedSupabase>[1]) {
  const fake = fakePagedSupabase(tables, rpc);
  return { db: fake.db, names: () => fake.rpcs.map((r) => r.name), reads: fake.reads };
}

const TABLES = {
  evidence_links: [{ candidate_id: 'c1' }],
  discovery_recompute_requests: [],
  deal_candidates: [{ id: 'c1', discovery_state: 'proposed', station_override_step_id: null }],
  stage_assessments: [],
};
const row = (over: Record<string, unknown>) => ({
  candidate_id: 'c1',
  source_item_id: 'i1',
  event_id: 'e1',
  type: 'loi_signed',
  occurred_at: '2026-09-18',
  confidence: 0.9,
  extractor_version: 'v1:m',
  created_at: '2026-09-18T10:00:00Z',
  ...over,
});

describe('the assessment inputs the worker reads (#173 G-07 audit S2)', () => {
  it('reads the audience-tagged definer, and never the shared-only one, once its migration has landed', async () => {
    const { db, names } = fakeDb(TABLES, (name) =>
      name === 'discovery_audience_assessment_inputs'
        ? { data: [row({ team_mailbox_id: null, basis: 'model' })], error: null }
        : { data: null, error: { code: 'XX000' } },
    );
    const [c] = await supabaseExtractStore(db).candidatesToAssess('t1', ['i1']);
    expect(c.events.map((e) => e.id)).toEqual(['e1']);
    expect(names()).not.toContain('discovery_assessment_inputs');
  });

  it('keeps a row tagged with a team inbox out of the shared assessment', async () => {
    const { db } = fakeDb(TABLES, (name) =>
      name === 'discovery_audience_assessment_inputs'
        ? {
            data: [
              row({ team_mailbox_id: null, basis: 'model' }),
              row({ source_item_id: 'i-team', event_id: 'e-team', team_mailbox_id: 'tm-1', basis: 'model' }),
            ],
            error: null,
          }
        : { data: null, error: { code: 'XX000' } },
    );
    const [c] = await supabaseExtractStore(db).candidatesToAssess('t1', ['i1']);
    expect(c.events.map((e) => e.id)).toEqual(['e1']);
  });

  it('falls back to the shared-only definer while the audience-tagged one is missing, and reads its rows as shared', async () => {
    const { db, names } = fakeDb(TABLES, (name) =>
      name === 'discovery_audience_assessment_inputs'
        ? { data: null, error: { code: 'PGRST202' } }
        : { data: [row({})], error: null },
    );
    const [c] = await supabaseExtractStore(db).candidatesToAssess('t1', ['i1']);
    expect(names()).toContain('discovery_assessment_inputs');
    expect(c.events.map((e) => e.id)).toEqual(['e1']);
  });

  it('keeps the newest extractor version alone on the fallback, as before the current-events rule (audit S6)', async () => {
    const { db } = fakeDb(TABLES, (name) =>
      name === 'discovery_audience_assessment_inputs'
        ? { data: null, error: { code: 'PGRST202' } }
        : {
            data: [
              row({ event_id: 'e-old', extractor_version: 'v0:old', created_at: '2026-09-01T10:00:00Z' }),
              row({ event_id: 'e-new', type: 'signed' }),
            ],
            error: null,
          },
    );
    const [c] = await supabaseExtractStore(db).candidatesToAssess('t1', ['i1']);
    expect(c.events.map((e) => e.id)).toEqual(['e-new']);
  });

  it('fails on any other read error, with a code and never the message', async () => {
    const { db } = fakeDb(TABLES, () => ({ data: null, error: { code: '57014', message: 'canceling statement: secret' } }));
    await expect(supabaseExtractStore(db).candidatesToAssess('t1', ['i1'])).rejects.toThrow(/57014/);
    await expect(supabaseExtractStore(db).candidatesToAssess('t1', ['i1'])).rejects.not.toThrow(/secret/);
  });
});

describe('reads past one response (#173 G-07 audit S8, S15)', () => {
  // The fake caps every response at 1000 rows, as PostgREST's max_rows does.
  const many = (n: number, f: (i: number) => Record<string, unknown>) => Array.from({ length: n }, (_, i) => f(i));
  const pad = (i: number) => String(i).padStart(5, '0');

  it('reads every recompute request of a queue longer than one response, and answers each one', async () => {
    const requests = many(2500, (i) => ({ id: `r-${pad(i)}`, candidate_id: `c-${pad(i)}`, reason: 'purge' }));
    const candidates = many(2500, (i) => ({ id: `c-${pad(i)}`, discovery_state: 'proposed', station_override_step_id: null }));
    const { db, reads } = fakeDb(
      { discovery_recompute_requests: requests, deal_candidates: candidates, stage_assessments: [] },
      () => ({ data: [], error: null }),
    );
    const work = await supabaseExtractStore(db).candidatesToAssess('t1', []);
    expect(work).toHaveLength(2500);
    expect(work.flatMap((w) => w.requestIds)).toHaveLength(2500);
    expect(work.every((w) => w.trigger === 'purge')).toBe(true);
    expect(reads.get('discovery_recompute_requests')).toBe(4); // three full pages, then an empty one
  });

  it('reads every input row of a candidate whose events fill more than one response', async () => {
    const inputs = many(2300, (i) => row({ source_item_id: `i-${pad(i)}`, event_id: `e-${pad(i)}`, team_mailbox_id: null, basis: 'model' }));
    const { db } = fakeDb(TABLES, (name) =>
      name === 'discovery_audience_assessment_inputs' ? { data: inputs, error: null } : { data: [], error: null },
    );
    const [c] = await supabaseExtractStore(db).candidatesToAssess('t1', ['i1']);
    expect(c.events).toHaveLength(2300);
  });

  it('finds each scoped stream\'s latest row in a history longer than one response', async () => {
    // 1500 old rows of tm-1 that name a step, then its latest: a tombstone. One response would stop before it.
    const history = [
      ...many(1500, (i) => ({ candidate_id: 'c1', team_mailbox_id: 'tm-1', step_id: 'p4-s48', as_of: `2026-09-01T00:00:00Z`, id: `a-${pad(i)}` })),
      { candidate_id: 'c1', team_mailbox_id: 'tm-1', step_id: null, as_of: '2026-10-01T00:00:00Z', id: 'b-latest' },
    ];
    const { db } = fakeDb({ ...TABLES, stage_assessments: history }, (name) =>
      name === 'discovery_audience_assessment_inputs' ? { data: [], error: null } : { data: [], error: null },
    );
    const [c] = await supabaseExtractStore(db).candidatesToAssess('t1', ['i1']);
    // The stream ended with its tombstone, and its inbox adds no event: nothing is left to assess for it.
    expect(c.teams).toEqual([]);
  });
});
