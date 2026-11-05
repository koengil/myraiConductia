import { beforeEach, describe, expect, it, vi } from 'vitest';

// The guard builds its own service client, so the seam is the admin-client
// module: `admin.rpc` answers for the guard (audit round 1, item 2).
const admin = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseAdminClient: () => ({ rpc: admin.rpc }),
}));

import {
  MAILBOX_GUARD_PURPOSE,
  MAILBOX_PROVIDER,
  MAILBOX_REFUSAL_REASONS,
  SITE_REFUSAL_REASONS,
  SOURCE_KIND,
} from '@/lib/constants/discovery';
import { assertMailboxAllowed, assertSourceAllowed, MailboxAccessRefusedError } from '@/lib/mailboxAccess';
import { mailboxGuardVerdict } from '@/lib/mailboxAccess/guard';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADDRESS = 'storm.duncan@bank.example';

beforeEach(() => {
  admin.rpc.mockReset();
});

function clientAnswering(result: { data?: unknown; error?: { message: string; code?: string } | null }) {
  const rpc = admin.rpc.mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });
  return { rpc };
}

const ctx = () => ({
  purpose: MAILBOX_GUARD_PURPOSE.AGENT_TOOL,
  caller: 'agent-tool:test',
  owner: { userId: 'user-1' },
  provider: MAILBOX_PROVIDER.MICROSOFT,
});

describe('assertMailboxAllowed', () => {
  it('resolves when the guard returns null', async () => {
    clientAnswering({ data: null });
    await expect(assertMailboxAllowed(TENANT, ADDRESS, ctx())).resolves.toBeUndefined();
  });

  it.each(MAILBOX_REFUSAL_REASONS)('throws MailboxAccessRefusedError for %s', async (reason) => {
    clientAnswering({ data: reason });
    const error = await assertMailboxAllowed(TENANT, ADDRESS, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailboxAccessRefusedError);
    expect(error).toMatchObject({
      reason,
      purpose: MAILBOX_GUARD_PURPOSE.AGENT_TOOL,
      address: ADDRESS,
      tenantId: TENANT,
    });
  });

  it('covers the fifteen mailbox reasons, provider_mismatch, no_source, source_paused and the three team ones among them', () => {
    expect(MAILBOX_REFUSAL_REASONS).toHaveLength(15);
    expect(MAILBOX_REFUSAL_REASONS).toContain('provider_mismatch');
    expect(MAILBOX_REFUSAL_REASONS).toContain('no_source');
    expect(MAILBOX_REFUSAL_REASONS).toContain('source_paused');
    expect(MAILBOX_REFUSAL_REASONS).toEqual(
      expect.arrayContaining(['team_mailbox_unverified', 'team_mailbox_disconnected', 'team_mailbox_person']),
    );
  });

  it('refuses with source_paused when the SQL guard says the source is paused (audit round 3, M6)', async () => {
    clientAnswering({ data: 'source_paused' });
    const error = await assertMailboxAllowed(TENANT, ADDRESS, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailboxAccessRefusedError);
    expect((error as MailboxAccessRefusedError).reason).toBe('source_paused');
  });

  it.each(Object.values(MAILBOX_PROVIDER))('always sends the provider the caller reads through (%s)', async (provider) => {
    const { rpc } = clientAnswering({ data: null });
    await assertMailboxAllowed(TENANT, ADDRESS, { ...ctx(), provider });
    expect(rpc).toHaveBeenCalledWith('mailbox_guard_check', expect.objectContaining({ p_provider: provider }));
  });

  it('throws a plain Error for an unknown reason', async () => {
    clientAnswering({ data: 'because' });
    const error = await assertMailboxAllowed(TENANT, ADDRESS, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MailboxAccessRefusedError);
  });

  it('fails closed when the RPC errors', async () => {
    clientAnswering({ error: { message: 'connection reset', code: '08006' } });
    const error = await assertMailboxAllowed(TENANT, ADDRESS, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MailboxAccessRefusedError);
    expect((error as Error).message).toBe('mailbox guard unavailable (08006)');
  });

  it('sends the owner check, with a null owner refusing', async () => {
    const { rpc } = clientAnswering({ data: null });
    await assertMailboxAllowed(TENANT, ADDRESS, { ...ctx(), owner: { userId: null } });
    expect(rpc).toHaveBeenCalledWith(
      'mailbox_guard_check',
      expect.objectContaining({ p_check_owner: true, p_owner_user_id: null }),
    );
  });

  it('sends the owner id when one is bound', async () => {
    const { rpc } = clientAnswering({ data: null });
    await assertMailboxAllowed(TENANT, ADDRESS, { ...ctx(), owner: { userId: 'user-1' } });
    expect(rpc).toHaveBeenCalledWith(
      'mailbox_guard_check',
      expect.objectContaining({ p_check_owner: true, p_owner_user_id: 'user-1' }),
    );
  });

  it.each(Object.values(MAILBOX_GUARD_PURPOSE))('always sends the owner check for %s', async (purpose) => {
    const { rpc } = clientAnswering({ data: null });
    await assertMailboxAllowed(TENANT, ADDRESS, { ...ctx(), purpose });
    expect(rpc).toHaveBeenCalledWith('mailbox_guard_check', expect.objectContaining({ p_check_owner: true }));
  });

  it('asks about an ownerless team source with its purpose and a null owner, and a refusal for staleness is a refusal (#581)', async () => {
    // The SQL admits a null owner for provider_read alone (review round 2, M-B); the TS side's whole part is to send the
    // purpose and the null honestly, and to throw whatever the guard answers.
    const { rpc } = clientAnswering({ data: 'team_mailbox_unverified' });
    const team = { kind: SOURCE_KIND.MAILBOX, address: ADDRESS, ownerUserId: null };
    for (const purpose of Object.values(MAILBOX_GUARD_PURPOSE)) {
      rpc.mockClear();
      const error = await assertSourceAllowed(TENANT, team, {
        purpose,
        caller: 'discovery-worker',
        provider: MAILBOX_PROVIDER.GOOGLE,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MailboxAccessRefusedError);
      expect(error).toMatchObject({ reason: 'team_mailbox_unverified', purpose });
      expect(rpc).toHaveBeenCalledWith(
        'mailbox_guard_check',
        expect.objectContaining({ p_purpose: purpose, p_check_owner: true, p_owner_user_id: null, p_provider: 'google' }),
      );
    }
  });

  it('reads a missing owner as a null owner, never as "skip the check"', async () => {
    const { rpc } = clientAnswering({ data: 'owner_mismatch' });
    const { owner: _owner, ...withoutOwner } = ctx();
    void _owner;
    const error = await assertMailboxAllowed(TENANT, ADDRESS, withoutOwner as never).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'owner_mismatch' });
    expect(rpc).toHaveBeenCalledWith(
      'mailbox_guard_check',
      expect.objectContaining({ p_check_owner: true, p_owner_user_id: null }),
    );
  });

  it('passes the purpose, caller and provider reason through', async () => {
    const { rpc } = clientAnswering({ data: null });
    await assertMailboxAllowed(TENANT, ADDRESS, {
      purpose: MAILBOX_GUARD_PURPOSE.PROVIDER_READ,
      caller: 'discovery-worker',
      owner: { userId: 'user-1' },
      provider: MAILBOX_PROVIDER.GOOGLE,
      providerReason: 'not_in_provider_group',
    });
    expect(rpc).toHaveBeenCalledWith('mailbox_guard_check', {
      p_tenant_id: TENANT,
      p_address: ADDRESS,
      p_purpose: 'provider_read',
      p_caller: 'discovery-worker',
      p_check_owner: true,
      p_owner_user_id: 'user-1',
      p_provider_reason: 'not_in_provider_group',
      p_provider: 'google',
    });
  });
});

// The read-only half of the guard (#275 audit item 1): asked before a live Microsoft mailbox's binding requests, so no
// provider request precedes a guard decision. Same arguments mailbox_guard_check passes it; it writes nothing.
describe('mailboxGuardVerdict', () => {
  it('asks mailbox_guard_verdict with the owner bound and the provider, and returns null when allowed', async () => {
    const { rpc } = clientAnswering({ data: null });
    await expect(mailboxGuardVerdict(TENANT, ADDRESS, { provider: MAILBOX_PROVIDER.MICROSOFT, owner: { userId: 'user-1' } })).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('mailbox_guard_verdict', {
      p_tenant_id: TENANT,
      p_address: ADDRESS,
      p_provider: 'microsoft',
      p_check_owner: true,
      p_owner_user_id: 'user-1',
    });
  });

  it('sends a null owner as null, which the verdict refuses', async () => {
    const { rpc } = clientAnswering({ data: 'owner_mismatch' });
    await expect(mailboxGuardVerdict(TENANT, ADDRESS, { provider: MAILBOX_PROVIDER.MICROSOFT, owner: { userId: null } })).resolves.toBe('owner_mismatch');
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_check_owner: true, p_owner_user_id: null });
  });

  it.each(MAILBOX_REFUSAL_REASONS)('returns the reason %s without throwing', async (reason) => {
    clientAnswering({ data: reason });
    await expect(mailboxGuardVerdict(TENANT, ADDRESS, { provider: MAILBOX_PROVIDER.MICROSOFT, owner: { userId: 'user-1' } })).resolves.toBe(reason);
  });

  it('throws on an unknown answer', async () => {
    clientAnswering({ data: 'maybe' });
    await expect(mailboxGuardVerdict(TENANT, ADDRESS, { provider: MAILBOX_PROVIDER.MICROSOFT, owner: { userId: 'user-1' } })).rejects.toThrow(
      'mailbox guard returned an unknown reason',
    );
  });

  it('fails closed when the RPC errors', async () => {
    clientAnswering({ error: { message: 'down', code: 'PGRST301' } });
    await expect(mailboxGuardVerdict(TENANT, ADDRESS, { provider: MAILBOX_PROVIDER.MICROSOFT, owner: { userId: 'user-1' } })).rejects.toThrow(
      'mailbox guard unavailable (PGRST301)',
    );
  });
});

describe('assertSourceAllowed', () => {
  const SITE = 'bank.sharepoint.com:/sites/deals';
  const mailbox = { kind: SOURCE_KIND.MAILBOX, address: ADDRESS, ownerUserId: 'user-1' };
  const site = { kind: SOURCE_KIND.SHAREPOINT_SITE, address: SITE, ownerUserId: 'user-1' };

  it('dispatches a mailbox to the mailbox guard, keeping the owner binding and provider reason', async () => {
    const { rpc } = clientAnswering({ data: null });
    await assertSourceAllowed(TENANT, mailbox, {
      purpose: MAILBOX_GUARD_PURPOSE.PROVIDER_READ,
      caller: 'discovery-worker',
      provider: MAILBOX_PROVIDER.GOOGLE,
      providerReason: 'not_in_provider_group',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('mailbox_guard_check', {
      p_tenant_id: TENANT,
      p_address: ADDRESS,
      p_purpose: 'provider_read',
      p_caller: 'discovery-worker',
      p_check_owner: true,
      p_owner_user_id: 'user-1',
      p_provider_reason: 'not_in_provider_group',
      p_provider: 'google',
    });
  });

  it('refuses a mailbox with no provider before any database call', async () => {
    const { rpc } = clientAnswering({ data: null });
    await expect(
      assertSourceAllowed(TENANT, mailbox, { purpose: MAILBOX_GUARD_PURPOSE.PROVIDER_READ, caller: 'discovery-worker' }),
    ).rejects.toThrow(/needs the provider/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('dispatches a site to the site guard with no owner or provider arguments', async () => {
    const { rpc } = clientAnswering({ data: null });
    const { owner: _owner, ...siteCtx } = ctx();
    void _owner;
    await assertSourceAllowed(TENANT, site, siteCtx);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('site_guard_check', {
      p_tenant_id: TENANT,
      p_address: SITE,
      p_purpose: 'agent_tool',
      p_caller: 'agent-tool:test',
    });
  });

  it.each(SITE_REFUSAL_REASONS)('throws MailboxAccessRefusedError for the site reason %s', async (reason) => {
    clientAnswering({ data: reason });
    const error = await assertSourceAllowed(TENANT, site, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailboxAccessRefusedError);
    expect(error).toMatchObject({ reason, purpose: 'agent_tool', address: SITE, tenantId: TENANT });
  });

  it('refuses a mailbox reason from the site guard as unknown', async () => {
    clientAnswering({ data: 'no_consent' });
    const error = await assertSourceAllowed(TENANT, site, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MailboxAccessRefusedError);
  });

  it('fails closed on an unknown site reason', async () => {
    clientAnswering({ data: 'because' });
    const error = await assertSourceAllowed(TENANT, site, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MailboxAccessRefusedError);
  });

  it('fails closed when the site RPC errors', async () => {
    clientAnswering({ error: { message: 'connection reset', code: '08006' } });
    const error = await assertSourceAllowed(TENANT, site, ctx()).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(MailboxAccessRefusedError);
    expect((error as Error).message).toBe('site guard unavailable (08006)');
  });

  it('throws for a source kind that has no guard, without calling the database', async () => {
    const { rpc } = clientAnswering({ data: null });
    const unknown = { kind: 'drive' as never, address: SITE, ownerUserId: null };
    await expect(assertSourceAllowed(TENANT, unknown, ctx())).rejects.toThrow(/No access guard exists/);
    expect(rpc).not.toHaveBeenCalled();
  });
});
