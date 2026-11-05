import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DRIFT_STATUS, type MailboxProvider } from '@/lib/constants/discovery';
import {
  createFixtureAllowlistMirror,
  readableMailboxes,
  type ProviderAllowlistMirror,
} from '@/lib/mailboxAccess';

const TENANT = '11111111-1111-4111-8111-111111111111';
const A = 'storm.duncan@bank.example';
const B = 'morgan.vale@bank.example';
const C = 'alex.chen@bank.example';

/**
 * A fake db: `from().select().eq()...order().range()` pages a view and applies every `eq` filter to the row's own
 * columns; `rpc` records calls. The allowlist has two views (#581): `allowed_mailboxes` (people) and
 * `allowed_team_mailboxes` (team inboxes), each with its own rows and its own recorded pages.
 * A bare address is a Microsoft mailbox; pass `{ address, provider }` for the rest.
 */
type AllowedRow = string | { address: string; provider: MailboxProvider };
function fakeDb(allowed: AllowedRow[], rpcError: { message: string; code?: string } | null = null, team: AllowedRow[] = []) {
  const rpc = vi.fn().mockResolvedValue({ data: false, error: rpcError });
  const ranges: Array<[number, number]> = [];
  const teamRanges: Array<[number, number]> = [];
  const tables: string[] = [];
  const normalize = (list: AllowedRow[]) =>
    list.map((row) => (typeof row === 'string' ? { address: row, provider: 'microsoft' as MailboxProvider } : row));
  const personRows = normalize(allowed);
  const teamRows = normalize(team);
  const db = {
    rpc,
    from: (table: string) => {
      tables.push(table);
      const rows = table === 'allowed_team_mailboxes' ? teamRows : personRows;
      const pages = table === 'allowed_team_mailboxes' ? teamRanges : ranges;
      const filters: Array<[string, unknown]> = [];
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        order: () => builder,
        range: async (from: number, to: number) => {
          pages.push([from, to]);
          const matching = rows.filter((row) =>
            filters.every(([column, value]) => column === 'tenant_id' || (row as Record<string, unknown>)[column] === value),
          );
          return { data: matching.slice(from, to + 1), error: null };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, rpc, ranges, teamRanges, tables };
}

const mirrorOf = (members: string[]): ProviderAllowlistMirror => ({ listMembers: async () => members });
const failingMirror: ProviderAllowlistMirror = {
  listMembers: async () => {
    throw new Error('group unreachable');
  },
};

describe.each([['microsoft'], ['google']] as Array<[MailboxProvider]>)('readableMailboxes (%s)', (provider) => {
  // Bare addresses are this provider's mailboxes.
  const fakeFor = (rows: string[], rpcError: { message: string; code?: string } | null = null) =>
    fakeDb(
      rows.map((address) => ({ address, provider })),
      rpcError,
    );

  it('reads every allowed mailbox when the group matches, and records an empty difference', async () => {
    const { db, rpc } = fakeFor([A, B]);
    const result = await readableMailboxes(db, TENANT, provider, mirrorOf([B, A]));
    expect(result.status).toBe(DRIFT_STATUS.IN_SYNC);
    expect([...result.readable].sort()).toEqual([A, B].sort());
    expect(result.providerCheck(A)).toBeNull();
    expect(rpc).toHaveBeenCalledWith('discovery_record_allowlist_drift', {
      p_tenant_id: TENANT,
      p_provider: provider,
      p_status: 'in_sync',
      p_missing: [],
      p_extra: [],
      p_present: [A, B].sort(),
    });
  });

  it('reads the intersection and reports the difference when the group drifts', async () => {
    const { db, rpc } = fakeFor([A, B, C]);
    const result = await readableMailboxes(db, TENANT, provider, mirrorOf([B, C, 'x@bank.example']));
    expect(result.status).toBe(DRIFT_STATUS.DRIFT);
    expect([...result.readable].sort()).toEqual([C, B].sort());
    expect(result.missingInGroup).toEqual([A]);
    expect(result.extraInGroup).toEqual(['x@bank.example']);
    expect(result.providerCheck(A)).toBe('not_in_provider_group');
    expect(result.providerCheck('x@bank.example')).toBe('not_in_provider_group');
    expect(result.providerCheck(B)).toBeNull();
    expect(rpc).toHaveBeenCalledWith('discovery_record_allowlist_drift', {
      p_tenant_id: TENANT,
      p_provider: provider,
      p_status: 'drift',
      p_missing: [A],
      p_extra: ['x@bank.example'],
      // Only what the check saw in the group: the missing address is not here.
      p_present: [B, C].sort(),
    });
  });

  it('records the drift but no address as present when told not to, so group removal cannot start (D100)', async () => {
    const { db, rpc } = fakeFor([A, B, C]);
    const result = await readableMailboxes(db, TENANT, provider, mirrorOf([B, C]), { recordPresence: false });
    expect([...result.readable].sort()).toEqual([B, C].sort());
    expect(rpc).toHaveBeenCalledWith(
      'discovery_record_allowlist_drift',
      expect.objectContaining({ p_status: 'drift', p_missing: [A], p_present: [] }),
    );
  });

  it('reads nothing when the group cannot be read', async () => {
    const { db, rpc } = fakeFor([A, B]);
    const result = await readableMailboxes(db, TENANT, provider, failingMirror);
    expect(result.status).toBe(DRIFT_STATUS.UNAVAILABLE);
    expect(result.readable.size).toBe(0);
    expect(result.providerCheck(A)).toBe('mirror_unavailable');
    expect(result.providerCheck('anyone@bank.example')).toBe('mirror_unavailable');
    expect(rpc).toHaveBeenCalledWith(
      'discovery_record_allowlist_drift',
      expect.objectContaining({ p_status: 'unavailable', p_missing: [], p_extra: [], p_present: [] }),
    );
  });

  it('fails closed on a mirror timeout: unavailable, every mailbox refused as mirror_unavailable, nothing read', async () => {
    // Orchestrator decision (#409 PR A audit, F4): no retry path for a directory timeout; the source waits for the next tick.
    const timedOut: ProviderAllowlistMirror = {
      listMembers: () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    };
    const { db, rpc } = fakeFor([A, B]);
    const result = await readableMailboxes(db, TENANT, provider, timedOut);
    expect(result.status).toBe(DRIFT_STATUS.UNAVAILABLE);
    expect(result.readable.size).toBe(0);
    expect(result.providerCheck(A)).toBe('mirror_unavailable');
    expect(result.providerCheck(B)).toBe('mirror_unavailable');
    expect(rpc).toHaveBeenCalledWith('discovery_record_allowlist_drift', expect.objectContaining({ p_status: 'unavailable' }));
  });

  it('compares membership in lower case', async () => {
    const { db } = fakeFor([A]);
    const result = await readableMailboxes(db, TENANT, provider, mirrorOf(['  Storm.Duncan@Bank.Example ']));
    expect(result.status).toBe(DRIFT_STATUS.IN_SYNC);
    expect(result.providerCheck(A)).toBeNull();
  });

  it('pages the allowlist read', async () => {
    const many = Array.from({ length: 1201 }, (_, i) => `u${String(i).padStart(4, '0')}@bank.example`);
    const { db, ranges } = fakeFor(many);
    const result = await readableMailboxes(db, TENANT, provider, mirrorOf(many));
    expect(result.status).toBe(DRIFT_STATUS.IN_SYNC);
    expect(result.readable.size).toBe(1201);
    expect(ranges).toEqual([
      [0, 499],
      [500, 999],
      [1000, 1499],
    ]);
  });

  it('throws when the drift record is rejected', async () => {
    const { db } = fakeFor([A], { message: 'boom', code: 'XX000' });
    const error = await readableMailboxes(db, TENANT, provider, mirrorOf([A])).catch((e: unknown) => e);
    expect((error as Error).message).toBe('drift record failed (XX000)');
  });
});

describe('readableMailboxes across providers (audit round 1, item 22)', () => {
  const G = 'dana.reyes@bank.example';

  it('compares each provider group with its own mailboxes only', async () => {
    const rows: AllowedRow[] = [A, B, { address: G, provider: 'google' }];
    const microsoft = fakeDb(rows);
    const ms = await readableMailboxes(microsoft.db, TENANT, 'microsoft', mirrorOf([A, B]));
    expect(ms.status).toBe(DRIFT_STATUS.IN_SYNC);
    expect(ms.missingInGroup).toEqual([]);
    expect([...ms.readable].sort()).toEqual([A, B].sort());
    expect(ms.providerCheck(G)).toBe('not_in_provider_group');

    const google = fakeDb(rows);
    const gg = await readableMailboxes(google.db, TENANT, 'google', mirrorOf([G]));
    expect(gg.status).toBe(DRIFT_STATUS.IN_SYNC);
    expect(gg.extraInGroup).toEqual([]);
    expect([...gg.readable]).toEqual([G]);
    expect(google.rpc).toHaveBeenCalledWith(
      'discovery_record_allowlist_drift',
      expect.objectContaining({ p_provider: 'google', p_status: 'in_sync', p_missing: [], p_extra: [] }),
    );
  });

  it('does not report another provider address as missing from this provider group', async () => {
    const { db, rpc } = fakeDb([A, { address: G, provider: 'google' }]);
    const result = await readableMailboxes(db, TENANT, 'microsoft', mirrorOf([A]));
    expect(result.missingInGroup).toEqual([]);
    expect(rpc).toHaveBeenCalledWith('discovery_record_allowlist_drift', expect.objectContaining({ p_missing: [] }));
  });

  it('counts an address for both providers when its domain is registered under both (C6)', async () => {
    // allowed_mailboxes yields one row per provider whose registered domains match the address.
    const rows: AllowedRow[] = [
      { address: A, provider: 'microsoft' },
      { address: A, provider: 'google' },
    ];
    const ms = await readableMailboxes(fakeDb(rows).db, TENANT, 'microsoft', mirrorOf([A]));
    const gg = await readableMailboxes(fakeDb(rows).db, TENANT, 'google', mirrorOf([A]));
    expect([...ms.readable]).toEqual([A]);
    expect([...gg.readable]).toEqual([A]);
    // Missing from one group is drift for that provider only.
    const msDrift = await readableMailboxes(fakeDb(rows).db, TENANT, 'microsoft', mirrorOf([]));
    expect(msDrift.missingInGroup).toEqual([A]);
  });

  it('the fixture mirror holds only that provider allowlist', async () => {
    const { db } = fakeDb([A, { address: G, provider: 'google' }]);
    expect(await createFixtureAllowlistMirror(db).listMembers(TENANT, 'microsoft')).toEqual([A]);
    expect(await createFixtureAllowlistMirror(db).listMembers(TENANT, 'google')).toEqual([G]);
  });
});

describe('the expected set is the union of the people and the team inboxes (#581)', () => {
  const D = 'deals@bank.example';
  const google = (address: string) => ({ address, provider: 'google' as MailboxProvider });

  it('reads both views for the tenant and provider, people first', async () => {
    const { db, tables } = fakeDb([google(A)], null, [google(D)]);
    await readableMailboxes(db, TENANT, 'google', mirrorOf([A, D]));
    expect(tables).toEqual(['allowed_mailboxes', 'allowed_team_mailboxes']);
  });

  it('counts a team inbox in the group as readable, and in sync', async () => {
    const { db, rpc } = fakeDb([google(A)], null, [google(D)]);
    const result = await readableMailboxes(db, TENANT, 'google', mirrorOf([D, A]));
    expect(result.status).toBe(DRIFT_STATUS.IN_SYNC);
    expect([...result.readable].sort()).toEqual([A, D].sort());
    expect(result.providerCheck(D)).toBeNull();
    expect(rpc).toHaveBeenCalledWith(
      'discovery_record_allowlist_drift',
      expect.objectContaining({ p_status: 'in_sync', p_missing: [], p_extra: [], p_present: [A, D].sort() }),
    );
  });

  it('reports a team inbox the group lacks as missing, and refuses it as not in the group', async () => {
    const { db, rpc } = fakeDb([google(A)], null, [google(D)]);
    const result = await readableMailboxes(db, TENANT, 'google', mirrorOf([A]));
    expect(result.status).toBe(DRIFT_STATUS.DRIFT);
    expect(result.missingInGroup).toEqual([D]);
    expect(result.providerCheck(D)).toBe('not_in_provider_group');
    expect(rpc).toHaveBeenCalledWith('discovery_record_allowlist_drift', expect.objectContaining({ p_missing: [D], p_extra: [] }));
  });

  it('reports a group member that is no team inbox yet (pending, refused, closed) as extra', async () => {
    const { db } = fakeDb([google(A)], null, []);
    const result = await readableMailboxes(db, TENANT, 'google', mirrorOf([A, D]));
    expect(result.extraInGroup).toEqual([D]);
    expect(result.providerCheck(D)).toBe('not_in_provider_group');
  });

  it('reads only this provider\'s team inboxes', async () => {
    const { db } = fakeDb([], null, [google(D), { address: 'ms-deals@bank.example', provider: 'microsoft' }]);
    const result = await readableMailboxes(db, TENANT, 'microsoft', mirrorOf(['ms-deals@bank.example']));
    expect(result.status).toBe(DRIFT_STATUS.IN_SYNC);
    expect(result.missingInGroup).toEqual([]);
    expect([...result.readable]).toEqual(['ms-deals@bank.example']);
  });

  it('does not double-count an address both views hold, and compares in lower case', async () => {
    const { db } = fakeDb([google(A)], null, [google(A.toUpperCase())]);
    const result = await readableMailboxes(db, TENANT, 'google', mirrorOf([A]));
    expect(result.status).toBe(DRIFT_STATUS.IN_SYNC);
    expect(result.readable.size).toBe(1);
  });

  it('pages the team view too', async () => {
    const many = Array.from({ length: 501 }, (_, i) => google(`t${String(i).padStart(4, '0')}@bank.example`));
    const { db, teamRanges } = fakeDb([], null, many);
    const result = await readableMailboxes(db, TENANT, 'google', mirrorOf(many.map((row) => row.address)));
    expect(result.readable.size).toBe(501);
    expect(teamRanges).toEqual([
      [0, 499],
      [500, 999],
    ]);
  });

  it('the group listing a team inbox the view lacks never moves with the clock: the set is the views, nothing else', async () => {
    // The freshness of a check is the guard's alone (review round 2, M-A). The mirror asks two views and no time:
    // the same rows give the same set, now or an hour later, so a stale check can neither flip drift nor hide an inbox.
    const first = await readableMailboxes(fakeDb([], null, [google(D)]).db, TENANT, 'google', mirrorOf([D]));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
      const later = await readableMailboxes(fakeDb([], null, [google(D)]).db, TENANT, 'google', mirrorOf([D]));
      expect(later.status).toBe(first.status);
      expect([...later.readable]).toEqual([...first.readable]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the team view cannot be read', async () => {
    const base = fakeDb([google(A)], null, [google(D)]).db as unknown as { from: (t: string) => unknown; rpc: unknown };
    const db = {
      rpc: base.rpc,
      from: (table: string) =>
        table === 'allowed_team_mailboxes'
          ? {
              select: () => ({
                eq: () => ({
                  eq: () => ({ order: () => ({ range: async () => ({ data: null, error: { code: '42501', message: 'denied' } }) }) }),
                }),
              }),
            }
          : base.from(table),
    } as unknown as SupabaseClient;
    const error = await readableMailboxes(db, TENANT, 'google', mirrorOf([A, D])).catch((e: unknown) => e);
    expect((error as Error).message).toBe('allowlist lookup failed (42501)');
  });
});

// Design R4 (#275): an allowlisted address is read only when exactly one directory member has it as mail and no
// other member has it as UPN. Anything else is ambiguous: counted as missing, refused, and given no read key.
describe('readableMailboxes binds each address to exactly one directory member (#275, design R4)', () => {
  const user = (id: string, mail: string | null, upn: string) => ({ id, mail, upn });
  const directory = (members: Array<ReturnType<typeof user> | string>): ProviderAllowlistMirror => ({ listMembers: async () => members });
  const bindOne = async (address: string, members: Array<ReturnType<typeof user> | string>) => {
    const { db, rpc } = fakeDb([address]);
    const result = await readableMailboxes(db, TENANT, 'microsoft', directory(members));
    return { result, args: rpc.mock.calls[0][1] as Record<string, unknown> };
  };

  it('binds by mail when the mail equals the UPN', async () => {
    const { result } = await bindOne(A, [user('id-a', A, A)]);
    expect(result.status).toBe(DRIFT_STATUS.IN_SYNC);
    expect([...result.readable]).toEqual([A]);
    expect(result.providerCheck(A)).toBeNull();
    expect(result.readKey(A)).toEqual({ upn: A, id: 'id-a' });
  });

  it('binds by mail when the UPN differs from the mail, as a shared mailbox does, and reads it by its UPN', async () => {
    const { result } = await bindOne('deals@bank.example', [user('id-s', 'deals@bank.example', 'deals@bankexample.onmicrosoft.com')]);
    expect(result.status).toBe(DRIFT_STATUS.IN_SYNC);
    expect(result.providerCheck('deals@bank.example')).toBeNull();
    expect(result.readKey('deals@bank.example')).toEqual({ upn: 'deals@bankexample.onmicrosoft.com', id: 'id-s' });
  });

  it('lowercases members and the address asked about', async () => {
    const { result } = await bindOne(A, [user('id-a', '  Storm.Duncan@Bank.Example ', 'STORM.DUNCAN@BANK.EXAMPLE')]);
    expect(result.status).toBe(DRIFT_STATUS.IN_SYNC);
    expect(result.readKey('Storm.Duncan@bank.example')).toEqual({ upn: A, id: 'id-a' });
  });

  it.each([
    ['a UPN-only hit', [user('id-x', 'x@bank.example', A)]],
    ["another member's UPN", [user('id-a', A, 'a.upn@bank.example'), user('id-y', 'y@bank.example', A)]],
    ['two mail hits', [user('id-1', A, 'one@bank.example'), user('id-2', A, 'two@bank.example')]],
  ])('refuses %s as ambiguous: missing, not read, no read key', async (_name, members) => {
    const { result, args } = await bindOne(A, members);
    expect(result.status).toBe(DRIFT_STATUS.DRIFT);
    expect(result.readable.size).toBe(0);
    expect(result.missingInGroup).toEqual([A]);
    expect(result.providerCheck(A)).toBe('not_in_provider_group');
    expect(result.readKey(A)).toBeNull();
    expect(args.p_missing).toEqual([A]);
  });

  it('reports a member bound to no allowlisted address as extra, by its mail, or by its UPN when it has no mail', async () => {
    const { result, args } = await bindOne(A, [
      user('id-a', A, A),
      user('id-b', B, 'b.upn@bank.example'),
      user('id-c', null, 'c.upn@bank.example'),
    ]);
    expect(result.status).toBe(DRIFT_STATUS.DRIFT);
    expect(result.extraInGroup).toEqual([B, 'c.upn@bank.example'].sort());
    expect(args).toMatchObject({ p_status: 'drift', p_missing: [], p_extra: [B, 'c.upn@bank.example'].sort() });
    expect(result.providerCheck(B)).toBe('not_in_provider_group');
    expect(result.readKey(B)).toBeNull();
  });

  it('gives string members (Google, fixture) no read key: they bind by equality, as before', async () => {
    const { result } = await bindOne(A, [A, A.toUpperCase()]);
    expect(result.status).toBe(DRIFT_STATUS.IN_SYNC);
    expect(result.providerCheck(A)).toBeNull();
    expect(result.readKey(A)).toBeNull();
  });

  it('fails closed on a malformed directory member: unavailable, no read key', async () => {
    const { result, args } = await bindOne(A, [{ id: '', mail: A, upn: A }]);
    expect(result.status).toBe(DRIFT_STATUS.UNAVAILABLE);
    expect(result.providerCheck(A)).toBe('mirror_unavailable');
    expect(result.readKey(A)).toBeNull();
    expect(args).toMatchObject({ p_status: 'unavailable', p_missing: [], p_extra: [] });
  });

  it('gives no read key when the group cannot be read', async () => {
    const { db } = fakeDb([A]);
    const result = await readableMailboxes(db, TENANT, 'microsoft', failingMirror);
    expect(result.readKey(A)).toBeNull();
  });
});

describe('createFixtureAllowlistMirror', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('holds exactly the allowlist by default, and applies add, drop and fail', async () => {
    const { db } = fakeDb([A, B]);
    expect((await createFixtureAllowlistMirror(db).listMembers(TENANT, 'microsoft')).sort()).toEqual([A, B].sort());
    expect(
      (await createFixtureAllowlistMirror(db, { drop: [A.toUpperCase()], add: ['X@bank.example'] }).listMembers(TENANT, 'microsoft')).sort(),
    ).toEqual([B, 'x@bank.example'].sort());
    await expect(createFixtureAllowlistMirror(db, { fail: true }).listMembers(TENANT, 'microsoft')).rejects.toThrow(
      'fixture mirror unavailable',
    );
  });

  it('is refused in production', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'prod');
    expect(() => createFixtureAllowlistMirror(fakeDb([]).db)).toThrow('refused in production');
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', ' PRODUCTION ');
    expect(() => createFixtureAllowlistMirror(fakeDb([]).db)).toThrow('refused in production');
  });
});
