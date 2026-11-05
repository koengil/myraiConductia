// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const requireFlagMock = vi.hoisted(() => vi.fn());
const scopedMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: requireFlagMock }));
vi.mock('@/lib/api/v1/httpScoped', () => ({ requireApiUserScoped: scopedMock }));

import { GET } from '@/app/api/v1/discovery/model-proposals/route';
import { TABLE } from '@/lib/constants/tables';
import type { ModelProposalRow } from '@/lib/discovery/propose/group';
import { messageKey } from '@/lib/discovery/propose/key';
import { proposedStepFor } from '@/lib/discovery/propose/station';
import { coveredLinks, isCovered, listModelProposals } from '@/lib/discovery/propose/read';

const CANDIDATE = '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071';
const HIDDEN = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';

/** A row as the reader selects it: its id and source are read for the covered link, the tenant for the owner check. */
type Row = ModelProposalRow & { id: string; content_source_id: string; tenant_id: string };

const TENANT = '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';

/** The viewer's own personal mailbox, and a team inbox whose rows may reach them after G-01. */
const OWN_SOURCE = '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f';
const TEAM_SOURCE = '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b';

/** One row, by its message id; its row id is derived from it. */
const row = ({ msg, ...over }: Partial<Row> & { msg: string }): Row => ({
  id: `p-${msg}`,
  message_key: messageKey(msg),
  outcome: 'deal',
  deal_key: 'm:project-heron',
  deal_name: 'Project Heron',
  candidate_id: null,
  phase: 'phase-2',
  sent_at: '2026-03-02T10:00:00Z',
  party_domains: ['harbourline.example'],
  content_source_id: OWN_SOURCE,
  tenant_id: TENANT,
  ...over,
});

const ROWS = [
  row({ msg: '<a@x>' }),
  row({ msg: '<b@x>', phase: 'phase-3', sent_at: '2026-03-04T10:00:00Z' }),
  row({ msg: '<c@x>', deal_key: `c:${CANDIDATE}`, deal_name: 'Project Kestrel', candidate_id: CANDIDATE, sent_at: '2026-02-01T00:00:00Z' }),
  row({ msg: '<d@x>', deal_key: `c:${HIDDEN}`, deal_name: 'Project Osprey', candidate_id: HIDDEN, sent_at: '2026-01-01T00:00:00Z' }),
];

type Call = {
  table: string;
  select?: string;
  eq?: [string, unknown];
  in?: [string, unknown[]];
  is?: [string, unknown];
  range?: [number, number];
};

/**
 * A PostgREST builder double that records each query and answers per table, as RLS would for the caller. Its rpc
 * answers app_owns_mailbox_source: true for the sources in `owned` (by default the viewer's own mailbox only), and
 * discovery_candidate_origins (the definer batch read) from `origins`: a candidate listed there gets that origin, one
 * left out gets no row (the definer would not answer for it). Without `origins`, every candidate asked is `rules`.
 */
function fakeDb(
  answers: Record<string, { data: unknown; error: { message: string } | null }>,
  opts: {
    maxRows?: number;
    owned?: string[];
    rpcError?: string;
    origins?: Record<string, 'model_proposal' | 'rules'>;
    originsError?: string;
  } = {},
) {
  const calls: Call[] = [];
  const rpcCalls: Array<[string, Record<string, unknown>]> = [];
  const owned = new Set(opts.owned ?? [OWN_SOURCE]);
  const db = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push([name, args]);
      if (opts.rpcError) return Promise.resolve({ data: null, error: { message: opts.rpcError } });
      if (name === 'discovery_candidate_origins') {
        if (opts.originsError) return Promise.resolve({ data: null, error: { message: opts.originsError } });
        const asked = args.p_candidate_ids as string[];
        const data = asked
          .filter((id) => opts.origins === undefined || id in opts.origins)
          .map((id) => ({ candidate_id: id, origin: opts.origins?.[id] ?? 'rules' }));
        return Promise.resolve({ data, error: null });
      }
      return Promise.resolve({ data: owned.has(args.p_source as string), error: null });
    },
    from(table: string) {
      const call: Call = { table };
      calls.push(call);
      const answer = () => {
        const a = answers[table] ?? { data: [], error: null };
        // A paged read answers its range only, as PostgREST does.
        if (!call.range || !Array.isArray(a.data)) return Promise.resolve(a);
        const to = Math.min(call.range[1] + 1, call.range[0] + (opts.maxRows ?? Number.POSITIVE_INFINITY));
        return Promise.resolve({ data: a.data.slice(call.range[0], to), error: a.error });
      };
      const builder = {
        select(columns: string) {
          call.select = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          call.eq = [column, value];
          return builder;
        },
        in(column: string, values: unknown[]) {
          call.in = [column, values];
          return builder;
        },
        is(column: string, value: unknown) {
          call.is = [column, value];
          return builder;
        },
        order() {
          return builder;
        },
        range(from: number, to: number) {
          call.range = [from, to];
          return builder;
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => answer().then(resolve, reject),
      };
      return builder;
    },
  };
  return { db: db as never, calls, rpcCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireFlagMock.mockResolvedValue(null);
});

describe('GET /api/v1/discovery/model-proposals', () => {
  it('404s when deal_discovery is off, before authenticating', async () => {
    requireFlagMock.mockImplementation(async (key: string) =>
      key === 'deal_discovery' ? NextResponse.json({ error: 'Not found' }, { status: 404 }) : null,
    );
    expect((await GET()).status).toBe(404);
    expect(scopedMock).not.toHaveBeenCalled();
  });

  it('404s when the demo flag is off, before authenticating', async () => {
    requireFlagMock.mockImplementation(async (key: string) =>
      key === 'discovery_model_proposals_demo' ? NextResponse.json({ error: 'Not found' }, { status: 404 }) : null,
    );
    expect((await GET()).status).toBe(404);
    expect(requireFlagMock).toHaveBeenCalledWith('deal_discovery');
    expect(requireFlagMock).toHaveBeenCalledWith('discovery_model_proposals_demo');
    expect(scopedMock).not.toHaveBeenCalled();
  });

  it('passes an authentication failure through', async () => {
    scopedMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await GET()).status).toBe(401);
  });

  it("reads under the caller's own scoped client and answers the grouped deals", async () => {
    const { db, calls } = fakeDb({
      [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: ROWS, error: null },
      [TABLE.DEAL_CANDIDATES]: { data: [{ id: CANDIDATE, promoted_deal_id: null }], error: null },
    });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposals: Array<Record<string, unknown>>; dismissedCount: number };
    expect(Object.keys(body)).toEqual(['proposals', 'dismissedCount']);
    expect(body.dismissedCount).toBe(0);
    expect(body.proposals).toEqual([
      {
        dealKey: 'm:project-heron',
        name: 'Project Heron',
        candidateId: null,
        phase: { id: 'phase-3', name: 'Marketing & First-Round Bids' },
        emails: 2,
        firstSentAt: '2026-03-02T10:00:00Z',
        lastSentAt: '2026-03-04T10:00:00Z',
        parties: ['harbourline.example'],
        promoted: false,
        actionable: true,
        // The station the model proposes for the highest phase, and how many emails it placed there (G-02b).
        proposed: { stepId: proposedStepFor('phase-3'), phase: 'phase-3', placed: 1, of: 2 },
        accept: null,
        origin: null,
      },
      expect.objectContaining({
        dealKey: `c:${CANDIDATE}`,
        candidateId: CANDIDATE,
        emails: 1,
        promoted: false,
        proposed: null,
        accept: null,
        origin: 'rules',
      }),
    ]);
    // The caller cannot see the Osprey candidate, so neither its name nor its key leaves the route (review M2).
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`Osprey|${HIDDEN}`));
    // Live deal rows only: an archived row (its candidate went away, review #509-3) is never read.
    expect(calls[0]).toMatchObject({ table: TABLE.DISCOVERY_MODEL_PROPOSALS, eq: ['outcome', 'deal'], is: ['archived_at', null] });
    // No message key, content hash, model detail or row timestamp leaves the route.
    expect(JSON.stringify(body)).not.toMatch(/message_key|item_hash|[0-9a-f]{64}|created_at|createdAt/);
    // Nor does a row id, a source id or a tenant id: they feed the covered link and the owner check only.
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`p-<|${OWN_SOURCE}|${TENANT}|content_source_id|tenant_id`));
  });

  it('asks the owner check as the caller, once per source, and 500s with a fixed message when it fails', async () => {
    const { db, rpcCalls } = fakeDb({ [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [ROWS[0], ROWS[1]], error: null } });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    expect((await GET()).status).toBe(200);
    expect(rpcCalls).toEqual([
      ['app_owns_mailbox_source', { p_source: OWN_SOURCE, p_tenant: TENANT, p_user: 'u-storm' }],
    ]);

    const failing = fakeDb({ [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: ROWS, error: null } }, { rpcError: 'boom' });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db: failing.db });
    const res = await GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('boom');
  });

  it('500s with a fixed message when the read fails', async () => {
    const { db } = fakeDb({ [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: null, error: { message: 'boom' } } });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    const res = await GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('boom');
  });
});

describe('listModelProposals', () => {
  it('selects only the deal rows and no text column', async () => {
    const { db, calls } = fakeDb({ [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [], error: null } });
    expect(await listModelProposals(db)).toEqual({ ok: true, proposals: [], dismissedCount: 0 });
    // No row, so nothing to cover: the dismissals are not read either.
    expect(calls).toHaveLength(1);
    expect(calls[0].select).not.toMatch(/item_hash|subject|body|address|response_id|model/);
  });

  it('asks which linked candidates the caller can see, once', async () => {
    const { db, calls } = fakeDb({
      [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: ROWS, error: null },
      [TABLE.DEAL_CANDIDATES]: { data: [], error: null },
    });
    const result = await listModelProposals(db);
    // Neither candidate is visible: both of their groups are dropped, the model-named one stays.
    expect(result.ok && result.proposals.map((g) => g.dealKey)).toEqual(['m:project-heron']);
    expect(calls.filter((c) => c.table === TABLE.DEAL_CANDIDATES)).toEqual([
      expect.objectContaining({ in: ['id', [CANDIDATE, HIDDEN]] }),
    ]);
  });

  it('drops a group whose candidate was deleted, though its rows keep the key (review M2)', async () => {
    const orphan = row({ msg: '<e@x>', deal_key: `c:${HIDDEN}`, deal_name: 'Project Osprey', candidate_id: null });
    const { db } = fakeDb({
      [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [orphan], error: null },
      [TABLE.DEAL_CANDIDATES]: { data: [], error: null },
    });
    expect(await listModelProposals(db)).toEqual({ ok: true, proposals: [], dismissedCount: 0 });
  });

  it('pages through every visible row, past the 1,000-row cap (review M4)', async () => {
    const many = Array.from({ length: 1_001 }, (_, i) => row({ msg: `<m-${i}@x>` }));
    const { db, calls } = fakeDb({ [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: many, error: null } });
    const result = await listModelProposals(db);
    expect(result.ok && result.proposals).toMatchObject([{ dealKey: 'm:project-heron', emails: 1_001 }]);
    // It stops only on an empty page.
    const proposalPages = (list: Call[]) => list.filter((c) => c.table === TABLE.DISCOVERY_MODEL_PROPOSALS).map((c) => c.range);
    expect(proposalPages(calls)).toEqual([
      [0, 999],
      [1000, 1999],
      [1001, 2000],
    ]);

    const small = fakeDb({ [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: many.slice(0, 5), error: null } });
    const paged = await listModelProposals(small.db, { pageSize: 2 });
    expect(paged.ok && paged.proposals[0].emails).toBe(5);
    expect(proposalPages(small.calls)).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
      [5, 6],
    ]);
  });

  it('reads every row when the server caps a response below the page size (hosted max_rows, review on #512)', async () => {
    const many = Array.from({ length: 1_001 }, (_, i) => row({ msg: `<cap-${i}@x>` }));
    const capped = fakeDb({ [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: many, error: null } }, { maxRows: 300 });
    const result = await listModelProposals(capped.db);
    expect(result.ok && result.proposals[0].emails).toBe(1_001);
    // Four pages of at most 300 rows, moving on by the rows each returned, then one empty page.
    expect(capped.calls.filter((c) => c.table === TABLE.DISCOVERY_MODEL_PROPOSALS).map((c) => c.range?.[0])).toEqual([
      0, 300, 600, 900, 1001,
    ]);
  });

  it('opens to actions only the groups whose rows all sit on a personal mailbox the caller owns (TH1-3)', async () => {
    const heronTeam = row({ msg: '<t@x>', content_source_id: TEAM_SOURCE, sent_at: '2026-03-08T10:00:00Z' });
    const wren = row({ msg: '<w@x>', deal_key: 'm:project-wren', deal_name: 'Project Wren', content_source_id: TEAM_SOURCE });
    const { db } = fakeDb({
      [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [ROWS[0], heronTeam, wren, ROWS[2]], error: null },
      [TABLE.DEAL_CANDIDATES]: { data: [{ id: CANDIDATE, promoted_deal_id: null }], error: null },
    });
    const result = await listModelProposals(db, { userId: 'u-storm' });
    expect(result.ok && Object.fromEntries(result.proposals.map((g) => [g.dealKey, g.actionable]))).toEqual({
      // An own row and a team row: the dismiss RPC would cover only part of it, so the group stays closed.
      'm:project-heron': false,
      // Team rows only.
      'm:project-wren': false,
      // The caller's own mailbox only.
      [`c:${CANDIDATE}`]: true,
    });
  });

  it('opens nothing without the caller id, and asks nothing', async () => {
    const { db, rpcCalls } = fakeDb({ [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [ROWS[0]], error: null } });
    const result = await listModelProposals(db);
    expect(result.ok && result.proposals.map((g) => g.actionable)).toEqual([false]);
    expect(rpcCalls).toEqual([]);
  });

  describe('the accept state of an m: group (G-02b, #173)', () => {
    const heronAccept = (over: Record<string, unknown> = {}) => ({
      deal_key: 'm:project-heron',
      state: 'pending',
      email_count: 2,
      failure_code: null,
      requested_at: '2026-03-10T10:00:00Z',
      ...over,
    });
    const heron = async (accepts: unknown[], opts: { pageSize?: number } = {}) => {
      const { db, calls } = fakeDb({
        [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [ROWS[0], ROWS[1]], error: null },
        [TABLE.DISCOVERY_MODEL_PROPOSAL_ACCEPTS]: { data: accepts, error: null },
      });
      const result = await listModelProposals(db, { userId: 'u-storm', ...opts });
      return { group: result.ok ? result.proposals[0] : undefined, calls };
    };

    it('says pending while a request is live, with the emails to be read', async () => {
      for (const state of ['pending', 'running', 'storing', 'stored']) {
        const { group } = await heron([heronAccept({ state })]);
        expect(group).toMatchObject({ dealKey: 'm:project-heron', accept: { state: 'pending', requested: 2 } });
      }
    });

    it('says failed with the fixed code, and nothing when none was asked', async () => {
      const failed = await heron([heronAccept({ state: 'failed', failure_code: 'none_readable' })]);
      expect(failed.group?.accept).toEqual({ state: 'failed', code: 'none_readable' });
      expect((await heron([])).group?.accept).toBeNull();
    });

    it('reads the accepts of the caller, by state, without the snapshot', async () => {
      const { calls } = await heron([heronAccept()]);
      const read = calls.find((c) => c.table === TABLE.DISCOVERY_MODEL_PROPOSAL_ACCEPTS);
      expect(read).toMatchObject({ in: ['state', ['pending', 'running', 'storing', 'stored', 'failed']] });
      expect(read?.select).not.toMatch(/message_keys|item_hashes|proposal_ids|claim|storing_keys|candidate/);
    });

    it('reads every page of the accepts, as it does the rows', async () => {
      const others = Array.from({ length: 5 }, (_, i) => heronAccept({ deal_key: `m:other-${i}`, state: 'failed' }));
      const { group, calls } = await heron([...others, heronAccept({ email_count: 7 })], { pageSize: 2 });
      expect(group?.accept).toEqual({ state: 'pending', requested: 7 });
      expect(calls.filter((c) => c.table === TABLE.DISCOVERY_MODEL_PROPOSAL_ACCEPTS).map((c) => c.range)).toEqual([
        [0, 1],
        [2, 3],
        [4, 5],
        [6, 7],
      ]);
    });

    it('gives a team group neither a proposal nor an accept state, and does not read the accepts for it', async () => {
      const wren = row({ msg: '<w@x>', deal_key: 'm:project-wren', deal_name: 'Project Wren', content_source_id: TEAM_SOURCE });
      const heronTeam = row({ msg: '<t@x>', content_source_id: TEAM_SOURCE });
      const { db, calls } = fakeDb({
        [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [wren, heronTeam, ROWS[0]], error: null },
        [TABLE.DISCOVERY_MODEL_PROPOSAL_ACCEPTS]: {
          data: [heronAccept(), heronAccept({ deal_key: 'm:project-wren' })],
          error: null,
        },
      });
      const result = await listModelProposals(db, { userId: 'u-storm' });
      expect(result.ok && result.proposals.map((g) => [g.dealKey, g.actionable, g.proposed, g.accept])).toEqual([
        ['m:project-heron', false, null, null],
        ['m:project-wren', false, null, null],
      ]);
      expect(calls.some((c) => c.table === TABLE.DISCOVERY_MODEL_PROPOSAL_ACCEPTS)).toBe(false);
    });

    it('does not read the accepts for a c: group, or without the caller id', async () => {
      const kestrel = row({ msg: '<k@x>', deal_key: `c:${CANDIDATE}`, deal_name: 'Project Kestrel', candidate_id: CANDIDATE });
      const owned = fakeDb({
        [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [kestrel], error: null },
        [TABLE.DEAL_CANDIDATES]: { data: [{ id: CANDIDATE, promoted_deal_id: null }], error: null },
      });
      const result = await listModelProposals(owned.db, { userId: 'u-storm' });
      expect(result.ok && result.proposals.map((g) => [g.actionable, g.proposed, g.accept])).toEqual([[true, null, null]]);
      expect(owned.calls.some((c) => c.table === TABLE.DISCOVERY_MODEL_PROPOSAL_ACCEPTS)).toBe(false);

      const anonymous = fakeDb({ [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [ROWS[0]], error: null } });
      await listModelProposals(anonymous.db);
      expect(anonymous.calls.some((c) => c.table === TABLE.DISCOVERY_MODEL_PROPOSAL_ACCEPTS)).toBe(false);
    });

    it('reports a failed accept read', async () => {
      const { db } = fakeDb({
        [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [ROWS[0]], error: null },
        [TABLE.DISCOVERY_MODEL_PROPOSAL_ACCEPTS]: { data: null, error: { message: 'nope' } },
      });
      expect(await listModelProposals(db, { userId: 'u-storm' })).toEqual({ ok: false, error: 'nope' });
    });
  });

  it('reports a failed candidate read', async () => {
    const { db } = fakeDb({
      [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: ROWS, error: null },
      [TABLE.DEAL_CANDIDATES]: { data: null, error: { message: 'nope' } },
    });
    expect(await listModelProposals(db)).toEqual({ ok: false, error: 'nope' });
  });
});

describe('dismissed proposals (G-02a, #173)', () => {
  // Heron's first row was read by its dismissal; its second was not (written, or committed, after the read).
  const HERON_SEEN = row({ msg: '<h1@x>' });
  const HERON_UNSEEN = row({ msg: '<h2@x>', sent_at: '2026-03-06T10:00:00Z' });
  const KESTREL = row({ msg: '<k1@x>', deal_key: `c:${CANDIDATE}`, deal_name: 'Project Kestrel', candidate_id: CANDIDATE });
  /** A live dismissal as the dismiss RPC writes it: on the row's source, of its key, listing the rows it read. */
  const dismissal = (...rows: Row[]) => ({
    content_source_id: rows[0].content_source_id,
    deal_key: rows[0].deal_key!,
    proposal_ids: rows.map((r) => r.id),
  });
  const DISMISSALS = [
    dismissal(HERON_SEEN),
    dismissal(KESTREL),
    // Another deal's dismissal covers nothing here.
    { content_source_id: OWN_SOURCE, deal_key: 'm:project-wren', proposal_ids: ['p-<w@x>'] },
  ];

  it('drops the rows a dismissal lists, keeps the ones it never read, and counts the dismissed deals', async () => {
    const { db, calls } = fakeDb({
      [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [HERON_SEEN, HERON_UNSEEN, KESTREL], error: null },
      [TABLE.DISCOVERY_MODEL_PROPOSAL_DISMISSALS]: { data: DISMISSALS, error: null },
      [TABLE.DEAL_CANDIDATES]: { data: [{ id: CANDIDATE, promoted_deal_id: null }], error: null },
    });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposals: Array<Record<string, unknown>>; dismissedCount: number };
    // Heron shows from its unread row only; Kestrel's one row is covered, so its group is gone.
    expect(body.proposals).toEqual([
      expect.objectContaining({ dealKey: 'm:project-heron', emails: 1, firstSentAt: '2026-03-06T10:00:00Z' }),
    ]);
    // Two deals hold a dismissed row: Heron (with an unread row too) and Kestrel.
    expect(body.dismissedCount).toBe(2);
    // A count only: the dismissed-only deal's name, key and candidate never leave the route, nor does a link.
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`Kestrel|${CANDIDATE}|proposal_ids|p-<`));
    // Live dismissals only, read under the caller's own session: a restored one covers nothing.
    expect(calls.find((c) => c.table === TABLE.DISCOVERY_MODEL_PROPOSAL_DISMISSALS)).toMatchObject({
      select: 'content_source_id, deal_key, proposal_ids',
      is: ['restored_at', null],
    });
  });

  it("never hides a row of another source with the same key, such as a team inbox's (audit D2)", async () => {
    const TEAM_HERON = row({ msg: '<t1@x>', content_source_id: TEAM_SOURCE, sent_at: '2026-03-08T10:00:00Z' });
    const { db } = fakeDb({
      [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [HERON_SEEN, TEAM_HERON], error: null },
      [TABLE.DISCOVERY_MODEL_PROPOSAL_DISMISSALS]: {
        data: [
          dismissal(HERON_SEEN),
          // Listing the team row on the personal source, or under another key, covers nothing.
          { content_source_id: OWN_SOURCE, deal_key: 'm:project-heron', proposal_ids: [TEAM_HERON.id] },
          { content_source_id: TEAM_SOURCE, deal_key: 'm:project-wren', proposal_ids: [TEAM_HERON.id] },
        ],
        error: null,
      },
    });
    const result = await listModelProposals(db);
    // The personal row is covered; the team row of the same key still shows.
    expect(result.ok && result.proposals).toMatchObject([
      { dealKey: 'm:project-heron', emails: 1, firstSentAt: '2026-03-08T10:00:00Z' },
    ]);
    expect(result.ok && result.dismissedCount).toBe(1);
  });

  it('counts no dismissed deal whose candidate the caller can no longer see', async () => {
    const { db } = fakeDb({
      [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [KESTREL], error: null },
      [TABLE.DISCOVERY_MODEL_PROPOSAL_DISMISSALS]: { data: DISMISSALS, error: null },
      [TABLE.DEAL_CANDIDATES]: { data: [], error: null },
    });
    expect(await listModelProposals(db)).toEqual({ ok: true, proposals: [], dismissedCount: 0 });
  });

  it('marks a group promoted when its candidate is already a mandate, and never a model-named one', async () => {
    const { db, calls } = fakeDb({
      [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [HERON_SEEN, KESTREL], error: null },
      [TABLE.DEAL_CANDIDATES]: { data: [{ id: CANDIDATE, promoted_deal_id: 'deal-kestrel-mandate' }], error: null },
    });
    const result = await listModelProposals(db);
    expect(result.ok && result.proposals.map((g) => [g.dealKey, g.promoted])).toEqual([
      ['m:project-heron', false],
      [`c:${CANDIDATE}`, true],
    ]);
    expect(calls.find((c) => c.table === TABLE.DEAL_CANDIDATES)?.select).toBe('id, promoted_deal_id');
    // The deal id itself never leaves the reader.
    expect(JSON.stringify(result)).not.toContain('deal-kestrel-mandate');
  });

  describe("a c: group's origin, read with candidateOrigins (G-02b)", () => {
    const MODEL = '4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f70';
    const falcon = row({ msg: '<f@x>', deal_key: `c:${MODEL}`, deal_name: 'Project Falcon', candidate_id: MODEL });
    const candidates = {
      [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [falcon, KESTREL], error: null },
      [TABLE.DEAL_CANDIDATES]: {
        data: [
          { id: MODEL, promoted_deal_id: null },
          { id: CANDIDATE, promoted_deal_id: null },
        ],
        error: null,
      },
    };
    const origins = (result: Awaited<ReturnType<typeof listModelProposals>>) =>
      result.ok ? Object.fromEntries(result.proposals.map((g) => [g.dealKey, g.origin])) : result;

    it('is model_proposal for a model-origin candidate, else rules, asked of the definer for the visible c: ids only', async () => {
      const { db, rpcCalls } = fakeDb(candidates, { origins: { [MODEL]: 'model_proposal', [CANDIDATE]: 'rules' } });
      const result = await listModelProposals(db);
      expect(origins(result)).toEqual({ [`c:${MODEL}`]: 'model_proposal', [`c:${CANDIDATE}`]: 'rules' });
      const asked = rpcCalls.filter(([name]) => name === 'discovery_candidate_origins');
      expect(asked).toHaveLength(1);
      expect([...(asked[0][1].p_candidate_ids as string[])].sort()).toEqual([MODEL, CANDIDATE].sort());
      // The reader never selects the cluster key, so it cannot reach a response.
      expect(JSON.stringify(result)).not.toMatch(/model:|cluster_key|codename:/);
    });

    it("gives a rules survivor that a model: candidate was merged into the model_proposal origin (the definer follows merges)", async () => {
      // The survivor's own key is a codename key; the definer answers model_proposal through the merge ancestry.
      const { db } = fakeDb(candidates, { origins: { [MODEL]: 'model_proposal', [CANDIDATE]: 'model_proposal' } });
      expect(origins(await listModelProposals(db))).toEqual({
        [`c:${MODEL}`]: 'model_proposal',
        [`c:${CANDIDATE}`]: 'model_proposal',
      });
    });

    it('gives a candidate the definer does not answer for no origin, never rules', async () => {
      const { db } = fakeDb(candidates, { origins: { [MODEL]: 'model_proposal' } });
      const result = await listModelProposals(db);
      expect(origins(result)).toEqual({ [`c:${MODEL}`]: 'model_proposal', [`c:${CANDIDATE}`]: null });
      // The group still shows; only its origin is withheld.
      expect(result.ok && result.proposals).toHaveLength(2);
    });

    it('asks nothing of the definer when no c: group is visible', async () => {
      const { db, rpcCalls } = fakeDb({ [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [KESTREL], error: null } });
      expect(await listModelProposals(db)).toEqual({ ok: true, proposals: [], dismissedCount: 0 });
      expect(rpcCalls.filter(([name]) => name === 'discovery_candidate_origins')).toEqual([]);
    });

    it('reports a failed origin read as a failed list, like every other read', async () => {
      const { db } = fakeDb(candidates, { originsError: 'origin boom' });
      expect(await listModelProposals(db)).toEqual({ ok: false, error: 'origin boom' });
    });
  });

  it('pages through every live dismissal, as it does the rows', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      content_source_id: OWN_SOURCE,
      deal_key: `m:other-${i}`,
      proposal_ids: [`p-<other-${i}>`],
    }));
    const { db, calls } = fakeDb({
      [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [HERON_SEEN], error: null },
      [TABLE.DISCOVERY_MODEL_PROPOSAL_DISMISSALS]: { data: [...many, DISMISSALS[0]], error: null },
    });
    // The Heron dismissal is the last row of the last page, and still covers.
    expect(await listModelProposals(db, { pageSize: 2 })).toEqual({ ok: true, proposals: [], dismissedCount: 1 });
    expect(calls.filter((c) => c.table === TABLE.DISCOVERY_MODEL_PROPOSAL_DISMISSALS).map((c) => c.range)).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ]);
  });

  it('reports a failed dismissal read', async () => {
    const { db } = fakeDb({
      [TABLE.DISCOVERY_MODEL_PROPOSALS]: { data: [HERON_SEEN], error: null },
      [TABLE.DISCOVERY_MODEL_PROPOSAL_DISMISSALS]: { data: null, error: { message: 'nope' } },
    });
    expect(await listModelProposals(db)).toEqual({ ok: false, error: 'nope' });
  });
});

describe('the covered rule: the link the dismiss RPC writes', () => {
  const at = { id: 'p-1', content_source_id: OWN_SOURCE, deal_key: 'm:project-heron' };
  const links = coveredLinks([{ content_source_id: OWN_SOURCE, deal_key: 'm:project-heron', proposal_ids: ['p-1', 'p-2'] }]);

  it('covers a row a live dismissal on its source, of its key, lists', () => {
    expect(isCovered(at, links)).toBe(true);
    expect(isCovered({ ...at, id: 'p-2' }, links)).toBe(true);
  });

  it('covers nothing the dismissal does not list, on another source or under another key', () => {
    expect(isCovered({ ...at, id: 'p-3' }, links)).toBe(false);
    expect(isCovered({ ...at, content_source_id: TEAM_SOURCE }, links)).toBe(false);
    // The writer re-ran the row in place under another key: it no longer matches its dismissal.
    expect(isCovered({ ...at, deal_key: 'm:project-heronx' }, links)).toBe(false);
    expect(isCovered({ ...at, deal_key: null }, links)).toBe(false);
    expect(isCovered(at, coveredLinks([]))).toBe(false);
  });
});
