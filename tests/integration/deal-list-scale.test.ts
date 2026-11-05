import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * #160: GET /api/v1/deals at 320 seats, through the real gateway.
 *
 * The old member branch read the caller's membership ids and sent them back as
 * `.in('id', ids)`, about 39 bytes per seat in the request URL. Kong caps the
 * request line at 8 KiB and answers 414 "URI too long", so a user on ~207+
 * deals got a 500. Since #237 the list filters through the membership join and
 * its URL no longer grows with the seat count.
 *
 * This seats one MD on 320 deals of a throwaway tenant and calls the REAL GET
 * handler, with the real admin client pointed at NEXT_PUBLIC_SUPABASE_URL
 * (Kong on the local stack). Only the browser session is faked, as in
 * phase1.e2e.test.ts. The external /projects picker's query
 * (listMemberDealSummaries) runs against the same seats. A control shows the
 * old id-list form still fails on the same stack, so the test cannot pass
 * against a stack without the gateway.
 * 320 is above the ~207-id break and below max_rows (1000), so truncation
 * cannot hide a failure.
 */

const session = { id: '', email: '' };

vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return {
    ...actual,
    createSupabaseServerClient: async () => ({
      auth: {
        getUser: async () => ({
          data: { user: { id: session.id, email: session.email } },
          error: null,
        }),
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({
            data: { currentLevel: 'aal2', nextLevel: 'aal2' },
            error: null,
          }),
        },
      },
    }),
  };
});

import { createClient } from '@supabase/supabase-js';
import { GET as listDeals } from '@/app/api/v1/deals/route';
import { listMemberDealSummaries } from '@/lib/api/v1/access';
import { createProvisionedUser } from '@/lib/auth/provisioning';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  throw new Error(
    'The deal-list scale test needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (local `supabase start` stack).',
  );
}
// It seeds 320 deals with the service role and leaves suspended users behind: a local stack only.
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
  throw new Error('The deal-list scale test runs against a local Supabase only (127.0.0.1 or localhost).');
}
const db = createClient(url, secret, { auth: { persistSession: false } });

const SEATS = 320;
const PEER_SEATS = 10;
const RUN = Date.now().toString(36);
const TENANT = crypto.randomUUID();
const emailFor = (who: string) => `${who}-${RUN}@integration.conductia.dev`;

type Actor = { id: string; email: string };
const md: Actor = { id: '', email: emailFor('scale-md') };
const peer: Actor = { id: '', email: emailFor('scale-peer') };

function actAs(actor: Actor) {
  session.id = actor.id;
  session.email = actor.email;
}

/** The MD's deals in insertion order: created_at ascends 1 s apart, so the list returns them reversed. */
let seededIds: string[] = [];
let decoyId = '';

async function createActor(actor: Actor): Promise<void> {
  // No firm_role: the MD takes the member branch of listDealsForUser.
  const user = await createProvisionedUser(db, {
    email: actor.email,
    password: `Integration-${RUN}-x9!`,
    email_confirm: true,
    profile: { tenant_id: TENANT },
  });
  actor.id = user.id;
}

async function roleId(slug: 'md' | 'deal_team'): Promise<string> {
  const role = await db.from('roles').select('id').eq('slug', slug).single();
  if (role.error) throw new Error(`role lookup failed: ${role.error.message}`);
  return role.data.id as string;
}

beforeAll(async () => {
  const { data: bank, error: bankError } = await db
    .from('companies')
    .insert({ tenant_id: TENANT, name: `Integration Bank ${RUN}`, type: 'bank' })
    .select('id')
    .single();
  if (bankError || !bank) throw new Error(`bank seed failed: ${bankError?.message}`);

  await createActor(md);
  await createActor(peer);

  // One bulk insert each: the rows travel in the POST body, not the URL.
  // created_at is explicit because one insert would give every row the same now().
  const base = Date.now() - (SEATS + 60) * 1000;
  const { data: deals, error: dealsError } = await db
    .from('deals')
    .insert(
      Array.from({ length: SEATS }, (_, i) => ({
        tenant_id: TENANT,
        bank_id: bank.id,
        code: `SCALE-${RUN}-${i}`,
        codename: `Scale ${RUN} ${i}`,
        created_at: new Date(base + i * 1000).toISOString(),
      })),
    )
    .select('id, created_at');
  if (dealsError || !deals) throw new Error(`deal seed failed: ${dealsError?.message}`);
  seededIds = [...deals]
    .sort((a, b) => Date.parse(a.created_at as string) - Date.parse(b.created_at as string))
    .map((d) => d.id as string);
  if (seededIds.length !== SEATS) throw new Error(`deal seed returned ${seededIds.length} rows, expected ${SEATS}`);

  const { data: decoy, error: decoyError } = await db
    .from('deals')
    .insert({ tenant_id: TENANT, bank_id: bank.id, code: `SCALE-${RUN}-decoy`, codename: `Scale ${RUN} decoy` })
    .select('id')
    .single();
  if (decoyError || !decoy) throw new Error(`decoy seed failed: ${decoyError?.message}`);
  decoyId = decoy.id as string;

  const [mdRole, teamRole] = [await roleId('md'), await roleId('deal_team')];
  const { error: seatError } = await db.from('deal_memberships').insert([
    ...seededIds.map((dealId) => ({ deal_id: dealId, user_id: md.id, role_id: mdRole, deal_role: 'md' })),
    // A second seat on some deals: the join must still return each deal once.
    ...[...seededIds.slice(0, PEER_SEATS), decoyId].map((dealId) => ({
      deal_id: dealId,
      user_id: peer.id,
      role_id: teamRole,
      deal_role: 'deal_team',
    })),
  ]);
  if (seatError) throw new Error(`seat seed failed: ${seatError.message}`);
});

afterAll(async () => {
  // Best-effort teardown, children first; every row carries the throwaway
  // tenant or one of its two users, so nothing outside this run is touched.
  // Seats, deals and the bank company delete cleanly: the direct inserts and
  // the GET handler write no audit rows.
  // KNOWN RESIDUE: createProvisionedUser runs authorize_provisioned_profile,
  // which writes an immutable profile_provisioned audit row naming the new
  // user as actor, and audit_log.actor_id references users. So both users
  // survive their deletes and are suspended instead (the dropGuardedTenant
  // pattern): two seatless, suspended users. The CI stack is destroyed whole.
  const userIds = [md.id, peer.id].filter(Boolean);
  if (userIds.length) await db.from('deal_memberships').delete().in('user_id', userIds);
  await db.from('deals').delete().eq('tenant_id', TENANT);
  await db.from('companies').delete().eq('tenant_id', TENANT);
  for (const id of userIds) {
    // GoTrue cannot cascade into public.users, so the mirror row goes first (phase1 pattern).
    await db.from('users').delete().eq('id', id);
    await db.auth.admin.deleteUser(id);
    const { data: left } = await db.from('users').select('id').eq('id', id).maybeSingle();
    if (left) await db.from('users').update({ status: 'suspended' }).eq('id', id);
  }
});

describe('GET /api/v1/deals at 320 seats (#160)', () => {
  it('lists all 320 seated deals through GET /api/v1/deals', async () => {
    actAs(md);
    const res = await listDeals();
    const body = await res.text();
    // On failure the body names the cause; before #237 it was {"error":"URI too long\n"}.
    expect(res.status, body.slice(0, 200)).toBe(200);
    const { deals } = JSON.parse(body) as { deals: Array<{ id: string; dealRole: string | null }> };

    const ids = deals.map((d) => d.id);
    expect(ids).toHaveLength(SEATS);
    expect(new Set(ids).size).toBe(SEATS);
    expect(new Set(ids)).toEqual(new Set(seededIds));
    expect(ids).not.toContain(decoyId);
    expect(ids).toEqual([...seededIds].reverse());
    expect(deals.every((d) => d.dealRole === 'md')).toBe(true);
  });

  it('lists the same 320 deals through the external picker query', async () => {
    const { data, error } = await listMemberDealSummaries(db, md.id);
    expect(error, error?.message).toBeNull();

    const ids = data.map((d) => d.id);
    expect(ids).toHaveLength(SEATS);
    expect(new Set(ids).size).toBe(SEATS);
    expect(ids).not.toContain(decoyId);
    expect(ids).toEqual([...seededIds].reverse());
  });

  it('control: the id-list form it replaced is rejected on this stack', async () => {
    const control = await db.from('deals').select('id').in('id', seededIds);
    // Any other error (auth, schema, network) would prove nothing about the URL
    // length: require Kong's 414 "URI too long" (the body postgrest-js surfaces
    // as the message, as the pre-#237 handler's 500 showed).
    const rejectedForLength =
      control.status === 414 || /uri too long/i.test(control.error?.message ?? '');
    expect(
      rejectedForLength,
      "the local gateway no longer rejects a ~12.5 KB request line; raise the control's id count, do not delete it" +
        ` (got status ${control.status}: ${control.error?.message ?? 'no error'})`,
    ).toBe(true);
  });
});
