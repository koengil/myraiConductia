// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { GMAIL_READER_SCOPE } from '@/lib/constants/googleReader';
import {
  DELEGATION_RECHECK_MS,
  GOOGLE_REGISTRATION_COLUMNS,
  googleDelegationRecorder,
  googleReaderRegistry,
  googleRegistrationFromRow,
  REGISTRATION_STALE_MS,
} from '@/lib/google/reader/registration';
import type { createDelegatedTokenCache } from '@/lib/google/reader/token';
import type { SourceRow } from '@/lib/discovery/source/types';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ROW = {
  tenant_id: TENANT,
  workspace_domain: 'bank.example',
  service_account_email: 'dwd-reader@proj-1.iam.gserviceaccount.com',
  client_id: '123456789012345678',
  directory_service_account_email: 'dir-reader@proj-1.iam.gserviceaccount.com',
  allowlist_group: 'conductia-ingest@bank.example',
  firm_company_id: null,
};

function fakeDb(rows: Array<typeof ROW | null>) {
  const filters: Array<[string, unknown]> = [];
  let calls = 0;
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    },
    maybeSingle: async () => ({ data: rows[Math.min(calls++, rows.length - 1)], error: null }),
  };
  const from = vi.fn(() => builder);
  return { db: { from } as unknown as SupabaseClient, from, filters, calls: () => calls };
}

const source: SourceRow = {
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: TENANT,
  kind: 'mailbox',
  provider: 'google',
  address: 'Storm.Duncan@bank.example',
  ownerUserId: null,
  deltaCheckpoint: null,
};

describe('the Google registration registry', () => {
  it('reads only the active registration of the tenant, and caches it for a minute', async () => {
    let now = 1_000;
    const { db, from, filters, calls } = fakeDb([ROW]);
    const registry = googleReaderRegistry(undefined, { db: () => db, now: () => now });
    const first = await registry.registrationFor(TENANT);
    expect(first).toMatchObject({ tenantId: TENANT, workspaceDomain: 'bank.example', allowlistGroup: 'conductia-ingest@bank.example' });
    expect(from).toHaveBeenCalledWith('google_reader_registrations');
    expect(filters).toEqual([['tenant_id', TENANT], ['status', 'active']]);

    now += REGISTRATION_STALE_MS - 1;
    await registry.registrationFor(TENANT);
    expect(calls()).toBe(1);
    now += 2;
    await registry.registrationFor(TENANT);
    expect(calls()).toBe(2);
  });

  it('throws when the tenant has no active registration, and stops serving a cached one once it is gone', async () => {
    let now = 0;
    const { db } = fakeDb([ROW, null]);
    const registry = googleReaderRegistry(undefined, { db: () => db, now: () => now });
    await registry.registrationFor(TENANT);
    now += REGISTRATION_STALE_MS + 1;
    await expect(registry.registrationFor(TENANT)).rejects.toThrow('no active Google registration for this tenant');
  });

  it('builds a gmail.readonly token source for the mailbox, keyed by the registration and the address', async () => {
    const { db } = fakeDb([ROW]);
    const forSubject = vi.fn(() => async () => 'token');
    const tokens = { forSubject } as unknown as ReturnType<typeof createDelegatedTokenCache>;
    const registry = googleReaderRegistry(tokens, { db: () => db });
    const http = await registry.httpFor(source);
    expect(await http.getToken()).toBe('token');
    expect(forSubject).toHaveBeenCalledWith(
      { tenantId: TENANT, serviceAccountEmail: ROW.service_account_email },
      'Storm.Duncan@bank.example',
      GMAIL_READER_SCOPE.READONLY,
    );
  });

  it('returns the registration client id with the options, from the one lookup it already made (#370)', async () => {
    const { db, calls } = fakeDb([ROW]);
    const tokens = { forSubject: vi.fn(() => async () => 'token') } as unknown as ReturnType<typeof createDelegatedTokenCache>;
    const registry = googleReaderRegistry(tokens, { db: () => db });
    const http = await registry.httpFor(source);
    expect(http.clientId).toBe(ROW.client_id);
    expect(calls()).toBe(1);
    // Never the service-account email, which is address-shaped.
    expect(JSON.stringify({ ...http, getToken: undefined })).not.toContain('@');
  });

  it('refuses to mint for a mailbox outside the registered Workspace domain', async () => {
    const { db } = fakeDb([ROW]);
    const forSubject = vi.fn(() => async () => 'token');
    const tokens = { forSubject } as unknown as ReturnType<typeof createDelegatedTokenCache>;
    const registry = googleReaderRegistry(tokens, { db: () => db });
    for (const address of ['ceo@other.example', 'ceo@sub.bank.example', 'ceo@bank.example.evil', 'bank.example', '']) {
      await expect(registry.httpFor({ ...source, address }), address).rejects.toThrow('mailbox is outside the registered Workspace domain');
    }
    expect(forSubject).not.toHaveBeenCalled();
    await registry.httpFor({ ...source, address: 'storm.duncan@BANK.Example' });
    expect(forSubject).toHaveBeenCalledTimes(1);
  });

  it('refuses to build HTTP options without a token cache', async () => {
    const registry = googleReaderRegistry(undefined, { db: () => fakeDb([ROW]).db });
    await expect(registry.httpFor(source)).rejects.toThrow(/no token cache/);
  });
});

describe('the registration row mapping, shared with the connection probe (#344, R15)', () => {
  it('maps every selected column, and the registry selects exactly those columns', async () => {
    expect(googleRegistrationFromRow(ROW)).toEqual({
      tenantId: TENANT,
      workspaceDomain: 'bank.example',
      serviceAccountEmail: 'dwd-reader@proj-1.iam.gserviceaccount.com',
      clientId: '123456789012345678',
      directoryServiceAccountEmail: 'dir-reader@proj-1.iam.gserviceaccount.com',
      allowlistGroup: 'conductia-ingest@bank.example',
      firmCompanyId: null,
    });
    expect(GOOGLE_REGISTRATION_COLUMNS.split(',').map((c) => c.trim()).sort()).toEqual(Object.keys(ROW).sort());
    const select = vi.fn();
    const builder = {
      select: (columns: string) => (select(columns), builder),
      eq: () => builder,
      maybeSingle: async () => ({ data: ROW, error: null }),
    };
    const registry = googleReaderRegistry(undefined, { db: () => ({ from: () => builder }) as unknown as SupabaseClient });
    expect(await registry.registrationFor(TENANT)).toEqual(googleRegistrationFromRow(ROW));
    expect(select).toHaveBeenCalledWith(GOOGLE_REGISTRATION_COLUMNS);
  });
});

describe('the delegation status recorder (plan D11)', () => {
  const identity = { tenantId: TENANT, serviceAccountEmail: ROW.service_account_email };

  function updateDb(result: { error: { code?: string } | null } = { error: null }) {
    const writes: Array<{ table: string; values: Record<string, unknown>; filters: string[] }> = [];
    const from = vi.fn((table: string) => ({
      update: (values: Record<string, unknown>) => {
        const write = { table, values, filters: [] as string[] };
        writes.push(write);
        const builder = {
          eq: (column: string, value: unknown) => {
            write.filters.push(`${column}=${String(value)}`);
            return builder;
          },
          or: async (expression: string) => {
            write.filters.push(`or(${expression})`);
            return result;
          },
        };
        return builder;
      },
    }));
    return { db: { from } as unknown as SupabaseClient, writes };
  }

  it('writes the status and time for the tenant, guarded in the database by change or age', async () => {
    const now = Date.UTC(2026, 9, 21, 9, 0, 0);
    const { db, writes } = updateDb();
    await googleDelegationRecorder({ db: () => db, now: () => now })(identity, 'missing');
    expect(writes).toHaveLength(1);
    expect(writes[0].table).toBe('google_reader_registrations');
    expect(writes[0].values).toEqual({ delegation_status: 'missing', delegation_checked_at: new Date(now).toISOString() });
    expect(writes[0].filters[0]).toBe(`tenant_id=${TENANT}`);
    expect(writes[0].filters[1]).toContain('delegation_status.neq.missing');
    expect(writes[0].filters[1]).toContain('delegation_status.is.null');
    expect(writes[0].filters[1]).toContain(`delegation_checked_at.lt.${new Date(now - DELEGATION_RECHECK_MS).toISOString()}`);
  });

  it('writes only on a change, or when the last check is older than an hour, not once per mint', async () => {
    let now = 0;
    const { db, writes } = updateDb();
    const record = googleDelegationRecorder({ db: () => db, now: () => now });
    await record(identity, 'ok');
    await record(identity, 'ok');
    now += DELEGATION_RECHECK_MS - 1;
    await record(identity, 'ok');
    expect(writes).toHaveLength(1);

    await record(identity, 'missing');
    expect(writes).toHaveLength(2);
    await record(identity, 'ok');
    expect(writes).toHaveLength(3);

    now += DELEGATION_RECHECK_MS;
    await record(identity, 'ok');
    expect(writes).toHaveLength(4);
  });

  it('keeps a separate hour for each tenant', async () => {
    const { db, writes } = updateDb();
    const record = googleDelegationRecorder({ db: () => db, now: () => 0 });
    await record(identity, 'ok');
    await record({ ...identity, tenantId: '99999999-9999-4999-8999-999999999999' }, 'ok');
    expect(writes).toHaveLength(2);
  });

  it('never throws into the read that minted the token, and tries again after a failed write', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = updateDb({ error: { code: '42501' } });
    const record = googleDelegationRecorder({ db: () => failing.db, now: () => 0 });
    await expect(record(identity, 'ok')).resolves.toBeUndefined();
    await record(identity, 'ok');
    expect(failing.writes).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith('google delegation status could not be recorded');
    // The log line carries no detail from the database.
    expect(JSON.stringify(warn.mock.calls)).not.toContain('42501');
    warn.mockRestore();
  });
});
