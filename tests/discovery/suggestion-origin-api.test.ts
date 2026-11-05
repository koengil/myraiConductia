// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getEvidenceSuggestion } from '@/lib/discovery/api';

// getEvidenceSuggestion's origin (G-02b #173): read through the discovery_deal_origin definer, which answers a member
// or overseer of the deal whatever the candidate rows' RLS shows them. A failed or missing answer is an error (the
// route's 500), never `rules`: the rail marker offers a one-click Move only on an explicit `rules`.

type Rows = Record<string, unknown[]>;

const DEAL = { id: 'd1' };
const ASSESSMENT = {
  id: 'a1',
  step_id: 'p5-s51',
  reason_text: 'Signing / Announcement Prep because signing on 26 Oct 2026 (1 email)',
  evidence_event_ids: [],
  flags: [],
  as_of: '2026-10-28T10:00:00Z',
};

function fakeDb(rows: Rows, origin: { data: unknown; error: { message: string } | null }) {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const from = (table: string) => {
    // The assessments are read page by page by id (keyset: order('id').limit(n).gt('id', last)), so the fake applies
    // the gt, as PostgREST does; without it the reader would be handed the same page forever.
    let after: [string, string] | null = null;
    const window = () => {
      const all = (rows[table] ?? []) as Array<Record<string, unknown>>;
      return after ? all.filter((r) => String(r[after![0]]) > after![1]) : all;
    };
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'contains']) builder[m] = () => builder;
    builder.gt = (col: string, v: string) => {
      after = [col, v];
      return builder;
    };
    builder.maybeSingle = async () => ({ data: window()[0] ?? null, error: null });
    builder.then = (resolve: (v: unknown) => void) => resolve({ data: window(), error: null });
    return builder;
  };
  const rpc = async (name: string, args: unknown) => {
    rpcCalls.push({ name, args });
    if (name === 'discovery_deal_origin') return origin;
    throw new Error(`unexpected rpc ${name}`);
  };
  return { db: { from, rpc } as unknown as SupabaseClient, rpcCalls };
}

const withAssessment: Rows = { deals: [DEAL], stage_assessments: [ASSESSMENT], corrections: [] };

describe('getEvidenceSuggestion origin', () => {
  it('asks the definer for the deal and answers rules only when it says rules', async () => {
    const { db, rpcCalls } = fakeDb(withAssessment, { data: 'rules', error: null });
    const result = await getEvidenceSuggestion(db, 'KESTR-2026-412');
    expect(result.ok && result.origin).toBe('rules');
    expect(rpcCalls).toEqual([{ name: 'discovery_deal_origin', args: { p_deal_id: 'd1' } }]);
  });

  it('answers model_proposal for a deal member or overseer who is not the finder', async () => {
    const { db } = fakeDb(withAssessment, { data: 'model_proposal', error: null });
    const result = await getEvidenceSuggestion(db, 'KESTR-2026-412');
    expect(result.ok && result.origin).toBe('model_proposal');
    expect(result.ok && result.suggestion?.stepId).toBe('p5-s51');
  });

  it('keeps the origin on a deal with no assessment yet', async () => {
    const { db } = fakeDb({ deals: [DEAL], stage_assessments: [] }, { data: 'model_proposal', error: null });
    expect(await getEvidenceSuggestion(db, 'KESTR-2026-412')).toEqual({ ok: true, suggestion: null, origin: 'model_proposal' });
  });

  it('is an error, never rules, when the origin read fails', async () => {
    const { db } = fakeDb(withAssessment, { data: null, error: { message: 'boom' } });
    expect(await getEvidenceSuggestion(db, 'KESTR-2026-412')).toEqual({ ok: false, error: 'boom' });
  });

  it('is an error, never rules, when the definer will not answer for a deal the caller found (null)', async () => {
    const { db } = fakeDb(withAssessment, { data: null, error: null });
    expect(await getEvidenceSuggestion(db, 'KESTR-2026-412')).toEqual({ ok: false, error: 'origin_unavailable' });
  });

  it('asks nothing for a deal the caller cannot find: no marker, so nothing to guard', async () => {
    const { db, rpcCalls } = fakeDb({ deals: [] }, { data: 'rules', error: null });
    expect(await getEvidenceSuggestion(db, 'NOPE')).toEqual({ ok: true, suggestion: null, origin: 'rules' });
    expect(rpcCalls).toEqual([]);
  });
});
