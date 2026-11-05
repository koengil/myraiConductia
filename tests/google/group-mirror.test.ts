// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { createGoogleGroupMirror } from '@/lib/google/reader/groupMirror';
import type { GoogleRegistration } from '@/lib/google/reader/registration';
import { createFixtureAllowlistMirror, readableMailboxes } from '@/lib/mailboxAccess/mirror';

import { scripted, type Reply } from './helpers';

const TENANT = '11111111-1111-4111-8111-111111111111';
const REGISTRATION: GoogleRegistration = {
  tenantId: TENANT,
  workspaceDomain: 'bank.example',
  serviceAccountEmail: 'dwd-reader@proj-1.iam.gserviceaccount.com',
  clientId: '123456789012345678',
  directoryServiceAccountEmail: 'dir-reader@proj-1.iam.gserviceaccount.com',
  allowlistGroup: 'conductia-ingest@bank.example',
  firmCompanyId: null,
};
const registry = { registrationFor: async () => REGISTRATION };
const TOKEN_REPLY: Reply = { status: 200, body: { accessToken: 'directory-token' } };

function mirrorWith(replies: Reply[]) {
  const { fetchImpl, calls } = scripted([TOKEN_REPLY, ...replies]);
  return { mirror: createGoogleGroupMirror({ callerToken: async () => 'caller-token', registry, fetchImpl }), calls };
}

describe('the Google group mirror (C7)', () => {
  it('lists every member page, lowercased, through the directory identity', async () => {
    const { mirror, calls } = mirrorWith([
      { status: 200, body: { members: [{ email: 'Storm.Duncan@Bank.Example', type: 'USER' }], nextPageToken: 'next-1' } },
      { status: 200, body: { members: [{ email: 'morgan.vale@bank.example', type: 'USER' }], nextPageToken: 'next-2' } },
      { status: 200, body: { members: [{ email: 'alex.chen@bank.example', type: 'USER' }] } },
    ]);
    expect(await mirror.listMembers(TENANT, 'google')).toEqual([
      'storm.duncan@bank.example',
      'morgan.vale@bank.example',
      'alex.chen@bank.example',
    ]);
    // The first call mints the directory SA's own token; the members calls carry it, never the caller's.
    expect(calls[0].url).toContain('iamcredentials.googleapis.com');
    expect(calls[0].url).toContain(encodeURIComponent(REGISTRATION.directoryServiceAccountEmail));
    // Both directory scopes, as on the directory credential's own token (#581: the team inbox check needs users).
    expect(JSON.parse(String(calls[0].init.body)).scope).toEqual([
      'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
      'https://www.googleapis.com/auth/admin.directory.user.readonly',
    ]);
    const memberCalls = calls.slice(1);
    expect(memberCalls).toHaveLength(3);
    for (const call of memberCalls) {
      expect(call.url).toContain(`/groups/${encodeURIComponent('conductia-ingest@bank.example')}/members`);
      expect(call.url).toContain('maxResults=200');
      expect(new Headers(call.init.headers).get('Authorization')).toBe('Bearer directory-token');
    }
    expect(memberCalls[1].url).toContain('pageToken=next-1');
    expect(memberCalls[2].url).toContain('pageToken=next-2');
  });

  it('uses the directory credential token as it comes when one is given, with no IAM Credentials call (#344, R5)', async () => {
    const { fetchImpl, calls } = scripted([
      { status: 200, body: { members: [{ email: 'Storm.Duncan@Bank.Example', type: 'USER' }] } },
    ]);
    const callerCalls: number[] = [];
    let directoryCalls = 0;
    const mirror = createGoogleGroupMirror({
      callerToken: async () => {
        callerCalls.push(1);
        return 'caller-token';
      },
      directoryToken: async () => {
        directoryCalls += 1;
        return 'impersonated-directory-token';
      },
      registry,
      fetchImpl,
    });
    expect(await mirror.listMembers(TENANT, 'google')).toEqual(['storm.duncan@bank.example']);
    expect(directoryCalls).toBe(1);
    expect(callerCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).not.toContain('iamcredentials.googleapis.com');
    expect(calls[0].url).toContain(`/groups/${encodeURIComponent('conductia-ingest@bank.example')}/members`);
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer impersonated-directory-token');
  });

  it('a failing directory credential fails the read closed, with no fallback to the caller path', async () => {
    const { fetchImpl, calls } = scripted([]);
    const mirror = createGoogleGroupMirror({
      callerToken: async () => 'caller-token',
      directoryToken: async () => {
        throw new Error('STS refused');
      },
      registry,
      fetchImpl,
    });
    await expect(mirror.listMembers(TENANT, 'google')).rejects.toThrow(/STS refused/);
    expect(calls).toHaveLength(0);
  });

  it('drops members that are not users, and members with no email', async () => {
    const { mirror } = mirrorWith([
      {
        status: 200,
        body: {
          members: [
            { email: 'a@bank.example', type: 'USER' },
            { email: 'team@bank.example', type: 'GROUP' },
            { email: 'everyone@bank.example', type: 'CUSTOMER' },
            { type: 'USER' },
          ],
        },
      },
    ]);
    expect(await mirror.listMembers(TENANT, 'google')).toEqual(['a@bank.example']);
  });

  it('throws on any HTTP error, so the pass fails closed', async () => {
    const { mirror } = mirrorWith([{ status: 403, body: { error: { errors: [{ reason: 'forbidden' }], message: 'Subject: Project Falcon' } } }]);
    const error = await mirror.listMembers(TENANT, 'google').catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 403, reason: 'forbidden' });
    expect((error as Error).message).not.toContain('Falcon');
  });

  it('throws when the directory token cannot be minted', async () => {
    const { fetchImpl } = scripted([{ status: 403, body: { error: { status: 'PERMISSION_DENIED' } } }]);
    const mirror = createGoogleGroupMirror({ callerToken: async () => 'caller', registry, fetchImpl });
    await expect(mirror.listMembers(TENANT, 'google')).rejects.toMatchObject({ status: 403 });
  });

  it('throws when the tenant has no active registration', async () => {
    const mirror = createGoogleGroupMirror({
      callerToken: async () => 'caller',
      registry: { registrationFor: async () => { throw new Error('no active Google registration for this tenant'); } },
      fetchImpl: scripted([]).fetchImpl,
    });
    await expect(mirror.listMembers(TENANT, 'google')).rejects.toThrow(/no active Google registration/);
  });

  it('serves google only', async () => {
    const { mirror, calls } = mirrorWith([]);
    await expect(mirror.listMembers(TENANT, 'microsoft')).rejects.toThrow(/serves google/);
    expect(calls).toHaveLength(0);
  });
});

/** A fake service client for readableMailboxes: the allowed_mailboxes rows and the drift RPC. */
function fakeDb(allowed: string[]) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    range: async () => ({ data: allowed.map((address) => ({ address })), error: null }),
  };
  const db = {
    from: () => builder,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: true, error: null };
    },
  } as unknown as SupabaseClient;
  return { db, rpcCalls };
}

describe('the Google mirror through readableMailboxes (#262)', () => {
  it('reads the intersection, records drift for a member that left the group, and refuses that mailbox with not_in_provider_group', async () => {
    const { mirror } = mirrorWith([{ status: 200, body: { members: [{ email: 'a@bank.example', type: 'USER' }, { email: 'stray@bank.example', type: 'USER' }] } }]);
    const { db, rpcCalls } = fakeDb(['a@bank.example', 'b@bank.example']);
    const result = await readableMailboxes(db, TENANT, 'google', mirror);
    expect(result.status).toBe('drift');
    expect([...result.readable]).toEqual(['a@bank.example']);
    expect(result.missingInGroup).toEqual(['b@bank.example']);
    expect(result.extraInGroup).toEqual(['stray@bank.example']);
    expect(result.providerCheck('a@bank.example')).toBeNull();
    expect(result.providerCheck('b@bank.example')).toBe('not_in_provider_group');
    expect(rpcCalls).toEqual([
      {
        fn: 'discovery_record_allowlist_drift',
        args: { p_tenant_id: TENANT, p_provider: 'google', p_status: 'drift', p_missing: ['b@bank.example'], p_extra: ['stray@bank.example'], p_present: ['a@bank.example'] },
      },
    ]);
  });

  it('an unavailable mirror is recorded as unavailable and refuses every mailbox with mirror_unavailable', async () => {
    // A 403 is not retried, so the mirror fails at once: the directory identity was refused.
    const { fetchImpl } = scripted([{ status: 403, body: { error: { status: 'PERMISSION_DENIED' } } }]);
    const mirror = createGoogleGroupMirror({ callerToken: async () => 'caller', registry, fetchImpl });
    const { db, rpcCalls } = fakeDb(['a@bank.example']);
    const result = await readableMailboxes(db, TENANT, 'google', mirror);
    expect(result.status).toBe('unavailable');
    expect(result.readable.size).toBe(0);
    expect(result.providerCheck('a@bank.example')).toBe('mirror_unavailable');
    expect(rpcCalls[0].args).toMatchObject({ p_provider: 'google', p_status: 'unavailable' });
  });

  it('an in-sync group records in_sync and passes every allowlisted mailbox', async () => {
    const { mirror } = mirrorWith([{ status: 200, body: { members: [{ email: 'A@bank.example', type: 'USER' }] } }]);
    const { db } = fakeDb(['a@bank.example']);
    const result = await readableMailboxes(db, TENANT, 'google', mirror);
    expect(result.status).toBe('in_sync');
    expect(result.providerCheck('a@bank.example')).toBeNull();
  });
});

// Audit item 3: live mode reads a team inbox only when its address is a DIRECT member of the ingest group. The
// fixture mirror lists the allowlist views themselves, so it admits a team inbox silently; the live one lists the
// group's direct USER members, so a deals@ nobody added (or added only through a nested group) is refused.
describe('a team inbox through the LIVE mirror shape (#581, audit item 3)', () => {
  const TEAM = 'deals@bank.example';
  const PERSON = 'storm.duncan@bank.example';
  /** The two allowlist views, each with its own rows, as readableMailboxes pages them. */
  function viewsDb() {
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const db = {
      from: (table: string) => {
        const rows = table === 'allowed_team_mailboxes' ? [{ address: TEAM }] : [{ address: PERSON }];
        const builder = { select: () => builder, eq: () => builder, order: () => builder, range: async () => ({ data: rows, error: null }) };
        return builder;
      },
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        return { data: true, error: null };
      },
    } as unknown as SupabaseClient;
    return { db, rpcCalls };
  }

  it('refuses a verified team inbox that is only inside a nested group, and records it missing', async () => {
    const { mirror } = mirrorWith([
      { status: 200, body: { members: [{ email: PERSON, type: 'USER' }, { email: 'team-inboxes@bank.example', type: 'GROUP' }] } },
    ]);
    const { db, rpcCalls } = viewsDb();
    const result = await readableMailboxes(db, TENANT, 'google', mirror);
    expect(result.providerCheck(PERSON)).toBeNull();
    expect(result.providerCheck(TEAM)).toBe('not_in_provider_group');
    expect(result.missingInGroup).toEqual([TEAM]);
    expect(rpcCalls[0].args).toMatchObject({ p_status: 'drift', p_missing: [TEAM] });
  });

  it('reads it once the Workspace admin adds it directly, by its primary address', async () => {
    const { mirror } = mirrorWith([
      { status: 200, body: { members: [{ email: PERSON, type: 'USER' }, { email: 'Deals@Bank.Example', type: 'USER' }] } },
    ]);
    const { db } = viewsDb();
    const result = await readableMailboxes(db, TENANT, 'google', mirror);
    expect(result.providerCheck(TEAM)).toBeNull();
    expect(result.status).toBe('in_sync');
  });

  it('the fixture mirror, by contrast, admits it silently: it lists the views, not a group', async () => {
    const { db } = viewsDb();
    const result = await readableMailboxes(db, TENANT, 'google', createFixtureAllowlistMirror(db));
    expect(result.providerCheck(TEAM)).toBeNull();
  });
});
