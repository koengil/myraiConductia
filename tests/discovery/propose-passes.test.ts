import { describe, expect, it, vi } from 'vitest';

import { TEAM_PROPOSAL_PASS_OUTCOMES } from '@/lib/constants/discovery';
import { DEV_TENANT_ID } from '@/lib/db/tenant';
import {
  emptyPassCounts,
  LEASE_MARGIN_MS,
  SourcePasses,
  TeamNotApprovedError,
  type BeginResult,
  type PassStore,
} from '@/lib/discovery/propose/passes';
import { supabaseProposalStore } from '@/lib/discovery/propose/store';
import type { ProposalRow } from '@/lib/discovery/propose/run';

// G-01 (#173), slice 5: the worker's side of the audited team pass. SourcePasses is judged against a scripted
// PassStore; the Supabase store's mapping of the SQL definers' answers is judged against a fake rpc.

const SOURCE = '33333333-3333-4333-8333-333333333331';
const OTHER = '33333333-3333-4333-8333-333333333332';
const RUN = '22222222-2222-4222-8222-222222222222';
const FIRM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T0 = Date.parse('2026-10-22T12:00:00Z');
const at = { sourceId: SOURCE, runId: RUN };
const lease = (ms: number) => new Date(T0 + ms).toISOString();

function scripted(begin: BeginResult[], renew: BeginResult[] = []) {
  const calls: string[] = [];
  const ends: Array<{ outcome: string; counts: unknown }> = [];
  const store: PassStore = {
    async beginSource() {
      calls.push('begin');
      return begin.shift() ?? { ok: false, code: 'error' };
    },
    async renewSource() {
      calls.push('renew');
      return renew.shift() ?? { ok: false, code: 'error' };
    },
    async endSource(_t, _s, _r, outcome, counts) {
      calls.push('end');
      ends.push({ outcome, counts });
    },
    async closeLapsedPasses() {
      calls.push('sweep');
      return 0;
    },
  };
  return { store, calls, ends };
}

describe('SourcePasses', () => {
  it('begins once, renews on later pages, and judges the lease in memory with a margin', async () => {
    let now = T0;
    const s = scripted([{ ok: true, scope: 'team', leaseUntil: lease(30 * 60_000) }], [{ ok: true, scope: 'team', leaseUntil: lease(70 * 60_000) }]);
    const passes = new SourcePasses({ tenantId: DEV_TENANT_ID, store: s.store, firmIds: [FIRM], path: 'recorded', now: () => now });

    // Before begin nothing is fresh.
    expect(passes.leaseFresh(SOURCE)).toBe(false);
    expect(await passes.beginOrRenew(at)).toBe(true);
    expect(passes.leaseFresh(SOURCE)).toBe(true);

    now = T0 + 30 * 60_000 - LEASE_MARGIN_MS - 1;
    expect(passes.leaseFresh(SOURCE)).toBe(true);
    now = T0 + 30 * 60_000 - LEASE_MARGIN_MS;
    expect(passes.leaseFresh(SOURCE)).toBe(false);

    // ensureLease renews a stale lease and not a fresh one.
    expect(await passes.ensureLease(at)).toBe(true);
    expect(await passes.ensureLease(at)).toBe(true);
    expect(s.calls).toEqual(['begin', 'renew']);
    expect(passes.leaseFresh(SOURCE)).toBe(true);
  });

  it('a lease time that does not parse reads as lapsed, so the next call renews', async () => {
    const s = scripted([{ ok: true, scope: 'team', leaseUntil: 'soon' }], [{ ok: true, scope: 'team', leaseUntil: lease(30 * 60_000) }]);
    const passes = new SourcePasses({ tenantId: DEV_TENANT_ID, store: s.store, firmIds: [FIRM], path: 'recorded', now: () => T0 });
    await passes.beginOrRenew(at);
    expect(passes.leaseFresh(SOURCE)).toBe(false);
    await passes.ensureLease(at);
    expect(s.calls).toEqual(['begin', 'renew']);
  });

  it('a personal answer holds no pass: later pages do not renew, and end sends nothing', async () => {
    const s = scripted([{ ok: true, scope: 'personal' }]);
    const passes = new SourcePasses({ tenantId: DEV_TENANT_ID, store: s.store, firmIds: [], path: 'recorded' });
    expect(await passes.beginOrRenew(at)).toBe(true);
    expect(await passes.beginOrRenew(at)).toBe(true);
    expect(passes.leaseFresh(SOURCE)).toBe(true);
    await passes.end(at, 'complete');
    expect(s.calls).toEqual(['begin']);
  });

  it.each<[string, BeginResult]>([
    ['not approved', { ok: false, code: 'team_not_approved' }],
    ['an inbox not allowed', { ok: false, code: 'team_inbox_not_allowed' }],
    ['no reader', { ok: false, code: 'no_reader' }],
    ['a pass in progress', { ok: false, code: 'pass_in_progress' }],
  ])('a begin refused for %s stops the source as refused, is counted once, and sends no end', async (_label, answer) => {
    const s = scripted([answer]);
    const passes = new SourcePasses({ tenantId: DEV_TENANT_ID, store: s.store, firmIds: [FIRM], path: 'recorded' });
    expect(await passes.beginOrRenew(at)).toBe(false);
    expect(await passes.beginOrRenew(at)).toBe(false);
    expect(await passes.ensureLease(at)).toBe(false);
    expect(passes.isStopped(SOURCE)).toBe(true);
    expect(passes.refusalOf(SOURCE)).toBe('refused');
    expect(passes.refused).toBe(1);
    // A definite refusal opened no pass, so there is nothing to close.
    await passes.end(at, 'complete');
    expect(s.calls).toEqual(['begin']);
  });

  it('refuses another source on its own, and counts each stopped source once', async () => {
    const s = scripted([{ ok: false, code: 'team_not_approved' }, { ok: false, code: 'no_reader' }]);
    const passes = new SourcePasses({ tenantId: DEV_TENANT_ID, store: s.store, firmIds: [FIRM], path: 'recorded' });
    await passes.beginOrRenew(at);
    await passes.beginOrRenew({ sourceId: OTHER, runId: RUN });
    expect(passes.refused).toBe(2);
    expect(passes.isStopped('some-third-source')).toBe(false);
  });

  it('an unknown begin failure is an error outcome, and the close is still sent in case the pass opened', async () => {
    const s = scripted([{ ok: false, code: 'error' }]);
    const passes = new SourcePasses({ tenantId: DEV_TENANT_ID, store: s.store, firmIds: [FIRM], path: 'recorded' });
    expect(await passes.beginOrRenew(at)).toBe(false);
    await passes.end(at, 'complete');
    expect(s.ends).toEqual([{ outcome: 'error', counts: emptyPassCounts() }]);
  });

  it('a store that throws, or answers nothing usable, is an error answer', async () => {
    const throwing: PassStore = {
      beginSource: async () => {
        throw new Error('socket hang up');
      },
      renewSource: async () => undefined as unknown as BeginResult,
      endSource: async () => undefined,
      closeLapsedPasses: async () => 0,
    };
    const passes = new SourcePasses({ tenantId: DEV_TENANT_ID, store: throwing, firmIds: [FIRM], path: 'recorded' });
    expect(await passes.beginOrRenew(at)).toBe(false);
    expect(passes.isStopped(SOURCE)).toBe(true);

    const nothing = new SourcePasses({
      tenantId: DEV_TENANT_ID,
      store: { ...throwing, beginSource: async () => undefined as unknown as BeginResult },
      firmIds: [FIRM],
      path: 'recorded',
    });
    expect(await nothing.beginOrRenew(at)).toBe(false);
  });

  it('a renew refused after the approval went is revoked, and any other refusal or error is refused or error', async () => {
    const outcomes: string[] = [];
    for (const code of ['team_not_approved', 'team_inbox_not_allowed', 'error'] as const) {
      const s = scripted([{ ok: true, scope: 'team', leaseUntil: lease(30 * 60_000) }], [{ ok: false, code }]);
      const passes = new SourcePasses({ tenantId: DEV_TENANT_ID, store: s.store, firmIds: [FIRM], path: 'recorded', now: () => T0 });
      await passes.beginOrRenew(at);
      expect(await passes.beginOrRenew(at)).toBe(false);
      await passes.end(at, 'complete');
      outcomes.push(String(s.ends[0].outcome));
    }
    expect(outcomes).toEqual(['revoked', 'refused', 'error']);
  });

  it('closes a pass once, with the source\'s own refusal over the caller\'s outcome, and swallows a failed close', async () => {
    const s = scripted([{ ok: true, scope: 'team', leaseUntil: lease(30 * 60_000) }]);
    const passes = new SourcePasses({ tenantId: DEV_TENANT_ID, store: s.store, firmIds: [FIRM], path: 'recorded', now: () => T0 });
    await passes.beginOrRenew(at);
    const tally = { called: 3, deal: 1, notDeal: 1, invalid: 0, failed: 1 };
    passes.track(SOURCE, tally);
    passes.refuse(SOURCE, 'revoked');
    passes.refuse(SOURCE, 'error'); // the first reason stays
    await passes.end(at, 'complete');
    await passes.end(at, 'complete');
    expect(s.ends).toEqual([{ outcome: 'revoked', counts: { asked: 3, deal: 1, notDeal: 1, invalid: 0, failed: 1 } }]);

    const broken: PassStore = { ...s.store, endSource: async () => { throw new Error('boom'); } };
    const other = new SourcePasses({ tenantId: DEV_TENANT_ID, store: { ...broken, beginSource: async () => ({ ok: true, scope: 'team', leaseUntil: lease(1) }) }, firmIds: [FIRM], path: 'recorded' });
    await other.beginOrRenew(at);
    await expect(other.end(at, 'error')).resolves.toBeUndefined();
  });

  it('keeps the counts of every page tracked, live, so a close or renew sees the page in flight', async () => {
    const s = scripted([{ ok: true, scope: 'team', leaseUntil: lease(30 * 60_000) }]);
    const passes = new SourcePasses({ tenantId: DEV_TENANT_ID, store: s.store, firmIds: [FIRM], path: 'recorded', now: () => T0 });
    await passes.beginOrRenew(at);
    const page1 = { called: 1, deal: 0, notDeal: 1, invalid: 0, failed: 0 };
    const page2 = { called: 0, deal: 0, notDeal: 0, invalid: 0, failed: 0 };
    passes.track(SOURCE, page1);
    passes.track(SOURCE, page2);
    page2.called = 2;
    page2.invalid = 2;
    expect(passes.counts(SOURCE)).toEqual({ asked: 3, deal: 0, notDeal: 1, invalid: 2, failed: 0 });
    expect(passes.counts(OTHER)).toEqual(emptyPassCounts());
  });

  it('the worker can never close a pass as unclosed: that outcome is the SQL begin\'s alone', () => {
    expect(TEAM_PROPOSAL_PASS_OUTCOMES).toContain('unclosed');
    type Sendable = Parameters<PassStore['endSource']>[3];
    const sendable: Sendable = 'complete';
    // @ts-expect-error 'unclosed' is not a PassOutcome
    const unclosed: Sendable = 'unclosed';
    expect([sendable, unclosed]).toHaveLength(2);
  });
});

describe('supabaseProposalStore: the pass definers and the writer\'s refusal', () => {
  type Answer = { data: unknown; error: { code: string; message: string } | null };
  function fakeDb(answer: Answer | (() => never)) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return typeof answer === 'function' ? answer() : Promise.resolve(answer);
    });
    return { db: { rpc } as never, calls };
  }
  const err = (code: string, message: string): Answer => ({ data: null, error: { code, message } });
  const row = { contentSourceId: SOURCE, runId: RUN } as ProposalRow;

  it('begin sends the tenant, source, run, path and firm ids, and maps a team or personal answer', async () => {
    const team = fakeDb({ data: { scope: 'team', leaseUntil: lease(30 * 60_000) }, error: null });
    expect(await supabaseProposalStore(team.db).beginSource(DEV_TENANT_ID, SOURCE, RUN, 'recorded', [FIRM])).toEqual({
      ok: true,
      scope: 'team',
      leaseUntil: lease(30 * 60_000),
    });
    expect(team.calls).toEqual([
      {
        name: 'discovery_begin_proposal_source',
        args: { p_tenant: DEV_TENANT_ID, p_source: SOURCE, p_run: RUN, p_path: 'recorded', p_firm_ids: [FIRM] },
      },
    ]);
    const personal = fakeDb({ data: { scope: 'personal' }, error: null });
    expect(await supabaseProposalStore(personal.db).beginSource(DEV_TENANT_ID, SOURCE, RUN, 'verified', [])).toEqual({
      ok: true,
      scope: 'personal',
    });
  });

  it.each([
    ['42501', 'team_not_approved', 'team_not_approved'],
    ['42501', 'team_inbox_not_allowed', 'team_inbox_not_allowed'],
    ['42501', 'no_reader', 'no_reader'],
    ['55P03', 'pass_in_progress', 'pass_in_progress'],
    // The SQL's other refusals, bad input and anything unknown, all fail closed as `error`.
    ['42501', 'pass_closed', 'error'],
    ['42501', 'pass_not_open', 'error'],
    ['22023', 'discovery_begin_proposal_source: unknown path', 'error'],
    ['42501', 'permission denied for table audit_log', 'error'],
    ['XX000', 'internal error', 'error'],
  ])('begin and renew map SQLSTATE %s "%s" to %s', async (code, message, want) => {
    const { db } = fakeDb(err(code, message));
    const store = supabaseProposalStore(db);
    expect(await store.beginSource(DEV_TENANT_ID, SOURCE, RUN, 'recorded', [FIRM])).toEqual({ ok: false, code: want });
    expect(await store.renewSource(DEV_TENANT_ID, SOURCE, RUN, [FIRM], emptyPassCounts())).toEqual({ ok: false, code: want });
  });

  it.each([
    ['no data', { data: null, error: null }],
    ['an unknown scope', { data: { scope: 'both' }, error: null }],
    ['a team answer without a lease', { data: { scope: 'team' }, error: null }],
    ['a team answer with a lease that is not a time', { data: { scope: 'team', leaseUntil: 'tomorrow' }, error: null }],
  ])('begin fails closed on %s', async (_label, answer) => {
    const { db } = fakeDb(answer);
    expect(await supabaseProposalStore(db).beginSource(DEV_TENANT_ID, SOURCE, RUN, 'recorded', [FIRM])).toEqual({ ok: false, code: 'error' });
  });

  it('begin and renew never throw: a rejected call is an error answer', async () => {
    const { db } = fakeDb(() => {
      throw new Error('fetch failed');
    });
    const store = supabaseProposalStore(db);
    expect(await store.beginSource(DEV_TENANT_ID, SOURCE, RUN, 'recorded', [FIRM])).toEqual({ ok: false, code: 'error' });
    expect(await store.renewSource(DEV_TENANT_ID, SOURCE, RUN, [FIRM], emptyPassCounts())).toEqual({ ok: false, code: 'error' });
  });

  it('renew sends the firm ids and the counts', async () => {
    const { db, calls } = fakeDb({ data: { scope: 'team', leaseUntil: lease(0) }, error: null });
    const counts = { asked: 4, deal: 1, notDeal: 2, invalid: 0, failed: 1 };
    await supabaseProposalStore(db).renewSource(DEV_TENANT_ID, SOURCE, RUN, [FIRM], counts);
    expect(calls).toEqual([
      {
        name: 'discovery_renew_proposal_source',
        args: { p_tenant: DEV_TENANT_ID, p_source: SOURCE, p_run: RUN, p_firm_ids: [FIRM], p_counts: counts },
      },
    ]);
  });

  it('end sends the outcome and counts, and throws a code, never the database message, when it fails', async () => {
    const ok = fakeDb({ data: null, error: null });
    await supabaseProposalStore(ok.db).endSource(DEV_TENANT_ID, SOURCE, RUN, 'complete', emptyPassCounts());
    expect(ok.calls[0]).toEqual({
      name: 'discovery_end_proposal_source',
      args: { p_tenant: DEV_TENANT_ID, p_source: SOURCE, p_run: RUN, p_outcome: 'complete', p_counts: emptyPassCounts() },
    });
    const bad = fakeDb(err('22023', 'discovery_end_proposal_source: unknown outcome'));
    const failure = await supabaseProposalStore(bad.db).endSource(DEV_TENANT_ID, SOURCE, RUN, 'complete', emptyPassCounts()).catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('end proposal pass failed: 22023');
  });

  it('saveProposal maps the writer\'s 42501 team_not_approved to TeamNotApprovedError, and nothing else', async () => {
    const refused = fakeDb(err('42501', 'team_not_approved'));
    await expect(supabaseProposalStore(refused.db).saveProposal(DEV_TENANT_ID, row)).rejects.toBeInstanceOf(TeamNotApprovedError);

    const otherDenial = fakeDb(err('42501', 'permission denied for function discovery_record_model_proposal'));
    const denied = await supabaseProposalStore(otherDenial.db).saveProposal(DEV_TENANT_ID, row).catch((e) => e);
    expect(denied).not.toBeInstanceOf(TeamNotApprovedError);
    expect((denied as Error).message).toBe('record model proposal failed: 42501');

    const badInput = fakeDb(err('22023', 'source has no reader'));
    const invalid = await supabaseProposalStore(badInput.db).saveProposal(DEV_TENANT_ID, row).catch((e) => e);
    expect(invalid).not.toBeInstanceOf(TeamNotApprovedError);
    expect((invalid as Error).message).toBe('record model proposal failed: 22023');
  });
});
