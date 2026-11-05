import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The guard asks the database through a service client it builds itself
 * (#262, audit round 1, item 2). A caller-supplied `db` whose rpc answers
 * "allowed" must never decide a read, so the guard has no db parameter and a
 * smuggled one is ignored.
 */

const admin = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseAdminClient: () => ({ rpc: admin.rpc }),
}));

import { MAILBOX_PROVIDER, SOURCE_KIND, READER_MODE } from '@/lib/constants/discovery';
import {
  assertMailboxAllowed,
  assertSourceAllowed,
  guardedContentSource,
  MailboxAccessRefusedError,
  type SourceRow,
} from '@/lib/mailboxAccess';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = 'storm.duncan@bank.example';

/** A stub that answers "allowed" to everything and records that it was asked. */
function allowAll() {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
  return { db: { rpc } as unknown as SupabaseClient, rpc };
}

const source: SourceRow = {
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: TENANT,
  kind: SOURCE_KIND.MAILBOX,
  provider: MAILBOX_PROVIDER.MICROSOFT,
  address: ADDRESS,
  ownerUserId: OWNER,
  deltaCheckpoint: null,
};

beforeEach(() => {
  admin.rpc.mockReset();
});

describe('the guard owns its service client', () => {
  it('assertMailboxAllowed ignores a caller-supplied db that says "allowed"', async () => {
    admin.rpc.mockResolvedValue({ data: 'no_consent', error: null });
    const stub = allowAll();
    const error = await assertMailboxAllowed(TENANT, ADDRESS, {
      db: stub.db,
      purpose: 'agent_tool',
      caller: 'agent-tool:test',
      owner: { userId: OWNER },
      provider: 'microsoft',
    } as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailboxAccessRefusedError);
    expect(error).toMatchObject({ reason: 'no_consent' });
    expect(stub.rpc).not.toHaveBeenCalled();
    expect(admin.rpc).toHaveBeenCalledTimes(1);
  });

  it('assertSourceAllowed ignores a caller-supplied db, for a mailbox and for a site', async () => {
    admin.rpc.mockResolvedValueOnce({ data: 'seat_inactive', error: null });
    admin.rpc.mockResolvedValueOnce({ data: 'site_not_registered', error: null });
    const stub = allowAll();
    const ctx = { db: stub.db, purpose: 'provider_read', caller: 'discovery-worker', provider: 'microsoft' } as never;
    await expect(
      assertSourceAllowed(TENANT, { kind: SOURCE_KIND.MAILBOX, address: ADDRESS, ownerUserId: OWNER }, ctx),
    ).rejects.toMatchObject({ reason: 'seat_inactive' });
    await expect(
      assertSourceAllowed(TENANT, { kind: SOURCE_KIND.SHAREPOINT_SITE, address: 'x.sharepoint.com:/sites/a', ownerUserId: null }, ctx),
    ).rejects.toMatchObject({ reason: 'site_not_registered' });
    expect(stub.rpc).not.toHaveBeenCalled();
  });

  it('a guarded reader ignores a caller-supplied db and reads nothing when the real guard refuses', async () => {
    admin.rpc.mockResolvedValue({ data: 'no_consent', error: null });
    const stub = allowAll();
    const reader = guardedContentSource(
      { kind: SOURCE_KIND.MAILBOX, provider: MAILBOX_PROVIDER.MICROSOFT },
      READER_MODE.FIXTURE,
      { db: stub.db, tenantId: TENANT, providerCheck: () => null } as never,
    );
    const pages: unknown[] = [];
    const run = async () => {
      for await (const page of reader.backfill(source, null)) pages.push(page);
    };
    await expect(run()).rejects.toBeInstanceOf(MailboxAccessRefusedError);
    expect(pages).toEqual([]);
    expect(stub.rpc).not.toHaveBeenCalled();
    expect(admin.rpc).toHaveBeenCalledWith('mailbox_guard_check', expect.objectContaining({ p_address: ADDRESS }));
  });

  it('always binds the owner: a call without one sends p_check_owner true and a null owner', async () => {
    admin.rpc.mockResolvedValue({ data: 'owner_mismatch', error: null });
    await expect(
      assertMailboxAllowed(TENANT, ADDRESS, { purpose: 'agent_tool', caller: 'agent-tool:test', provider: 'microsoft' } as never),
    ).rejects.toMatchObject({ reason: 'owner_mismatch' });
    expect(admin.rpc).toHaveBeenCalledWith(
      'mailbox_guard_check',
      expect.objectContaining({ p_check_owner: true, p_owner_user_id: null }),
    );
  });
});
