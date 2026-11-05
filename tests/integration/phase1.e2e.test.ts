import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * Phase 1 integration test (#27) — the done-when criterion of ADR-0008, run
 * as one story against a REAL database (no mocked query builders):
 *
 *   User A signs in → creates a deal → adds User B as deal_team →
 *   B opens a document → the audit rows exist;
 *   User C (same tenant, NO membership) is denied.
 *
 * What is real: the route handlers, the access predicates, the RPC, Postgres.
 * What is faked: ONLY the browser session (createSupabaseServerClient) — the
 * cookie/JWT layer needs a Next runtime; identity is switched per step via
 * `actAs`. The admin client is the real one, pointed at the DB by env.
 * External services are stubbed: Box provisioning (network) and the email
 * transport are not Phase 1 scope.
 *
 * The test is self-contained: it creates a throwaway tenant (bank company +
 * three auth users) and tears down what the WORM audit trail allows in
 * afterAll (see the residue note there), so it is safe against the shared
 * -dev project as well as the hermetic CI stack.
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

// Box is an external service — not part of the Phase 1 contract under test.
vi.mock('@/lib/dataroom/steps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dataroom/steps')>();
  return {
    ...actual,
    provisionDealDataroomOnCreate: vi.fn(async () => undefined),
  };
});

import { createClient } from '@supabase/supabase-js';
import { GET as listDeals, POST as createDeal } from '@/app/api/v1/deals/route';
import { GET as readDeal } from '@/app/api/v1/deals/[dealId]/route';
import { GET as readDealAudit } from '@/app/api/v1/deals/[dealId]/audit/route';
import { GET as listDocuments } from '@/app/api/v1/deals/[dealId]/documents/route';
import { POST as addMember } from '@/app/api/v1/deals/[dealId]/members/route';
import { POST as viewDocument } from '@/app/api/v1/deals/[dealId]/documents/[documentId]/view/route';
import { createProvisionedUser } from '@/lib/auth/provisioning';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  throw new Error(
    'Integration suite needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY ' +
      '(local `supabase start` stack or the -dev project).',
  );
}
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const TENANT = crypto.randomUUID();
const OTHER_TENANT = crypto.randomUUID();
const emailFor = (who: string) => `${who}-${RUN}@integration.conductia.dev`;

type Actor = { id: string; email: string };
const actors: Record<'a' | 'b' | 'c' | 'cco' | 'otherCco', Actor> = {
  a: { id: '', email: emailFor('md-a') },
  b: { id: '', email: emailFor('team-b') },
  c: { id: '', email: emailFor('outsider-c') },
  cco: { id: '', email: emailFor('cco') },
  otherCco: { id: '', email: emailFor('other-firm-cco') },
};

function actAs(actor: Actor) {
  session.id = actor.id;
  session.email = actor.email;
}

const ctx = (params: Record<string, string>) =>
  ({ params: Promise.resolve(params) }) as never;

let dealId = '';
let documentId = '';

async function createActor(
  actor: Actor,
  profile: { tenant_id: string; firm_role?: string } = { tenant_id: TENANT },
): Promise<void> {
  // The trigger only contains a new identity; trusted provisioning claims it
  // for the throwaway tenant and activates it (requireApiUser rejects 'invited').
  const user = await createProvisionedUser(db, {
    email: actor.email,
    password: `Integration-${RUN}-x9!`,
    email_confirm: true,
    profile,
  });
  actor.id = user.id;
}

beforeAll(async () => {
  const { data: bank, error: bankError } = await db
    .from('companies')
    .insert({ tenant_id: TENANT, name: `Integration Bank ${RUN}`, type: 'bank' })
    .select('id')
    .single();
  if (bankError || !bank) throw new Error(`bank seed failed: ${bankError?.message}`);

  await createActor(actors.a);
  await createActor(actors.b);
  await createActor(actors.c);
  await createActor(actors.cco, { tenant_id: TENANT, firm_role: 'cco' });
  await createActor(actors.otherCco, { tenant_id: OTHER_TENANT, firm_role: 'cco' });

  // create_deal_gate0 refuses a bank with nobody to notify. Seat A as the
  // bank director so the throwaway tenant has an eligible recipient.
  const { error: seatError } = await db
    .from('users')
    .update({ company_id: bank.id, company_role: 'director' })
    .eq('id', actors.a.id);
  if (seatError) throw new Error(`director seat failed: ${seatError.message}`);
});

afterAll(async () => {
  // Best-effort teardown, children first. Every row carries the throwaway
  // tenant or the deal id, so nothing outside this run is touched.
  // KNOWN RESIDUE on a shared (-dev) run: audit_log rows are IMMUTABLE by
  // design (WORM — the compliance record must survive deletion attempts,
  // even by service_role), and their FKs fan out: audit_log.deal_id keeps
  // the `deals` row, deals.bank_id keeps the bank `companies` row,
  // audit_log.document_id keeps the viewed `documents` row, and
  // audit_log.actor_id keeps users A and B (their auth.users deletes below
  // fail too — the cascade into public.users is blocked). All of it is
  // inert: memberships are removed, so no real user can reach the husk.
  // The deletes stay best-effort so a PARTIAL run (failed before any audit
  // row was written) still cleans up fully; the hermetic CI stack is
  // destroyed whole, leaving nothing.
  if (dealId) {
    for (const table of [
      'notifications',
      'documents',
      'deal_steps',
      'deal_memberships',
      'deal_parties',
    ]) {
      await db.from(table).delete().eq('deal_id', dealId);
    }
    await db.from('deals').delete().eq('id', dealId);
  }
  await db.from('companies').delete().eq('tenant_id', TENANT);
  for (const actor of Object.values(actors)) {
    if (!actor.id) continue;
    // GoTrue runs deletes as supabase_auth_admin, which has NO grants on
    // public tables — the users-mirror ON DELETE CASCADE fails and the API
    // 500s (verified against -dev). Drop the mirror row as service_role
    // first (succeeds unless WORM audit rows pin it, i.e. for C but not
    // A/B), then the auth-side delete goes through.
    await db.from('users').delete().eq('id', actor.id);
    await db.auth.admin.deleteUser(actor.id);
  }
});

describe('Phase 1 — sign in → create deal → grant → document view → audit; outsider denied', () => {
  it('A creates a deal (Gate 0) and becomes its MD', async () => {
    actAs(actors.a);
    const res = await createDeal(
      new Request('http://localhost/api/v1/deals', {
        method: 'POST',
        body: JSON.stringify({
          codename: `PROJECT GRANITE ${RUN.toUpperCase()}`,
          targetName: 'Blue Harbor Manufacturing',
          conflictsAttestation: {
            approvedBy: 'Senior Partner (integration)',
            approvedOn: new Date().toISOString().slice(0, 10),
          },
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { deal: { id: string; code: string } };
    dealId = body.deal.id;
    expect(body.deal.code).toMatch(/^[A-Z]{5}-\d{4}-\d{3}$/);

    const { data: membership } = await db
      .from('deal_memberships')
      .select('deal_role')
      .eq('deal_id', dealId)
      .eq('user_id', actors.a.id)
      .maybeSingle();
    expect(membership?.deal_role).toBe('md');
  });

  it('A adds B as deal_team; the grant is audited', async () => {
    actAs(actors.a);
    const res = await addMember(
      new Request(`http://localhost/api/v1/deals/${dealId}/members`, {
        method: 'POST',
        body: JSON.stringify({ email: actors.b.email, dealRole: 'deal_team' }),
      }),
      ctx({ dealId }),
    );
    expect([200, 201]).toContain(res.status);

    const { data: membership } = await db
      .from('deal_memberships')
      .select('deal_role')
      .eq('deal_id', dealId)
      .eq('user_id', actors.b.id)
      .maybeSingle();
    expect(membership?.deal_role).toBe('deal_team');

    // TWO grant audits exist by design: the RPC audits A's own MD membership
    // at Gate 0, the members route audits B's. Both were actor A.
    const { data: grants } = await db
      .from('audit_log')
      .select('actor_id')
      .eq('deal_id', dealId)
      .eq('action', 'grant');
    expect((grants ?? []).length).toBeGreaterThanOrEqual(2);
    expect((grants ?? []).every((g) => g.actor_id === actors.a.id)).toBe(true);
  });

  it('B reads the deal and opens a document; the view is audited', async () => {
    // A fixture document row — upload itself (multipart + storage provider)
    // is outside the Phase 1 contract; the ACCESS + AUDIT path is not.
    const { data: doc, error: docError } = await db
      .from('documents')
      .insert({
        deal_id: dealId,
        name: `teaser-${RUN}.pdf`,
        room: 'internal',
        classification: 1,
        min_phase: 0,
        uploaded_by: actors.a.id,
      })
      .select('id')
      .single();
    if (docError || !doc) throw new Error(`document seed failed: ${docError?.message}`);
    documentId = doc.id;

    actAs(actors.b);
    const read = await readDeal(
      new Request(`http://localhost/api/v1/deals/${dealId}`),
      ctx({ dealId }),
    );
    expect(read.status).toBe(200);

    const view = await viewDocument(
      new Request(`http://localhost/api/v1/deals/${dealId}/documents/${documentId}/view`, {
        method: 'POST',
      }),
      ctx({ dealId, documentId }),
    );
    expect(view.status).toBe(201);

    const { data: audit } = await db
      .from('audit_log')
      .select('id, actor_id, action, document_id')
      .eq('deal_id', dealId)
      .eq('action', 'view')
      .eq('actor_id', actors.b.id)
      .maybeSingle();
    expect(audit?.document_id).toBe(documentId);
  });

  it('C (same tenant, no membership) is denied everywhere and leaves no view audit', async () => {
    actAs(actors.c);
    const read = await readDeal(
      new Request(`http://localhost/api/v1/deals/${dealId}`),
      ctx({ dealId }),
    );
    expect([403, 404]).toContain(read.status);

    const view = await viewDocument(
      new Request(`http://localhost/api/v1/deals/${dealId}/documents/${documentId}/view`, {
        method: 'POST',
      }),
      ctx({ dealId, documentId }),
    );
    expect([403, 404]).toContain(view.status);

    const { data: audits } = await db
      .from('audit_log')
      .select('id')
      .eq('deal_id', dealId)
      .eq('action', 'view')
      .eq('actor_id', actors.c.id);
    expect(audits ?? []).toHaveLength(0);
  });
});

describe("another firm's CCO is refused where the deal's own CCO reads", () => {
  const dealIdsListedFor = async (actor: Actor) => {
    actAs(actor);
    const res = await listDeals();
    expect(res.status).toBe(200);
    const { deals } = (await res.json()) as { deals: { id: string }[] };
    return deals.map((deal) => deal.id);
  };

  it("the deal's own CCO lists and reads the deal without a seat", async () => {
    expect(await dealIdsListedFor(actors.cco)).toContain(dealId);
    const read = await readDeal(
      new Request(`http://localhost/api/v1/deals/${dealId}`),
      ctx({ dealId }),
    );
    expect(read.status).toBe(200);
  });

  it("another firm's CCO does not see the deal listed and is refused on its deal, document and audit routes", async () => {
    expect(await dealIdsListedFor(actors.otherCco)).not.toContain(dealId);

    const responses = [
      await readDeal(new Request(`http://localhost/api/v1/deals/${dealId}`), ctx({ dealId })),
      await listDocuments(
        new Request(`http://localhost/api/v1/deals/${dealId}/documents`),
        ctx({ dealId }),
      ),
      await readDealAudit(
        new Request(`http://localhost/api/v1/deals/${dealId}/audit`),
        ctx({ dealId }),
      ),
      await viewDocument(
        new Request(`http://localhost/api/v1/deals/${dealId}/documents/${documentId}/view`, {
          method: 'POST',
        }),
        ctx({ dealId, documentId }),
      ),
    ];
    for (const res of responses) expect([403, 404]).toContain(res.status);

    const { data: audits } = await db
      .from('audit_log')
      .select('id')
      .eq('deal_id', dealId)
      .eq('actor_id', actors.otherCco.id);
    expect(audits ?? []).toHaveLength(0);
  });
});
