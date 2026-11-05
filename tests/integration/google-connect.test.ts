import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/*
 * Gmail inside #262's one-click opt-in, against a REAL database (#259 phase 4):
 *
 *   opt-in (POST /discovery/mailbox-consent, mailbox_consent_grant) creates the
 *   Google source and notifies the firm's admins -> the guard refuses
 *   not_in_provider_group until the member is in the group -> the worker reads
 *   -> the admin pauses -> the worker skips the source -> resume -> it reads.
 *   There is no separate connect step: the Gmail route only reports status.
 *
 * What is real: the route handlers, requireApiUserScoped, the RPCs, the guard,
 * the worker (runOnce) and Postgres. What is scripted: Gmail (fakeGmail behind
 * the real Gmail ContentSource) and how a handler obtains the caller's session.
 * Nothing contacts Google. Self-contained: a throwaway tenant, bank, firm admin,
 * director and one deal-team member; everything is deleted afterwards (audit
 * rows stay: audit_log is append-only, so a user who wrote one is suspended).
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

import { GET as googleStatus } from '@/app/api/v1/discovery/google-mailbox/route';
import { GET as consentStatus, POST as optIn } from '@/app/api/v1/discovery/mailbox-consent/route';
import { PATCH as setSourceStatus } from '@/app/api/v1/discovery/sources/[sourceId]/status/route';
import { READER_MODE } from '@/lib/constants/discovery';
import { createGmailMailContentSource } from '@/lib/google/reader/mail';
import { NO_EXCLUSION } from '../google/exclusion';
import { createFixtureAllowlistMirror } from '@/lib/mailboxAccess';
import { fakeGmail } from '../google/fakeGmail';
import { runOnce } from '../../worker/classify';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !secret || !publishable) {
  throw new Error(
    'The Gmail opt-in test needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and ' +
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (local `supabase start` stack).',
  );
}
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const TENANT = crypto.randomUUID();
const PASSWORD = `Connect-${RUN}-x9!`;
const DOMAIN = `gc-${RUN}.example`;
const GMAIL = `gina@${DOMAIN}`;
const GROUP = `conductia-ingest@${DOMAIN}`;

type Persona = 'director' | 'admin' | 'gina' | 'guest';
const users: Record<Persona, { id: string; email: string; firmRole: 'admin' | null; department: string }> = {
  director: { id: '', email: `gc-director-${RUN}@integration.conductia.dev`, firmRole: null, department: 'ib' },
  admin: { id: '', email: `gc-admin-${RUN}@integration.conductia.dev`, firmRole: 'admin', department: 'admin' },
  gina: { id: '', email: `gc-gina-${RUN}@integration.conductia.dev`, firmRole: null, department: 'ib' },
  // Seated, but on no deal: the one-click opt-in refuses them.
  guest: { id: '', email: `gc-guest-${RUN}@integration.conductia.dev`, firmRole: null, department: 'ib' },
};

let bankCompanyId = '';
let dealId = '';
let sourceId = '';
let previousFlag: { enabled: boolean } | null = null;
let previousWorkerFlag: { enabled: boolean } | null = null;
let previousMfa: string | undefined;
let gmail: ReturnType<typeof fakeGmail>;

async function setFlag(enabled: boolean, key = 'deal_discovery'): Promise<void> {
  const { error } = await db
    .from('feature_flags')
    .upsert({ key, description: `${key} (integration)`, enabled }, { onConflict: 'key' });
  if (error) throw new Error(`flag upsert failed: ${error.message}`);
}
// The status's health state reads the worker switch too (#341); runOnce itself does not, so passes run either way.
const WORKER_FLAG = 'discovery_worker_enabled';

const patch = (id: string, status: string) =>
  setSourceStatus(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ status }) }), {
    params: Promise.resolve({ sourceId: id }),
  });

const pass = async (mirrorOptions: { drop?: string[] } = {}) => {
  const summary = await runOnce({
    tenantId: TENANT,
    db,
    provider: READER_MODE.FIXTURE,
    mirror: createFixtureAllowlistMirror(db, mirrorOptions),
  });
  if (summary.status !== 'ok') throw new Error(`pass skipped: ${summary.reason}`);
  return summary;
};

beforeAll(async () => {
  previousMfa = process.env.MFA_ENFORCEMENT;
  process.env.MFA_ENFORCEMENT = 'invite_only';
  const { data: flagRow } = await db.from('feature_flags').select('enabled').eq('key', 'deal_discovery').maybeSingle();
  previousFlag = flagRow as { enabled: boolean } | null;
  await setFlag(true);
  const { data: workerRow } = await db.from('feature_flags').select('enabled').eq('key', WORKER_FLAG).maybeSingle();
  previousWorkerFlag = workerRow as { enabled: boolean } | null;
  await setFlag(true, WORKER_FLAG);

  for (const persona of Object.keys(users) as Persona[]) {
    const user = users[persona];
    const { data, error } = await db.auth.admin.createUser({
      email: user.email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { tenant_id: TENANT, department: user.department },
    });
    if (error || !data.user) throw new Error(`auth user create failed: ${error?.message}`);
    user.id = data.user.id;
    const { error: updateError } = await db
      .from('users')
      .update({ tenant_id: TENANT, status: 'active', firm_role: user.firmRole, is_external: false })
      .eq('id', user.id);
    if (updateError) throw new Error(`user claim failed: ${updateError.message}`);
    const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: signInError } = await client.auth.signInWithPassword({ email: user.email, password: PASSWORD });
    if (signInError) throw new Error(`sign-in failed for ${persona}: ${signInError.message}`);
    sessions.set(persona, client);
  }

  const company = await db
    .from('companies')
    .insert({ tenant_id: TENANT, name: `Connect Bank ${RUN}`, type: 'bank' })
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
  await seat('director', 'director');
  for (const persona of ['admin', 'gina', 'guest'] as const) await seat(persona, 'member');

  const registration = await db.from('google_reader_registrations').insert({
    tenant_id: TENANT,
    workspace_domain: DOMAIN,
    service_account_email: 'dwd-reader@proj-1.iam.gserviceaccount.com',
    client_id: '123456789012345678',
    directory_service_account_email: 'dir-reader@proj-1.iam.gserviceaccount.com',
    allowlist_group: GROUP,
    firm_company_id: bankCompanyId,
    status: 'active',
    consented_at: new Date().toISOString(),
  });
  if (registration.error) throw new Error(`google registration failed: ${registration.error.message}`);

  const invites = await db.from('invites').insert(
    (['gina', 'guest'] as const).map((persona) => ({
      tenant_id: TENANT,
      email: persona === 'gina' ? GMAIL : `guest@${DOMAIN}`,
      invited_by: users.director.id,
      company_id: bankCompanyId,
      company_role: 'member',
      status: 'accepted',
      delivery_status: 'sent',
      accepted_at: new Date().toISOString(),
      accepted_user_id: users[persona].id,
    })),
  );
  if (invites.error) throw new Error(`invites failed: ${invites.error.message}`);

  // Gina is on a deal as deal_team; the guest is on none.
  const deal = await db
    .from('deals')
    .insert({ tenant_id: TENANT, code: `GC-${RUN.toUpperCase()}`, codename: 'Project Connect', bank_id: bankCompanyId })
    .select('id')
    .single();
  if (deal.error) throw new Error(`deal failed: ${deal.error.message}`);
  dealId = deal.data.id as string;
  const role = await db.from('roles').select('id').eq('slug', 'deal_team').single();
  if (role.error) throw new Error(`role lookup failed: ${role.error.message}`);
  const membership = await db.from('deal_memberships').insert({
    deal_id: dealId,
    user_id: users.gina.id,
    role_id: role.data.id,
    deal_role: 'deal_team',
    added_by: users.director.id,
  });
  if (membership.error) throw new Error(`membership failed: ${membership.error.message}`);

  gmail = fakeGmail({
    address: GMAIL,
    threads: [
      {
        id: 'thread-osprey',
        messages: [
          {
            id: 'c1',
            internalDate: Date.parse('2026-03-02T09:00:00Z'),
            from: { name: 'Gina Park', address: GMAIL },
            to: [{ name: 'Casey Buyer', address: 'casey@osprey-capital.example' }],
            subject: 'Project Osprey: teaser draft',
            body: { contentType: 'text', content: 'Project Osprey teaser attached for the buyer group.' },
          },
        ],
      },
    ],
  });
  gmailReader.source = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: NO_EXCLUSION });
});

afterAll(async () => {
  if (previousMfa === undefined) delete process.env.MFA_ENFORCEMENT;
  else process.env.MFA_ENFORCEMENT = previousMfa;

  await db.from('deal_candidates').delete().eq('tenant_id', TENANT);
  await db.from('source_items').delete().eq('tenant_id', TENANT);
  await db.from('content_sources').delete().eq('tenant_id', TENANT);
  await db.from('google_reader_registrations').delete().eq('tenant_id', TENANT);
  await db.from('mailbox_allowlist_drift').delete().eq('tenant_id', TENANT);
  await db.from('notifications').delete().eq('tenant_id', TENANT);
  await db.from('deal_memberships').delete().eq('deal_id', dealId);
  if (dealId) await db.from('deals').delete().eq('id', dealId);
  await db.from('invites').delete().eq('tenant_id', TENANT);
  for (const client of sessions.values()) await client.auth.signOut();
  for (const user of Object.values(users).reverse()) {
    if (!user.id) continue;
    const { error } = await db.auth.admin.deleteUser(user.id);
    if (error) {
      await db.from('users').update({ status: 'suspended', company_id: null, company_role: null }).eq('id', user.id);
    }
  }
  if (bankCompanyId) await db.from('companies').delete().eq('id', bankCompanyId);

  if (previousFlag) await setFlag(previousFlag.enabled);
  else await db.from('feature_flags').delete().eq('key', 'deal_discovery');
  if (previousWorkerFlag) await setFlag(previousWorkerFlag.enabled, WORKER_FLAG);
  else await db.from('feature_flags').delete().eq('key', WORKER_FLAG);
});

const json = async (res: Response) => res.json();
const sourcesOf = async () =>
  (await db.from('content_sources').select('*', { count: 'exact', head: true }).eq('tenant_id', TENANT)).count;
const bellsOf = async () =>
  (await db.from('notifications').select('*', { count: 'exact', head: true }).eq('tenant_id', TENANT).eq('event_type', 'mailbox_connected'))
    .count;

describe('Gmail through the one-click opt-in (#259 phase 4, folded into #262)', () => {
  it('reports no Google mailbox to anyone before an opt-in', async () => {
    for (const persona of ['gina', 'guest'] as const) {
      actingAs = persona;
      expect(await json(await googleStatus())).toEqual({ connected: false });
    }
  });

  it('refuses the deal-less member with 403 not_eligible and creates no source', async () => {
    actingAs = 'guest';
    const res = await optIn();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_eligible' });
    expect(await sourcesOf()).toBe(0);
    expect(await bellsOf()).toBe(0);
  });

  it('opts gina in: a Google source she owns, develop\'s mailbox_connected to the firm admin, no access-change audit', async () => {
    actingAs = 'gina';
    const res = await optIn();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ consented: true, address: GMAIL });

    const { data: source } = await db.from('content_sources').select('*').eq('tenant_id', TENANT).single();
    expect(source).toMatchObject({
      provider: 'google',
      kind: 'mailbox',
      address: GMAIL,
      owner_user_id: users.gina.id,
      status: 'active',
    });
    sourceId = source!.id as string;
    // The opt-in's source takes the default window (#353). This story's mail is dated March 2026, so it reads the
    // whole mailbox, as the seed does.
    expect(source!.backfill_since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const { error: windowError } = await db.from('content_sources').update({ backfill_since: null }).eq('id', sourceId);
    if (windowError) throw new Error(`window reset failed: ${windowError.message}`);

    const { data: bell } = await db
      .from('notifications')
      .select('recipient_id, payload')
      .eq('tenant_id', TENANT)
      .eq('event_type', 'mailbox_connected');
    expect(bell).toEqual([
      { recipient_id: users.admin.id, payload: { address: GMAIL, outcome: 'created', provider: 'google', sourceId } },
    ]);

    const { data: audit } = await db
      .from('audit_log')
      .select('action, actor_id')
      .eq('tenant_id', TENANT)
      .in('action', ['discovery.mailbox_consented', 'discovery.mailbox_access_changed']);
    expect(audit).toEqual([{ action: 'discovery.mailbox_consented', actor_id: users.gina.id }]);
  });

  it('is idempotent: a second opt-in adds no source and no notification', async () => {
    actingAs = 'gina';
    expect((await optIn()).status).toBe(200);
    expect([await sourcesOf(), await bellsOf()]).toEqual([1, 1]);
  });

  it('reports the group to join, while the database verdict alone already says reading', async () => {
    actingAs = 'gina';
    expect(await json(await googleStatus())).toEqual({
      connected: true,
      address: GMAIL,
      group: GROUP,
      domain: DOMAIN,
      paused: false,
      waitingForGroup: false,
      // First-sync status (#341): connected, the reader on, and no pass yet.
      state: 'not_started',
      backfillCompletedAt: null,
      lastSyncedAt: null,
      delegationRefused: false,
    });
    // The card must not trust this alone: the group is not a database fact.
    expect(await json(await consentStatus())).toMatchObject({ consented: true, reading: true });
    actingAs = 'guest';
    expect(await json(await googleStatus())).toEqual({ connected: false });
  });

  it('refuses not_in_provider_group until the member is in the group, and the status says so', async () => {
    const summary = await pass({ drop: [GMAIL] });
    expect(summary.refused).toEqual(expect.arrayContaining([{ sourceId, reason: 'not_in_provider_group' }]));
    expect(gmail.log).toEqual([]);
    actingAs = 'gina';
    expect(await json(await googleStatus())).toMatchObject({ connected: true, waitingForGroup: true, paused: false });
  });

  it('reads once the member is in the group, and the refusal clears', async () => {
    const summary = await pass();
    expect(summary.refused.filter((r) => r.sourceId === sourceId)).toEqual([]);
    expect(gmail.log.filter((l) => l.startsWith('raw:'))).toEqual(['raw:c1']);
    actingAs = 'gina';
    const read = await json(await googleStatus());
    expect(read).toMatchObject({ connected: true, waitingForGroup: false, paused: false, delegationRefused: false });
    expect(read).not.toHaveProperty('itemsRead');
    expect(['reading', 'up_to_date']).toContain(read.state);
    expect(typeof read.lastSyncedAt).toBe('string');
  });

  it('lets only the firm admin pause: the owner and a colleague get 404, and nothing changes', async () => {
    for (const persona of ['gina', 'director', 'guest'] as const) {
      actingAs = persona;
      expect((await patch(sourceId, 'paused')).status).toBe(404);
    }
    const { data } = await db.from('content_sources').select('status').eq('id', sourceId).single();
    expect(data?.status).toBe('active');
  });

  it('skips a paused source on the next pass, keeps what was read, and audits the pause', async () => {
    actingAs = 'admin';
    const res = await patch(sourceId, 'paused');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: sourceId, status: 'paused', changed: true });

    gmail.log.length = 0;
    const summary = await pass();
    expect(gmail.log).toEqual([]);
    expect(summary.refused.filter((r) => r.sourceId === sourceId)).toEqual([]);
    const google = summary.providers.find((p) => p.provider === 'google');
    expect(google?.sources).toBe(0);

    // Provenance stays: the item read before the pause is still recorded.
    const { count } = await db
      .from('routing_ledger')
      .select('*', { count: 'exact', head: true })
      .eq('source_id', sourceId);
    expect(count).toBe(1);
    actingAs = 'gina';
    expect(await json(await googleStatus())).toMatchObject({ connected: true, paused: true });

    const { data: audit } = await db
      .from('audit_log')
      .select('actor_id, detail')
      .eq('tenant_id', TENANT)
      .eq('action', 'discovery.mailbox_access_changed');
    expect(audit).toHaveLength(1);
    expect(audit![0].actor_id).toBe(users.admin.id);
    expect(audit![0].detail).toMatchObject({ change: 'paused', provider: 'google', address: GMAIL, sourceId });
  });

  it('does not let the member resume a paused source by opting in again', async () => {
    actingAs = 'gina';
    expect((await optIn()).status).toBe(200);
    const { data } = await db.from('content_sources').select('status').eq('id', sourceId).single();
    expect(data?.status).toBe('paused');
  });

  it('reads again once the firm admin resumes', async () => {
    actingAs = 'admin';
    const res = await patch(sourceId, 'active');
    expect(await res.json()).toEqual({ id: sourceId, status: 'active', changed: true });
    gmail.log.length = 0;
    const summary = await pass();
    expect(summary.providers.find((p) => p.provider === 'google')?.sources).toBe(1);
    expect(gmail.log.length).toBeGreaterThan(0);
    actingAs = 'gina';
    expect(await json(await googleStatus())).toMatchObject({ connected: true, paused: false, waitingForGroup: false });
  });
});
