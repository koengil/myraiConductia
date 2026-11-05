// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReaderRegistration, ReaderTokenCache } from '@/lib/graph/reader/token';

/*
 * The Exchange group mirror (#275, design R1-R4, R8, R12), driven through the fake Graph tenant. The mirror is the
 * real one, reached the way the worker reaches it: createLiveAllowlistMirror in readers.ts, which holds the reader
 * capability. Only getGraphGroupMirror's dependencies are injected here: the registration lookup, a token cache that
 * mints a fixed token, and the fake tenant as the transport.
 */
const wire = vi.hoisted(() => ({
  db: null as unknown,
  fetch: (async () => {
    throw new Error('no transport wired');
  }) as typeof fetch,
  registrations: [] as unknown[],
}));
vi.mock('@/lib/graph/reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/graph/reader')>();
  const tokenCache = {
    forRegistration: (registration: ReaderRegistration) => {
      wire.registrations.push(registration);
      return async () => 'fake-token';
    },
  } as unknown as ReaderTokenCache;
  return {
    ...actual,
    getGraphGroupMirror: (capability: Parameters<typeof actual.getGraphGroupMirror>[0]) =>
      actual.getGraphGroupMirror(capability, {
        db: () => wire.db as SupabaseClient,
        tokenCache,
        fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => wire.fetch(input, init)) as typeof fetch,
      }),
  };
});

import {
  createFakeTenant,
  fakeGroupUsers,
  FAKE_GROUP_HAZARDS,
  FAKE_GROUP_ID,
  FAKE_SHARED_MAILBOX,
  type FakeTenantOptions,
} from '../../scripts/m365/cassette/fakeTenant';
import { GraphHttpError } from '@/lib/graph/http';
import { getGraphGroupMirror } from '@/lib/graph/reader';
import { createGraphGroupMirror } from '@/lib/graph/reader/groupMirror';
import { createLiveAllowlistMirror, MailboxAccessRefusedError, readableMailboxes } from '@/lib/mailboxAccess';

const TENANT = '11111111-1111-4111-8111-111111111111';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const MEMBERS = `${GRAPH}/groups/${FAKE_GROUP_ID}/members?$select=id,mail,userPrincipalName&$top=999`;
const REGISTRATION = {
  tenant_id: TENANT,
  ms_tenant_id: '00000000-0000-4000-8000-00000000000a',
  client_id: '00000000-0000-4000-8000-00000000000b',
  cert_thumbprint: 'a'.repeat(64),
  cert_secret_ref: 'env:M365_READER_PEM',
  scope_group_id: FAKE_GROUP_ID,
};
type RegistrationRow = typeof REGISTRATION | (Omit<typeof REGISTRATION, 'scope_group_id'> & { scope_group_id: string | null });

const ALEX = 'alex.chen@bank.example';
const MORGAN = 'morgan.vale@bank.example';
const STORM = 'storm.duncan@bank.example';
const SHARED = FAKE_SHARED_MAILBOX.mail;
const JOINER = 'new.joiner@bank.example';
const { UPN_DIFFERS, UPN_IS_OTHERS_MAIL, UPN_ONLY } = FAKE_GROUP_HAZARDS;
const idOf = (mail: string) => fakeGroupUsers().find((user) => user.mail.toLowerCase() === mail)!.id;

/** A service client for the registration lookup, the allowed_mailboxes pages and the drift RPC. */
function fakeDb(registration: RegistrationRow | null, allowed: string[]) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const lookups: Array<{ table: string; columns: string; filters: Array<[string, unknown]> }> = [];
  const db = {
    from: (table: string) => {
      const lookup = { table, columns: '', filters: [] as Array<[string, unknown]> };
      lookups.push(lookup);
      const builder = {
        select: (columns: string) => {
          lookup.columns = columns;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          lookup.filters.push([column, value]);
          return builder;
        },
        order: () => builder,
        range: async () => ({ data: allowed.map((address) => ({ address })), error: null }),
        maybeSingle: async () => ({ data: registration, error: null }),
      };
      return builder;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: true, error: null };
    },
  } as unknown as SupabaseClient;
  return { db, rpcCalls, lookups };
}

/** Wires the fake tenant (or a stand-in transport) and the registration, and records every Graph request. */
function wireTenant(
  options: { tenant?: FakeTenantOptions; registration?: RegistrationRow | null; allowed?: string[]; transport?: typeof fetch } = {},
) {
  const transport = options.transport ?? createFakeTenant(options.tenant).fetch;
  const requests: Array<{ url: string; headers: Headers }> = [];
  wire.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return transport(input, init);
  }) as typeof fetch;
  const db = fakeDb(options.registration === undefined ? REGISTRATION : options.registration, options.allowed ?? []);
  wire.db = db.db;
  return { requests, ...db };
}

beforeEach(() => {
  wire.registrations.length = 0;
});

describe('the Exchange group mirror (#275)', () => {
  it('lists every page of the scope group, keeps the shared mailbox, and skips the nested group and the contact', async () => {
    const { requests, lookups } = wireTenant();
    const members = (await createLiveAllowlistMirror().listMembers(TENANT, 'microsoft')) as Array<{ id: string; mail: string | null; upn: string }>;

    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    const expected = fakeGroupUsers().map((user) => ({ id: user.id, mail: user.mail.toLowerCase(), upn: user.upn.toLowerCase() }));
    expect([...members].sort(byId)).toEqual(expected.sort(byId));
    expect(members).toContainEqual({ id: FAKE_SHARED_MAILBOX.id, mail: 'deals@bank.example', upn: 'deals@bankexample.onmicrosoft.com' });
    // Only users: the nested group and the contact are not in the list.
    expect(members).toHaveLength(fakeGroupUsers().length);

    // Two pages, the second through nextLink, each with the reader's own token.
    expect(requests.map((r) => r.url)).toEqual([MEMBERS, expect.stringMatching(/^https:\/\/graph\.microsoft\.com\/v1\.0\/groups\/[^/]+\/members\?.*\$skiptoken=/)]);
    for (const request of requests) expect(request.headers.get('Authorization')).toBe('Bearer fake-token');

    // The tenant's active registration, read for its group, authenticates the read.
    expect(lookups).toEqual([
      {
        table: 'graph_reader_registrations',
        columns: expect.stringContaining('scope_group_id'),
        filters: [
          ['tenant_id', TENANT],
          ['status', 'active'],
        ],
      },
    ]);
    expect(wire.registrations).toEqual([
      {
        tenantId: TENANT,
        msTenantId: REGISTRATION.ms_tenant_id,
        clientId: REGISTRATION.client_id,
        certThumbprint: REGISTRATION.cert_thumbprint,
        certSecretRef: REGISTRATION.cert_secret_ref,
      },
    ]);
  });

  it('is built behind the reader capability', () => {
    let error: unknown;
    try {
      getGraphGroupMirror({} as never);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MailboxAccessRefusedError);
    expect(error).toMatchObject({ reason: 'no_capability' });
  });

  it('throws, before any Graph request, when the tenant has no active Microsoft registration', async () => {
    const { requests } = wireTenant({ registration: null });
    await expect(createLiveAllowlistMirror().listMembers(TENANT, 'microsoft')).rejects.toThrow(/no active Microsoft registration/);
    expect(requests).toEqual([]);
  });

  it('throws, before any Graph request, when the registration records no scope group', async () => {
    const { requests } = wireTenant({ registration: { ...REGISTRATION, scope_group_id: null } });
    await expect(createLiveAllowlistMirror().listMembers(TENANT, 'microsoft')).rejects.toThrow(/no scope group recorded/);
    expect(requests).toEqual([]);
  });

  it('throws on a refused listing, with the status and code and nothing from the body', async () => {
    const denied = (async () =>
      new Response(JSON.stringify({ error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges for deals@bank.example' } }), {
        status: 403,
      })) as typeof fetch;
    const { requests } = wireTenant({ transport: denied });
    const error = await createLiveAllowlistMirror().listMembers(TENANT, 'microsoft').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphHttpError);
    expect(error).toMatchObject({ status: 403, code: 'Authorization_RequestDenied' });
    expect((error as Error).message).not.toContain('@');
    // A 403 is not retried.
    expect(requests).toHaveLength(1);
  });

  it('throws when the recorded group is not one the tenant holds', async () => {
    wireTenant({ registration: { ...REGISTRATION, scope_group_id: '00000000-0000-4000-8000-0000000000ff' } });
    await expect(createLiveAllowlistMirror().listMembers(TENANT, 'microsoft')).rejects.toMatchObject({ status: 404 });
  });

  it('throws when a user comes back with no UPN: the group is unreadable, not empty', async () => {
    wireTenant({ tenant: { strip: 'mailAndUpn' } });
    await expect(createLiveAllowlistMirror().listMembers(TENANT, 'microsoft')).rejects.toThrow(/member addresses not readable/);
  });

  it('throws when no user comes back with mail: the group is unreadable, not drifted (review r2 #6)', async () => {
    wireTenant({ tenant: { strip: 'mail' } });
    await expect(createLiveAllowlistMirror().listMembers(TENANT, 'microsoft')).rejects.toThrow(/member mail not readable/);
  });

  it('serves microsoft only', async () => {
    const { db, lookups } = fakeDb(REGISTRATION, []);
    const mirror = createGraphGroupMirror({ db: () => db, httpFor: () => ({ getToken: async () => 'fake-token', fetchImpl: wire.fetch }) });
    await expect(mirror.listMembers(TENANT, 'google')).rejects.toThrow(/serves microsoft/);
    expect(lookups).toEqual([]);
  });
});

describe('the Exchange mirror through readableMailboxes (#275, #262)', () => {
  it('records a member without an invite and opt-in as extra and an allowlisted user missing from the group as missing, and reads neither', async () => {
    // Morgan is in the group with no allowlist row; the new joiner is allowlisted and not in the group. The hazard
    // members are in the group and allowlisted under none of their addresses, so they are extra too.
    const { rpcCalls } = wireTenant({ allowed: [ALEX, STORM, SHARED, JOINER] });
    const result = await readableMailboxes(wire.db as SupabaseClient, TENANT, 'microsoft', createLiveAllowlistMirror());
    expect(result.status).toBe('drift');
    expect([...result.readable].sort()).toEqual([ALEX, SHARED, STORM].sort());
    expect(rpcCalls).toEqual([
      {
        fn: 'discovery_record_allowlist_drift',
        args: {
          p_tenant_id: TENANT,
          p_provider: 'microsoft',
          p_status: 'drift',
          p_missing: [JOINER],
          p_extra: [UPN_IS_OTHERS_MAIL.mail, UPN_DIFFERS.mail, MORGAN, UPN_ONLY.mail].sort(),
          p_present: [ALEX, SHARED, STORM].sort(),
        },
      },
    ]);
    expect(result.providerCheck(MORGAN)).toBe('not_in_provider_group');
    expect(result.providerCheck(JOINER)).toBe('not_in_provider_group');
    expect(result.readKey(MORGAN)).toBeNull();
    expect(result.readKey(JOINER)).toBeNull();
  });

  it('as the worker reads it (recordPresence false), records the drift with no address present, so group removal never starts (D100)', async () => {
    const { rpcCalls } = wireTenant({ allowed: [ALEX, STORM, SHARED, JOINER] });
    const result = await readableMailboxes(wire.db as SupabaseClient, TENANT, 'microsoft', createLiveAllowlistMirror(), {
      recordPresence: false,
    });
    expect([...result.readable].sort()).toEqual([ALEX, SHARED, STORM].sort());
    expect(rpcCalls[0].args).toMatchObject({ p_status: 'drift', p_missing: [JOINER], p_present: [] });
  });

  it('binds the shared mailbox by its mail and reads it by its UPN; every bound mailbox has a read key', async () => {
    wireTenant({ allowed: [ALEX, STORM, SHARED] });
    const result = await readableMailboxes(wire.db as SupabaseClient, TENANT, 'microsoft', createLiveAllowlistMirror());
    expect(result.providerCheck(SHARED)).toBeNull();
    expect(result.readKey(SHARED)).toEqual({ upn: 'deals@bankexample.onmicrosoft.com', id: FAKE_SHARED_MAILBOX.id });
    // Alex is held in upper case in the directory: bound in lower case, read by the lowercased UPN.
    expect(result.readKey(ALEX)).toEqual({ upn: ALEX, id: idOf(ALEX) });
    expect(result.readKey(STORM)).toEqual({ upn: STORM, id: idOf(STORM) });
  });

  it("refuses every ambiguous address with no read key: another member's UPN, and a UPN-only hit", async () => {
    // UPN_DIFFERS's mail is UPN_IS_OTHERS_MAIL's UPN; UPN_ONLY's UPN is no member's mail.
    const { rpcCalls } = wireTenant({ allowed: [UPN_DIFFERS.mail, UPN_ONLY.upn] });
    const result = await readableMailboxes(wire.db as SupabaseClient, TENANT, 'microsoft', createLiveAllowlistMirror());
    expect(result.readable.size).toBe(0);
    expect(result.missingInGroup).toEqual([UPN_DIFFERS.mail, UPN_ONLY.upn].sort());
    for (const address of [UPN_DIFFERS.mail, UPN_ONLY.upn]) {
      expect(result.providerCheck(address)).toBe('not_in_provider_group');
      expect(result.readKey(address)).toBeNull();
    }
    expect(rpcCalls[0].args).toMatchObject({ p_status: 'drift', p_missing: [UPN_DIFFERS.mail, UPN_ONLY.upn].sort() });
  });

  it.each([
    ['no mail on any member', { tenant: { strip: 'mail' } }],
    ['no scope group recorded', { registration: { ...REGISTRATION, scope_group_id: null } }],
  ] as Array<[string, Parameters<typeof wireTenant>[0]]>)('an unreadable group (%s) is unavailable: every mailbox refused as mirror_unavailable, no read key', async (_name, options) => {
    const { rpcCalls } = wireTenant({ ...options, allowed: [ALEX, SHARED] });
    const result = await readableMailboxes(wire.db as SupabaseClient, TENANT, 'microsoft', createLiveAllowlistMirror());
    expect(result.status).toBe('unavailable');
    expect(result.readable.size).toBe(0);
    for (const address of [ALEX, SHARED]) {
      expect(result.providerCheck(address)).toBe('mirror_unavailable');
      expect(result.readKey(address)).toBeNull();
    }
    expect(rpcCalls).toEqual([
      {
        fn: 'discovery_record_allowlist_drift',
        args: { p_tenant_id: TENANT, p_provider: 'microsoft', p_status: 'unavailable', p_missing: [], p_extra: [], p_present: [] },
      },
    ]);
  });
});
