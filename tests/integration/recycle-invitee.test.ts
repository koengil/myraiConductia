import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { recycleInvitee } from '../../scripts/lib/recycleInvitee';
import { createUserProvisioned } from './support/provisioned';

/*
 * scripts/lib/recycleInvitee.ts against a REAL database, through a partial failure (C15, #262).
 *
 * The recycle tombstones the identity first and clears its seats last, so a failure in between
 * leaves an address with no live user, and a retry that looks the user up by the original email
 * finds nothing and never clears deal_memberships. The retry must still find the identity it
 * tombstoned, by the accepted invitation's user id while the invitation exists, and by the
 * tombstone's own name once it is gone, and clear its seats.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) throw new Error('needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (local stack)');
const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN = Date.now().toString(36);
const TENANT = randomUUID();
let companyId = '';
let readOnlyRoleId = '';
let directorId = '';
const dealIds: string[] = [];
const userIds: string[] = [];

type Fixture = { email: string; userId: string; dealId: string; inviteId: string };

async function fixture(label: string): Promise<Fixture> {
  const email = `rc-${label}-${RUN}@integration.conductia.dev`;
  const created = await createUserProvisioned(admin, {
    email,
    password: `Recycle-${RUN}-x9!`,
    email_confirm: true,
    user_metadata: { tenant_id: TENANT, department: 'ib' },
  });
  if (created.error || !created.data.user) throw new Error(`user create failed: ${created.error?.message}`);
  const userId = created.data.user.id;
  userIds.push(userId);
  const claim = await admin
    .from('users')
    // No company seat: losing a seat revokes the memberships through cascade_revoke_membership, so a retry
    // has nothing left to clear. An invitee who holds only a deal membership is the case recycle must resume.
    .update({ tenant_id: TENANT, status: 'active', is_external: true, company_id: null, company_role: null })
    .eq('id', userId);
  if (claim.error) throw new Error(`user claim failed: ${claim.error.message}`);

  const dealId = randomUUID();
  const deal = await admin
    .from('deals')
    .insert({ id: dealId, tenant_id: TENANT, code: `RC-${dealId.slice(0, 8)}`, codename: `Recycle ${label} ${dealId.slice(0, 6)}`, bank_id: companyId });
  if (deal.error) throw new Error(`deal failed: ${deal.error.message}`);
  dealIds.push(dealId);
  const seat = await admin.from('deal_memberships').insert({ deal_id: dealId, user_id: userId, role_id: readOnlyRoleId, deal_role: 'read_only' });
  if (seat.error) throw new Error(`seat failed: ${seat.error.message}`);

  const invite = await admin
    .from('invites')
    .insert({
      tenant_id: TENANT,
      email,
      invited_by: directorId,
      company_id: companyId,
      company_role: 'member',
      status: 'accepted',
      delivery_status: 'sent',
      accepted_at: new Date().toISOString(),
      accepted_user_id: userId,
    })
    .select('id')
    .single();
  if (invite.error) throw new Error(`invite failed: ${invite.error.message}`);
  return { email, userId, dealId, inviteId: invite.data.id as string };
}

/** The admin client with one table failing a delete, as a mid-run outage would. */
function failingDeletes(table: string): SupabaseClient {
  return new Proxy(admin, {
    get(target, prop) {
      if (prop !== 'from') return Reflect.get(target, prop, target);
      return (name: string) => {
        if (name !== table) return target.from(name);
        const builder = { delete: () => ({ in: async () => ({ error: { message: 'unavailable' }, count: null }), eq: async () => ({ error: { message: 'unavailable' }, count: null }) }) };
        return builder as unknown;
      };
    },
  }) as SupabaseClient;
}

async function seatCount(userId: string): Promise<number> {
  const { count, error } = await admin.from('deal_memberships').select('*', { count: 'exact', head: true }).eq('user_id', userId);
  if (error) throw new Error(`seat count failed: ${error.message}`);
  return count ?? 0;
}

async function inviteCount(email: string): Promise<number> {
  const { count, error } = await admin.from('invites').select('*', { count: 'exact', head: true }).eq('email', email);
  if (error) throw new Error(`invite count failed: ${error.message}`);
  return count ?? 0;
}

beforeAll(async () => {
  const company = await admin.from('companies').insert({ tenant_id: TENANT, name: `Recycle Bank ${RUN}`, type: 'bank' }).select('id').single();
  if (company.error) throw new Error(`company failed: ${company.error.message}`);
  companyId = company.data.id as string;
  const role = await admin.from('roles').select('id').eq('slug', 'read_only').single();
  if (role.error) throw new Error(`role failed: ${role.error.message}`);
  readOnlyRoleId = role.data.id as string;
  // A company holds no member without a director.
  const director = await createUserProvisioned(admin, {
    email: `rc-director-${RUN}@integration.conductia.dev`,
    password: `Recycle-${RUN}-x9!`,
    email_confirm: true,
    user_metadata: { tenant_id: TENANT, department: 'ib' },
  });
  if (director.error || !director.data.user) throw new Error(`director create failed: ${director.error?.message}`);
  directorId = director.data.user.id;
  userIds.push(directorId);
  const seated = await admin
    .from('users')
    .update({ tenant_id: TENANT, status: 'active', is_external: false, company_id: companyId, company_role: 'director' })
    .eq('id', directorId);
  if (seated.error) throw new Error(`director claim failed: ${seated.error.message}`);
});

afterAll(async () => {
  for (const id of dealIds) await admin.from('deals').delete().eq('id', id);
  await admin.from('invites').delete().eq('tenant_id', TENANT);
  for (const id of userIds) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) await admin.from('users').update({ status: 'suspended', company_id: null, company_role: null }).eq('id', id);
  }
  await admin.from('companies').delete().eq('id', companyId);
});

describe('recycleInvitee resumes after a partial failure', () => {
  it('clears the seats on a retry when the failure came before the invitations were deleted', async () => {
    const f = await fixture('early');
    await expect(recycleInvitee(failingDeletes('invite_domain_confirmations'), f.email)).rejects.toThrow('confirmations delete failed');
    // The identity is already tombstoned: the original address has no live user, and the seat is untouched.
    expect((await admin.from('users').select('id').eq('email', f.email)).data).toEqual([]);
    expect(await seatCount(f.userId)).toBe(1);
    expect(await inviteCount(f.email)).toBe(1);

    const result = await recycleInvitee(admin, f.email);
    expect(await seatCount(f.userId)).toBe(0);
    expect(await inviteCount(f.email)).toBe(0);
    expect(result).toMatchObject({ invitesRemoved: 1, seatsRemoved: 1 });
    expect(result.tombstone).toMatch(/^rc-early-.+\+used-\d+@integration\.conductia\.dev$/);
    // The same identity: never a second tombstone, never another account.
    const { data: user } = await admin.from('users').select('email, status, company_id').eq('id', f.userId).single();
    expect(user).toMatchObject({ email: result.tombstone, status: 'suspended', company_id: null });
  });

  it('clears the seats on a retry when the failure came after the invitations were deleted', async () => {
    const f = await fixture('late');
    await expect(recycleInvitee(failingDeletes('deal_memberships'), f.email)).rejects.toThrow('seat delete failed');
    expect(await inviteCount(f.email)).toBe(0);
    expect(await seatCount(f.userId)).toBe(1);

    const result = await recycleInvitee(admin, f.email);
    expect(await seatCount(f.userId)).toBe(0);
    expect(result).toMatchObject({ invitesRemoved: 0, seatsRemoved: 1 });
    expect(result.tombstone).toMatch(/\+used-\d+@integration\.conductia\.dev$/);
  });

  it('leaves another account alone: an unrelated user with a similar address keeps its seat', async () => {
    const f = await fixture('own');
    const other = await fixture('own-other');
    await expect(recycleInvitee(failingDeletes('invite_domain_confirmations'), f.email)).rejects.toThrow();
    await recycleInvitee(admin, f.email);
    expect(await seatCount(f.userId)).toBe(0);
    expect(await seatCount(other.userId)).toBe(1);
    expect(await inviteCount(other.email)).toBe(1);
  });

  it('a clean run is unchanged: one tombstone, the seat and the invitation gone', async () => {
    const f = await fixture('clean');
    const result = await recycleInvitee(admin, f.email);
    expect(result).toMatchObject({ invitesRemoved: 1, seatsRemoved: 1 });
    expect(await seatCount(f.userId)).toBe(0);
  });
});
