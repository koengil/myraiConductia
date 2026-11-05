// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getCandidateDetail, getEvidenceSuggestion, listCandidates } from '@/lib/discovery/api';
import { captureConsole } from '../helpers/consoleCapture';

// getCandidateDetail over a fake client. Each table answers a fixed row set (the
// rows RLS would have returned for the caller), so this tests how the rows are
// assembled: own vs colleague, the current extractor version, one timeline row
// per milestone and day, and the excerpt only from the caller's own text.

type Rows = Record<string, unknown[]>;
/** RPCs whose migration has not landed yet: they answer PGRST202, as PostgREST does for a function it does not know. */
const missing = new Set<string>();
/** Rows in one response, as PostgREST's max_rows caps it. */
const MAX_ROWS = 1000;
/**
 * `authority` is what discovery_correction_authority answers: null (may act) or the reason not. `ending` is its
 * answer when asked about an action that ends the proposal (p_action set), which defaults to `authority`.
 */
function fakeDb(rows: Rows, failOn?: string, authority: string | null = null, ending: string | null = authority): SupabaseClient {
  const from = (table: string) => {
    // order, gt (a keyset) and limit act on the rows, and a response holds at most MAX_ROWS of them.
    let sort: { col: string; ascending: boolean } | null = null;
    let after: [string, string] | null = null;
    let limit = MAX_ROWS;
    const window = () => {
      let out = [...(rows[table] ?? [])] as Array<Record<string, unknown>>;
      if (sort) {
        const { col, ascending } = sort;
        out.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (ascending ? 1 : -1));
      }
      if (after) out = out.filter((r) => String(r[after![0]]) > after![1]);
      return out.slice(0, Math.min(limit, MAX_ROWS));
    };
    const result = () =>
      failOn === table
        ? { data: null, error: { message: 'boom' } }
        : { data: window(), error: null };
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'contains']) builder[m] = () => builder;
    builder.order = (col: string, opts?: { ascending?: boolean }) => {
      sort ??= { col, ascending: opts?.ascending ?? true };
      return builder;
    };
    builder.gt = (col: string, v: string) => {
      after = [col, v];
      return builder;
    };
    builder.limit = (n: number) => {
      limit = n;
      return builder;
    };
    builder.maybeSingle = async () => {
      const r = result();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : null, error: r.error };
    };
    builder.then = (resolve: (v: unknown) => void) => resolve(result());
    return builder;
  };
  const answer = (name: string, args?: { p_action?: string }) => {
    // discovery_item_metadata answers the item rows: the subject only for the caller's own items (null otherwise).
    // discovery_candidate_origins answers the origin rows, read past RLS by the database: the word, never a cluster key.
    if (name === 'discovery_item_metadata' || name === 'discovery_candidate_origins') {
      return failOn === name ? { data: null, error: { message: 'boom' } } : { data: rows[name] ?? [], error: null };
    }
    // discovery_deal_origin answers one word for a promoted deal (G-02b): the rules unless a test gives another.
    if (name === 'discovery_deal_origin') {
      return failOn === name ? { data: null, error: { message: 'boom' } } : { data: rows[name]?.[0] ?? 'rules', error: null };
    }
    // discovery_item_current_events names the current events (20261023130400): by default every event the
    // caller reads, unless a test gives the rule's answer itself.
    if (name === 'discovery_item_current_events') {
      if (failOn === name) return { data: null, error: { message: 'boom' } };
      if (missing.has(name)) return { data: null, error: { code: 'PGRST202', message: 'not in the schema cache' } };
      const events = (rows.milestone_events ?? []) as Array<{ id: string; source_item_id: string }>;
      return {
        data: rows[name] ?? events.map((e) => ({ item_id: e.source_item_id, event_id: e.id, basis: 'model' })),
        error: null,
      };
    }
    // discovery_item_team_access (20261023130500): which items the caller reads only through a team inbox.
    if (name === 'discovery_item_team_access') {
      if (missing.has(name)) return { data: null, error: { code: 'PGRST202', message: 'not in the schema cache' } };
      return failOn === name ? { data: null, error: { code: '57014', message: 'boom' } } : { data: rows[name] ?? [], error: null };
    }
    return { data: args?.p_action ? ending : authority, error: null };
  };
  // An RPC answers a builder, as PostgREST's does: the detail filters, orders and limits its set-returning reads.
  const rpc = (name: string, args?: { p_action?: string }) => {
    const builder: Record<string, unknown> = {};
    for (const m of ['gt', 'order', 'limit']) builder[m] = () => builder;
    builder.then = (resolve: (v: unknown) => void) => resolve(answer(name, args));
    return builder;
  };
  return { from, rpc } as unknown as SupabaseClient;
}

const CAND = 'c-kestrel';
const KESTREL = {
  id: CAND,
  proposed_name: 'Project Kestrel',
  codename_guess: 'Project Kestrel',
  parties: [{ name: 'Northwind Robotics', domain: 'northwind-robotics.example' }],
  first_seen_at: '2026-05-05T09:00:00Z',
  last_seen_at: '2026-09-18T17:00:00Z',
  discovery_state: 'proposed',
  merged_into_id: null,
  station_override_step_id: null,
  station_override_correction_id: null,
};
const BODY = 'Team, good news. The letter of intent for Project Kestrel was signed on 18 September 2026. Next: diligence.';
const QUOTE = 'The letter of intent for Project Kestrel was signed on 18 September 2026.';
const START = BODY.indexOf(QUOTE);
const event = (over: Record<string, unknown>) => ({
  id: 'e1',
  source_item_id: 'i-own',
  type: 'loi_signed',
  occurred_at: '2026-09-18',
  span_start: START,
  span_end: START + QUOTE.length,
  extractor_version: 'v1:anthropic/claude-sonnet-5',
  created_at: '2026-09-30T10:00:00Z',
  ...over,
});
const ASSESSMENT = {
  id: 'a-1',
  step_id: 'p4-s48',
  lifecycle_suggestion: 'live',
  reason_text: 'LOI Review because LOI signed on Sep 18, 2026 (2 emails)',
  evidence_event_ids: ['e1', 'e2'],
  confidence: '0.900',
  flags: [],
  as_of: '2026-09-30T10:01:00Z',
};

function rows(over: Rows = {}): Rows {
  return {
    deal_candidates: [KESTREL],
    evidence_links: [{ source_item_id: 'i-own' }, { source_item_id: 'i-colleague' }],
    candidate_visibility: [{ source_item_count: 1 }],
    stage_assessments: [ASSESSMENT],
    discovery_candidate_origins: [{ candidate_id: CAND, origin: 'rules' }],
    discovery_item_metadata: [
      { id: 'i-own', subject: 'Project Kestrel: LOI signed', sent_at: '2026-09-18T15:00:00Z', own: true },
      { id: 'i-colleague', subject: null, sent_at: '2026-09-18T16:00:00Z', own: false },
    ],
    source_item_texts: [{ source_item_id: 'i-own', body_text: BODY }],
    milestone_events: [event({}), event({ id: 'e2', source_item_id: 'i-colleague', span_start: 4, span_end: 9 })],
    ...over,
  };
}

describe('getCandidateDetail', () => {
  it('answers null when the candidate is not visible', async () => {
    const result = await getCandidateDetail(fakeDb({ deal_candidates: [] }), 'u', CAND);
    expect(result).toEqual({ ok: true, detail: null });
  });

  it('reads the step from the latest assessment on the current rail', async () => {
    const result = await getCandidateDetail(fakeDb(rows()), 'u', CAND);
    if (!result.ok || !result.detail) throw new Error('expected a detail');
    expect(result.detail).toMatchObject({
      name: 'Project Kestrel',
      state: 'proposed',
      evidenceCount: 2,
      ownEvidenceCount: 1,
      station: { stepId: 'p4-s48', station: 44, total: 61, title: 'LOI Review', lifecycle: 'live', confidence: 0.9 },
    });
    expect(result.detail.station?.reason).toBe('LOI Review because LOI signed on Sep 18, 2026 (2 emails)');
  });

  it('gives an excerpt for the caller\'s own mail and none for a colleague\'s', async () => {
    const result = await getCandidateDetail(fakeDb(rows()), 'u', CAND);
    if (!result.ok || !result.detail) throw new Error('expected a detail');
    const [own, colleague] = result.detail.evidence;
    expect(own).toMatchObject({ sourceItemId: 'i-own', own: true, subject: 'Project Kestrel: LOI signed' });
    const [from, to] = own.excerpt!.highlight;
    expect(own.excerpt!.text.slice(from, to)).toBe(QUOTE);
    expect(colleague).toMatchObject({ sourceItemId: 'i-colleague', own: false, subject: '', excerpt: null });
  });

  it('shows one timeline row per milestone and day, preferring the caller\'s own mail as its source', async () => {
    const result = await getCandidateDetail(fakeDb(rows({
      // The colleague's event sorts first by id; the own one must still win the row.
      milestone_events: [event({ id: 'a-first', source_item_id: 'i-colleague' }), event({ id: 'z-last' })],
    })), 'u', CAND);
    if (!result.ok || !result.detail) throw new Error('expected a detail');
    expect(result.detail.milestones).toEqual([
      { id: 'z-last', type: 'loi_signed', label: 'LOI signed', occurredAt: '2026-09-18', sourceItemId: 'i-own', own: true, team: false },
    ]);
  });

  it('shows only the events the current-events rule names, so an older version\'s never mix in', async () => {
    const result = await getCandidateDetail(fakeDb(rows({
      milestone_events: [
        event({ id: 'old', type: 'signed', extractor_version: 'v0:old-model', created_at: '2026-09-01T10:00:00Z' }),
        event({ id: 'e1' }),
      ],
      discovery_item_current_events: [{ item_id: 'i-own', event_id: 'e1', basis: 'model' }],
    })), 'u', CAND);
    if (!result.ok || !result.detail) throw new Error('expected a detail');
    expect(result.detail.milestones.map((m) => m.type)).toEqual(['loi_signed']);
  });

  it('falls back to each item\'s newest extractor version while the current-events rule has not landed (audit S6)', async () => {
    missing.add('discovery_item_current_events');
    try {
      const result = await getCandidateDetail(fakeDb(rows({
        milestone_events: [
          event({ id: 'old', type: 'signed', extractor_version: 'v0:old-model', created_at: '2026-09-01T10:00:00Z' }),
          event({ id: 'e1' }),
        ],
      })), 'u', CAND);
      if (!result.ok || !result.detail) throw new Error('expected a detail');
      expect(result.detail.milestones.map((m) => m.type)).toEqual(['loi_signed']);
    } finally {
      missing.clear();
    }
  });

  it('shows nothing from an item whose latest model answer found no milestone, even with older events stored (#173 G-07 slice 2a)', async () => {
    // Both items hold events from an earlier model; the latest ok call for each found nothing, so the rule
    // names no event. The assessment still cites the old ids: none of them reaches the timeline or the evidence.
    const result = await getCandidateDetail(fakeDb(rows({ discovery_item_current_events: [] })), 'u', CAND);
    if (!result.ok || !result.detail) throw new Error('expected a detail');
    expect(result.detail.milestones).toEqual([]);
    expect(result.detail.evidence).toEqual([]);
    expect(result.detail.station?.stepId).toBe('p4-s48');
  });

  it('has no step and no timeline before any milestone is extracted', async () => {
    const result = await getCandidateDetail(fakeDb(rows({ stage_assessments: [], milestone_events: [] })), 'u', CAND);
    if (!result.ok || !result.detail) throw new Error('expected a detail');
    expect(result.detail.station).toBeNull();
    expect(result.detail.milestones).toEqual([]);
    expect(result.detail.evidence).toEqual([]);
  });

  it('has no step for an assessment whose step the rail no longer has', async () => {
    const result = await getCandidateDetail(fakeDb(rows({ stage_assessments: [{ ...ASSESSMENT, step_id: 'p9-s99' }] })), 'u', CAND);
    if (!result.ok || !result.detail) throw new Error('expected a detail');
    expect(result.detail.station).toBeNull();
  });

  it('carries the decision history oldest first, with the actor named only as far as RLS allows', async () => {
    const result = await getCandidateDetail(fakeDb(rows({
      corrections: [
        { id: 'k2', candidate_id: CAND, actor_id: 'u-colleague', action: 'rename', before: { name: 'A' }, after: { name: 'B' }, reason: null, created_at: '2026-10-03T10:00:00Z' },
        { id: 'k1', candidate_id: CAND, actor_id: 'u', action: 'reject', before: { state: 'proposed' }, after: { state: 'rejected' }, reason: 'No', created_at: '2026-10-02T10:00:00Z' },
      ],
      users: [{ id: 'u', display_name: 'Storm Duncan', full_name: null }],
    })), 'u', CAND);
    if (!result.ok || !result.detail) throw new Error('expected a detail');
    expect(result.detail.decisions.map((d) => [d.id, d.actorName, d.own])).toEqual([
      ['k1', 'Storm Duncan', true],
      ['k2', 'A colleague', false],
    ]);
    expect(result.detail.decisions[0]).toMatchObject({ action: 'reject', reason: 'No', at: '2026-10-02T10:00:00Z' });
  });

  it('lists the live email links, and counts a link a person moved elsewhere in neither the list nor the total', async () => {
    const result = await getCandidateDetail(fakeDb(rows({
      evidence_links: [
        { id: 'l-own', source_item_id: 'i-own', state: 'proposed' },
        { id: 'l-col', source_item_id: 'i-colleague', state: 'confirmed' },
        { id: 'l-gone', source_item_id: 'i-moved', state: 'rejected' },
      ],
      discovery_item_metadata: [
        { id: 'i-own', subject: 'Project Kestrel: LOI signed', sent_at: '2026-09-18T15:00:00Z', own: true },
        { id: 'i-colleague', subject: null, sent_at: '2026-09-18T16:00:00Z', own: false },
        { id: 'i-moved', subject: 'Moved away', sent_at: '2026-09-01T16:00:00Z', own: true },
      ],
    })), 'u', CAND);
    if (!result.ok || !result.detail) throw new Error('expected a detail');
    expect(result.detail.evidenceCount).toBe(2);
    expect(result.detail.items).toEqual([
      { linkId: 'l-own', sourceItemId: 'i-own', subject: 'Project Kestrel: LOI signed', sentAt: '2026-09-18T15:00:00Z', own: true },
      { linkId: 'l-col', sourceItemId: 'i-colleague', subject: '', sentAt: '2026-09-18T16:00:00Z', own: false },
    ]);
  });

  it('reads a decision once, even when several of the history reads return it', async () => {
    const result = await getCandidateDetail(fakeDb(rows({
      corrections: [
        { id: 'k1', candidate_id: 'c-original', actor_id: 'u', action: 'split', before: { name: 'Project Original' }, after: { newCandidateId: CAND, newName: 'Project Kestrel', itemCount: 2 }, reason: 'Two deals', created_at: '2026-10-02T10:00:00Z' },
      ],
    })), 'u', CAND);
    if (!result.ok || !result.detail) throw new Error('expected a detail');
    expect(result.detail.decisions.map((d) => [d.id, d.candidateId, d.action])).toEqual([['k1', 'c-original', 'split']]);
  });

  it('answers what the caller may do from the authority RPC, fail-closed on anything unexpected', async () => {
    const read = async (authority: string | null) => {
      const result = await getCandidateDetail(fakeDb(rows(), undefined, authority), 'u', CAND);
      if (!result.ok || !result.detail) throw new Error('expected a detail');
      return result.detail.canAct;
    };
    expect(await read(null)).toEqual({ ok: true });
    expect(await read('no_authority')).toEqual({ ok: false, reason: 'no_authority' });
    expect(await read('candidate_state')).toEqual({ ok: false, reason: 'candidate_state' });
    expect(await read('not_visible')).toEqual({ ok: false, reason: 'no_authority' });
  });

  it('answers separately whether the proposal can be ended, so a promoted candidate keeps its other corrections', async () => {
    const result = await getCandidateDetail(fakeDb(rows(), undefined, null, 'candidate_state'), 'u', CAND);
    if (!result.ok || !result.detail) throw new Error('expected a detail');
    expect(result.detail.canAct).toEqual({ ok: true });
    expect(result.detail.canResolve).toEqual({ ok: false, reason: 'candidate_state' });
    const open = await getCandidateDetail(fakeDb(rows()), 'u', CAND);
    if (!open.ok || !open.detail) throw new Error('expected a detail');
    expect(open.detail.canResolve).toEqual({ ok: true });
  });

  it('carries the MD\'s step with its reason, beside the evidence\'s own', async () => {
    const result = await getCandidateDetail(fakeDb(rows({
      deal_candidates: [{ ...KESTREL, station_override_step_id: 'p5-s51', station_override_correction_id: 'k1' }],
      corrections: [
        { id: 'k1', candidate_id: CAND, actor_id: 'u', action: 'set_station', before: { stepId: null }, after: { stepId: 'p5-s51' }, reason: 'Signed by phone', created_at: '2026-10-02T10:00:00Z' },
      ],
    })), 'u', CAND);
    if (!result.ok || !result.detail) throw new Error('expected a detail');
    expect(result.detail.override).toEqual({ stepId: 'p5-s51', station: 47, title: 'Signing / Announcement Prep', reason: 'Signed by phone' });
    expect(result.detail.station?.stepId).toBe('p4-s48');
  });

  it('has no override for a step the rail no longer has, and names the survivor of a merge', async () => {
    const result = await getCandidateDetail(fakeDb(rows({
      deal_candidates: [{ ...KESTREL, discovery_state: 'merged_into', merged_into_id: 'c-survivor', station_override_step_id: 'p9-s99' }],
    })), 'u', CAND);
    if (!result.ok || !result.detail) throw new Error('expected a detail');
    expect(result.detail.override).toBeNull();
    expect(result.detail.state).toBe('merged_into');
    // The fake answers the same row for the survivor lookup, which is enough to see the name carried through.
    expect(result.detail.mergedInto).toEqual({ id: 'c-survivor', name: 'Project Kestrel' });
  });

  it('returns a read failure as an error, never as data', async () => {
    const result = await getCandidateDetail(fakeDb(rows(), 'milestone_events'), 'u', CAND);
    expect(result).toEqual({ ok: false, error: 'boom' });
    // The current-events rule fails closed too: no timeline built from unfiltered events.
    const rule = await getCandidateDetail(fakeDb(rows(), 'discovery_item_current_events'), 'u', CAND);
    expect(rule).toEqual({ ok: false, error: 'boom' });
  });

  describe('team inboxes (#173 G-07 slice 2b)', () => {
    it('flags the mail the caller reads only as a team inbox member, in the timeline and the evidence', async () => {
      const result = await getCandidateDetail(fakeDb(rows({
        discovery_item_team_access: [{ item_id: 'i-own', team: true }, { item_id: 'i-colleague', team: false }],
      })), 'u', CAND);
      if (!result.ok || !result.detail) throw new Error('expected a detail');
      expect(result.detail.evidence.map((e) => [e.sourceItemId, e.own, e.team])).toEqual([
        ['i-own', true, true],
        ['i-colleague', false, false],
      ]);
      expect(result.detail.milestones.map((m) => [m.sourceItemId, m.own, m.team])).toEqual([['i-own', true, true]]);
      // The member still reads the cited sentence of team mail.
      expect(result.detail.evidence[0].excerpt).not.toBeNull();
    });

    it('labels no team mail, and still answers, while the team read has not landed (audit S6)', async () => {
      missing.add('discovery_item_team_access');
      try {
        const result = await getCandidateDetail(fakeDb(rows({ discovery_item_team_access: [{ item_id: 'i-colleague', team: true }] })), 'u', CAND);
        if (!result.ok || !result.detail) throw new Error('expected a detail');
        expect(result.detail.milestones.every((m) => m.team === false)).toBe(true);
      } finally {
        missing.clear();
      }
    });

    it('labels no team mail, logs the code only, and still answers on any other team-read error (#744)', async () => {
      const capture = captureConsole();
      try {
        const result = await getCandidateDetail(
          fakeDb(rows({ discovery_item_team_access: [{ item_id: 'i-own', team: true }] }), 'discovery_item_team_access'),
          'u',
          CAND,
        );
        if (!result.ok || !result.detail) throw new Error('expected a detail');
        expect(result.detail.milestones.every((m) => m.team === false)).toBe(true);
        expect(result.detail.evidence.every((e) => e.team === false)).toBe(true);
        expect(capture.output()).toContain('"evt":"request_error"');
        expect(capture.output()).toContain('"sqlstate":"57014"');
        expect(capture.output()).not.toContain('boom');
      } finally {
        capture.restore();
      }
    });

    it('names the caller\'s own mailbox before team mail as a milestone\'s source', async () => {
      const result = await getCandidateDetail(fakeDb(rows({
        evidence_links: [{ source_item_id: 'i-team' }, { source_item_id: 'i-own' }],
        source_item_texts: [{ source_item_id: 'i-team', body_text: BODY }, { source_item_id: 'i-own', body_text: BODY }],
        milestone_events: [event({ id: 'a-team', source_item_id: 'i-team' }), event({ id: 'z-own' })],
        discovery_item_team_access: [{ item_id: 'i-team', team: true }],
      })), 'u', CAND);
      if (!result.ok || !result.detail) throw new Error('expected a detail');
      expect(result.detail.milestones.map((m) => [m.id, m.own, m.team])).toEqual([['z-own', true, false]]);
    });

    it('shows the scoped row furthest along the rail over the shared row, and the shared row after a tombstone', async () => {
      const shared = { ...ASSESSMENT, id: 's-1', team_mailbox_id: null, as_of: '2026-10-01T10:00:00Z' };
      const scoped = {
        ...ASSESSMENT, id: 't-1', team_mailbox_id: 'tm-1', step_id: 'p5-s51', as_of: '2026-09-30T10:00:00Z',
        reason_text: 'Signing / Announcement Prep because signing on Oct 28, 2026 (1 email)',
      };
      const preferred = await getCandidateDetail(fakeDb(rows({ stage_assessments: [shared, scoped] })), 'u', CAND);
      if (!preferred.ok || !preferred.detail) throw new Error('expected a detail');
      expect(preferred.detail.station).toMatchObject({ stepId: 'p5-s51', station: 47 });
      expect(preferred.detail.station?.reason).toBe(scoped.reason_text);

      const tombstone = { ...scoped, id: 't-2', step_id: null, evidence_event_ids: [], as_of: '2026-10-02T10:00:00Z' };
      const ended = await getCandidateDetail(fakeDb(rows({ stage_assessments: [shared, scoped, tombstone] })), 'u', CAND);
      if (!ended.ok || !ended.detail) throw new Error('expected a detail');
      expect(ended.detail.station?.stepId).toBe('p4-s48');
    });
  });
});

describe('getEvidenceSuggestion', () => {
  it('marks the preferred row of the deal: a scoped row naming a step over the shared one', async () => {
    const db = fakeDb({
      deals: [{ id: 'd-1' }],
      stage_assessments: [
        { id: 's-1', step_id: 'p4-s48', team_mailbox_id: null, reason_text: 'shared', evidence_event_ids: ['e1'], flags: [], as_of: '2026-10-02T10:00:00Z' },
        { id: 't-1', step_id: 'p5-s51', team_mailbox_id: 'tm-1', reason_text: 'scoped', evidence_event_ids: ['e9'], flags: [], as_of: '2026-10-01T10:00:00Z' },
      ],
      milestone_events: [],
    });
    const result = await getEvidenceSuggestion(db, 'KST-1');
    if (!result.ok) throw new Error('expected a suggestion');
    expect(result.suggestion).toMatchObject({ assessmentId: 't-1', stepId: 'p5-s51', reason: 'scoped', evidenceCount: 1 });
  });

  it('carries a failed read\'s code for the route\'s log line (#743)', async () => {
    const db = fakeDb(rows());
    const from = db.from.bind(db);
    (db as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      const builder = from(table) as unknown as Record<string, unknown>;
      if (table !== 'source_item_texts') return builder;
      builder.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { code: '57014', message: 'canceled' } });
      return builder;
    };
    expect(await getCandidateDetail(db, 'u', CAND)).toEqual({ ok: false, error: 'canceled', code: '57014' });
  });
});

// About two thousand links (#743): the read that once passed every item id in one GET, which the gateway refused
// with 414. This client answers the way PostgREST does: it applies eq, in and gt, orders, and cuts any answer at
// max_rows (1000). It records every id list a read was given.
describe('getCandidateDetail at about two thousand links', () => {
  const N = 2000;
  const pad = (i: number) => String(i).padStart(5, '0');
  const itemId = (i: number) => `i-${pad(i)}`;

  function scaleDb() {
    const idLists: Array<{ read: string; ids: string[] }> = [];
    // Item 0 carries 1,500 events, more than one page of a batch; every other item one.
    const events = [
      ...Array.from({ length: 1500 }, (_, k) => event({ id: `e-0-${pad(k)}`, source_item_id: itemId(0) })),
      ...Array.from({ length: N - 1 }, (_, k) => event({ id: `e-${pad(k + 1)}`, source_item_id: itemId(k + 1) })),
    ];
    const tables: Rows = {
      deal_candidates: [KESTREL],
      evidence_links: Array.from({ length: N }, (_, i) => ({ id: `l-${pad(i)}`, source_item_id: itemId(i), state: 'accepted' })),
      candidate_visibility: [{ source_item_count: N }],
      stage_assessments: [{ ...ASSESSMENT, candidate_id: CAND, evidence_event_ids: ['e-0-01499', `e-${pad(N - 1)}`] }],
      source_item_texts: Array.from({ length: N }, (_, i) => ({ source_item_id: itemId(i), body_text: BODY })),
      milestone_events: events,
    };
    const query = (read: string, all: () => unknown[]) => {
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      let key: string | null = null;
      let limit = Infinity;
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.contains = () => {
        filters.push(() => false);
        return builder;
      };
      builder.eq = (col: string, v: unknown) => {
        filters.push((r) => r[col] === undefined || r[col] === v);
        return builder;
      };
      builder.in = (col: string, vs: string[]) => {
        idLists.push({ read, ids: vs });
        filters.push((r) => vs.includes(r[col] as string));
        return builder;
      };
      builder.gt = (col: string, v: string) => {
        filters.push((r) => (r[col] as string) > v);
        return builder;
      };
      builder.order = (col: string) => {
        key = col;
        return builder;
      };
      builder.limit = (n: number) => {
        limit = n;
        return builder;
      };
      const run = () => {
        let out = (all() as Array<Record<string, unknown>>).filter((r) => filters.every((f) => f(r)));
        if (key) out = [...out].sort((a, b) => String(a[key!]).localeCompare(String(b[key!])));
        return { data: out.slice(0, Math.min(limit, MAX_ROWS)), error: null };
      };
      builder.maybeSingle = async () => ({ data: run().data[0] ?? null, error: null });
      builder.then = (resolve: (v: unknown) => void) => resolve(run());
      return builder;
    };
    const from = (table: string) => query(table, () => tables[table] ?? []);
    const rpc = (name: string, args: { p_items?: string[]; p_item_ids?: string[]; p_candidate_ids?: string[]; p_action?: string }) => {
      // The origin is read past RLS by the database (G-02b): an explicit answer for the candidate the page shows.
      if (name === 'discovery_candidate_origins') {
        return query(name, () => args.p_candidate_ids!.map((id) => ({ candidate_id: id, origin: 'rules' })));
      }
      if (name === 'discovery_item_metadata') {
        idLists.push({ read: name, ids: args.p_items! });
        return query(name, () => args.p_items!.map((id) => ({ id, subject: 'Project Kestrel', sent_at: '2026-09-18T15:00:00Z' })));
      }
      if (name === 'discovery_item_current_events') {
        idLists.push({ read: name, ids: args.p_item_ids! });
        const ids = new Set(args.p_item_ids);
        return query(name, () =>
          events.filter((e) => ids.has(e.source_item_id as string)).map((e) => ({ item_id: e.source_item_id, event_id: e.id, basis: 'model' })),
        );
      }
      if (name === 'discovery_item_team_access') {
        idLists.push({ read: name, ids: args.p_item_ids! });
        return query(name, () => args.p_item_ids!.map((id) => ({ item_id: id, team: false })));
      }
      return query(name, () => []);
    };
    return { db: { from, rpc } as unknown as SupabaseClient, idLists };
  }

  it('reads every link and every item, at most 100 ids a read, past max_rows', async () => {
    const { db, idLists } = scaleDb();
    const result = await getCandidateDetail(db, 'u', CAND);
    if (!result.ok || !result.detail) throw new Error('expected a detail');
    // Every link, not the first page of 1,000.
    expect(result.detail.evidenceCount).toBe(N);
    expect(result.detail.items).toHaveLength(N);
    // Both cited events: one on item 0's second page of events, one on the last item.
    expect(result.detail.evidence.map((e) => e.sourceItemId)).toEqual([itemId(0), itemId(N - 1)]);
    const reads = ['discovery_item_metadata', 'source_item_texts', 'milestone_events', 'discovery_item_current_events', 'discovery_item_team_access'];
    for (const read of reads) {
      const lists = idLists.filter((l) => l.read === read);
      expect(Math.max(...lists.map((l) => l.ids.length)), read).toBeLessThanOrEqual(100);
      expect(new Set(lists.flatMap((l) => l.ids)).size, read).toBe(N);
    }
  });

  describe('origin and the accepted model proposal (G-02b)', () => {
    const MODEL_KEY = 'model:u:3f0c1f0e-5a4b-4f57-9d8e-0c1f2a3b4c5d:project-kestrel';
    const ACCEPT = {
      id: 'r-1',
      operation_id: 'op-1',
      candidate_id: CAND,
      state: 'done',
      proposed_step_id: 'p3-s39',
      proposed_phase: 'phase-3',
      placed_count: 3,
      email_count: 4,
      finished_at: '2026-10-23T10:00:00Z',
    };

    const ORIGIN_MODEL = { discovery_candidate_origins: [{ candidate_id: CAND, origin: 'model_proposal' }] };

    it('is rules, with no model proposal, for a candidate the database says the rules found', async () => {
      const result = await getCandidateDetail(fakeDb(rows({ deal_candidates: [{ ...KESTREL, cluster_key: 'codename:kestrel' }] })), 'u', CAND);
      if (!result.ok || !result.detail) throw new Error('expected a detail');
      expect(result.detail.origin).toBe('rules');
      expect(result.detail.modelProposal).toBeNull();
    });

    it('carries the origin and the accepted proposal to the owner, and never the cluster key', async () => {
      const result = await getCandidateDetail(
        fakeDb(
          rows({
            ...ORIGIN_MODEL,
            deal_candidates: [{ ...KESTREL, cluster_key: MODEL_KEY }],
            discovery_model_proposal_accepts: [ACCEPT],
          }),
        ),
        'u',
        CAND,
      );
      if (!result.ok || !result.detail) throw new Error('expected a detail');
      expect(result.detail.origin).toBe('model_proposal');
      expect(result.detail.modelProposal).toEqual({
        requestId: 'r-1',
        stepId: 'p3-s39',
        phase: 'phase-3',
        placed: 3,
        of: 4,
      });
      const body = JSON.stringify(result.detail);
      expect(body).not.toContain('model:u:');
      expect(body).not.toContain('cluster_key');
      expect(body).not.toContain('project-kestrel');
    });

    it('answers a null model proposal to anyone who cannot read the requests (RLS returns none), and keeps the origin', async () => {
      const result = await getCandidateDetail(fakeDb(rows({ ...ORIGIN_MODEL, deal_candidates: [{ ...KESTREL, cluster_key: MODEL_KEY }] })), 'u', CAND);
      if (!result.ok || !result.detail) throw new Error('expected a detail');
      expect(result.detail.origin).toBe('model_proposal');
      expect(result.detail.modelProposal).toBeNull();
    });

    it('reads a survivor whose merged-away model candidate this caller cannot see as model-origin: the database decides', async () => {
      // The caller's candidate rows show only the survivor (a codename key); the definer follows the merge past RLS.
      const result = await getCandidateDetail(
        fakeDb(rows({ ...ORIGIN_MODEL, deal_candidates: [{ ...KESTREL, cluster_key: 'codename:kestrel' }] })),
        'u',
        CAND,
      );
      if (!result.ok || !result.detail) throw new Error('expected a detail');
      expect(result.detail.origin).toBe('model_proposal');
    });

    it('returns a failed accept read as an error, never as rules', async () => {
      const result = await getCandidateDetail(fakeDb(rows(), 'discovery_model_proposal_accepts'), 'u', CAND);
      expect(result).toEqual({ ok: false, error: 'boom' });
    });

    it('returns a failed origin read as an error, never as rules', async () => {
      const result = await getCandidateDetail(fakeDb(rows(), 'discovery_candidate_origins'), 'u', CAND);
      expect(result).toEqual({ ok: false, error: 'boom' });
    });

    it('returns a missing origin answer for a candidate the page shows as an error, never as rules', async () => {
      const result = await getCandidateDetail(fakeDb(rows({ discovery_candidate_origins: [] })), 'u', CAND);
      expect(result).toEqual({ ok: false, error: 'origin_unavailable' });
    });
  });
});

describe('listCandidates station', () => {
  it('carries each candidate\'s latest step as its step line', async () => {
    const db = fakeDb({
      deal_candidates: [KESTREL, { ...KESTREL, id: 'c-falcon', proposed_name: 'Project Falcon' }],
      evidence_links: [],
      candidate_visibility: [],
      stage_assessments: [
        { id: 'l-1', candidate_id: CAND, step_id: 'p5-s51', as_of: '2026-10-01T00:00:00Z' },
        { id: 'l-2', candidate_id: CAND, step_id: 'p4-s48', as_of: '2026-09-30T00:00:00Z' },
      ],
    });
    const result = await listCandidates(db, 'u');
    if (!result.ok) throw new Error('expected candidates');
    expect(result.candidates.map((c) => [c.name, c.station])).toEqual([
      ['Project Kestrel', { station: 47, title: 'Signing / Announcement Prep' }],
      ['Project Falcon', null],
    ]);
  });
});

describe('assessment histories longer than one response (audit S8)', () => {
  // 1200 newer rows sit ahead of the row that decides; a response holds at most MAX_ROWS of them.
  const newer = (n: number, over: (i: number) => Record<string, unknown>) =>
    Array.from({ length: n }, (_, i) => ({
      id: `n-${String(i).padStart(5, '0')}`,
      step_id: 'p4-s48',
      team_mailbox_id: null,
      reason_text: 'shared',
      evidence_event_ids: [],
      flags: [],
      lifecycle_suggestion: 'live',
      confidence: '0.9',
      as_of: `2026-10-${String(2 + (i % 20)).padStart(2, '0')}T10:00:00Z`,
      ...over(i),
    }));

  it('lists a candidate\'s station though another candidate\'s newer rows fill a whole response', async () => {
    const db = fakeDb({
      deal_candidates: [KESTREL, { ...KESTREL, id: 'c-falcon', proposed_name: 'Project Falcon' }],
      evidence_links: [],
      candidate_visibility: [],
      stage_assessments: [
        ...newer(1200, () => ({ candidate_id: 'c-falcon' })),
        { id: 'k-1', candidate_id: CAND, step_id: 'p5-s51', team_mailbox_id: null, as_of: '2026-09-01T00:00:00Z' },
      ],
    });
    const result = await listCandidates(db, 'u');
    if (!result.ok) throw new Error('expected candidates');
    expect(result.candidates.find((c) => c.name === 'Project Kestrel')?.station).toEqual({ station: 47, title: 'Signing / Announcement Prep' });
  });

  it('shows the scoped row furthest along the rail in the detail, past a long newer shared history', async () => {
    const scoped = { ...ASSESSMENT, id: 'z-scoped', team_mailbox_id: 'tm-1', step_id: 'p5-s51', as_of: '2026-09-01T00:00:00Z' };
    const result = await getCandidateDetail(fakeDb(rows({ stage_assessments: [...newer(1200, () => ({})), scoped] })), 'u', CAND);
    if (!result.ok || !result.detail) throw new Error('expected a detail');
    expect(result.detail.station?.stepId).toBe('p5-s51');
  });

  it('marks the deal with the scoped row, past a long newer shared history', async () => {
    const db = fakeDb({
      deals: [{ id: 'd-1' }],
      stage_assessments: [
        ...newer(1200, () => ({})),
        { id: 'z-scoped', step_id: 'p5-s51', team_mailbox_id: 'tm-1', reason_text: 'scoped', evidence_event_ids: ['e9'], flags: [], as_of: '2026-09-01T00:00:00Z' },
      ],
      corrections: [],
      milestone_events: [],
    });
    const result = await getEvidenceSuggestion(db, 'G7-1');
    if (!result.ok) throw new Error('expected a suggestion');
    expect(result.suggestion?.stepId).toBe('p5-s51');
  });
});

