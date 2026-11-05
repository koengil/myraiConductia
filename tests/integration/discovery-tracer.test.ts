import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProvisionedUser } from '@/lib/auth/provisioning';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/*
 * Deal discovery, phase 3 tracer bullet, against a REAL database:
 *
 *   fixture mailboxes -> runOnce (classification worker) -> GET
 *   /api/v1/discovery/candidates as each user, read under RLS.
 *
 * What is real: the worker, the route handler, requireApiUserScoped, the RLS
 * policies, Postgres. Every user signs in with a password, and the route
 * reads with that user's own session client, so the policies decide what
 * comes back. What is faked: only how the handler obtains that client (the
 * cookie layer needs a Next runtime).
 *
 * Self-contained: a throwaway tenant, a throwaway bank company and five
 * throwaway users (six with the external invitee). The fixture mailboxes map
 * to them as Alice (Storm's mailbox), the colleague (Morgan's) and Bob (Alex's,
 * no deal mail). Each mailbox is readable only through the allowlist (#262):
 * the owner is seated at the bank by an accepted invite and opts in through
 * their own session. Discovery rows, invites (with their consents) and the
 * companies are deleted afterwards; the audit rows stay (audit_log is
 * append-only), so a user who wrote a user-actor audit row, such as a consent,
 * is suspended and unseated instead of deleted.
 */

const sessions = new Map<string, SupabaseClient>();
let actingAs = '';

vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return {
    ...actual,
    createSupabaseServerClient: async () => {
      const client = sessions.get(actingAs);
      if (!client) throw new Error(`no session for ${actingAs}`);
      return client;
    },
  };
});

// The Gmail reader is real (the Gmail ContentSource over a scripted Gmail); only
// its factory is replaced, so this test scripts its own mailbox instead of
// reading the committed replay (tests/integration/discovery-canary.test.ts runs
// the real factory over a replay).
// The capability check stays honest: the stub demands it like the real factory.
const gmailReader = vi.hoisted(() => ({ source: null as import('@/lib/discovery/source/types').ContentSource | null }));
vi.mock('@/lib/google/reader', async () => {
  const capabilityModule = await import('@/lib/discovery/source/capability');
  const demandCapability: (candidate: unknown) => void = capabilityModule.requireReaderCapability;
  return {
    getGoogleContentSource: (capability: unknown) => {
      demandCapability(capability);
      if (!gmailReader.source) throw new Error('no scripted Gmail source');
      return gmailReader.source;
    },
    getGoogleGroupMirror: () => {
      throw new Error('the integration test injects its own mirror');
    },
  };
});

import { GET as listCandidatesRoute } from '@/app/api/v1/discovery/candidates/route';
import { GET as healthRoute } from '@/app/api/v1/discovery/health/route';
import { READER_MODE } from '@/lib/constants/discovery';
import { createGmailMailContentSource } from '@/lib/google/reader/mail';
import { NO_EXCLUSION } from '../google/exclusion';
import { createFixtureAllowlistMirror } from '@/lib/mailboxAccess';
import { fakeGmail } from '../google/fakeGmail';
import { runOnce } from '../../worker/classify';
import { addDealMembers, seatOnDeal } from './support/guardedTenant';
import { createUserProvisioned } from './support/provisioned';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !secret || !publishable) {
  throw new Error(
    'The discovery tracer needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and ' +
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (local `supabase start` stack).',
  );
}
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const TENANT = crypto.randomUUID();
const PASSWORD = `Discovery-${RUN}-x9!`;

type Persona = 'alice' | 'colleague' | 'bob' | 'cco' | 'admin' | 'gina';
const users: Record<Persona, { id: string; email: string; firmRole: 'cco' | 'admin' | null; department: string }> = {
  alice: { id: '', email: `dd-alice-${RUN}@integration.conductia.dev`, firmRole: null, department: 'ib' },
  colleague: { id: '', email: `dd-colleague-${RUN}@integration.conductia.dev`, firmRole: null, department: 'ib' },
  bob: { id: '', email: `dd-bob-${RUN}@integration.conductia.dev`, firmRole: null, department: 'ib' },
  cco: { id: '', email: `dd-cco-${RUN}@integration.conductia.dev`, firmRole: 'cco', department: 'compliance' },
  admin: { id: '', email: `dd-admin-${RUN}@integration.conductia.dev`, firmRole: 'admin', department: 'admin' },
  // Last, so the members are deleted before the director. Owns the Google mailbox (#259).
  gina: { id: '', email: `dd-gina-${RUN}@integration.conductia.dev`, firmRole: null, department: 'ib' },
};

const MAILBOXES: Array<{ address: string; owner: Persona }> = [
  { address: 'storm.duncan@bank.example', owner: 'alice' },
  { address: 'morgan.vale@bank.example', owner: 'colleague' },
  { address: 'alex.chen@bank.example', owner: 'bob' },
];

let bankCompanyId = '';
let bankDealId = '';
let counterpartyCompanyId = '';
const outsider = { id: '', email: `dd-outsider-${RUN}@integration.conductia.dev` };
let outsiderSession: SupabaseClient | null = null;

let previousFlag: { enabled: boolean } | null = null;
let previousMfa: string | undefined;

async function setFlag(enabled: boolean): Promise<void> {
  const { error } = await db
    .from('feature_flags')
    .upsert({ key: 'deal_discovery', description: 'deal discovery (integration)', enabled }, { onConflict: 'key' });
  if (error) throw new Error(`flag upsert failed: ${error.message}`);
}

async function listAs(persona: Persona) {
  actingAs = persona;
  const res = await listCandidatesRoute();
  const body = await res.json();
  return { status: res.status, body };
}

async function tenantCounts() {
  const count = async (table: string, column = 'tenant_id') => {
    const { count: n, error } = await db.from(table).select('*', { count: 'exact', head: true }).eq(column, TENANT);
    if (error) throw new Error(`${table} count failed: ${error.message}`);
    return n ?? 0;
  };
  const { data: candidates } = await db.from('deal_candidates').select('id').eq('tenant_id', TENANT);
  const ids = (candidates ?? []).map((c) => c.id as string);
  const links = ids.length
    ? (await db.from('evidence_links').select('*', { count: 'exact', head: true }).in('candidate_id', ids)).count
    : 0;
  const visibility = ids.length
    ? (await db.from('candidate_visibility').select('*', { count: 'exact', head: true }).in('candidate_id', ids)).count
    : 0;
  return {
    candidates: await count('deal_candidates'),
    items: await count('source_items'),
    links,
    visibility,
    proposedAudit: (
      await db
        .from('audit_log')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', TENANT)
        .eq('action', 'discovery.candidate_proposed')
    ).count,
  };
}

/**
 * The worker resumes each source from its checkpoint (#243), so a later pass
 * reads only what is new. The allowlist cases count what a pass reads, so each
 * of their passes starts every source from the beginning; the upserts it
 * repeats change nothing.
 */
async function rewindSources(): Promise<void> {
  const { error } = await db
    .from('content_sources')
    .update({ delta_checkpoint: null, backfill_completed_at: null })
    .eq('tenant_id', TENANT);
  if (error) throw new Error(`checkpoint rewind failed: ${error.message}`);
}

beforeAll(async () => {
  previousMfa = process.env.MFA_ENFORCEMENT;
  // Password-created accounts are established accounts: no TOTP needed.
  process.env.MFA_ENFORCEMENT = 'invite_only';

  const { data: flagRow } = await db.from('feature_flags').select('enabled').eq('key', 'deal_discovery').maybeSingle();
  previousFlag = flagRow as { enabled: boolean } | null;
  await setFlag(true);

  for (const persona of Object.keys(users) as Persona[]) {
    const user = users[persona];
    const created = await createProvisionedUser(db, {
      email: user.email,
      password: PASSWORD,
      email_confirm: true,
      profile: { tenant_id: TENANT, department: user.department, firm_role: user.firmRole, is_external: false },
    });
    user.id = created.id;

    const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: signInError } = await client.auth.signInWithPassword({ email: user.email, password: PASSWORD });
    if (signInError) throw new Error(`sign-in failed for ${persona}: ${signInError.message}`);
    sessions.set(persona, client);
  }

  // The bank: alice seated first, as director (a company holds no member
  // without one), then the others as members.
  const company = await db
    .from('companies')
    .insert({ tenant_id: TENANT, name: `Discovery Bank ${RUN}`, type: 'bank' })
    .select('id')
    .single();
  if (company.error) throw new Error(`bank company failed: ${company.error.message}`);
  bankCompanyId = company.data.id as string;
  const seat = async (persona: Persona, role: 'director' | 'member') => {
    const { error } = await db
      .from('users')
      .update({ company_id: bankCompanyId, company_role: role })
      .eq('id', users[persona].id);
    if (error) throw new Error(`seating ${persona} failed: ${error.message}`);
  };
  await seat('alice', 'director');
  for (const persona of ['colleague', 'bob', 'cco', 'admin', 'gina'] as const) await seat(persona, 'member');

  const { error: registrationError } = await db.from('graph_reader_registrations').insert({
    tenant_id: TENANT,
    ms_tenant_id: 'fixture',
    client_id: 'fixture',
    status: 'active',
    mailbox_domains: ['bank.example'],
    firm_company_id: bankCompanyId,
  });
  if (registrationError) throw new Error(`registration failed: ${registrationError.message}`);

  // Accepted invites (email = the mailbox address), then each owner opts in
  // through their own signed-in session.
  const { error: inviteError } = await db.from('invites').insert(
    MAILBOXES.map(({ address, owner }) => ({
      tenant_id: TENANT,
      email: address,
      invited_by: users.alice.id,
      company_id: bankCompanyId,
      company_role: 'member',
      status: 'accepted',
      delivery_status: 'sent',
      accepted_at: new Date().toISOString(),
      accepted_user_id: users[owner].id,
    })),
  );
  if (inviteError) throw new Error(`invites failed: ${inviteError.message}`);
  // The opt-in needs MD or deal team on a deal of the tenant (#262 round 3, A2).
  bankDealId = await seatOnDeal(db, {
    tenantId: TENANT,
    bankId: bankCompanyId,
    code: `DD-TRACER-${RUN}`,
    userIds: ['alice', 'colleague', 'bob'].map((persona) => users[persona as Persona].id),
  });
  for (const persona of ['alice', 'colleague', 'bob'] as const) {
    const { error } = await sessions.get(persona)!.rpc('mailbox_consent_grant');
    if (error) throw new Error(`consent for ${persona} failed: ${error.message}`);
  }

  // Each opt-in created its owner's mailbox source (C20): assert that instead of inserting a second row.
  const { data: sources, error: sourceError } = await db
    .from('content_sources')
    .select('address, owner_user_id')
    .eq('tenant_id', TENANT)
    .eq('kind', 'mailbox');
  if (sourceError) throw new Error(`content sources failed: ${sourceError.message}`);
  const created = new Map((sources ?? []).map((row) => [row.address as string, row.owner_user_id as string]));
  for (const { address, owner } of MAILBOXES) {
    if (created.get(address) !== users[owner].id) {
      throw new Error(`the opt-in did not create ${address}'s source for its owner`);
    }
  }
  // The opt-in gives each source the default window (#353); the fixture mail has fixed dates, so the tracer reads
  // every mailbox whole, as the seed does.
  const { error: windowError } = await db.from('content_sources').update({ backfill_since: null }).eq('tenant_id', TENANT);
  if (windowError) throw new Error(`window reset failed: ${windowError.message}`);
});

afterAll(async () => {
  if (previousMfa === undefined) delete process.env.MFA_ENFORCEMENT;
  else process.env.MFA_ENFORCEMENT = previousMfa;

  // Discovery rows first (cascades take links, visibility, texts, provenance
  // and the ledger), then the users. The audit rows name no user and no deal.
  await db.from('deal_candidates').delete().eq('tenant_id', TENANT);
  await db.from('source_items').delete().eq('tenant_id', TENANT);
  // A registration with sources cannot be deleted (on delete restrict, plan D1): sources first.
  await db.from('content_sources').delete().eq('tenant_id', TENANT);
  await db.from('graph_reader_registrations').delete().eq('tenant_id', TENANT);
  await db.from('google_reader_registrations').delete().eq('tenant_id', TENANT);
  // Drift state and its bell rows (notifications name their recipients, so they go before the users).
  await db.from('mailbox_allowlist_drift').delete().eq('tenant_id', TENANT);
  await db.from('notifications').delete().eq('tenant_id', TENANT);
  // Invites take their consents with them (the service role cannot delete a
  // consent directly), and must go before the users they name.
  await db.from('invites').delete().eq('tenant_id', TENANT);
  // The deal references the bank company; its memberships go with it.
  await db.from('deals').delete().eq('tenant_id', TENANT);
  for (const client of [...sessions.values(), ...(outsiderSession ? [outsiderSession] : [])]) {
    await client.auth.signOut();
  }
  // Members before the director (alice is first in `users`): a company may not
  // keep a member once its director is gone.
  for (const user of [outsider, ...Object.values(users).reverse()]) {
    if (!user.id) continue;
    const { error } = await db.auth.admin.deleteUser(user.id);
    // A user who wrote a user-actor audit row (a consent) cannot be deleted:
    // audit_log is append-only and names them. Suspend and unseat them instead.
    if (error) {
      await db.from('users').update({ status: 'suspended', company_id: null, company_role: null }).eq('id', user.id);
    }
  }
  for (const companyId of [bankCompanyId, counterpartyCompanyId]) {
    if (companyId) await db.from('companies').delete().eq('id', companyId);
  }

  if (previousFlag) await setFlag(previousFlag.enabled);
  else await db.from('feature_flags').delete().eq('key', 'deal_discovery');
});

describe('discovery tracer: fixture mailbox -> classify worker -> RLS-first list', () => {
  it('classifies the fixture corpus into Falcon and Cobra', async () => {
    const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    expect(summary.status).toBe('ok');
    if (summary.status !== 'ok') return;
    expect(summary.itemsRead).toBe(17);
    expect(summary.itemsStored).toBe(8);
    // The coverage counts (#460): the same sightings as itemsRead, as the ledger records them (see the health totals below).
    expect(summary.routing).toEqual({ read: 17, routed: 10, unrouted: 7, skipped: 0, collisions: 0, codenames: 2, fullRead: true, scopeBlocked: 0 });
    expect(summary.candidates.map((c) => [c.clusterKey, c.created])).toEqual([
      ['codename:cobra', true],
      ['codename:falcon', true],
    ]);
  });

  it('shows Alice Falcon, and only Falcon', async () => {
    const { status, body } = await listAs('alice');
    expect(status).toBe(200);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({
      name: 'Project Falcon',
      parties: [{ name: 'Heliotrope', domain: 'heliotrope.example' }],
      firstSeenAt: expect.stringMatching(/^2026-02-03T09:12:00/),
      lastSeenAt: expect.stringMatching(/^2026-02-20T16:05:00/),
      evidenceCount: 6,
      ownEvidenceCount: 5,
    });
  });

  it('shows Bob, who holds no evidence, nothing', async () => {
    const { status, body } = await listAs('bob');
    expect(status).toBe(200);
    expect(body.candidates).toEqual([]);
  });

  it('shows the colleague both of their candidates', async () => {
    const { body } = await listAs('colleague');
    expect(body.candidates.map((c: { name: string }) => c.name)).toEqual(['Project Falcon', 'Project Cobra']);
    expect(body.candidates[0]).toMatchObject({ evidenceCount: 6, ownEvidenceCount: 3 });
  });

  it('shows the control room everything in its tenant, and the firm admin nothing', async () => {
    expect((await listAs('cco')).body.candidates.map((c: { name: string }) => c.name)).toEqual([
      'Project Falcon',
      'Project Cobra',
    ]);
    expect((await listAs('admin')).body.candidates).toEqual([]);
  });

  it('shows Alice a colleague-only item as metadata, never its subject or text', async () => {
    const alice = sessions.get('alice')!;
    const { data: items } = await alice
      .from('source_items')
      .select('id')
      .eq('tenant_id', TENANT)
      .eq('internet_message_id', '<falcon-007@bank.example>');
    expect(items).toEqual([{ id: expect.any(String) }]);
    const itemId = items![0].id;
    // The column wall (20261017100000): subject is owner-only, so a direct read is refused...
    const { data: walled, error: wallError } = await alice.from('source_items').select('id, subject').eq('id', itemId);
    expect(walled).toBeNull();
    expect(wallError?.code).toBe('42501');
    // ...and the owner-gated definer answers the row without it.
    const { data: aliceMeta } = await alice.rpc('discovery_item_metadata', { p_items: [itemId] });
    expect(aliceMeta).toEqual([
      expect.objectContaining({ id: itemId, own: false, subject: null, participants: null, sender_domain: 'bank.example' }),
    ]);
    const { data: texts } = await alice.from('source_item_texts').select('source_item_id').eq('source_item_id', itemId);
    expect(texts).toEqual([]);

    const colleague = sessions.get('colleague')!;
    const { data: ownMeta } = await colleague.rpc('discovery_item_metadata', { p_items: [itemId] });
    expect(ownMeta).toEqual([
      expect.objectContaining({
        id: itemId,
        own: true,
        subject: 'Project Falcon: buyer list v2',
        participants: expect.arrayContaining([expect.objectContaining({ role: 'from', address: 'morgan.vale@bank.example' })]),
        sender_domain: 'bank.example',
      }),
    ]);
    const { data: ownText } = await colleague.from('source_item_texts').select('body_text').eq('source_item_id', itemId);
    expect(ownText).toEqual([{ body_text: 'The updated buyer list is attached: 14 strategics and 9 sponsors.' }]);
  });

  it('re-running the worker creates no duplicate candidate, link or audit row', async () => {
    const before = await tenantCounts();
    expect(before).toEqual({ candidates: 2, items: 8, links: 8, visibility: 3, proposedAudit: 2 });

    const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    expect(summary.status === 'ok' && summary.candidates.every((c) => !c.created)).toBe(true);
    // A pass after a completed backfill reads new mail only (#460): its counts are not a coverage answer.
    expect(summary.status === 'ok' && summary.routing).toMatchObject({ read: 0, fullRead: false });
    expect(await tenantCounts()).toEqual(before);

    const { data: audit } = await db
      .from('audit_log')
      .select('actor_type, actor_id, service_identity, chain_seq')
      .eq('tenant_id', TENANT)
      .eq('action', 'discovery.candidate_proposed');
    expect(audit).toHaveLength(2);
    for (const row of audit ?? []) {
      expect(row).toMatchObject({ actor_type: 'service', actor_id: null, service_identity: 'discovery-worker' });
      expect(row.chain_seq).not.toBeNull();
    }
  });

  it('shows ingestion health to the admin and the CCO as counts only, and 404s everyone else', async () => {
    const healthAs = async (persona: Persona) => {
      actingAs = persona;
      const res = await healthRoute();
      return { status: res.status, body: await res.json() };
    };
    const admin = await healthAs('admin');
    expect(admin.status).toBe(200);
    // Ledger counts are sightings: two Falcon messages sit in two mailboxes each.
    expect(admin.body.health.totals).toMatchObject({ sources: 3, itemsLedgered: 17, itemsRouted: 10, itemsStored: 8, candidatesProposed: 2 });
    expect(admin.body.health.sources.map((s: { address: string }) => s.address)).toEqual([
      'alex.chen@bank.example',
      'morgan.vale@bank.example',
      'storm.duncan@bank.example',
    ]);
    expect(admin.body.health.sources.every((s: { checkpointState: string }) => s.checkpointState === 'incremental')).toBe(true);
    expect(JSON.stringify(admin.body)).not.toMatch(/falcon|cobra|heliotrope/i);
    expect((await healthAs('cco')).status).toBe(200);
    for (const persona of ['alice', 'bob', 'colleague'] as const) {
      expect(await healthAs(persona)).toEqual({ status: 404, body: { error: 'Not found' } });
    }
  });

  it('reads nothing when deal_discovery is off, and changes nothing', async () => {
    const before = await tenantCounts();
    await setFlag(false);
    try {
      const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
      // Each active source still gets its reader pass (#370), ended disabled / flag_off: a record, not a read.
      expect(summary).toEqual({
        tenantId: TENANT,
        status: 'skipped',
        reason: 'flag_disabled',
        passes: expect.arrayContaining([expect.objectContaining({ passId: expect.any(String) })]),
      });
      if (summary.status !== 'skipped') throw new Error('unreachable');
      const { data: ends } = await db
        .from('audit_log')
        .select('detail')
        .eq('tenant_id', TENANT)
        .eq('action', 'discovery.reader_pass_finished')
        .in('detail->>passId', summary.passes.map((pass) => pass.passId));
      expect((ends ?? []).map((row) => [row.detail.status, row.detail.reason, row.detail.pages])).toEqual(
        summary.passes.map(() => ['disabled', 'flag_off', 0]),
      );
      expect(await tenantCounts()).toEqual(before);
    } finally {
      await setFlag(true);
    }
  });

  it('answers 404 when deal_discovery is off', async () => {
    await setFlag(false);
    try {
      const { status } = await listAs('alice');
      expect(status).toBe(404);
    } finally {
      await setFlag(true);
    }
  });
});

describe('the allowlist stops reads on the next pass', () => {
  const sourceIdOf = async (address: string) => {
    const { data, error } = await db
      .from('content_sources')
      .select('id')
      .eq('tenant_id', TENANT)
      .eq('address', address)
      .single();
    if (error) throw new Error(`source lookup failed: ${error.message}`);
    return data.id as string;
  };
  const refusalRows = async () => {
    const { data, error } = await db
      .from('audit_log')
      .select('detail, service_identity, actor_type')
      .eq('tenant_id', TENANT)
      .eq('action', 'discovery.mailbox_refused');
    if (error) throw new Error(`audit lookup failed: ${error.message}`);
    return data ?? [];
  };
  const pass = async () => {
    await rewindSources();
    const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    if (summary.status !== 'ok') throw new Error(`pass skipped: ${summary.reason}`);
    return summary;
  };

  it('stops reading a mailbox whose owner withdraws: its source is deleted, and a re-consent reads it afresh', async () => {
    const stormSource = await sourceIdOf('storm.duncan@bank.example');
    const { error } = await sessions.get('alice')!.rpc('mailbox_consent_withdraw');
    expect(error).toBeNull();

    // The withdrawal deleted the source with the mail it alone held (#461): there is nothing left to read or refuse.
    const { data: gone } = await db.from('content_sources').select('id').eq('id', stormSource);
    expect(gone).toEqual([]);
    const refusedPass = await pass();
    expect(refusedPass.refused).toEqual([]);
    expect(refusedPass.itemsRead).toBe(9);
    expect(await refusalRows()).toHaveLength(0);

    // Session reads: the withdrawn owner sees nothing; the colleague keeps both
    // candidates through their own mailbox, and the control room sees what
    // that mailbox still backs.
    const names = (body: { candidates: { name: string }[] }) => body.candidates.map((c) => c.name);
    expect((await listAs('alice')).body.candidates).toEqual([]);
    expect(names((await listAs('colleague')).body)).toEqual(['Project Falcon', 'Project Cobra']);
    expect(names((await listAs('cco')).body)).toEqual(['Project Falcon', 'Project Cobra']);

    const { error: reconsent } = await sessions.get('alice')!.rpc('mailbox_consent_grant');
    expect(reconsent).toBeNull();
    expect(await sourceIdOf('storm.duncan@bank.example')).not.toBe(stormSource);
    const resumed = await pass();
    expect(resumed.refused).toEqual([]);
    expect(resumed.itemsRead).toBe(17);
  });

  it('stops reading a removed member, withdraws their consent and deletes the source, and needs a fresh opt-in after the re-seat', async () => {
    const morganSource = await sourceIdOf('morgan.vale@bank.example');
    // The members route's effect on a removed member.
    const { error } = await db
      .from('users')
      .update({ company_id: null, company_role: null, status: 'suspended' })
      .eq('id', users.colleague.id);
    expect(error).toBeNull();

    const removedPass = await pass();
    expect(removedPass.refused).toEqual([]);
    const { data: gone } = await db.from('content_sources').select('id').eq('id', morganSource);
    expect(gone).toEqual([]);

    const { data: open } = await db
      .from('mailbox_consents')
      .select('id')
      .eq('user_id', users.colleague.id)
      .is('withdrawn_at', null);
    expect(open).toEqual([]);
    const { data: seatLost } = await db
      .from('audit_log')
      .select('detail, service_identity')
      .eq('tenant_id', TENANT)
      .eq('action', 'discovery.mailbox_consent_withdrawn')
      .eq('detail->>address', 'morgan.vale@bank.example')
      .eq('detail->>reason', 'seat_lost');
    expect(seatLost).toHaveLength(1);

    // Re-seat: the old consent does not come back.
    const { error: reseat } = await db
      .from('users')
      .update({ company_id: bankCompanyId, company_role: 'member', status: 'active' })
      .eq('id', users.colleague.id);
    expect(reseat).toBeNull();
    // Losing the company deleted the colleague's deal memberships; the re-seat puts them back on the deal.
    await addDealMembers(db, bankDealId, [users.colleague.id]);
    // No source, so nothing to read or refuse until the member opts in again.
    expect((await pass()).refused).toEqual([]);
    const { data: none } = await db.from('content_sources').select('id').eq('tenant_id', TENANT).eq('address', 'morgan.vale@bank.example');
    expect(none).toEqual([]);

    const { error: reconsent } = await sessions.get('colleague')!.rpc('mailbox_consent_grant');
    expect(reconsent).toBeNull();
    const resumed = await pass();
    expect(resumed.refused).toEqual([]);
    expect(resumed.itemsRead).toBe(17);
  });

  it('never reads an external invitee, and refuses their opt-in', async () => {
    const company = await db
      .from('companies')
      .insert({ tenant_id: TENANT, name: `Discovery Counterparty ${RUN}`, type: 'counterparty' })
      .select('id')
      .single();
    expect(company.error).toBeNull();
    counterpartyCompanyId = company.data!.id as string;

    const created = await createUserProvisioned(db, {
      email: outsider.email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { tenant_id: TENANT, department: 'ib' },
    });
    expect(created.error).toBeNull();
    outsider.id = created.data.user!.id;
    const claimed = await db
      .from('users')
      .update({
        tenant_id: TENANT,
        status: 'active',
        is_external: true,
        company_id: counterpartyCompanyId,
        company_role: 'director',
      })
      .eq('id', outsider.id);
    expect(claimed.error).toBeNull();
    const invite = await db.from('invites').insert({
      tenant_id: TENANT,
      email: 'ext.partner@bank.example',
      invited_by: users.alice.id,
      company_id: counterpartyCompanyId,
      company_role: 'director',
      status: 'accepted',
      delivery_status: 'sent',
      accepted_at: new Date().toISOString(),
      accepted_user_id: outsider.id,
    });
    expect(invite.error).toBeNull();

    outsiderSession = createClient(url!, publishable!, { auth: { persistSession: false, autoRefreshToken: false } });
    const signIn = await outsiderSession.auth.signInWithPassword({ email: outsider.email, password: PASSWORD });
    expect(signIn.error).toBeNull();
    const consent = await outsiderSession.rpc('mailbox_consent_grant');
    expect(consent.error?.message).toBe('not_eligible');

    const source = await db
      .from('content_sources')
      .insert({ tenant_id: TENANT, kind: 'mailbox', address: 'ext.partner@bank.example', owner_user_id: outsider.id })
      .select('id')
      .single();
    expect(source.error).toBeNull();
    const externalPass = await pass();
    expect(externalPass.refused).toEqual([{ sourceId: source.data!.id, reason: 'external' }]);
    expect(externalPass.itemsRead).toBe(17);
  });
});

describe('the provider group mirrors the allowlist', () => {
  const MORGAN = 'morgan.vale@bank.example';
  const EXTERNAL = 'ext.partner@bank.example';

  const sourceIdOf = async (address: string) => {
    const { data, error } = await db
      .from('content_sources')
      .select('id')
      .eq('tenant_id', TENANT)
      .eq('address', address)
      .single();
    if (error) throw new Error(`source lookup failed: ${error.message}`);
    return data.id as string;
  };
  const passWith = async (options: { add?: string[]; drop?: string[]; fail?: boolean }) => {
    await rewindSources();
    const summary = await runOnce({
      tenantId: TENANT,
      db,
      provider: READER_MODE.FIXTURE,
      mirror: createFixtureAllowlistMirror(db, options),
    });
    if (summary.status !== 'ok') throw new Error(`pass skipped: ${summary.reason}`);
    return summary;
  };
  const driftAuditCount = async () => {
    const { count, error } = await db
      .from('audit_log')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', TENANT)
      .eq('action', 'discovery.allowlist_drift');
    if (error) throw new Error(`audit count failed: ${error.message}`);
    return count ?? 0;
  };
  const bellCount = async (persona: Persona) => {
    const { count, error } = await db
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('recipient_id', users[persona].id)
      .eq('event_type', 'mailbox_allowlist_drift');
    if (error) throw new Error(`notification count failed: ${error.message}`);
    return count ?? 0;
  };
  const driftRow = async () => {
    const { data, error } = await db
      .from('mailbox_allowlist_drift')
      .select('provider, status, missing_in_group, extra_in_group')
      .eq('tenant_id', TENANT);
    if (error) throw new Error(`drift lookup failed: ${error.message}`);
    return data ?? [];
  };

  it('records nothing when the group holds exactly the allowlist', async () => {
    const summary = await passWith({});
    expect(summary.allowlist).toBe('in_sync');
    expect(summary.itemsRead).toBe(17);
    expect(await driftAuditCount()).toBe(0);
    expect(await bellCount('cco')).toBe(0);
  });

  it('reads the intersection when the group drops a mailbox, audits the drift and rings the bell', async () => {
    const morganSource = await sourceIdOf(MORGAN);
    const externalSource = await sourceIdOf(EXTERNAL);
    const summary = await passWith({ drop: [MORGAN] });
    expect(summary.allowlist).toBe('drift');
    expect(summary.refused).toEqual(
      expect.arrayContaining([
        { sourceId: morganSource, reason: 'not_in_provider_group' },
        { sourceId: externalSource, reason: 'external' },
      ]),
    );
    expect(summary.refused).toHaveLength(2);
    expect(summary.itemsRead).toBe(11);

    expect(await driftRow()).toEqual([
      { provider: 'microsoft', status: 'drift', missing_in_group: [MORGAN], extra_in_group: [] },
    ]);
    expect(await driftAuditCount()).toBe(1);
    expect(await bellCount('cco')).toBe(1);
    expect(await bellCount('admin')).toBe(1);
    expect(await bellCount('alice')).toBe(0);
  });

  it('records the same drift once: a second identical pass adds no audit row and no notification', async () => {
    const summary = await passWith({ drop: [MORGAN] });
    expect(summary.allowlist).toBe('drift');
    expect(await driftAuditCount()).toBe(1);
    expect(await bellCount('cco')).toBe(1);
    expect(await bellCount('admin')).toBe(1);
  });

  it('keeps an external invitee unreadable even when the provider group holds them', async () => {
    const externalSource = await sourceIdOf(EXTERNAL);
    const summary = await passWith({ add: [EXTERNAL] });
    expect(summary.refused).toEqual([{ sourceId: externalSource, reason: 'external' }]);
    expect(summary.itemsRead).toBe(17);
    expect(summary.allowlist).toBe('drift');
    const [row] = await driftRow();
    expect(row.extra_in_group).toContain(EXTERNAL);
    expect(row.missing_in_group).toEqual([]);
  });

  it('reads nothing when the group cannot be read', async () => {
    const summary = await passWith({ fail: true });
    expect(summary.allowlist).toBe('unavailable');
    expect(summary.itemsRead).toBe(0);
    // Every allowlisted mailbox is refused for the group; the external invitee for the invite rule.
    const reasons = summary.refused.map((r) => r.reason).sort();
    expect(reasons).toEqual(['external', 'mirror_unavailable', 'mirror_unavailable', 'mirror_unavailable']);
    expect((await driftRow())[0]).toMatchObject({ status: 'unavailable', missing_in_group: [], extra_in_group: [] });
  });

  it('shows the firm admin the drift entry, and nobody else', async () => {
    const { data, error } = await sessions.get('admin')!.rpc('discovery_allowlist_health');
    expect(error).toBeNull();
    expect(data).toEqual([
      expect.objectContaining({ provider: 'microsoft', status: 'unavailable', missingInGroup: [], extraInGroup: [] }),
    ]);
    const cco = await sessions.get('cco')!.rpc('discovery_allowlist_health');
    expect(cco.error).toBeNull();

    const alice = await sessions.get('alice')!.rpc('discovery_allowlist_health');
    expect(alice.data).toBeNull();
    expect(alice.error?.code).toBe('42501');
  });
});

// Runs last: it adds a Google registration to the tenant, and with it a second
// provider's drift row that the mirror describe above must not see.
describe('a Google source beside the Graph fixture sources (#259)', () => {
  const GMAIL = 'gina@gmail-bank.example';
  const FIXTURE_ITEMS = 17;
  let googleSourceId = '';
  let gmail: ReturnType<typeof fakeGmail>;

  const ospreyMessage = (id: string, minute: number, extra: object = {}) => ({
    id,
    internalDate: Date.parse('2026-03-02T09:00:00Z') + minute * 60_000,
    from: { name: 'Gina Park', address: GMAIL },
    to: [{ name: 'Casey Buyer', address: 'casey@osprey-capital.example' }],
    subject: 'Project Osprey: teaser draft',
    body: { contentType: 'text' as const, content: 'Project Osprey teaser attached for the buyer group.' },
    ...extra,
  });

  beforeAll(async () => {
    const registration = await db.from('google_reader_registrations').insert({
      tenant_id: TENANT,
      workspace_domain: 'gmail-bank.example',
      service_account_email: 'dwd-reader@proj-1.iam.gserviceaccount.com',
      client_id: '123456789012345678',
      directory_service_account_email: 'dir-reader@proj-1.iam.gserviceaccount.com',
      allowlist_group: 'conductia-ingest@gmail-bank.example',
      firm_company_id: bankCompanyId,
      status: 'active',
      consented_at: new Date().toISOString(),
    });
    if (registration.error) throw new Error(`google registration failed: ${registration.error.message}`);
    const invite = await db.from('invites').insert({
      tenant_id: TENANT,
      email: GMAIL,
      invited_by: users.alice.id,
      company_id: bankCompanyId,
      company_role: 'member',
      status: 'accepted',
      delivery_status: 'sent',
      accepted_at: new Date().toISOString(),
      accepted_user_id: users.gina.id,
    });
    if (invite.error) throw new Error(`google invite failed: ${invite.error.message}`);
    // The opt-in below needs MD or deal team on a deal of the tenant (#262). The source is inserted first,
    // owned by gina, so her opt-in binds it and creates nothing.
    await addDealMembers(db, bankDealId, [users.gina.id]);
    const source = await db
      .from('content_sources')
      // backfill_since null: the fixture mail has fixed dates, so it is read whole, as the seed does (#353).
      .insert({ tenant_id: TENANT, kind: 'mailbox', provider: 'google', address: GMAIL, owner_user_id: users.gina.id, backfill_since: null })
      .select('id')
      .single();
    if (source.error) throw new Error(`google source failed: ${source.error.message}`);
    googleSourceId = source.data.id as string;

    gmail = fakeGmail({
      address: GMAIL,
      threads: [
        {
          id: 'thread-osprey',
          messages: [
            ospreyMessage('g1', 0),
            ospreyMessage('g2', 5, {
              from: { name: 'Casey Buyer', address: 'casey@osprey-capital.example' },
              to: [{ name: 'Gina Park', address: GMAIL }],
              subject: 'Re: Project Osprey: teaser draft',
              inReplyTo: '<g1@bank.example>',
              references: ['<g1@bank.example>'],
            }),
          ],
        },
        // Never read: a draft and a message in the spam folder.
        { id: 'thread-draft', messages: [ospreyMessage('g3', 10, { labels: ['DRAFT'] })] },
        { id: 'thread-spam', messages: [ospreyMessage('g4', 11, { labels: ['SPAM'] })] },
      ],
    });
    gmailReader.source = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: NO_EXCLUSION });
  });

  const pass = async () => {
    const summary = await runOnce({
      tenantId: TENANT,
      db,
      provider: READER_MODE.FIXTURE,
      mirror: createFixtureAllowlistMirror(db),
    });
    if (summary.status !== 'ok') throw new Error(`pass skipped: ${summary.reason}`);
    return summary;
  };

  it('refuses the Google source no_consent before it asks Gmail for anything, and still reads the Graph sources', async () => {
    const summary = await pass();
    expect(summary.refused).toEqual(
      expect.arrayContaining([{ sourceId: googleSourceId, reason: 'no_consent' }]),
    );
    expect(summary.itemsRead).toBe(FIXTURE_ITEMS);
    expect(gmail.log).toEqual([]);
    // Each provider's pass is reported on its own.
    expect(summary.providers.map((p) => p.provider)).toEqual(['microsoft', 'google']);
    expect(summary.providers.find((p) => p.provider === 'google')).toMatchObject({
      sources: 1,
      refused: [{ sourceId: googleSourceId, reason: 'no_consent' }],
    });
  });

  it('persists both providers\' items once the owner consents, skipping draft and spam', async () => {
    const consent = await sessions.get('gina')!.rpc('mailbox_consent_grant');
    expect(consent.error).toBeNull();

    const summary = await pass();
    expect(summary.refused.filter((r) => r.sourceId === googleSourceId)).toEqual([]);
    // The worker resumes each source from its own checkpoint (#243): the Graph sources
    // finished their backfill on the pass above, so only the Gmail messages are read now
    // (the draft and the spam message are never fetched raw).
    expect(summary.itemsRead).toBe(2);
    expect(gmail.log.filter((l) => l.startsWith('raw:')).sort()).toEqual(['raw:g1', 'raw:g2']);
    expect(summary.candidates.map((c) => c.clusterKey)).toContain('codename:osprey');

    const { data: fromGoogle, error: googleError } = await db
      .from('source_item_sources')
      .select('provider_item_id')
      .eq('content_source_id', googleSourceId);
    expect(googleError).toBeNull();
    expect((fromGoogle ?? []).map((r) => r.provider_item_id as string).sort()).toEqual(['g1', 'g2']);
    // The Graph sources' items are still there beside them.
    const { data: graphSources } = await db
      .from('content_sources')
      .select('id')
      .eq('tenant_id', TENANT)
      .eq('provider', 'microsoft');
    const { count: fromGraph, error: graphError } = await db
      .from('source_item_sources')
      .select('*', { count: 'exact', head: true })
      .in('content_source_id', (graphSources ?? []).map((r) => r.id as string));
    expect(graphError).toBeNull();
    expect(fromGraph).toBeGreaterThan(0);
  });

  it('shows the Google candidate to its owner and the control room, and to nobody else', async () => {
    const names = async (persona: Persona) =>
      ((await listAs(persona)).body.candidates as Array<{ name: string }>).map((c) => c.name);
    expect(await names('gina')).toEqual(['Project Osprey']);
    expect(await names('cco')).toContain('Project Osprey');
    // Alice and the colleague hold Graph mail only: RLS gives them the Graph candidates, never Osprey.
    expect(await names('alice')).not.toContain('Project Osprey');
    expect(await names('colleague')).not.toContain('Project Osprey');
    expect(await names('bob')).toEqual([]);
    expect(await names('admin')).toEqual([]);
  });

  it('keeps the Graph candidates as they were: a second provider changes none of them', async () => {
    const { body } = await listAs('alice');
    expect(body.candidates.map((c: { name: string }) => c.name)).toEqual(['Project Falcon']);
    expect(body.candidates[0]).toMatchObject({ evidenceCount: 6, ownEvidenceCount: 5 });
  });

  it('stops reading the Google mailbox when its owner withdraws: the source is deleted, nothing is asked of Gmail', async () => {
    const { error } = await sessions.get('gina')!.rpc('mailbox_consent_withdraw');
    expect(error).toBeNull();
    const { data: gone } = await db.from('content_sources').select('id').eq('id', googleSourceId);
    expect(gone).toEqual([]);
    gmail.log.length = 0;
    const summary = await pass();
    expect(summary.refused.filter((r) => r.sourceId === googleSourceId)).toEqual([]);
    expect(gmail.log).toEqual([]);
    expect(((await listAs('gina')).body.candidates as unknown[]).length).toBe(0);
  });
});
