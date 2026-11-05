// @vitest-environment node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The guard builds its own service client, so the seam is the admin-client module: `admin.rpc` answers for every
// mailbox_guard_check and site_guard_check, and records what it was asked.
const admin = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseAdminClient: () => ({ rpc: admin.rpc }),
}));

import { MAILBOX_REFUSAL_REASONS, SITE_REFUSAL_REASONS } from '../src/lib/constants/discovery';
import type { MirrorMember, ProviderAllowlistMirror } from '../src/lib/mailboxAccess/mirror';
import { createFakeTenant, FAKE_GROUP_ID } from '../scripts/m365/cassette/fakeTenant';
import { assessReadiness, readinessLines, RUN_BLOCK, type Readiness } from '../scripts/m365/cassette/readiness';
import { RecorderRefusal } from '../scripts/m365/cassette/refusal';
import { recordGraphLive, type LiveRecordOptions, type RecordGraphDeps } from '../scripts/m365/record-graph';
import { domainRule } from './google/exclusion';

const TENANT = '11111111-1111-4111-8111-111111111111';
const MS_TENANT = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(40);

const ALICE = 'alice.moore@bank.example';
const SHARED = 'deals@bank.example';
const SHARED_UPN = 'deals@bankexample.onmicrosoft.com';
const SITE = 'zeta.sharepoint.com:/sites/Deals'; // sorts after the mailboxes

const objectId = (n: number) => `00000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`;
const member = (n: number, mail: string, upn = mail): MirrorMember => ({ id: objectId(n), mail, upn });

type Row = Record<string, unknown>;
type World = {
  allowed: string[];
  policies: Row[];
  sources: Row[];
  registration: Row | null;
};

const source = (kind: string, address: string, over: Row = {}): Row => ({
  id: `src-${address}`,
  tenant_id: TENANT,
  provider: 'microsoft',
  status: 'active',
  kind,
  address,
  owner_user_id: 'owner-1',
  last_error: null,
  ...over,
});

const baseWorld = (): World => ({
  allowed: [ALICE, SHARED],
  policies: [{ tenant_id: TENANT, version: 1, rules: [] }],
  sources: [source('mailbox', ALICE), source('mailbox', SHARED), source('sharepoint_site', SITE)],
  registration: {
    tenant_id: TENANT,
    ms_tenant_id: MS_TENANT,
    mailbox_domains: ['bank.example'],
    cert_secret_ref: 'env:GRAPH_READER_CERT_PEM',
    scope_group_id: FAKE_GROUP_ID,
    status: 'active',
  },
});

/**
 * An in-memory database: every `eq` filters the table's rows on the row's own column, `order` sorts, `range` and
 * `limit` end a query, and `await`ing the builder ends the others. `rpc` records the drift writes.
 */
function fakeDb(world: World) {
  const tables: Record<string, Row[]> = {
    allowed_mailboxes: world.allowed.map((address) => ({ tenant_id: TENANT, provider: 'microsoft', address })),
    discovery_exclusion_policies: world.policies,
    content_sources: world.sources,
    graph_reader_registrations: world.registration ? [world.registration] : [],
  };
  const drift = vi.fn().mockResolvedValue({ data: null, error: null });
  const asked: string[] = [];
  const db = {
    rpc: drift,
    from(table: string) {
      asked.push(table);
      const filters: Array<[string, unknown]> = [];
      let sort: { column: string; ascending: boolean } | null = null;
      const rows = () => {
        const matching = (tables[table] ?? []).filter((row) => filters.every(([column, value]) => row[column] === value));
        if (!sort) return matching;
        const { column, ascending } = sort;
        return [...matching].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
      };
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        order: (column: string, options?: { ascending?: boolean }) => {
          sort = { column, ascending: options?.ascending !== false };
          return builder;
        },
        range: async (from: number, to: number) => ({ data: rows().slice(from, to + 1), error: null }),
        limit: async (count: number) => ({ data: rows().slice(0, count), error: null }),
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: { data: Row[]; error: null }) => unknown) => resolve({ data: rows(), error: null }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, drift, asked };
}

const mirrorOf = (members: MirrorMember[]): ProviderAllowlistMirror & { listed: () => number } => {
  let calls = 0;
  return {
    listMembers: async () => {
      calls += 1;
      return members;
    },
    listed: () => calls,
  };
};
const failingMirror = (): ProviderAllowlistMirror => ({
  listMembers: async () => {
    throw new Error(`the group of ${TENANT} is unreachable`);
  },
});

/** The directory as the base world has it: Alice by her mail, the shared mailbox by its mail with another UPN. */
const directory = (): MirrorMember[] => [member(1, ALICE), member(2, SHARED, SHARED_UPN)];

/** What the guard answers per address, by reason; unlisted addresses are allowed. Also records every ask. */
function guardAnswers(refusals: Record<string, string> = {}) {
  admin.rpc.mockImplementation(async (fn: string, args: { p_address: string }) => {
    if (fn !== 'mailbox_guard_check' && fn !== 'site_guard_check') throw new Error(`unexpected rpc ${fn}`);
    return { data: refusals[args.p_address] ?? null, error: null };
  });
}
const guardCalls = () =>
  admin.rpc.mock.calls.map(([fn, args]) => ({ fn, ...(args as Record<string, unknown>) }) as { fn: string; p_address?: string } & Record<string, unknown>);

const assess = (world: World, mirror: ProviderAllowlistMirror) => {
  const { db } = fakeDb(world);
  return assessReadiness(db, TENANT, { scopeGroupId: world.registration?.scope_group_id as string | null }, mirror);
};

beforeEach(() => {
  admin.rpc.mockReset();
  guardAnswers();
});

describe('assessReadiness (#318): the one verdict the preflight prints and the capture reads', () => {
  it('marks every allowlisted source ready, records the shared mailbox under its UPN, and asks the guard as the recorder', async () => {
    const readiness = await assess(baseWorld(), mirrorOf(directory()));
    expect(readiness.blocked).toBeNull();
    expect(readiness.group).toBe('in_sync');
    expect(readiness.notReady).toEqual({});
    // Address order, as the sources are named; a mailbox is recorded under its bound UPN, a site under its address.
    expect(readiness.ready.map(({ row, recordAs }) => [row.kind, row.address, recordAs])).toEqual([
      ['mailbox', ALICE, ALICE],
      ['mailbox', SHARED, SHARED_UPN],
      ['sharepoint_site', SITE, SITE],
    ]);
    expect(readiness.recordedUnderUpn).toBe(1);
    expect(readiness.ready[0].row).toEqual({
      id: `src-${ALICE}`,
      tenantId: TENANT,
      kind: 'mailbox',
      provider: 'microsoft',
      address: ALICE,
      ownerUserId: 'owner-1',
      deltaCheckpoint: null,
    });
    expect(readiness.pass?.policy).toEqual({ version: 1, rules: [] });
    // One ask per source, under the recorder's caller, with the group's answer.
    expect(guardCalls()).toEqual([
      expect.objectContaining({ fn: 'mailbox_guard_check', p_address: ALICE, p_caller: 'm365-recorder', p_purpose: 'provider_read', p_provider: 'microsoft', p_provider_reason: null }),
      expect.objectContaining({ fn: 'mailbox_guard_check', p_address: SHARED, p_caller: 'm365-recorder', p_provider_reason: null }),
      expect.objectContaining({ fn: 'site_guard_check', p_address: SITE, p_caller: 'm365-recorder', p_purpose: 'provider_read' }),
    ]);
  });

  it('does not count a UPN that differs from the stored address only by case, and reads a shared mailbox the group lists in capitals', async () => {
    const readiness = await assess(baseWorld(), mirrorOf([member(1, 'Alice.Moore@Bank.Example'), member(2, SHARED, SHARED_UPN.toUpperCase())]));
    expect(readiness.ready.map((r) => r.recordAs)).toEqual([ALICE, SHARED_UPN, SITE]);
    expect(readiness.recordedUnderUpn).toBe(1);
  });

  it('reads only the tenant\'s active Microsoft sources', async () => {
    const world = baseWorld();
    world.sources.push(
      source('mailbox', 'paused@bank.example', { status: 'paused' }),
      source('mailbox', 'gmail@bank.example', { provider: 'google' }),
      source('mailbox', 'other@bank.example', { tenant_id: '99999999-9999-4999-8999-999999999999' }),
    );
    const readiness = await assess(world, mirrorOf(directory()));
    expect(readiness.ready).toHaveLength(3);
    expect(guardCalls().map((c) => c.p_address)).toEqual([ALICE, SHARED, SITE]);
  });

  describe('the whole run', () => {
    it('reads nothing without a scope group, and asks nothing: no policy read, no group read, no guard ask', async () => {
      for (const scope_group_id of [null, '', '   ']) {
        const world = baseWorld();
        world.registration!.scope_group_id = scope_group_id;
        const { db, drift, asked } = fakeDb(world);
        const mirror = mirrorOf(directory());
        const readiness = await assessReadiness(db, TENANT, { scopeGroupId: scope_group_id }, mirror);
        expect(readiness).toEqual({ blocked: RUN_BLOCK.NO_SCOPE_GROUP, group: null, ready: [], notReady: {}, recordedUnderUpn: 0, pass: null });
        expect(asked).toEqual([]);
        expect(drift).not.toHaveBeenCalled();
        expect(mirror.listed()).toBe(0);
        expect(admin.rpc).not.toHaveBeenCalled();
      }
    });

    it('reads nothing when the tenant has no stored exclusion policy (a live pass has no version-0 default)', async () => {
      const world = baseWorld();
      world.policies = [];
      const mirror = mirrorOf(directory());
      const readiness = await assess(world, mirror);
      expect(readiness).toMatchObject({ blocked: RUN_BLOCK.NO_EXCLUSION_POLICY, group: null, ready: [], pass: null });
      expect(mirror.listed()).toBe(0);
      expect(admin.rpc).not.toHaveBeenCalled();
    });

    it('reads nothing under a policy that does not validate, or one that has a rule', async () => {
      const invalid = baseWorld();
      invalid.policies = [{ tenant_id: TENANT, version: 2, rules: [{ nonsense: true }] }];
      expect(await assess(invalid, mirrorOf(directory()))).toMatchObject({ blocked: RUN_BLOCK.INVALID_EXCLUSION_POLICY, ready: [] });

      const withRule = baseWorld();
      withRule.policies = [{ tenant_id: TENANT, version: 2, rules: [domainRule('r1', 'private.example')] }];
      expect(await assess(withRule, mirrorOf(directory()))).toMatchObject({ blocked: RUN_BLOCK.EXCLUSION_POLICY_NOT_EMPTY, ready: [], pass: null });
      expect(admin.rpc).not.toHaveBeenCalled();
    });

    it('judges the latest policy version, so a later empty version clears an earlier rule', async () => {
      const world = baseWorld();
      world.policies = [
        { tenant_id: TENANT, version: 1, rules: [domainRule('r1', 'private.example')] },
        { tenant_id: TENANT, version: 2, rules: [] },
      ];
      expect((await assess(world, mirrorOf(directory()))).blocked).toBeNull();
    });

    it('reads nothing when the group cannot be read, records that, and asks the guard nothing', async () => {
      const { db, drift } = fakeDb(baseWorld());
      const readiness = await assessReadiness(db, TENANT, { scopeGroupId: FAKE_GROUP_ID }, failingMirror());
      expect(readiness).toEqual({ blocked: RUN_BLOCK.GROUP_UNAVAILABLE, group: 'unavailable', ready: [], notReady: {}, recordedUnderUpn: 0, pass: null });
      expect(drift).toHaveBeenCalledWith('discovery_record_allowlist_drift', expect.objectContaining({ p_status: 'unavailable' }));
      expect(admin.rpc).not.toHaveBeenCalled();
    });
  });

  describe('per source', () => {
    it('counts a halted source and does not ask the guard about it', async () => {
      const world = baseWorld();
      world.sources[1] = source('mailbox', SHARED, { last_error: 'history_window_exceeded' });
      const readiness = await assess(world, mirrorOf(directory()));
      expect(readiness.notReady).toEqual({ halted: 1 });
      expect(readiness.ready.map((r) => r.row.address)).toEqual([ALICE, SITE]);
      expect(readiness.recordedUnderUpn).toBe(0); // the only shared mailbox is the halted one
      expect(guardCalls().map((c) => c.p_address)).toEqual([ALICE, SITE]);
    });

    it('does not mistake another stored error for a halt', async () => {
      const world = baseWorld();
      world.sources[0] = source('mailbox', ALICE, { last_error: 'rate_limited' });
      expect((await assess(world, mirrorOf(directory()))).ready).toHaveLength(3);
    });

    it.each(MAILBOX_REFUSAL_REASONS)('counts a mailbox the guard refuses as %s', async (reason) => {
      guardAnswers({ [ALICE]: reason });
      const readiness = await assess(baseWorld(), mirrorOf(directory()));
      expect(readiness.notReady).toEqual({ [reason]: 1 });
      expect(readiness.ready.map((r) => r.row.address)).toEqual([SHARED, SITE]);
    });

    it.each(SITE_REFUSAL_REASONS)('counts a site the site guard refuses as %s', async (reason) => {
      guardAnswers({ [SITE]: reason });
      const readiness = await assess(baseWorld(), mirrorOf(directory()));
      expect(readiness.notReady).toEqual({ [reason]: 1 });
      expect(readiness.ready.map((r) => r.row.kind)).toEqual(['mailbox', 'mailbox']);
    });

    it('refuses a mailbox the group does not hold as not_in_provider_group, and tells the guard so', async () => {
      const readiness = await assess(baseWorld(), mirrorOf([member(2, SHARED, SHARED_UPN)]));
      expect(readiness.group).toBe('drift');
      expect(readiness.notReady).toEqual({ not_in_provider_group: 1 });
      expect(readiness.ready.map((r) => r.row.address)).toEqual([SHARED, SITE]);
      expect(guardCalls().find((c) => c.p_address === ALICE)).toMatchObject({ p_provider_reason: 'not_in_provider_group' });
    });

    it('counts the group\'s reason once when the guard refuses the same mailbox for it', async () => {
      guardAnswers({ [ALICE]: 'not_in_provider_group' });
      const readiness = await assess(baseWorld(), mirrorOf([member(2, SHARED, SHARED_UPN)]));
      expect(readiness.notReady).toEqual({ not_in_provider_group: 1 });
    });

    it('refuses a bound mailbox with no usable read key as mirror_unavailable, as the guarded read does', async () => {
      // A bare-address member binds but has no object id; a malformed id is no usable id either.
      for (const members of [
        [ALICE, member(2, SHARED, SHARED_UPN)],
        [{ id: 'not-an-object-id', mail: ALICE, upn: ALICE }, member(2, SHARED, SHARED_UPN)],
      ] as MirrorMember[][]) {
        admin.rpc.mockClear();
        const readiness = await assess(baseWorld(), mirrorOf(members));
        expect(readiness.notReady).toEqual({ mirror_unavailable: 1 });
        expect(readiness.ready.map((r) => r.row.address)).toEqual([SHARED, SITE]);
        expect(guardCalls().find((c) => c.p_address === ALICE)).toMatchObject({ p_provider_reason: 'mirror_unavailable' });
      }
    });

    it('is not a verdict when the guard itself fails: the check throws', async () => {
      admin.rpc.mockResolvedValue({ data: null, error: { message: 'down', code: '57014' } });
      await expect(assess(baseWorld(), mirrorOf(directory()))).rejects.toThrow(/guard unavailable/);
    });

    it('is not a verdict when a reader was reached without its capability: the check throws', async () => {
      const { MailboxAccessRefusedError } = await import('../src/lib/mailboxAccess/guard');
      admin.rpc.mockImplementation(async () => {
        throw new MailboxAccessRefusedError(TENANT, ALICE, 'no_capability', 'provider_read');
      });
      await expect(assess(baseWorld(), mirrorOf(directory()))).rejects.toThrow(/no_capability/);
    });

    it('lists a tenant with no sources as blocked by nothing and ready for nothing', async () => {
      const world = baseWorld();
      world.sources = [];
      expect(await assess(world, mirrorOf(directory()))).toMatchObject({ blocked: null, ready: [], notReady: {}, recordedUnderUpn: 0 });
    });
  });
});

describe('m365:record-graph --live --preflight (#318): the same readiness, counts only', () => {
  const LOCAL = { url: 'http://127.0.0.1:54321', secretKey: 'local-secret-key' };

  const live = (over: Partial<LiveRecordOptions> = {}): LiveRecordOptions => ({
    tenantId: TENANT,
    msTenantId: MS_TENANT,
    confirmDomains: ['bank.example'],
    out: null,
    allowEnvPem: true,
    allowRemoteSupabase: null,
    preflight: true,
    ...over,
  });

  const run = (world: World, mirror: ProviderAllowlistMirror, options: Partial<LiveRecordOptions> = {}) => {
    const database = fakeDb(world);
    const tenant = createFakeTenant();
    const lines: string[] = [];
    const deps: RecordGraphDeps = {
      fetchImpl: tenant.fetch,
      git: (args) => (args[0] === 'status' ? '' : SHA),
      db: database.db,
      adminCredentials: () => LOCAL,
      env: { GRAPH_READER_CERT_PEM: 'present, never read' },
      mirror,
      log: (line) => lines.push(line),
    };
    return { ...database, tenant, lines, deps, go: () => recordGraphLive(live(options), deps) };
  };

  /** No address, subject, object id, UUID, token or URL: only fixed words, reason codes and counts. */
  const expectNoTenantValue = (lines: string[]) => {
    for (const line of lines) {
      expect(line).not.toMatch(/@|https?:|\/\/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|eyJ|bearer/i);
      for (const value of [ALICE, SHARED, SHARED_UPN, SITE, 'bank.example', 'sharepoint', 'onmicrosoft', TENANT, MS_TENANT, FAKE_GROUP_ID]) {
        expect(line).not.toContain(value);
      }
    }
  };

  it('prints the group status, the ready count, the counts per reason and the recorded-under-UPN count, and nothing else', async () => {
    const { lines, go } = run(baseWorld(), mirrorOf(directory()));
    await go();
    expect(lines).toEqual([
      'provider group in_sync',
      'sources ready 3',
      'sources not ready 0',
      'mailboxes recorded under their UPN 1',
    ]);
    expectNoTenantValue(lines);
  });

  it('prints each reason once, in a fixed order, for a mixed tenant', async () => {
    guardAnswers({ [SHARED]: 'no_consent', [SITE]: 'site_not_registered' });
    const world = baseWorld();
    world.sources.push(source('mailbox', 'halted@bank.example', { last_error: 'history_window_exceeded' }));
    const { lines, go } = run(world, mirrorOf(directory()));
    await go();
    expect(lines).toEqual([
      'provider group in_sync',
      'sources ready 1',
      'sources not ready 3',
      '  halted 1',
      '  no_consent 1',
      '  site_not_registered 1',
      'mailboxes recorded under their UPN 0',
    ]);
    expectNoTenantValue(lines);
  });

  it.each([
    ['no scope group', (w: World) => void (w.registration!.scope_group_id = null), 'run blocked: no_scope_group', 'provider group not read'],
    ['no stored policy', (w: World) => void (w.policies = []), 'run blocked: no_exclusion_policy', 'provider group not read'],
    ['a non-empty policy', (w: World) => void (w.policies = [{ tenant_id: TENANT, version: 2, rules: [domainRule('r1', 'private.example')] }]), 'run blocked: exclusion_policy_not_empty', 'provider group not read'],
  ])('says why a blocked run reads nothing (%s), with no value', async (_name, change, blockedLine, groupLine) => {
    const world = baseWorld();
    change(world);
    const { lines, go } = run(world, mirrorOf(directory()));
    await go();
    expect(lines).toEqual([groupLine, blockedLine, 'sources ready 0', 'sources not ready 0', 'mailboxes recorded under their UPN 0']);
    expectNoTenantValue(lines);
  });

  it('says an unreadable group is blocking, and what the group status is', async () => {
    const { lines, go } = run(baseWorld(), failingMirror());
    await go();
    expect(lines).toEqual(['provider group unavailable', 'run blocked: group_unavailable', 'sources ready 0', 'sources not ready 0', 'mailboxes recorded under their UPN 0']);
    expectNoTenantValue(lines);
  });

  it('gives the same verdict as the readiness function the capture reads, for every state', async () => {
    const worlds: Array<[string, (w: World) => void, ProviderAllowlistMirror, Record<string, string>]> = [
      ['all ready', () => undefined, mirrorOf(directory()), {}],
      ['no scope group', (w) => void (w.registration!.scope_group_id = null), mirrorOf(directory()), {}],
      ['no stored policy', (w) => void (w.policies = []), mirrorOf(directory()), {}],
      ['non-empty policy', (w) => void (w.policies = [{ tenant_id: TENANT, version: 2, rules: [domainRule('r1', 'private.example')] }]), mirrorOf(directory()), {}],
      ['group unavailable', () => undefined, failingMirror(), {}],
      ['halted', (w) => void (w.sources[0] = source('mailbox', ALICE, { last_error: 'history_window_exceeded' })), mirrorOf(directory()), {}],
      ['guard refusal', () => undefined, mirrorOf(directory()), { [SHARED]: 'owner_mismatch' }],
      ['not in group', () => undefined, mirrorOf([member(2, SHARED, SHARED_UPN)]), {}],
      ['no key', () => undefined, mirrorOf([ALICE, member(2, SHARED, SHARED_UPN)]), {}],
    ];
    for (const [name, change, mirror, refusals] of worlds) {
      const world = baseWorld();
      change(world);
      guardAnswers(refusals);
      const direct = await assessReadiness(fakeDb(world).db, TENANT, { scopeGroupId: world.registration!.scope_group_id as string | null }, mirror);
      guardAnswers(refusals);
      const { lines, go } = run(world, mirror);
      const { readiness: viaPreflight } = await go();
      const pick = ({ blocked, group, ready, notReady, recordedUnderUpn }: Readiness) => ({ blocked, group, ready, notReady, recordedUnderUpn });
      expect(pick(viaPreflight), name).toEqual(pick(direct));
      expect(lines.some((line) => line === `sources ready ${direct.ready.length}`), name).toBe(true);
    }
  });

  it('reads no mail, writes no file and needs no --out', async () => {
    const out = join(tmpdir(), 'readiness-never-created');
    const { tenant, go } = run(baseWorld(), mirrorOf(directory()), { out });
    await go();
    expect(tenant.requests).toEqual([]);
    expect(existsSync(out)).toBe(false);
    // What it does write is the database's own: the group's drift, and the guard's audit of a refusal.
  });

  it('records the group state in the database, as any read of the group does', async () => {
    const { drift, go } = run(baseWorld(), mirrorOf([member(2, SHARED, SHARED_UPN)]));
    await go();
    expect(drift).toHaveBeenCalledWith(
      'discovery_record_allowlist_drift',
      expect.objectContaining({ p_tenant_id: TENANT, p_provider: 'microsoft', p_status: 'drift', p_missing: [ALICE] }),
    );
  });

  it('still asks the gates first: a mistyped Microsoft tenant id ends the run before the group is read', async () => {
    const mirror = mirrorOf(directory());
    const { go } = run(baseWorld(), mirror, { msTenantId: '33333333-3333-4333-8333-333333333333' });
    await expect(go()).rejects.toBeInstanceOf(RecorderRefusal);
    expect(mirror.listed()).toBe(0);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('without --preflight, runs the same readiness and refuses a blocked run before it announces or reads anything', async () => {
    // The capture itself (the sources readiness marks ready, read through the guard) is tested in tests/m365-record-graph.test.ts.
    const out = join(tmpdir(), 'readiness-never-created-either');
    const world = baseWorld();
    world.policies = [{ tenant_id: TENANT, version: 2, rules: [domainRule('r1', 'private.example')] }];
    const mirror = mirrorOf(directory());
    const { lines, tenant, go } = run(world, mirror, { preflight: false, out });
    await expect(go()).rejects.toThrow('the run is blocked (exclusion_policy_not_empty); nothing is read');
    expect(mirror.listed()).toBe(0); // blocked at the same check preflight reports, before the group is read
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(tenant.requests).toEqual([]);
    expect(lines).toEqual([]);
    expect(existsSync(out)).toBe(false);
  });
});

describe('readinessLines', () => {
  const ready = (n: number) => Array.from({ length: n }, (_, i) => ({ row: { id: String(i) } as never, recordAs: 'x' }));

  it('prints reasons sorted, and totals them', () => {
    const lines = readinessLines({
      blocked: null,
      group: 'in_sync',
      ready: ready(2),
      notReady: { owner_mismatch: 2, halted: 1 },
      recordedUnderUpn: 1,
      pass: null,
    });
    expect(lines).toEqual(['provider group in_sync', 'sources ready 2', 'sources not ready 3', '  halted 1', '  owner_mismatch 2', 'mailboxes recorded under their UPN 1']);
  });
});
