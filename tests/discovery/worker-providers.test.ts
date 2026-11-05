// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The worker runs one pass per provider that has an active registration (C2).
// The guard, the reader and the mirror are stubbed at the @/lib/mailboxAccess
// door; what is under test is the worker's loop and its summary.
const access = vi.hoisted(() => ({
  readableMailboxes: vi.fn(),
  guardedContentSource: vi.fn(),
  createGuardedContentSource: vi.fn(),
  createLiveAllowlistMirror: vi.fn(),
  // The real wrapper, for the team tests that read through the guard itself (set when the module above loads).
  realCreateGuardedContentSource: null as null | typeof import('@/lib/mailboxAccess').createGuardedContentSource,
}));
// The guard builds its own service client, so its seam is the admin-client module: `guard.rpc` answers mailbox_guard_check
// for the team tests that use the real wrapper. Every other test here stubs the reader at the door above and never reaches it.
const guard = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseAdminClient: () => ({ rpc: guard.rpc }) }));
vi.mock('@/lib/mailboxAccess', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mailboxAccess')>('@/lib/mailboxAccess');
  access.realCreateGuardedContentSource = actual.createGuardedContentSource;
  return {
    ...actual,
    readableMailboxes: access.readableMailboxes,
    guardedContentSource: access.guardedContentSource,
    createGuardedContentSource: access.createGuardedContentSource,
    createFixtureAllowlistMirror: () => ({ listMembers: async () => [] }),
    createLiveAllowlistMirror: access.createLiveAllowlistMirror,
  };
});
// The demo flag behind model proposals (G-02b #173) stays off: the accept step has its own suites.
vi.mock('@/lib/flags/isEnabled', () => ({ isEnabled: async (key: string) => key !== 'discovery_model_proposals_demo' }));
// The per-source sync (#243) reads every page the guarded reader gives it and
// stores nothing: the loop, the guard's refusals and the summary are under test.
vi.mock('../../worker/sync', async () => {
  const actual = await vi.importActual<typeof import('../../worker/sync')>('../../worker/sync');
  return {
    ...actual,
    loadRoutingContext: async () => new actual.RoutingContext(),
    discoverTenant: async () => [],
    syncSource: async (_db: unknown, { source, reader }: Parameters<typeof actual.syncSource>[1]) => {
      for await (const page of reader.backfill(source, source.deltaCheckpoint)) void page;
      return { status: 'complete', mode: 'backfill', pages: 0, itemsRead: 0, storedKeys: new Set<string>(), screening: { screened: 2, flagged: 1 }, checkpointAdvanced: false, routing: actual.emptyRoutingTally(), fullRead: true };
    },
  };
});

import { MAILBOX_PROVIDER, READER_MODE, type DriftStatus, type MailboxProvider } from '@/lib/constants/discovery';
import { SourceArchivedError } from '@/lib/discovery/persist';
import { MailboxAccessRefusedError, UnsupportedSourceError } from '@/lib/mailboxAccess';
import { createWorkerHandlers, GRAPH_MODE_NEEDS_MIRROR_MESSAGE, REGISTRATION_TABLE, runOnce } from '../../worker/classify';
import { recordingRpc } from '../helpers/readerPassRpc';
import { NO_EXCLUSION } from '../google/exclusion';

const TENANT = '11111111-1111-4111-8111-111111111111';
const MS_SOURCE = '33333333-3333-4333-8333-333333333331';
const MS_REFUSED = '33333333-3333-4333-8333-333333333332';
const GG_SOURCE = '33333333-3333-4333-8333-333333333333';

type SourceSpec = { id: string; provider: MailboxProvider; address: string; kind?: 'mailbox' | 'sharepoint_site'; backfillSince?: string | null; teamMailboxId?: string | null };
const SOURCES: SourceSpec[] = [
  { id: MS_SOURCE, provider: 'microsoft', address: 'a@bank.example' },
  { id: MS_REFUSED, provider: 'microsoft', address: 'b@bank.example' },
  { id: GG_SOURCE, provider: 'google', address: 'c@bank.example' },
];

type TaintRow = { source_id: string; provider_thread_id: string; rule_id: string };

/**
 * A fake service client: `active` names the registration tables that hold an active row for the tenant,
 * `policies` the exclusion policy versions the tenant has, newest first (none by default), and `taints` the thread
 * taints stored (read by source id, in pages).
 */
function fakeDb(
  active: string[],
  sources: SourceSpec[] = SOURCES,
  policies: Array<{ version: number; rules: unknown }> = [],
  taints: TaintRow[] = [],
) {
  const selected: string[] = [];
  const from = vi.fn((table: string) => {
    let rows: unknown[] = [];
    const filters: Array<[string, unknown]> = [];
    if (table === 'discovery_exclusion_policies') {
      rows = policies;
    } else if (table === 'discovery_thread_taints') {
      rows = taints;
    } else if (table === 'content_sources') {
      rows = sources.map((s) => ({
        id: s.id,
        tenant_id: TENANT,
        kind: s.kind ?? 'mailbox',
        provider: s.provider,
        address: s.address,
        owner_user_id: null,
        delta_checkpoint: null,
        backfill_since: s.backfillSince ?? null,
        team_mailbox_id: s.teamMailboxId ?? null,
      }));
    } else if (table === 'feature_flags') {
      rows = [{ enabled: true }];
    } else if (active.includes(table)) {
      rows = [{ tenant_id: TENANT }];
    }
    const builder: Record<string, unknown> = {
      select: (columns?: string) => {
        if (table === 'content_sources' && typeof columns === 'string') selected.push(columns);
        return builder;
      },
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      },
      not: () => builder,
      // The first-read claim (#353) of a Gmail backfill from nothing: update ... is ... select, read back as rows.
      update: () => builder,
      is: () => builder,
      order: () => builder,
      range: (first: number, last: number) =>
        Promise.resolve({
          data: (rows as Array<Record<string, unknown>>).filter((row) => filters.every(([column, value]) => row[column] === value)).slice(first, last + 1),
          error: null,
        }),
      limit: (n: number) => {
        rows = rows.slice(0, n);
        return builder;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return builder;
  });
  // Every attempt records a reader pass (#370): a recording rpc that accepts both events.
  const passes = recordingRpc();
  return { db: { from, rpc: passes.rpc } as unknown as SupabaseClient, from, events: passes.events, selected };
}

function group(status: DriftStatus) {
  return { status, readable: new Set<string>(), missingInGroup: [], extraInGroup: [], providerCheck: () => null };
}

const originalGoogleTable = REGISTRATION_TABLE.google;
beforeEach(() => {
  access.readableMailboxes.mockReset();
  access.guardedContentSource.mockReset();
  access.createGuardedContentSource.mockReset();
  access.createGuardedContentSource.mockImplementation((inner: unknown) => inner);
  access.createLiveAllowlistMirror.mockReset();
  access.createLiveAllowlistMirror.mockImplementation(() => ({ listMembers: async () => [] }));
  access.readableMailboxes.mockImplementation(async () => group('in_sync'));
  access.guardedContentSource.mockImplementation((target: { kind: string; provider: string }) => ({
    kind: target.kind,
    backfill: async function* (source: { id: string }) {
      if (source.id === MS_REFUSED) throw new MailboxAccessRefusedError(TENANT, 'b@bank.example', 'no_consent', 'provider_read');
      yield { items: [], nextCheckpoint: null };
    },
    delta: async function* () {},
  }));
});
afterEach(() => {
  REGISTRATION_TABLE.google = originalGoogleTable;
});

// C8 / C28: the reader is built per source, inside the source's own try. A fixture site has no reader, and
// that must skip the site, not abort the pass and lose the mailbox read before it.
describe('a source the reader cannot serve is skipped, never aborting the pass (C8)', () => {
  const SITE = '33333333-3333-4333-8333-333333333339';
  const SITE_SPEC: SourceSpec = { id: SITE, provider: 'microsoft', address: 'bank.sharepoint.com:/sites/Deals', kind: 'sharepoint_site' };

  beforeEach(() => {
    access.guardedContentSource.mockImplementation((target: { kind: string; provider: string }) => {
      if (target.kind === 'sharepoint_site') {
        throw new UnsupportedSourceError(target.kind, target.provider, 'fixture', 'The fixture reader serves mailboxes only, not sharepoint_site');
      }
      return {
        kind: target.kind,
        backfill: async function* () {
          yield { items: [], nextCheckpoint: null };
        },
        delta: async function* () {},
      };
    });
  });

  it('reads the mailbox and skips the site, in either order', async () => {
    for (const specs of [[SOURCES[0], SITE_SPEC], [SITE_SPEC, SOURCES[0]]]) {
      access.guardedContentSource.mockClear();
      const { db } = fakeDb(['graph_reader_registrations'], specs);
      const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
      if (summary.status !== 'ok') throw new Error('unreachable');
      // Both were asked for a reader; the mailbox's was built and read, the site's could not be.
      expect(access.guardedContentSource).toHaveBeenCalledTimes(2);
      expect(summary.skipped).toEqual([{ sourceId: SITE, kind: 'sharepoint_site', reason: 'unsupported_reader' }]);
      expect(summary.refused).toEqual([]);
      expect(summary.sources).toBe(2);
    }
  });

  it('the queue handler skips such a source instead of failing the job, and queues nothing', async () => {
    const { db } = fakeDb(['graph_reader_registrations'], [SITE_SPEC]);
    const boss = { send: vi.fn() };
    const handlers = createWorkerHandlers({ db, boss, provider: READER_MODE.FIXTURE });
    await expect(handlers.sync({ tenantId: TENANT, sourceId: SITE })).resolves.toEqual({
      status: 'skipped',
      skipReason: 'unsupported_reader',
    });
    expect(boss.send).not.toHaveBeenCalled();
  });

  it('still fails the pass on any other error building a reader, rather than hiding a wiring fault', async () => {
    access.guardedContentSource.mockImplementation(() => {
      throw new Error("a live Microsoft reader needs the tenant's reader registration");
    });
    const { db } = fakeDb(['graph_reader_registrations'], [SOURCES[0]]);
    await expect(runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE })).rejects.toThrow('a live Microsoft reader needs');
  });
});

describe('the worker hands the reader the source window (#353)', () => {
  it('selects backfill_since and passes it on the source the reader backfills, in both worker paths', async () => {
    const backfilled: Array<{ id: string; backfillSince?: string | null }> = [];
    access.guardedContentSource.mockImplementation((target: { kind: string }) => ({
      kind: target.kind,
      backfill: async function* (source: { id: string; backfillSince?: string | null }) {
        backfilled.push(source);
        yield { items: [], nextCheckpoint: null };
      },
      delta: async function* () {},
    }));
    const spec: SourceSpec = { ...SOURCES[2], backfillSince: '2026-07-17' };

    const pass = fakeDb(['google_reader_registrations'], [spec]);
    await runOnce({ tenantId: TENANT, db: pass.db, provider: READER_MODE.FIXTURE });
    const job = fakeDb(['google_reader_registrations'], [spec]);
    await createWorkerHandlers({ db: job.db, boss: { send: vi.fn() }, provider: READER_MODE.FIXTURE }).sync({ tenantId: TENANT, sourceId: GG_SOURCE });

    expect(backfilled.map((source) => [source.id, source.backfillSince])).toEqual([
      [GG_SOURCE, '2026-07-17'],
      [GG_SOURCE, '2026-07-17'],
    ]);
    // The source reads (SOURCE_COLUMNS, the ones that name the cursor) carry the window column; a halt check need not.
    for (const { selected } of [pass, job]) {
      const sourceReads = selected.filter((columns) => columns.split(', ').includes('delta_checkpoint'));
      expect(sourceReads.length).toBeGreaterThan(0);
      for (const columns of sourceReads) expect(columns.split(', ')).toContain('backfill_since');
    }
  });

  it('hands the guard a first-read claim for a Gmail source only, and none on a re-read (audit r1 item 1)', async () => {
    const claims = new Map<string, boolean>();
    access.guardedContentSource.mockImplementation((target: { kind: string; provider: string }, _mode: unknown, ctx: { claimFirstRead?: unknown }) => {
      claims.set(target.provider, typeof ctx.claimFirstRead === 'function');
      return { kind: target.kind, backfill: async function* () {}, delta: async function* () {} };
    });

    const live = fakeDb(['graph_reader_registrations', 'google_reader_registrations'], [SOURCES[0], SOURCES[2]]);
    await runOnce({ tenantId: TENANT, db: live.db, provider: READER_MODE.FIXTURE });
    expect(Object.fromEntries(claims)).toEqual({ microsoft: false, google: true });

    claims.clear();
    const recount = fakeDb(['google_reader_registrations'], [SOURCES[2]]);
    await runOnce({ tenantId: TENANT, db: recount.db, provider: READER_MODE.FIXTURE, reread: true });
    expect(Object.fromEntries(claims)).toEqual({ google: false });
  });
});

describe('the worker reads once per provider with an active registration (C2)', () => {
  it('a tenant with only a Graph registration reads Graph only: the Google registration is looked up and not found (#259)', async () => {
    expect(REGISTRATION_TABLE.google).toBe('google_reader_registrations');
    const { db, from } = fakeDb(['graph_reader_registrations']);
    const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });

    expect(access.readableMailboxes).toHaveBeenCalledTimes(1);
    expect(access.readableMailboxes.mock.calls[0][2]).toBe(MAILBOX_PROVIDER.MICROSOFT);
    // Not the live mirror: the fixture group read records presence, as before.
    expect(access.readableMailboxes.mock.calls[0][4]).toEqual({ recordPresence: true });
    expect(from).toHaveBeenCalledWith('google_reader_registrations');
    expect(summary).toMatchObject({ status: 'ok', sources: 3, allowlist: 'in_sync' });
    if (summary.status !== 'ok') throw new Error('unreachable');
    expect(summary.providers.map((p) => p.provider)).toEqual(['microsoft']);
    // The google source is not read: no reader is built for it, and the pass says why.
    expect(access.guardedContentSource.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'mailbox', provider: 'microsoft' },
      { kind: 'mailbox', provider: 'microsoft' },
    ]);
    expect(summary.refused).toEqual([
      { sourceId: MS_REFUSED, reason: 'no_consent' },
      { sourceId: GG_SOURCE, reason: 'registration_inactive' },
    ]);
  });

  it('builds the live group mirror in live mode for a Google-only tenant, and never in fixture mode (#259, D68 T1)', async () => {
    const live = fakeDb(['google_reader_registrations']);
    await runOnce({ tenantId: TENANT, db: live.db, provider: READER_MODE.LIVE });
    expect(access.createLiveAllowlistMirror).toHaveBeenCalledTimes(1);
    // The provider check runs against that mirror, for the Google provider only.
    expect(access.readableMailboxes).toHaveBeenCalledTimes(1);
    expect(access.readableMailboxes.mock.calls[0][2]).toBe(MAILBOX_PROVIDER.GOOGLE);
    expect(access.readableMailboxes.mock.calls[0][3]).toBe(access.createLiveAllowlistMirror.mock.results[0].value);
    expect(access.guardedContentSource.mock.calls.map((c) => [c[0].provider, c[1]])).toEqual([[MAILBOX_PROVIDER.GOOGLE, READER_MODE.LIVE]]);

    access.createLiveAllowlistMirror.mockClear();
    const fixture = fakeDb(['google_reader_registrations']);
    await runOnce({ tenantId: TENANT, db: fixture.db, provider: READER_MODE.FIXTURE });
    expect(access.createLiveAllowlistMirror).not.toHaveBeenCalled();
  });

  it('live mode builds the live mirror for a Microsoft tenant; Google and Microsoft passes both run (#275 lifts D68)', async () => {
    REGISTRATION_TABLE.google = 'google_reader_registrations';
    const { db } = fakeDb(['graph_reader_registrations', 'google_reader_registrations']);
    const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.LIVE });
    expect(access.createLiveAllowlistMirror).toHaveBeenCalledTimes(1);
    const mirror = access.createLiveAllowlistMirror.mock.results[0].value;
    // Each provider's group is read through that one live mirror.
    expect(access.readableMailboxes.mock.calls.map((c) => [c[2], c[3]])).toEqual([
      [MAILBOX_PROVIDER.MICROSOFT, mirror],
      [MAILBOX_PROVIDER.GOOGLE, mirror],
    ]);
    // Reads only: a live Microsoft group read records no presence, so group removal (#461, D93) never reaches it.
    expect(access.readableMailboxes.mock.calls.map((c) => c[4])).toEqual([{ recordPresence: false }, { recordPresence: true }]);
    expect(access.guardedContentSource.mock.calls.map((c) => [c[0].provider, c[1]])).toEqual([
      [MAILBOX_PROVIDER.MICROSOFT, READER_MODE.LIVE],
      [MAILBOX_PROVIDER.MICROSOFT, READER_MODE.LIVE],
      [MAILBOX_PROVIDER.GOOGLE, READER_MODE.LIVE],
    ]);
    if (summary.status !== 'ok') throw new Error('unreachable');
    expect(summary.providers.map((p) => p.provider)).toEqual(['microsoft', 'google']);
    expect(summary.refused).toEqual([{ sourceId: MS_REFUSED, reason: 'no_consent' }]);
  });

  it("hands each Microsoft source its group's read key next to its provider check, in both worker paths (#275 R4)", async () => {
    const providerCheck = () => null;
    const readKey = () => ({ upn: 'a@bank.example', id: '00000000-0000-4000-8000-000000000101' });
    access.readableMailboxes.mockImplementation(async () => ({ ...group('in_sync'), providerCheck, readKey }));
    const { db } = fakeDb(['graph_reader_registrations'], [SOURCES[0]]);
    await runOnce({ tenantId: TENANT, db, provider: READER_MODE.LIVE });
    const handlers = createWorkerHandlers({ db: fakeDb(['graph_reader_registrations'], [SOURCES[0]]).db, boss: { send: vi.fn() }, provider: READER_MODE.LIVE });
    await handlers.sync({ tenantId: TENANT, sourceId: MS_SOURCE });
    const contexts = access.guardedContentSource.mock.calls.map((c) => c[2]);
    expect(contexts).toHaveLength(2);
    for (const ctx of contexts) {
      expect(ctx.providerCheck).toBe(providerCheck);
      expect(ctx.readKey).toBe(readKey);
      // A live Microsoft read authenticates with the tenant's registration.
      expect(ctx.graphRegistration).toBeDefined();
    }
  });

  it('reads a live SharePoint site source too, under the site guard, in both worker paths (#275 R6)', async () => {
    const SITE = '33333333-3333-4333-8333-333333333339';
    const site: SourceSpec = { id: SITE, provider: 'microsoft', address: 'bank.sharepoint.com:/sites/Deals', kind: 'sharepoint_site' };
    const pass = fakeDb(['graph_reader_registrations'], [site]);
    const summary = await runOnce({ tenantId: TENANT, db: pass.db, provider: READER_MODE.LIVE });
    if (summary.status !== 'ok') throw new Error('unreachable');
    expect(summary.refused).toEqual([]);
    expect(summary.skipped).toEqual([]);
    const job = fakeDb(['graph_reader_registrations'], [site]);
    await createWorkerHandlers({ db: job.db, boss: { send: vi.fn() }, provider: READER_MODE.LIVE }).sync({ tenantId: TENANT, sourceId: SITE });
    // The real reader is built for the site in live mode (its guard is the site guard; readers.test.ts reads one).
    expect(access.guardedContentSource.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [{ kind: 'sharepoint_site', provider: 'microsoft' }, READER_MODE.LIVE],
      [{ kind: 'sharepoint_site', provider: 'microsoft' }, READER_MODE.LIVE],
    ]);
  });

  it('skips the tenant when no provider has an active registration', async () => {
    const { db, events } = fakeDb([]);
    const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    // Every active source still gets its reader pass, ended skipped / no_provider (#370).
    expect(summary).toEqual({
      tenantId: TENANT,
      status: 'skipped',
      reason: 'no_active_registration',
      passes: SOURCES.map((source) => ({ sourceId: source.id, passId: expect.any(String) })),
    });
    const ends = events().filter((e) => e.event === 'finished');
    expect(ends.map((e) => [e.detail.status, e.detail.reason])).toEqual(SOURCES.map(() => ['skipped', 'no_provider']));
    expect(access.readableMailboxes).not.toHaveBeenCalled();
    expect(access.guardedContentSource).not.toHaveBeenCalled();
  });

  it('loops over every registered provider: its own group, its own sources, its own results', async () => {
    REGISTRATION_TABLE.google = 'google_reader_registrations';
    access.readableMailboxes.mockImplementation(async (_db: unknown, _tenant: string, provider: string) =>
      group(provider === 'google' ? 'drift' : 'in_sync'),
    );
    const { db } = fakeDb(['graph_reader_registrations', 'google_reader_registrations']);
    const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });

    expect(access.readableMailboxes.mock.calls.map((c) => c[2])).toEqual(['microsoft', 'google']);
    expect(access.guardedContentSource.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'mailbox', provider: 'microsoft' },
      { kind: 'mailbox', provider: 'microsoft' },
      { kind: 'mailbox', provider: 'google' },
    ]);
    if (summary.status !== 'ok') throw new Error('unreachable');
    expect(summary.providers).toEqual([
      { provider: 'microsoft', allowlist: 'in_sync', sources: 2, refused: [{ sourceId: MS_REFUSED, reason: 'no_consent' }] },
      { provider: 'google', allowlist: 'drift', sources: 1, refused: [] },
    ]);
    // One flat list for callers that do not care which provider, and the worst group state.
    expect(summary.refused).toEqual([{ sourceId: MS_REFUSED, reason: 'no_consent' }]);
    expect(summary.allowlist).toBe('drift');
  });

  it('hands each source the provider check of its own group', async () => {
    REGISTRATION_TABLE.google = 'google_reader_registrations';
    const msCheck = () => null;
    const ggCheck = () => 'not_in_provider_group' as const;
    access.readableMailboxes.mockImplementation(async (_db: unknown, _tenant: string, provider: string) => ({
      ...group('in_sync'),
      providerCheck: provider === 'google' ? ggCheck : msCheck,
    }));
    const { db } = fakeDb(['graph_reader_registrations', 'google_reader_registrations']);
    await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    const contexts = access.guardedContentSource.mock.calls.map((c) => [c[0].provider, c[2].providerCheck]);
    expect(contexts).toEqual([
      ['microsoft', msCheck],
      ['microsoft', msCheck],
      ['google', ggCheck],
    ]);
  });

  it('reports the worst group state: unavailable outranks drift outranks in_sync', async () => {
    REGISTRATION_TABLE.google = 'google_reader_registrations';
    access.readableMailboxes.mockImplementation(async (_db: unknown, _tenant: string, provider: string) =>
      group(provider === 'google' ? 'unavailable' : 'drift'),
    );
    const { db } = fakeDb(['graph_reader_registrations', 'google_reader_registrations']);
    const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    if (summary.status !== 'ok') throw new Error('unreachable');
    expect(summary.allowlist).toBe('unavailable');
  });

  it('wraps an overriding reader in the guard, never reading it raw (#243)', async () => {
    const override = { kind: 'mailbox', backfill: async function* () {}, delta: async function* () {} };
    const readerFor = vi.fn(() => override);
    const { db } = fakeDb(['graph_reader_registrations'], [SOURCES[0]]);
    await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE, readerFor: readerFor as never });
    expect(access.guardedContentSource).not.toHaveBeenCalled();
    expect(access.createGuardedContentSource).toHaveBeenCalledTimes(1);
    const [inner, ctx, provider] = access.createGuardedContentSource.mock.calls[0];
    expect(inner).toBe(override);
    expect(ctx).toMatchObject({ tenantId: TENANT });
    expect(typeof ctx.providerCheck).toBe('function');
    expect(provider).toBe(MAILBOX_PROVIDER.MICROSOFT);
  });
});

// #275 R6: graph mode is the cassette replay's, which brings its own mirror, and it gets an implicit empty exclusion
// policy for Microsoft. Without a mirror it still refuses before it reads anything, so it never builds the live
// mirror. Fixture mode and a given mirror are unaffected.
describe('graph mode without a mirror still refuses before reading (#275 R6)', () => {
  const MESSAGE = GRAPH_MODE_NEEDS_MIRROR_MESSAGE;

  it('runOnce refuses with the actionable message, before the group, a reader or a source is touched', async () => {
    const { db, from, events } = fakeDb(['graph_reader_registrations']);
    await expect(runOnce({ tenantId: TENANT, db, provider: READER_MODE.GRAPH })).rejects.toThrow(MESSAGE);
    expect(access.readableMailboxes).not.toHaveBeenCalled();
    expect(access.guardedContentSource).not.toHaveBeenCalled();
    expect(access.createGuardedContentSource).not.toHaveBeenCalled();
    // The source list is read once, as metadata, so each source's reader pass is recorded (#370); every pass
    // then ends failed, and no source is read.
    expect(from.mock.calls.filter(([table]) => table === 'content_sources')).toHaveLength(1);
    const ends = events().filter((e) => e.event === 'finished');
    expect(ends).toHaveLength(SOURCES.length);
    for (const end of ends) expect(end.detail).toMatchObject({ status: 'failed', pages: 0, fetched: 0, stored: 0 });
  });

  it('the queue handlers and the worker refuse at construction, so nothing is queued or read', () => {
    const { db, from } = fakeDb(['graph_reader_registrations']);
    const boss = { send: vi.fn() };
    expect(() => createWorkerHandlers({ db, boss, provider: READER_MODE.GRAPH })).toThrow(MESSAGE);
    expect(boss.send).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('a live worker reads a Microsoft and a Google source, each through the live mirror, behind the guard (#259, #275)', async () => {
    const boss = { send: vi.fn() };
    const both = ['graph_reader_registrations', 'google_reader_registrations'];
    // (The fake client answers a source lookup with its first source, so each job gets its own.)
    const microsoft = createWorkerHandlers({ db: fakeDb(both, [SOURCES[0]]).db, boss, provider: READER_MODE.LIVE });
    await microsoft.sync({ tenantId: TENANT, sourceId: MS_SOURCE });
    const google = createWorkerHandlers({ db: fakeDb(both, [SOURCES[2]]).db, boss, provider: READER_MODE.LIVE });
    await google.sync({ tenantId: TENANT, sourceId: GG_SOURCE });
    expect(access.readableMailboxes.mock.calls.map((c) => c[2])).toEqual([MAILBOX_PROVIDER.MICROSOFT, MAILBOX_PROVIDER.GOOGLE]);
    expect(access.guardedContentSource.mock.calls.map((c) => c[0].provider)).toEqual([MAILBOX_PROVIDER.MICROSOFT, MAILBOX_PROVIDER.GOOGLE]);
  });

  it('the message has no em-dash and says what graph mode needs', () => {
    expect(MESSAGE).toBe('graph mode replays a cassette; give it a mirror.');
    expect(MESSAGE).not.toMatch(/[–—]/);
  });

  it('fixture mode and a graph worker that is given a mirror are unaffected', async () => {
    const { db } = fakeDb(['graph_reader_registrations'], [SOURCES[0]]);
    // The run summary sums each source's incoming-mail screening counts (plan v5 W3): one source here.
    await expect(runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE })).resolves.toMatchObject({
      status: 'ok',
      screening: { screened: 2, flagged: 1 },
    });
    const mirror = { listMembers: async () => [] };
    await expect(runOnce({ tenantId: TENANT, db, provider: READER_MODE.GRAPH, mirror })).resolves.toMatchObject({ status: 'ok' });
  });
});

// PR #300 round 4 (Codex 3): a source archived while a page was in flight refuses that page's writes. The pass
// reports the source as skipped (it is not a guard refusal and not a failed run), reads the others, and any other
// error still fails the pass.
describe('a source archived while its page was in flight is skipped, not a crash (Codex 3)', () => {
  beforeEach(() => {
    access.guardedContentSource.mockImplementation((target: { kind: string; provider: string }) => ({
      kind: target.kind,
      backfill: async function* (source: { id: string }) {
        if (source.id === MS_REFUSED) throw new SourceArchivedError();
        yield { items: [], nextCheckpoint: null };
      },
      delta: async function* () {},
    }));
  });

  it('runOnce reports it as skipped with source_archived, reads the other sources, and refuses nothing', async () => {
    const { db } = fakeDb(['graph_reader_registrations'], [SOURCES[1], SOURCES[0]]);
    const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    if (summary.status !== 'ok') throw new Error('unreachable');
    expect(summary.skipped).toEqual([{ sourceId: MS_REFUSED, kind: 'mailbox', reason: 'source_archived' }]);
    expect(summary.refused).toEqual([]);
    expect(summary.sources).toBe(2);
  });

  it('the queue handler returns it as skipped instead of failing the job, and queues nothing', async () => {
    const { db } = fakeDb(['graph_reader_registrations'], [SOURCES[1]]);
    const boss = { send: vi.fn() };
    const handlers = createWorkerHandlers({ db, boss, provider: READER_MODE.FIXTURE });
    await expect(handlers.sync({ tenantId: TENANT, sourceId: MS_REFUSED })).resolves.toEqual({
      status: 'skipped',
      skipReason: 'source_archived',
      // What the pass read before the archive stopped it (#370 R1): nothing here.
      pages: 0,
      fetched: 0,
      excluded: 0,
      stored: 0,
    });
    expect(boss.send).not.toHaveBeenCalled();
  });

  it('skips an archived Google source the same way, in its own provider pass (#259)', async () => {
    access.guardedContentSource.mockImplementation((target: { kind: string; provider: string }) => ({
      kind: target.kind,
      backfill: async function* (source: { id: string }) {
        if (source.id === GG_SOURCE) throw new SourceArchivedError();
        yield { items: [], nextCheckpoint: null };
      },
      delta: async function* () {},
    }));
    const { db } = fakeDb(['graph_reader_registrations', REGISTRATION_TABLE.google as string], [SOURCES[0], SOURCES[2]]);
    const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    if (summary.status !== 'ok') throw new Error('unreachable');
    expect(summary.skipped).toEqual([{ sourceId: GG_SOURCE, kind: 'mailbox', reason: 'source_archived' }]);
    expect(summary.refused).toEqual([]);
    const own = fakeDb(['graph_reader_registrations', REGISTRATION_TABLE.google as string], [SOURCES[2]]);
    const handlers = createWorkerHandlers({ db: own.db, boss: { send: vi.fn() }, provider: READER_MODE.FIXTURE });
    await expect(handlers.sync({ tenantId: TENANT, sourceId: GG_SOURCE })).resolves.toEqual({
      status: 'skipped',
      skipReason: 'source_archived',
      pages: 0,
      fetched: 0,
      excluded: 0,
      stored: 0,
    });
  });

  it('any other error still fails the pass and the job', async () => {
    access.guardedContentSource.mockImplementation((target: { kind: string }) => ({
      kind: target.kind,
      backfill: async function* () {
        throw new Error('discovery persist: source_items insert failed (XX000)');
      },
      delta: async function* () {},
    }));
    const { db } = fakeDb(['graph_reader_registrations'], [SOURCES[0]]);
    await expect(runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE })).rejects.toThrow('XX000');
    const handlers = createWorkerHandlers({ db, boss: { send: vi.fn() }, provider: READER_MODE.FIXTURE });
    await expect(handlers.sync({ tenantId: TENANT, sourceId: MS_SOURCE })).rejects.toThrow('XX000');
  });
});

// #263: the tenant's exclusion policy is loaded once per provider pass and rides on the guarded reader context.
describe('the worker loads the tenant exclusion policy once per pass (#263)', () => {
  const RULES = [
    { id: 'outside-counsel', category: 'never_read', scope: 'message', kind: 'participant_domain', domains: ['counsel.example'] },
  ];
  const BOTH = ['graph_reader_registrations', 'google_reader_registrations'];

  it('reads the policy table once per provider pass, never per source, and hands the version to every source', async () => {
    REGISTRATION_TABLE.google = 'google_reader_registrations';
    const { db, from } = fakeDb(BOTH, SOURCES, [{ version: 2, rules: RULES }]);
    await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    // Two providers, three sources: two policy reads.
    expect(from.mock.calls.filter(([table]) => table === 'discovery_exclusion_policies')).toHaveLength(2);
    const contexts = access.guardedContentSource.mock.calls.map((c) => c[2].exclusion);
    expect(contexts).toHaveLength(3);
    for (const exclusion of contexts) expect(exclusion.policy).toMatchObject({ version: 2, rules: [{ id: 'outside-counsel' }] });
  });

  it('runs a tenant with no policy under version 0 in fixture mode, and passes "missing" on in live mode', async () => {
    const fixture = fakeDb(['google_reader_registrations'], [SOURCES[2]]);
    await runOnce({ tenantId: TENANT, db: fixture.db, provider: READER_MODE.FIXTURE });
    expect(access.guardedContentSource.mock.calls[0][2].exclusion.policy).toEqual({ version: 0, rules: [] });

    access.guardedContentSource.mockClear();
    const live = fakeDb(['google_reader_registrations'], [SOURCES[2]]);
    await runOnce({ tenantId: TENANT, db: live.db, provider: READER_MODE.LIVE });
    expect(access.guardedContentSource.mock.calls[0][2].exclusion.policy).toEqual({ unavailable: 'missing' });
  });

  it('passes "missing" on for a Google source in graph mode with a mirror, in both worker paths: that mode reads live Gmail (audit C1)', async () => {
    const mirror = { listMembers: async () => [] };
    const google = fakeDb(['google_reader_registrations'], [SOURCES[2]]);
    await runOnce({ tenantId: TENANT, db: google.db, provider: READER_MODE.GRAPH, mirror });
    expect(access.guardedContentSource.mock.calls[0][2].exclusion.policy).toEqual({ unavailable: 'missing' });

    access.guardedContentSource.mockClear();
    const handlers = createWorkerHandlers({ db: google.db, boss: { send: vi.fn() }, provider: READER_MODE.GRAPH, mirror });
    await handlers.sync({ tenantId: TENANT, sourceId: GG_SOURCE });
    expect(access.guardedContentSource.mock.calls[0][2].exclusion.policy).toEqual({ unavailable: 'missing' });

    // A Microsoft source in the same mode (the Graph cassette) still reads under version 0: R9 refuses any rule there.
    access.guardedContentSource.mockClear();
    const microsoft = fakeDb(['graph_reader_registrations'], [SOURCES[0]]);
    await runOnce({ tenantId: TENANT, db: microsoft.db, provider: READER_MODE.GRAPH, mirror });
    expect(access.guardedContentSource.mock.calls[0][2].exclusion.policy).toEqual({ version: 0, rules: [] });
  });

  it('passes "invalid" on, in any mode, when the current version fails validation', async () => {
    const bad = [{ id: 'x', category: 'hr', scope: 'conversation', kind: 'participant_domain', domains: ['counsel.example'] }];
    const { db } = fakeDb(['google_reader_registrations'], [SOURCES[2]], [{ version: 4, rules: bad }]);
    await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    expect(access.guardedContentSource.mock.calls[0][2].exclusion.policy).toEqual({ unavailable: 'invalid' });
  });

  it('loads the policy in the queued sync handler too', async () => {
    const { db } = fakeDb(['google_reader_registrations'], [SOURCES[2]], [{ version: 3, rules: RULES }]);
    const handlers = createWorkerHandlers({ db, boss: { send: vi.fn() }, provider: READER_MODE.FIXTURE });
    await handlers.sync({ tenantId: TENANT, sourceId: GG_SOURCE });
    expect(access.guardedContentSource.mock.calls[0][2].exclusion.policy).toMatchObject({ version: 3 });
  });

  it('refuses a Gmail override reader under a non-empty policy, in both worker paths, before it is read or wrapped', async () => {
    const read = vi.fn();
    const noncompliant = {
      kind: 'mailbox',
      backfill: async function* () {
        read();
        // A reader that ignores the policy and hands back the excluded message in full.
        yield { items: [{ id: 'privileged' }], nextCheckpoint: null };
      },
      delta: async function* () {},
    };
    const readerFor = vi.fn(() => noncompliant);
    const withRules = fakeDb(['google_reader_registrations'], [SOURCES[2]], [{ version: 1, rules: RULES }]);
    await expect(
      runOnce({ tenantId: TENANT, db: withRules.db, provider: READER_MODE.FIXTURE, readerFor: readerFor as never }),
    ).rejects.toThrow('an override reader cannot enforce the exclusion policy');
    const handlers = createWorkerHandlers({
      db: withRules.db,
      boss: { send: vi.fn() },
      provider: READER_MODE.FIXTURE,
      readerFor: readerFor as never,
    });
    await expect(handlers.sync({ tenantId: TENANT, sourceId: GG_SOURCE })).rejects.toThrow('an override reader cannot enforce');
    expect(read).not.toHaveBeenCalled();
    expect(access.createGuardedContentSource).not.toHaveBeenCalled();

    // Under version 0 (the tests, and the Graph cassette replay) an override is unchanged.
    const none = fakeDb(['google_reader_registrations'], [SOURCES[2]]);
    await runOnce({ tenantId: TENANT, db: none.db, provider: READER_MODE.FIXTURE, readerFor: readerFor as never });
    expect(access.createGuardedContentSource).toHaveBeenCalledTimes(1);
  });
});

// #263, phase 3: a thread-scoped rule's taint is per source (a thread id is per mailbox), read right before the
// source's reader is built, in both worker entry points, and never for a policy that cannot use it.
describe('the worker reads the thread taint per source, before its reader (#263)', () => {
  const PRIVILEGED = { id: 'privileged', category: 'privileged', scope: 'thread', kind: 'label', names: ['Privileged'] };
  const COUNSEL = { id: 'counsel', category: 'never_read', scope: 'message', kind: 'participant_domain', domains: ['counsel.example'] };
  const GG_SECOND = '33333333-3333-4333-8333-333333333334';
  const TWO_GOOGLE: SourceSpec[] = [SOURCES[2], { id: GG_SECOND, provider: 'google', address: 'd@bank.example' }];
  const TAINTS: TaintRow[] = [
    { source_id: GG_SOURCE, provider_thread_id: 't1', rule_id: 'privileged' },
    { source_id: GG_SOURCE, provider_thread_id: 't1', rule_id: 'dropped-rule' },
    { source_id: GG_SOURCE, provider_thread_id: 't2', rule_id: 'counsel' },
    { source_id: GG_SECOND, provider_thread_id: 'u9', rule_id: 'privileged' },
  ];
  const taintReads = (from: ReturnType<typeof fakeDb>['from']) =>
    from.mock.calls.flatMap(([table], i) => (table === 'discovery_thread_taints' ? [from.mock.invocationCallOrder[i]] : []));

  it("hands each source its own mailbox's taint, kept to the current version's thread-scoped rules, and reads it before the reader is built", async () => {
    const { db, from } = fakeDb(['google_reader_registrations'], TWO_GOOGLE, [{ version: 3, rules: [PRIVILEGED, COUNSEL] }], TAINTS);
    await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    const [first, second] = access.guardedContentSource.mock.calls.map((c) => c[2].exclusion.threadTaint as Map<string, Set<string>>);
    // t1's dropped rule is gone from the policy, and t2's rule is message-scoped now: neither applies.
    expect(first).toEqual(new Map([['t1', new Set(['privileged'])]]));
    expect(second).toEqual(new Map([['u9', new Set(['privileged'])]]));
    const reads = taintReads(from);
    const built = access.guardedContentSource.mock.invocationCallOrder;
    expect(reads).toHaveLength(2);
    expect(reads[0]).toBeLessThan(built[0]);
    expect(built[0]).toBeLessThan(reads[1]);
    expect(reads[1]).toBeLessThan(built[1]);
    // The policy itself is still loaded once per provider pass, not per source.
    expect(from.mock.calls.filter(([table]) => table === 'discovery_exclusion_policies')).toHaveLength(1);
  });

  it('reads it in the queued sync handler too, for the one source the job names', async () => {
    const { db, from } = fakeDb(['google_reader_registrations'], [SOURCES[2]], [{ version: 3, rules: [PRIVILEGED] }], TAINTS);
    const handlers = createWorkerHandlers({ db, boss: { send: vi.fn() }, provider: READER_MODE.FIXTURE });
    await handlers.sync({ tenantId: TENANT, sourceId: GG_SOURCE });
    expect(access.guardedContentSource.mock.calls[0][2].exclusion.threadTaint).toEqual(new Map([['t1', new Set(['privileged'])]]));
    expect(taintReads(from)).toHaveLength(1);
    expect(taintReads(from)[0]).toBeLessThan(access.guardedContentSource.mock.invocationCallOrder[0]);
  });

  it('asks for no taint when the policy has no thread-scoped rule, or is unavailable', async () => {
    for (const [policies, mode] of [
      [[{ version: 3, rules: [COUNSEL] }], READER_MODE.FIXTURE],
      [[], READER_MODE.FIXTURE],
      [[], READER_MODE.LIVE],
      [[{ version: 4, rules: [{ ...PRIVILEGED, scope: 'conversation' }] }], READER_MODE.FIXTURE],
    ] as const) {
      access.guardedContentSource.mockClear();
      const { db, from } = fakeDb(['google_reader_registrations'], [SOURCES[2]], [...policies], TAINTS);
      await runOnce({ tenantId: TENANT, db, provider: mode });
      expect(taintReads(from), JSON.stringify(policies)).toEqual([]);
      expect(access.guardedContentSource.mock.calls[0][2].exclusion.threadTaint.size).toBe(0);
    }
  });

  it('gives the override check the same per-source pass, so a thread-scoped policy still refuses an override', async () => {
    const { db } = fakeDb(['google_reader_registrations'], [SOURCES[2]], [{ version: 3, rules: [PRIVILEGED] }], TAINTS);
    const override = { kind: 'mailbox', backfill: async function* () {}, delta: async function* () {} };
    await expect(
      runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE, readerFor: (() => override) as never }),
    ).rejects.toThrow('an override reader cannot enforce the exclusion policy');
  });
});

// The team inbox check (#581, design R7): a source that belongs to a registration is checked against the Google
// Directory before its reader is built, from both entry points. The database says whether the check is due and keeps
// the outcome; the hook itself is unit-tested in team-mailbox-check.test.ts.
describe('a team source is checked before its reader is built, from both entry points (#581)', () => {
  const TEAM_SOURCE = '33333333-3333-4333-8333-333333333340';
  const TEAM_ID = '44444444-4444-4444-8444-444444444444';
  const TEAM_SPEC: SourceSpec = { id: TEAM_SOURCE, provider: 'google', address: 'deals@bank.example', teamMailboxId: TEAM_ID };
  const CHECK_RPCS = ['discovery_team_mailbox_check_due', 'discovery_record_team_mailbox_check'];

  /** The fake db with the two check RPCs answered and recorded; every other rpc is the pass record's. */
  function withCheckRpcs(spec: SourceSpec[], due: boolean, address = 'deals@bank.example') {
    const base = fakeDb(['google_reader_registrations'], spec);
    const checks = vi.fn((name: string, args: Record<string, unknown>) => {
      const data =
        name === 'discovery_team_mailbox_check_due'
          ? { due, teamMailboxId: TEAM_ID, address, pinnedId: null }
          : { recorded: true, id: args.p_id };
      return Promise.resolve({ data, error: null });
    });
    // Every rpc in the order it was made, so a test can place the check against the group read (the drift record).
    const order: string[] = [];
    const rpc = (name: string, args: Record<string, unknown>) => {
      order.push(name);
      return CHECK_RPCS.includes(name) ? checks(name, args) : (base.db as unknown as { rpc: (n: string, a: unknown) => unknown }).rpc(name, args);
    };
    const db = { ...(base.db as unknown as object), rpc } as unknown as SupabaseClient;
    return { ...base, db, checks, order };
  }
  const verified = () => ({ verify: vi.fn(async () => ({ status: 'verified' as const, directoryUserId: 'dir-1' })) });

  it('runOnce: asks whether the check is due, verifies, records, and only then builds the reader', async () => {
    const { db, checks, selected } = withCheckRpcs([TEAM_SPEC], true);
    const teamVerifier = verified();
    await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE, teamVerifier });

    expect(checks.mock.calls.map(([name]) => name)).toEqual(CHECK_RPCS);
    expect(checks.mock.calls[0][1]).toEqual({ p_source_id: TEAM_SOURCE });
    expect(teamVerifier.verify).toHaveBeenCalledWith(TENANT, 'deals@bank.example', null);
    expect(checks.mock.calls[1][1]).toEqual({ p_id: TEAM_ID, p_status: 'verified', p_reason: null, p_directory_user_id: 'dir-1' });
    expect(access.guardedContentSource).toHaveBeenCalledTimes(1);
    expect(checks.mock.invocationCallOrder[1]).toBeLessThan(access.guardedContentSource.mock.invocationCallOrder[0]);
    // The source read carries the registration column.
    expect(selected.some((columns) => columns.split(', ').includes('team_mailbox_id'))).toBe(true);
  });

  it('the queue handler: the same check, before the reader', async () => {
    const { db, checks } = withCheckRpcs([TEAM_SPEC], true);
    const teamVerifier = verified();
    await createWorkerHandlers({ db, boss: { send: vi.fn() }, provider: READER_MODE.FIXTURE, teamVerifier }).sync({
      tenantId: TENANT,
      sourceId: TEAM_SOURCE,
    });

    expect(checks.mock.calls.map(([name]) => name)).toEqual(CHECK_RPCS);
    expect(teamVerifier.verify).toHaveBeenCalledTimes(1);
    expect(checks.mock.invocationCallOrder[1]).toBeLessThan(access.guardedContentSource.mock.invocationCallOrder[0]);
  });

  // Audit item 10: the check is recorded before the provider group is read (its drift record), so a registration
  // verified this tick is compared, and read, this tick.
  it('records the check before the provider group is read, in either entry point', async () => {
    const pass = withCheckRpcs([TEAM_SPEC], true);
    await runOnce({ tenantId: TENANT, db: pass.db, provider: READER_MODE.FIXTURE, teamVerifier: verified() });
    const job = withCheckRpcs([TEAM_SPEC], true);
    await createWorkerHandlers({ db: job.db, boss: { send: vi.fn() }, provider: READER_MODE.FIXTURE, teamVerifier: verified() }).sync({
      tenantId: TENANT,
      sourceId: TEAM_SOURCE,
    });
    // The group read is readableMailboxes (mocked here): the record comes before its first call in each entry point.
    const groupCalls = access.readableMailboxes.mock.invocationCallOrder;
    expect(groupCalls).toHaveLength(2);
    for (const [{ checks, order }, groupAt] of [[pass, groupCalls[0]], [job, groupCalls[1]]] as const) {
      const record = checks.mock.calls.findIndex(([name]) => name === 'discovery_record_team_mailbox_check');
      expect(record).toBeGreaterThanOrEqual(0);
      expect(checks.mock.invocationCallOrder[record]).toBeLessThan(groupAt);
      // One check per pass: readOneSource does not ask again.
      expect(order.filter((name) => name === 'discovery_team_mailbox_check_due')).toHaveLength(1);
    }
  });

  it('verifies nothing when the database says the check is not due, in either entry point', async () => {
    const pass = withCheckRpcs([TEAM_SPEC], false);
    const passVerifier = verified();
    await runOnce({ tenantId: TENANT, db: pass.db, provider: READER_MODE.FIXTURE, teamVerifier: passVerifier });
    const job = withCheckRpcs([TEAM_SPEC], false);
    const jobVerifier = verified();
    await createWorkerHandlers({ db: job.db, boss: { send: vi.fn() }, provider: READER_MODE.FIXTURE, teamVerifier: jobVerifier }).sync({
      tenantId: TENANT,
      sourceId: TEAM_SOURCE,
    });

    for (const { checks, verifier } of [
      { checks: pass.checks, verifier: passVerifier },
      { checks: job.checks, verifier: jobVerifier },
    ]) {
      expect(checks.mock.calls.map(([name]) => name)).toEqual(['discovery_team_mailbox_check_due']);
      expect(verifier.verify).not.toHaveBeenCalled();
    }
  });

  it('a person\'s mailbox is never checked: the database is not asked', async () => {
    const { db, checks } = withCheckRpcs([SOURCES[2]], true);
    const teamVerifier = verified();
    await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE, teamVerifier });
    expect(access.guardedContentSource).toHaveBeenCalledTimes(1);
    expect(checks).not.toHaveBeenCalled();
    expect(teamVerifier.verify).not.toHaveBeenCalled();
  });

  it('fixture mode answers from the replay folder: a replayed mailbox verifies, any other address is not found', async () => {
    // storm.duncan@bank.example has a committed replay; deals@bank.example has none until the demo twin adds one.
    const hit = withCheckRpcs([{ ...TEAM_SPEC, address: 'storm.duncan@bank.example' }], true, 'storm.duncan@bank.example');
    await runOnce({ tenantId: TENANT, db: hit.db, provider: READER_MODE.FIXTURE });
    expect(hit.checks.mock.calls.map(([name]) => name)).toEqual(CHECK_RPCS);
    expect(hit.checks.mock.calls[1][1]).toEqual({
      p_id: TEAM_ID,
      p_status: 'verified',
      p_reason: null,
      p_directory_user_id: expect.stringMatching(/^fixture-[0-9a-f]{16}$/),
    });

    const miss = withCheckRpcs([TEAM_SPEC], true);
    await runOnce({ tenantId: TENANT, db: miss.db, provider: READER_MODE.FIXTURE });
    expect(miss.checks.mock.calls[1][1]).toEqual({ p_id: TEAM_ID, p_status: 'refused', p_reason: 'not_found', p_directory_user_id: null });
  });

  it('a failure to record the check fails the pass: the reader is never built on an unrecorded check', async () => {
    const base = withCheckRpcs([TEAM_SPEC], true);
    const rpc = (name: string, args: Record<string, unknown>) =>
      name === 'discovery_record_team_mailbox_check'
        ? Promise.resolve({ data: null, error: { code: '57014', message: 'canceling statement' } })
        : (base.db as unknown as { rpc: (n: string, a: unknown) => unknown }).rpc(name, args);
    const db = { ...(base.db as unknown as object), rpc } as unknown as SupabaseClient;
    await expect(runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE, teamVerifier: verified() })).rejects.toThrow(
      'team mailbox check could not be recorded (57014)',
    );
    expect(access.guardedContentSource).not.toHaveBeenCalled();
  });

  // ── The mid-pass renewal (#581, design R7) ───────────────────────────────────
  // A read that outlives the 65 minutes the guard allows a confirmation (a long backfill, a --recount re-read) may renew
  // the Directory check once between two pages. The worker gives the guarded reader a closure for it, for a team source
  // only; the guard, asked again, decides whether the pass goes on.
  const STALE = 'team_mailbox_unverified';
  /** The context the worker gave the last reader it built. */
  const lastCtx = () => access.guardedContentSource.mock.calls.at(-1)?.[2] as { recheckTeam?: () => Promise<void> };

  it('gives a team source a way to renew its check mid-pass, from both entry points, and a person\'s mailbox none', async () => {
    const pass = withCheckRpcs([TEAM_SPEC], false);
    await runOnce({ tenantId: TENANT, db: pass.db, provider: READER_MODE.FIXTURE, teamVerifier: verified() });
    expect(typeof lastCtx().recheckTeam).toBe('function');

    access.guardedContentSource.mockClear();
    const job = withCheckRpcs([TEAM_SPEC], false);
    await createWorkerHandlers({ db: job.db, boss: { send: vi.fn() }, provider: READER_MODE.FIXTURE, teamVerifier: verified() }).sync({
      tenantId: TENANT,
      sourceId: TEAM_SOURCE,
    });
    expect(typeof lastCtx().recheckTeam).toBe('function');

    access.guardedContentSource.mockClear();
    const person = withCheckRpcs([SOURCES[2]], false);
    await runOnce({ tenantId: TENANT, db: person.db, provider: READER_MODE.FIXTURE, teamVerifier: verified() });
    expect(lastCtx().recheckTeam).toBeUndefined();
  });

  it('the renewal verifies whether or not the database calls the check due, and records the answer', async () => {
    const { db, checks } = withCheckRpcs([TEAM_SPEC], false);
    const teamVerifier = verified();
    await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE, teamVerifier });
    expect(teamVerifier.verify).not.toHaveBeenCalled(); // the start-of-pass check was not due
    checks.mockClear();

    await lastCtx().recheckTeam!();

    expect(teamVerifier.verify).toHaveBeenCalledTimes(1);
    expect(teamVerifier.verify).toHaveBeenCalledWith(TENANT, 'deals@bank.example', null);
    expect(checks.mock.calls.map(([name]) => name)).toEqual(CHECK_RPCS);
    expect(checks.mock.calls[1][1]).toEqual({ p_id: TEAM_ID, p_status: 'verified', p_reason: null, p_directory_user_id: 'dir-1' });
  });

  describe('through the real guarded reader, a long read that goes stale between pages', () => {
    const PAGES = 3;
    beforeEach(() => {
      guard.rpc.mockReset();
      // The real wrapper over a three-page stub, so the guard's answer is what lets each page be requested.
      access.guardedContentSource.mockImplementation((target: { kind: string; provider: MailboxProvider }, _mode: unknown, ctx: object) =>
        access.realCreateGuardedContentSource!(
          {
            kind: target.kind as 'mailbox',
            backfill: async function* () {
              for (let page = 1; page <= PAGES; page += 1) yield { items: [], nextCheckpoint: `stub:${page}` };
            },
            delta: async function* () {},
          },
          { ...ctx, tenantId: TENANT, exclusion: NO_EXCLUSION } as never,
          target.provider,
        ),
      );
    });

    /** The guard answers these in order (then allows); the rpc's call order is kept to place the renewal between them. */
    const guardAnswers = (...answers: Array<string | null>) => {
      const queue = [...answers];
      guard.rpc.mockImplementation(async () => ({ data: queue.shift() ?? null, error: null }));
    };

    it('runOnce --recount: renews once, asks the guard again, and reads every page', async () => {
      guardAnswers(null, STALE, null, null, null);
      const { db, checks } = withCheckRpcs([TEAM_SPEC], false);
      const teamVerifier = verified();

      const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE, teamVerifier, reread: true });

      if (summary.status !== 'ok') throw new Error('unreachable');
      expect(summary.refused).toEqual([]);
      expect(summary.skipped).toEqual([]);
      expect(guard.rpc).toHaveBeenCalledTimes(PAGES + 2);
      expect(teamVerifier.verify).toHaveBeenCalledTimes(1);
      // The record landed between the guard's refusal (its second answer) and its next question.
      const record = checks.mock.calls.findIndex(([name]) => name === 'discovery_record_team_mailbox_check');
      expect(record).toBeGreaterThanOrEqual(0);
      expect(guard.rpc.mock.invocationCallOrder[1]).toBeLessThan(checks.mock.invocationCallOrder[record]);
      expect(checks.mock.invocationCallOrder[record]).toBeLessThan(guard.rpc.mock.invocationCallOrder[2]);
    });

    it('the queue handler: the same renewal, and the job completes', async () => {
      guardAnswers(null, STALE, null, null, null);
      const { db } = withCheckRpcs([TEAM_SPEC], false);
      const teamVerifier = verified();
      const boss = { send: vi.fn() };

      const result = await createWorkerHandlers({ db, boss, provider: READER_MODE.FIXTURE, teamVerifier }).sync({
        tenantId: TENANT,
        sourceId: TEAM_SOURCE,
      });

      expect(result.status).toBe('complete');
      expect(guard.rpc).toHaveBeenCalledTimes(PAGES + 2);
      expect(teamVerifier.verify).toHaveBeenCalledTimes(1);
    });

    it('runOnce: a check that cannot be renewed stops the source as refused, and the pass goes on to its end', async () => {
      // The renewal is recorded as a transient error (the Directory could not be reached); the guard, asked again, still says stale.
      guardAnswers(null, STALE, STALE);
      const { db, checks } = withCheckRpcs([TEAM_SPEC], false);
      const teamVerifier = { verify: vi.fn(async () => ({ status: 'error' as const, reason: 'directory_error' as const })) };

      const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE, teamVerifier, reread: true });

      if (summary.status !== 'ok') throw new Error('unreachable');
      expect(summary.refused).toEqual([{ sourceId: TEAM_SOURCE, reason: STALE }]);
      expect(guard.rpc).toHaveBeenCalledTimes(3);
      expect(teamVerifier.verify).toHaveBeenCalledTimes(1);
      expect(checks.mock.calls.filter(([name]) => name === 'discovery_record_team_mailbox_check').map(([, args]) => args)).toEqual([
        { p_id: TEAM_ID, p_status: 'error', p_reason: 'directory_error', p_directory_user_id: null },
      ]);
    });

    it('the queue handler: the same stop is a refusal, not a failure to retry', async () => {
      guardAnswers(null, STALE, STALE);
      const { db } = withCheckRpcs([TEAM_SPEC], false);
      const boss = { send: vi.fn() };

      const result = await createWorkerHandlers({ db, boss, provider: READER_MODE.FIXTURE, teamVerifier: verified() }).sync({
        tenantId: TENANT,
        sourceId: TEAM_SOURCE,
      });

      expect(result).toMatchObject({ status: 'refused', reason: STALE });
      expect(boss.send).not.toHaveBeenCalled();
    });

    it('a stale check at the first page stops the source without a renewal', async () => {
      guardAnswers(STALE);
      const { db, checks } = withCheckRpcs([TEAM_SPEC], false);
      const teamVerifier = verified();

      const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE, teamVerifier });

      if (summary.status !== 'ok') throw new Error('unreachable');
      expect(summary.refused).toEqual([{ sourceId: TEAM_SOURCE, reason: STALE }]);
      expect(guard.rpc).toHaveBeenCalledTimes(1);
      expect(teamVerifier.verify).not.toHaveBeenCalled();
      expect(checks.mock.calls.map(([name]) => name)).toEqual(['discovery_team_mailbox_check_due']);
    });
  });
});
