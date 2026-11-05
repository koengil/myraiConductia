import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

vi.mock('@/lib/dataroom/steps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dataroom/steps')>();
  return {
    ...actual,
    provisionDealDataroomOnCreate: vi.fn(async () => undefined),
  };
});

import { createClient } from '@supabase/supabase-js';
import { POST as createDeal } from '@/app/api/v1/deals/route';
import { PATCH as patchDeal } from '@/app/api/v1/deals/[dealId]/route';
import { POST as addMember } from '@/app/api/v1/deals/[dealId]/members/route';
import { createProvisionedUser } from '@/lib/auth/provisioning';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  throw new Error('Integration suite needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.');
}
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const TENANT = crypto.randomUUID();
const FIRST_PHASE_TWO_SEQ = 26;

type Actor = { id: string; email: string };
const md: Actor = { id: '', email: `close-md-${RUN}@integration.conductia.dev` };
const member: Actor = { id: '', email: `close-member-${RUN}@integration.conductia.dev` };

const actAs = (actor: Actor) => {
  session.id = actor.id;
  session.email = actor.email;
};
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const patch = (body: Record<string, unknown>) =>
  patchDeal(
    new Request(`http://localhost/api/v1/deals/${dealId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    ctx({ dealId }),
  );
const dealRow = async () =>
  (await db.from('deals').select('status, lifecycle_category').eq('id', dealId).single()).data;

let dealId = '';

beforeAll(async () => {
  const { data: bank, error: bankError } = await db
    .from('companies')
    .insert({ tenant_id: TENANT, name: `Close Bank ${RUN}`, type: 'bank' })
    .select('id')
    .single();
  if (bankError || !bank) throw new Error(`bank seed failed: ${bankError?.message}`);

  for (const actor of [md, member]) {
    const user = await createProvisionedUser(db, {
      email: actor.email,
      password: `Integration-${RUN}-x9!`,
      email_confirm: true,
      profile: { tenant_id: TENANT },
    });
    actor.id = user.id;
  }
  const { error: seatError } = await db
    .from('users')
    .update({ company_id: bank.id, company_role: 'director' })
    .eq('id', md.id);
  if (seatError) throw new Error(`director seat failed: ${seatError.message}`);
});

afterAll(async () => {
  if (dealId) {
    await db
      .from('legal_holds')
      .update({ lifted_at: new Date().toISOString(), lifted_by: md.id })
      .eq('deal_id', dealId)
      .is('lifted_at', null);
    for (const table of ['notifications', 'deal_steps', 'deal_memberships', 'deal_parties']) {
      await db.from(table).delete().eq('deal_id', dealId);
    }
    await db.from('deals').delete().eq('id', dealId);
  }
  await db.from('companies').delete().eq('tenant_id', TENANT);
  for (const actor of [md, member]) {
    if (!actor.id) continue;
    await db.from('users').delete().eq('id', actor.id);
    await db.auth.admin.deleteUser(actor.id);
  }
});

describe('the MD closes a deal under legal hold through the Book', () => {
  it('a deal opened at a phase 2 step is active, not intake', async () => {
    actAs(md);
    const res = await createDeal(
      new Request('http://localhost/api/v1/deals', {
        method: 'POST',
        body: JSON.stringify({
          codename: `PROJECT SHUTTER ${RUN.toUpperCase()}`,
          targetName: 'Harbor Freight Analytics',
          entryStepSeq: FIRST_PHASE_TWO_SEQ,
          conflictsAttestation: {
            approvedBy: 'Senior Partner (integration)',
            approvedOn: new Date().toISOString().slice(0, 10),
          },
        }),
      }),
    );
    expect(res.status).toBe(201);
    dealId = ((await res.json()) as { deal: { id: string } }).deal.id;

    expect(await dealRow()).toEqual({ status: 'active', lifecycle_category: 'live' });
  });

  it('a member who is not the MD cannot close it', async () => {
    actAs(md);
    const added = await addMember(
      new Request(`http://localhost/api/v1/deals/${dealId}/members`, {
        method: 'POST',
        body: JSON.stringify({ email: member.email, dealRole: 'deal_team' }),
      }),
      ctx({ dealId }),
    );
    expect([200, 201]).toContain(added.status);

    actAs(member);
    expect((await patch({ lifecycleCategory: 'closed' })).status).toBe(403);
    expect(await dealRow()).toEqual({ status: 'active', lifecycle_category: 'live' });
  });

  it('closing a held deal closes it, audits both changes, and leaves the hold in force', async () => {
    const { error: holdError } = await db
      .from('legal_holds')
      .insert({ deal_id: dealId, reason: 'Integration: pending litigation', placed_by: md.id });
    if (holdError) throw new Error(`hold seed failed: ${holdError.message}`);

    actAs(md);
    expect((await patch({ lifecycleCategory: 'closed' })).status).toBe(200);
    expect(await dealRow()).toEqual({ status: 'closed', lifecycle_category: 'closed' });

    const { data: audits } = await db
      .from('audit_log')
      .select('actor_id, detail')
      .eq('deal_id', dealId)
      .eq('action', 'update');
    expect(audits).toEqual(
      expect.arrayContaining([
        { actor_id: md.id, detail: { field: 'lifecycle_category', from: 'live', to: 'closed' } },
        { actor_id: md.id, detail: { field: 'status', from: 'active', to: 'closed' } },
      ]),
    );

    const { data: holds } = await db
      .from('legal_holds')
      .select('lifted_at')
      .eq('deal_id', dealId);
    expect(holds).toEqual([{ lifted_at: null }]);

    const { error: deleteError } = await db.from('deals').delete().eq('id', dealId);
    expect(deleteError?.message).toMatch(/under legal hold/);
    expect(await dealRow()).toEqual({ status: 'closed', lifecycle_category: 'closed' });
  });
});
