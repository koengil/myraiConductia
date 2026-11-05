import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/*
 * Deal discovery, phase 4: the worker resumes a backfill from its checkpoint,
 * against a REAL database, with the fixture reader standing in for Graph.
 *
 *   1. In process: the reader fails part-way through a mailbox (as a Graph
 *      outage would). The pages already read are stored and checkpointed; the
 *      rerun asks the reader only for what follows, and completes.
 *   2. A real kill: the worker CLI is SIGKILLed between two pages, then started
 *      again. The backfill completes, the first run's pages are not re-read
 *      (their ledger rows keep the first run's id), and nothing is duplicated.
 *   3. The queue: the pg-boss consumer over the migrated `pgboss` schema
 *      (migrate: false), logged in as the discovery_queue role, runs sync and
 *      discover jobs to the same result; that role cannot read or write
 *      audit_log; and discovery_worker_enabled off makes a sync do nothing.
 *   4. Routing is forward only: read newest first, a reply and an alias
 *      match stay unrouted. Their ledger rows keep the conversation and
 *      Internet message ids the eval counts them by.
 *   5. A different message that reuses a stored Internet message id is never
 *      merged: the stored text stays, its mailbox owns nothing, and its
 *      ledger row says id_collision with how far the two differ.
 *   6. A drive item listed more than once in a delta page gets one ledger
 *      row, its last sighting's, and the page is stored and checkpointed.
 *   7. A Gmail source (#259 phase 3), read through the real Gmail ContentSource
 *      over a replay: a worker killed between two pages resumes from the
 *      checkpoint; a job capped at one page resumes; a delta pass reads only
 *      what history.list names (two imports, then an un-spammed message); and a
 *      history id Gmail no longer holds resets the source, re-syncs without
 *      duplicates, and halts only when a reset would loop.
 *
 * Each case uses its own throwaway tenant and three throwaway owners. The
 * fixture corpus reads 17 sightings, stores 8 items, and proposes Falcon and
 * Cobra (see discovery-tracer.test.ts).
 *
 * Every read goes through the guard (#262), so each tenant is set up the way
 * the allowlist admits a mailbox: a bank company, a registration naming it and
 * the mail domain, an accepted invite per mailbox, and each owner's own opt-in
 * under their session. A site source is read once the tenant's firm admin has
 * registered it. A case that needs its own reader passes an inner reader
 * (readerFor); the worker wraps it in the guard like the real one.
 */

import { HISTORY_WINDOW_EXCEEDED, HISTORY_WINDOW_HALT_DAYS, READER_MODE } from '@/lib/constants/discovery';
import { parseCheckpoint, serializeCheckpoint, THREADS_PER_CHUNK } from '@/lib/google/reader/mail';
import type { ContentSource, SourceItemPage, SourceRow } from '@/lib/graph/reader';
import { FIXTURE_PAGE_SIZE } from '@/lib/graph/reader/fixture';
import { buildGmailTwin, STALE_HISTORY_ID, twinFileName } from '../../scripts/google/build-gmail-twin';
import type { SeedMessage } from '../../scripts/google/lib/seedFormat';
import { QUEUE } from '../../worker/boss';
import { createWorkerHandlers, runOnce, startWorker } from '../../worker/classify';
import { SYNC_ERROR } from '../../worker/sync';
import { fixtureMailboxes, innerFixtureReader } from '../discovery/fixtureInnerReader';
import { seatOnDeal } from './support/guardedTenant';
import { createUserProvisioned } from './support/provisioned';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !secret || !publishable) {
  throw new Error(
    'The discovery resume test needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and ' +
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (local stack).',
  );
}
const databaseUrl = process.env.DATABASE_URL;
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const PASSWORD = `Resume-${RUN}-x9!`;
const MAILBOXES = ['alex.chen@bank.example', 'morgan.vale@bank.example', 'storm.duncan@bank.example'];
const EXPECTED = { candidates: 2, items: 8, links: 8, visibility: 3, ledger: 17, proposedAudit: 2 };

type Tenant = {
  id: string;
  companyId: string;
  /** The mailbox owners, in MAILBOXES order, then the firm admin. */
  userIds: string[];
  adminId: string;
  sessions: SupabaseClient[];
  sourceIds: Map<string, string>;
};
const tenants: Tenant[] = [];

async function signInAs(email: string): Promise<SupabaseClient> {
  const client = createClient(url!, publishable!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}

async function createTenant(label: string): Promise<Tenant> {
  const id = crypto.randomUUID();
  const company = await db
    .from('companies')
    .insert({ tenant_id: id, name: `Resume Bank ${label} ${RUN}`, type: 'bank' })
    .select('id')
    .single();
  if (company.error) throw new Error(`bank company failed: ${company.error.message}`);
  const companyId = company.data.id as string;

  // The owners (the first seated as director: a company holds no member without
  // one), then the firm admin who registers sites.
  const people = [
    ...MAILBOXES.map((_, index) => ({ email: `dd-resume-${label}-${index}-${RUN}@integration.conductia.dev`, admin: false })),
    { email: `dd-resume-${label}-admin-${RUN}@integration.conductia.dev`, admin: true },
  ];
  const userIds: string[] = [];
  for (const [index, person] of people.entries()) {
    const { data, error } = await createUserProvisioned(db, {
      email: person.email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { tenant_id: id, department: person.admin ? 'admin' : 'ib' },
    });
    if (error || !data.user) throw new Error(`auth user create failed: ${error?.message}`);
    const { error: updateError } = await db
      .from('users')
      .update({
        tenant_id: id,
        status: 'active',
        is_external: false,
        firm_role: person.admin ? 'admin' : null,
        company_id: companyId,
        company_role: index === 0 ? 'director' : 'member',
      })
      .eq('id', data.user.id);
    if (updateError) throw new Error(`user claim failed: ${updateError.message}`);
    userIds.push(data.user.id);
  }
  const adminId = userIds[MAILBOXES.length];

  const { error: registrationError } = await db.from('graph_reader_registrations').insert({
    tenant_id: id,
    ms_tenant_id: 'fixture',
    client_id: 'fixture',
    status: 'active',
    mailbox_domains: ['bank.example'],
    firm_company_id: companyId,
  });
  if (registrationError) throw new Error(`registration failed: ${registrationError.message}`);

  // Accepted invites (email = the mailbox address), then each owner opts in
  // through their own signed-in session.
  const { error: inviteError } = await db.from('invites').insert(
    MAILBOXES.map((address, index) => ({
      tenant_id: id,
      email: address,
      invited_by: userIds[0],
      company_id: companyId,
      company_role: 'member',
      status: 'accepted',
      delivery_status: 'sent',
      accepted_at: new Date().toISOString(),
      accepted_user_id: userIds[index],
    })),
  );
  if (inviteError) throw new Error(`invites failed: ${inviteError.message}`);
  const sessions: SupabaseClient[] = [];
  for (const person of people) sessions.push(await signInAs(person.email));
  // The opt-in needs MD or deal team on a deal of the tenant (#262 round 3, A2).
  await seatOnDeal(db, {
    tenantId: id,
    bankId: companyId,
    code: `DD-RESUME-${label}-${RUN}`,
    userIds: userIds.slice(0, MAILBOXES.length),
  });
  for (const session of sessions.slice(0, MAILBOXES.length)) {
    const { error } = await session.rpc('mailbox_consent_grant');
    if (error) throw new Error(`consent failed: ${error.message}`);
  }

  // Each opt-in created its owner's mailbox source (C20): read them back instead of inserting a second row.
  const { data: sources, error: sourceError } = await db
    .from('content_sources')
    .select('id, address, owner_user_id')
    .eq('tenant_id', id)
    .eq('kind', 'mailbox');
  if (sourceError) throw new Error(`content sources failed: ${sourceError.message}`);
  MAILBOXES.forEach((address, index) => {
    const row = (sources ?? []).find((source) => source.address === address);
    if (row?.owner_user_id !== userIds[index]) throw new Error(`the opt-in did not create ${address}'s source for its owner`);
  });
  const tenant: Tenant = {
    id,
    companyId,
    userIds,
    adminId,
    sessions,
    sourceIds: new Map((sources ?? []).map((row) => [row.address as string, row.id as string])),
  };
  tenants.push(tenant);
  return tenant;
}

/** A SharePoint site source, registered by the tenant's firm admin so the site guard admits it (R23). */
async function addSite(tenant: Tenant, label: string): Promise<string> {
  const address = `bank.sharepoint.com:/sites/dd-${label}-${RUN}`;
  const { data: site, error } = await db
    .from('content_sources')
    .insert({ tenant_id: tenant.id, kind: 'sharepoint_site', address, owner_user_id: tenant.userIds[2] })
    .select('id')
    .single();
  if (error) throw new Error(`site source failed: ${error.message}`);
  const admin = tenant.sessions[MAILBOXES.length];
  const { error: registerError } = await admin.rpc('site_register', { p_address: address });
  if (registerError) throw new Error(`site registration failed: ${registerError.message}`);
  return site.id as string;
}

let previousDiscoveryFlag: { enabled: boolean } | null = null;

beforeAll(async () => {
  // deal_discovery off means the worker reads nothing (#262).
  const { data } = await db.from('feature_flags').select('enabled').eq('key', 'deal_discovery').maybeSingle();
  previousDiscoveryFlag = data as { enabled: boolean } | null;
  const { error } = await db
    .from('feature_flags')
    .upsert({ key: 'deal_discovery', description: 'deal discovery (integration)', enabled: true }, { onConflict: 'key' });
  if (error) throw new Error(`flag upsert failed: ${error.message}`);
});

type CountQuery = ReturnType<ReturnType<typeof db.from>['select']>;

async function counts(tenantId: string) {
  const exact = async (table: string, filter: (q: CountQuery) => CountQuery) => {
    const { count, error } = await filter(db.from(table).select('*', { count: 'exact', head: true }));
    if (error) throw new Error(`${table} count failed: ${error.message}`);
    return count ?? 0;
  };
  const { data: candidates } = await db.from('deal_candidates').select('id').eq('tenant_id', tenantId);
  const ids = (candidates ?? []).map((c) => c.id as string);
  const { data: sources } = await db.from('content_sources').select('id').eq('tenant_id', tenantId);
  const sourceIds = (sources ?? []).map((s) => s.id as string);
  return {
    candidates: ids.length,
    items: await exact('source_items', (q) => q.eq('tenant_id', tenantId)),
    links: ids.length ? await exact('evidence_links', (q) => q.in('candidate_id', ids)) : 0,
    visibility: ids.length ? await exact('candidate_visibility', (q) => q.in('candidate_id', ids)) : 0,
    ledger: await exact('routing_ledger', (q) => q.in('source_id', sourceIds)),
    proposedAudit: await exact('audit_log', (q) =>
      q.eq('tenant_id', tenantId).eq('action', 'discovery.candidate_proposed'),
    ),
  };
}

type SourceState = { delta_checkpoint: string | null; backfill_completed_at: string | null; last_error: string | null };

async function sourceState(sourceId: string): Promise<SourceState> {
  const { data, error } = await db
    .from('content_sources')
    .select('delta_checkpoint, backfill_completed_at, last_error')
    .eq('id', sourceId)
    .single();
  if (error) throw new Error(`source read failed: ${error.message}`);
  return data as SourceState;
}

afterAll(async () => {
  for (const tenant of tenants) {
    await db.from('deal_candidates').delete().eq('tenant_id', tenant.id);
    await db.from('source_items').delete().eq('tenant_id', tenant.id);
    // A registration with sources cannot be deleted (on delete restrict): sources first.
    await db.from('content_sources').delete().eq('tenant_id', tenant.id);
    await db.from('graph_reader_registrations').delete().eq('tenant_id', tenant.id);
    await db.from('google_reader_registrations').delete().eq('tenant_id', tenant.id);
    await db.from('mailbox_allowlist_drift').delete().eq('tenant_id', tenant.id);
    await db.from('mailbox_guard_state').delete().eq('tenant_id', tenant.id);
    await db.from('notifications').delete().eq('tenant_id', tenant.id);
    // Invites take their consents with them, and must go before the users they name.
    await db.from('invites').delete().eq('tenant_id', tenant.id);
    // The deal references the bank company; its memberships go with it.
    await db.from('deals').delete().eq('tenant_id', tenant.id);
    for (const session of tenant.sessions) await session.auth.signOut();
    // Members before the director. A user who wrote a user-actor audit row (a
    // consent, a site registration) cannot be deleted: suspend and unseat them.
    for (const id of [...tenant.userIds].reverse()) {
      const { error } = await db.auth.admin.deleteUser(id);
      if (error) await db.from('users').update({ status: 'suspended', company_id: null, company_role: null }).eq('id', id);
    }
    // registered_sites is append-only and keeps a company with a site alive.
    await db.from('companies').delete().eq('id', tenant.companyId);
  }
  if (previousDiscoveryFlag) {
    await db.from('feature_flags').update({ enabled: previousDiscoveryFlag.enabled }).eq('key', 'deal_discovery');
  } else {
    await db.from('feature_flags').delete().eq('key', 'deal_discovery');
  }
});

/** A reader that records what it is asked for, counts the pages it serves, and can fail on a page. */
function recordingReader(options: { failOnPage?: { address: string; page: number } } = {}) {
  const fixture = innerFixtureReader();
  const calls: Array<{ address: string; method: 'backfill' | 'delta'; checkpoint: string | null }> = [];
  const served = new Map<string, number>();
  const wrap = (address: string, pages: AsyncIterable<SourceItemPage>): AsyncIterable<SourceItemPage> => ({
    async *[Symbol.asyncIterator]() {
      for await (const page of pages) {
        const n = (served.get(address) ?? 0) + 1;
        if (options.failOnPage && options.failOnPage.address === address && options.failOnPage.page === n) {
          throw new Error('fixture reader: simulated Graph outage');
        }
        served.set(address, n);
        yield page;
      }
    },
  });
  const reader: ContentSource = {
    kind: fixture.kind,
    backfill(source: SourceRow, checkpoint) {
      calls.push({ address: source.address, method: 'backfill', checkpoint });
      return wrap(source.address, fixture.backfill(source, checkpoint));
    },
    delta(source: SourceRow, token) {
      calls.push({ address: source.address, method: 'delta', checkpoint: token });
      return wrap(source.address, fixture.delta(source, token));
    },
  };
  return { reader, calls, served };
}

describe('discovery backfill resumes from its checkpoint', () => {
  let tenant: Tenant;
  beforeAll(async () => {
    tenant = await createTenant('inproc');
  });

  it('stores and checkpoints the pages read before a failure, and nothing after it', async () => {
    const { reader } = recordingReader({ failOnPage: { address: 'morgan.vale@bank.example', page: 2 } });
    await expect(
      runOnce({ tenantId: tenant.id, db, provider: READER_MODE.FIXTURE, readerFor: () => reader }),
    ).rejects.toThrow('simulated Graph outage');

    const alex = await sourceState(tenant.sourceIds.get('alex.chen@bank.example')!);
    expect(alex.delta_checkpoint).toBe('fixture:3');
    expect(alex.backfill_completed_at).not.toBeNull();

    const morgan = await sourceState(tenant.sourceIds.get('morgan.vale@bank.example')!);
    expect(morgan.delta_checkpoint).toBe(`fixture:${FIXTURE_PAGE_SIZE}`);
    expect(morgan.backfill_completed_at).toBeNull();
    // A non-Graph failure is recorded as a fixed code, never its message.
    expect(morgan.last_error).toBe(SYNC_ERROR.WORKER);

    const storm = await sourceState(tenant.sourceIds.get('storm.duncan@bank.example')!);
    expect(storm.delta_checkpoint).toBeNull();

    // Morgan's first page (Falcon x3, Cobra x1) is stored; clustering has not run.
    const partial = await counts(tenant.id);
    expect(partial).toMatchObject({ candidates: 0, items: 4, ledger: 3 + FIXTURE_PAGE_SIZE });
  });

  it('asks the reader only for what follows each checkpoint, and completes', async () => {
    const { reader, calls, served } = recordingReader();
    const summary = await runOnce({ tenantId: tenant.id, db, provider: READER_MODE.FIXTURE, readerFor: () => reader });

    expect(calls).toEqual([
      { address: 'alex.chen@bank.example', method: 'delta', checkpoint: 'fixture:3' },
      { address: 'morgan.vale@bank.example', method: 'backfill', checkpoint: `fixture:${FIXTURE_PAGE_SIZE}` },
      { address: 'storm.duncan@bank.example', method: 'backfill', checkpoint: null },
    ]);
    expect(served.get('alex.chen@bank.example') ?? 0).toBe(0);
    expect(served.get('morgan.vale@bank.example')).toBe(1);
    expect(served.get('storm.duncan@bank.example')).toBe(2);
    // 2 of Morgan's, 8 of Storm's: the 7 read before the failure are not read again.
    expect(summary.status === 'ok' && summary.itemsRead).toBe(10);

    expect(await counts(tenant.id)).toEqual(EXPECTED);
    const morgan = await sourceState(tenant.sourceIds.get('morgan.vale@bank.example')!);
    expect(morgan).toMatchObject({ delta_checkpoint: 'fixture:6', last_error: null });
    expect(morgan.backfill_completed_at).not.toBeNull();
  });

  it('reads nothing on the next run and duplicates nothing', async () => {
    const { reader, served } = recordingReader();
    const summary = await runOnce({ tenantId: tenant.id, db, provider: READER_MODE.FIXTURE, readerFor: () => reader });
    expect(summary.status === 'ok' && summary.itemsRead).toBe(0);
    expect([...served.values()].reduce((a, b) => a + b, 0)).toBe(0);
    expect(summary.status === 'ok' && summary.candidates.every((c) => !c.created)).toBe(true);
    expect(await counts(tenant.id)).toEqual(EXPECTED);
  });
});

describe('a backfill whose owner withdraws part-way (#262 on #243)', () => {
  it('stops at the page in flight, deletes the source, records no sync error, and reads afresh on re-consent', async () => {
    const tenant = await createTenant('withdraw');
    const MORGAN = 'morgan.vale@bank.example';
    const morganSession = tenant.sessions[1];
    const fixture = innerFixtureReader();
    let withdrawn = false;
    // Morgan withdraws while their first page is in flight: the guard admitted
    // that page, and asks again before the second.
    const reader: ContentSource = {
      kind: fixture.kind,
      backfill: (source, checkpoint) => ({
        async *[Symbol.asyncIterator]() {
          for await (const page of fixture.backfill(source, checkpoint)) {
            if (source.address === MORGAN && !withdrawn) {
              withdrawn = true;
              const { error } = await morganSession.rpc('mailbox_consent_withdraw');
              if (error) throw new Error(`withdraw failed: ${error.message}`);
            }
            yield page;
          }
        },
      }),
      delta: (source, token) => fixture.delta(source, token),
    };

    // The withdrawal deletes Morgan's source (#461). The page in flight lands on no source: its provenance is
    // refused as for an archived source, so the source is skipped, not failed, and the pass reads the others.
    const morganId = tenant.sourceIds.get(MORGAN)!;
    const summary = await runOnce({ tenantId: tenant.id, db, provider: READER_MODE.FIXTURE, readerFor: () => reader });
    expect(summary.status === 'ok' && summary.refused).toEqual([]);
    expect(summary.status === 'ok' && summary.skipped).toEqual([{ sourceId: morganId, kind: 'mailbox', reason: 'source_archived' }]);
    const { data: gone } = await db.from('content_sources').select('id').eq('id', morganId);
    expect(gone).toEqual([]);
    for (const address of [MAILBOXES[0], MAILBOXES[2]]) {
      expect((await sourceState(tenant.sourceIds.get(address)!)).backfill_completed_at).not.toBeNull();
    }

    // A re-consent creates a fresh source, read from the start.
    const { error: reconsent } = await morganSession.rpc('mailbox_consent_grant');
    expect(reconsent).toBeNull();
    const { reader: recording, calls } = recordingReader();
    const resumed = await runOnce({ tenantId: tenant.id, db, provider: READER_MODE.FIXTURE, readerFor: () => recording });
    expect(resumed.status === 'ok' && resumed.refused).toEqual([]);
    expect(calls).toContainEqual({ address: MORGAN, method: 'backfill', checkpoint: null });
    expect(await counts(tenant.id)).toEqual(EXPECTED);
  });
});

function runWorker(tenantId: string, env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'worker/classify.ts', '--tenant', tenantId], {
    cwd: process.cwd(),
    env: { ...process.env, GRAPH_READER_PROVIDER: 'fixture', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, output: () => output };
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('a worker killed mid-backfill resumes when restarted', () => {
  it('completes after SIGKILL between two pages, without re-reading or duplicating', async () => {
    const tenant = await createTenant('kill');
    const morganId = tenant.sourceIds.get('morgan.vale@bank.example')!;

    // Slow pages, so the kill lands between Morgan's first and second page.
    const first = runWorker(tenant.id, { DISCOVERY_FIXTURE_PAGE_DELAY_MS: '1500' });
    await waitFor(async () => {
      const state = await sourceState(morganId);
      return state.delta_checkpoint === `fixture:${FIXTURE_PAGE_SIZE}` ? state : null;
    }, 60_000);
    first.child.kill('SIGKILL');
    await first.exited;

    const killed = await sourceState(morganId);
    expect(killed.delta_checkpoint).toBe(`fixture:${FIXTURE_PAGE_SIZE}`);
    expect(killed.backfill_completed_at).toBeNull();
    expect((await sourceState(tenant.sourceIds.get('storm.duncan@bank.example')!)).delta_checkpoint).toBeNull();
    expect((await counts(tenant.id)).candidates).toBe(0);

    const { data: firstRun } = await db
      .from('routing_ledger')
      .select('run_id')
      .eq('source_id', morganId)
      .limit(1)
      .single();

    const second = runWorker(tenant.id, {});
    const code = await second.exited;
    expect(code, second.output()).toBe(0);

    expect(await counts(tenant.id)).toEqual(EXPECTED);
    // Morgan's first page was not read again: its rows keep the first run's id.
    const { data: morganRows } = await db
      .from('routing_ledger')
      .select('provider_item_id, run_id')
      .eq('source_id', morganId)
      .order('provider_item_id');
    const firstPage = (morganRows ?? []).slice(0, FIXTURE_PAGE_SIZE);
    const rest = (morganRows ?? []).slice(FIXTURE_PAGE_SIZE);
    expect(firstPage.every((row) => row.run_id === firstRun!.run_id)).toBe(true);
    expect(rest.length).toBe(2);
    expect(rest.every((row) => row.run_id !== firstRun!.run_id)).toBe(true);
  }, 120_000);
});

function psql(connection: string, sql: string): string {
  return execFileSync('psql', [connection, '-v', 'ON_ERROR_STOP=1', '-Atc', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe.skipIf(!databaseUrl)('the pg-boss consumer over the migrated queue schema', () => {
  let previousFlag: { enabled: boolean } | null = null;
  // The worker's queue connection, as the runbook configures it: the
  // discovery_queue role (20260925160000), never the table owner. The role has
  // no password until an operator sets one; the test sets a throwaway one.
  let queueUrl = '';

  async function setWorkerFlag(enabled: boolean) {
    const { error } = await db
      .from('feature_flags')
      .upsert({ key: 'discovery_worker_enabled', description: 'discovery worker (integration)', enabled }, { onConflict: 'key' });
    if (error) throw new Error(`flag upsert failed: ${error.message}`);
  }

  beforeAll(async () => {
    const { data } = await db.from('feature_flags').select('enabled').eq('key', 'discovery_worker_enabled').maybeSingle();
    previousFlag = data as { enabled: boolean } | null;
    const password = `dq${RUN}${crypto.randomUUID().replace(/-/g, '')}`;
    psql(databaseUrl!, `alter role discovery_queue with password '${password}'`);
    const url = new URL(databaseUrl!);
    url.username = 'discovery_queue';
    url.password = password;
    queueUrl = url.toString();
  });

  afterAll(async () => {
    psql(databaseUrl!, 'alter role discovery_queue with password null');
    if (previousFlag) await setWorkerFlag(previousFlag.enabled);
    else await db.from('feature_flags').delete().eq('key', 'discovery_worker_enabled');
  });

  it('connects as discovery_queue, which cannot read or write audit_log or disable its triggers', () => {
    expect(psql(queueUrl, 'select current_user').trim()).toBe('discovery_queue');
    for (const sql of [
      'select 1 from public.audit_log limit 1',
      "insert into public.audit_log (action, detail) values ('view', '{}')",
      "update public.audit_log set detail = '{}' where false",
      'delete from public.audit_log where false',
      'truncate public.audit_log',
      'alter table public.audit_log disable trigger all',
    ]) {
      expect(() => psql(queueUrl, sql), sql).toThrow(/permission denied|must be owner/);
    }
  });

  it('does nothing while discovery_worker_enabled is off', async () => {
    const tenant = await createTenant('flagoff');
    await setWorkerFlag(false);
    const sent: unknown[] = [];
    const handlers = createWorkerHandlers({
      db,
      boss: { send: async (...args: unknown[]) => (sent.push(args), 'job') } as never,
      provider: READER_MODE.FIXTURE,
    });
    expect(await handlers.tick()).toEqual({ queued: 0 });
    const result = await handlers.sync({ tenantId: tenant.id, sourceId: tenant.sourceIds.get('storm.duncan@bank.example')! });
    expect(result).toEqual({ status: 'disabled' });
    expect(sent).toEqual([]);
    expect(await counts(tenant.id)).toMatchObject({ items: 0, ledger: 0 });
  });

  it('runs sync and discover jobs to the same result as discovery_queue', async () => {
    const tenant = await createTenant('boss');
    await setWorkerFlag(true);
    const worker = await startWorker({
      db,
      connectionString: queueUrl,
      provider: READER_MODE.FIXTURE,
      schedule: false,
    });
    try {
      for (const sourceId of tenant.sourceIds.values()) {
        await worker.boss.send(QUEUE.SYNC, { tenantId: tenant.id, sourceId }, { singletonKey: sourceId });
      }
      await waitFor(async () => {
        const c = await counts(tenant.id);
        return c.candidates === EXPECTED.candidates && c.visibility === EXPECTED.visibility ? c : null;
      }, 60_000);
      // Let any discover job still queued finish, then check nothing doubled.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(await counts(tenant.id)).toEqual(EXPECTED);
      for (const sourceId of tenant.sourceIds.values()) {
        expect((await sourceState(sourceId)).backfill_completed_at).not.toBeNull();
      }
    } finally {
      await worker.stop();
    }
  }, 90_000);

  // #344, design R13: pg-boss serializes a thrown handler error into pgboss.job.output and keeps it for
  // 7 days. A failed sync leaves only its fixed code there, never the PostgREST message it caught.
  it('leaves only the fixed code in pgboss.job.output when a sync job fails', async () => {
    const tenant = await createTenant('jobfail');
    await setWorkerFlag(true);
    const canary = `canary-${RUN}`;
    const failing = (): AsyncIterable<SourceItemPage> => ({
      async *[Symbol.asyncIterator]() {
        throw Object.assign(
          new Error(`discovery persist: source_items insert failed: Key (internet_message_id)=(<${canary}@buyer.example>) already exists`),
          { details: `${canary} details`, hint: `${canary} hint`, code: '23505' },
        );
      },
    });
    const reader: ContentSource = { kind: 'mailbox', backfill: failing, delta: failing };
    const sourceId = tenant.sourceIds.get('alex.chen@bank.example')!;
    const worker = await startWorker({
      db,
      connectionString: queueUrl,
      provider: READER_MODE.FIXTURE,
      schedule: false,
      readerFor: () => reader,
    });
    try {
      await worker.boss.send(QUEUE.SYNC, { tenantId: tenant.id, sourceId }, { singletonKey: sourceId });
      const output = await waitFor(async () => {
        const raw = psql(
          databaseUrl!,
          `select output::text from pgboss.job where name = '${QUEUE.SYNC}' and singleton_key = '${sourceId}' and output is not null limit 1`,
        ).trim();
        return raw === '' ? null : raw;
      }, 60_000);
      expect(JSON.parse(output)).toMatchObject({ name: 'WorkerJobError', message: SYNC_ERROR.DATABASE });
      expect(output).not.toContain(canary);
      expect(output).not.toContain('buyer.example');
      // The admin's last_error is the same code.
      expect((await sourceState(sourceId)).last_error).toBe(SYNC_ERROR.DATABASE);
    } finally {
      await worker.stop();
      // The job waits for its retry: remove it, so no later worker picks it up.
      psql(databaseUrl!, `delete from pgboss.job where name = '${QUEUE.SYNC}' and singleton_key = '${sourceId}'`);
    }
  }, 90_000);

  // C6: proof by configuration. pg-boss's supervision of a stale heartbeat is not re-tested (it needs over two minutes).
  it('gives an existing discovery.sync queue, and the jobs sent to it, the heartbeat, as discovery_queue', async () => {
    psql(databaseUrl!, "update pgboss.queue set heartbeat_seconds = null where name = 'discovery.sync'");
    const worker = await startWorker({ db, connectionString: queueUrl, provider: READER_MODE.FIXTURE, schedule: false });
    try {
      expect(psql(databaseUrl!, "select heartbeat_seconds from pgboss.queue where name = 'discovery.sync'").trim()).toBe('120');
      await setWorkerFlag(false);
      const id = await worker.boss.send(QUEUE.SYNC, { tenantId: crypto.randomUUID(), sourceId: crypto.randomUUID() });
      expect(psql(databaseUrl!, `select heartbeat_seconds from pgboss.job where id = '${id}'`).trim()).toBe('120');
    } finally {
      await worker.stop();
    }
  }, 60_000);
});

// C8 / C28: the fixture reader serves mailboxes only. A registered site source beside them is skipped and
// reported, and the mailboxes on either side of it (sources sort by address) are still read in full.
describe('a SharePoint site source under the fixture reader', () => {
  it('is skipped and reported, and the mailboxes are still read', async () => {
    const tenant = await createTenant('fixture-site');
    const siteId = await addSite(tenant, 'fixture-site');

    const summary = await runOnce({ tenantId: tenant.id, db, provider: READER_MODE.FIXTURE });
    if (summary.status !== 'ok') throw new Error('unreachable');
    expect(summary.skipped).toEqual([{ sourceId: siteId, kind: 'sharepoint_site', reason: 'unsupported_reader' }]);
    expect(summary.refused).toEqual([]);
    expect(summary.sources).toBe(4);
    expect(summary.itemsRead).toBe(17);
    expect(await counts(tenant.id)).toMatchObject(EXPECTED);
    // Nothing of the site was read or recorded against it.
    expect((await sourceState(siteId)).delta_checkpoint).toBeNull();
  });
});

describe('a SharePoint site source', () => {
  it('stores routed documents by drive item, ledgers skipped ones, and reruns without duplicates', async () => {
    const tenant = await createTenant('site');
    const site = { id: await addSite(tenant, 'site') };

    const fixture = innerFixtureReader();
    const sitePages: SourceItemPage[] = [
      {
        items: [],
        documents: [
          {
            driveItemKey: 'D1:cim',
            providerItemId: 'cim',
            name: 'Falcon CIM.docx',
            drivePath: '/Deals/Falcon CIM.docx',
            lastModifiedDateTime: '2026-02-21T10:00:00Z',
            authors: [{ address: 'storm.duncan@bank.example', name: 'Storm Duncan' }],
            text: 'Project Falcon confidential information memorandum, draft 3.',
            cTag: 'c1',
          },
          {
            driveItemKey: 'D1:menu',
            providerItemId: 'menu',
            name: 'Canteen menu.docx',
            drivePath: '/Canteen menu.docx',
            lastModifiedDateTime: '2026-02-21T10:00:00Z',
            authors: [],
            text: 'Soup of the day.',
            cTag: 'c2',
          },
        ],
        skipped: [{ providerItemId: 'org', itemHash: 'h-org', reason: 'image_only' }],
        nextCheckpoint: 'site:1',
      },
    ];
    const siteReader: ContentSource = {
      kind: 'sharepoint_site',
      async *backfill(_source, checkpoint) {
        if (checkpoint === null) yield* sitePages;
      },
      async *delta() {},
    };
    const readerFor = (source: SourceRow) => (source.kind === 'sharepoint_site' ? siteReader : fixture);

    await runOnce({ tenantId: tenant.id, db, provider: READER_MODE.FIXTURE, readerFor });
    await runOnce({ tenantId: tenant.id, db, provider: READER_MODE.FIXTURE, readerFor });

    const { data: docs } = await db
      .from('source_items')
      .select('id, kind, subject, drive_item_key, drive_path, internet_message_id')
      .eq('tenant_id', tenant.id)
      .eq('kind', 'document');
    expect(docs).toEqual([
      {
        id: expect.any(String),
        kind: 'document',
        subject: 'Falcon CIM.docx',
        drive_item_key: 'D1:cim',
        drive_path: '/Deals/Falcon CIM.docx',
        internet_message_id: null,
      },
    ]);
    const { data: ledger } = await db
      .from('routing_ledger')
      .select('provider_item_id, decision, method, skip_reason, conversation_id, internet_message_id')
      .eq('source_id', site!.id)
      .order('provider_item_id');
    // A document has no thread, so even unrouted it keeps no thread ids.
    const none = { conversation_id: null, internet_message_id: null };
    expect(ledger).toEqual([
      { provider_item_id: 'cim', decision: 'routed', method: 'codename', skip_reason: null, ...none },
      { provider_item_id: 'menu', decision: 'unrouted', method: null, skip_reason: null, ...none },
      { provider_item_id: 'org', decision: 'skipped', method: null, skip_reason: 'image_only', ...none },
    ]);

    // The CIM is Falcon evidence beside the mail, and its owner sees Falcon.
    const { data: falcon } = await db
      .from('deal_candidates')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('cluster_key', 'codename:falcon')
      .single();
    const { count: cimLinks } = await db
      .from('evidence_links')
      .select('*', { count: 'exact', head: true })
      .eq('candidate_id', falcon!.id)
      .eq('source_item_id', docs![0].id);
    expect(cimLinks).toBe(1);
    expect(await counts(tenant.id)).toMatchObject({ candidates: 2, items: 9, links: 9, ledger: 20, proposedAudit: 2 });
  });
});

describe('a delta page that lists the same drive item more than once', () => {
  // Graph can list one driveItem twice in a delta page. Every sighting of it
  // is a ledger row on (source_id, provider_item_id), and one upsert that
  // touches the same row twice is rejected by Postgres, so the page (and
  // every retry of it) used to fail. The last sighting's row wins.

  /** Runs one tenant whose site source serves `pages`; returns the site's state and ledger. */
  async function runSite(label: string, pages: SourceItemPage[]) {
    const tenant = await createTenant(label);
    const site = { id: await addSite(tenant, label) };
    const fixture = innerFixtureReader();
    const siteReader: ContentSource = {
      kind: 'sharepoint_site',
      async *backfill(_source, checkpoint) {
        if (checkpoint === null) yield* pages;
      },
      async *delta() {},
    };
    const readerFor = (source: SourceRow) => (source.kind === 'sharepoint_site' ? siteReader : fixture);

    await runOnce({ tenantId: tenant.id, db, provider: READER_MODE.FIXTURE, readerFor });

    const { data: ledger } = await db
      .from('routing_ledger')
      .select('provider_item_id, item_hash, decision, skip_reason')
      .eq('source_id', site!.id)
      .order('provider_item_id');
    return { state: await sourceState(site!.id), ledger };
  }

  it('ledgers a skipped item listed twice once, with the last sighting', async () => {
    const { state, ledger } = await runSite('twice', [
      {
        items: [],
        skipped: [
          { providerItemId: 'org', itemHash: 'h-org-1', reason: 'image_only' },
          { providerItemId: 'org', itemHash: 'h-org-2', reason: 'image_only' },
        ],
        nextCheckpoint: 'site:1',
      },
    ]);
    expect(state).toMatchObject({ delta_checkpoint: 'site:1', last_error: null });
    expect(state.backfill_completed_at).not.toBeNull();
    expect(ledger).toEqual([{ provider_item_id: 'org', item_hash: 'h-org-2', decision: 'skipped', skip_reason: 'image_only' }]);
  });

  it('ledgers a skipped row and a collision row for the same item once', async () => {
    const memo = (text: string, cTag: string) => ({
      driveItemKey: 'D1:memo',
      providerItemId: 'memo',
      name: 'Falcon memo.docx',
      drivePath: '/Deals/Falcon memo.docx',
      lastModifiedDateTime: '2026-02-21T10:00:00Z',
      authors: [{ address: 'storm.duncan@bank.example', name: 'Storm Duncan' }],
      text,
      cTag,
    });
    // The item listed three times: read with one text, read again with
    // another (a collision in the page), then skipped.
    const { state, ledger } = await runSite('relist', [
      {
        items: [],
        documents: [memo('Project Falcon memo, draft 1.', 'c1'), memo('Project Falcon memo, draft 2 with the fee.', 'c2')],
        skipped: [{ providerItemId: 'memo', itemHash: 'h-memo', reason: 'extraction_timeout' }],
        nextCheckpoint: 'site:1',
      },
    ]);
    expect(state).toMatchObject({ delta_checkpoint: 'site:1', last_error: null });
    expect(state.backfill_completed_at).not.toBeNull();
    expect(ledger).toEqual([
      { provider_item_id: 'memo', item_hash: expect.any(String), decision: 'skipped', skip_reason: 'id_collision' },
    ]);
  });
});

describe('a reply read before the message that names the codename', () => {
  const STORM = 'storm.duncan@bank.example';
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** Storm's mailbox alone, one message per page, in the given order. */
  function stormReader(order: 'forward' | 'reversed'): ContentSource {
    const storm = fixtureMailboxes().find((m) => m.mailbox === STORM)!;
    const dir = mkdtempSync(join(tmpdir(), `dd-${order}-`));
    dirs.push(dir);
    const messages = order === 'forward' ? storm.messages : [...storm.messages].reverse();
    writeFileSync(join(dir, 'mailbox-storm.json'), JSON.stringify({ ...storm, messages }));
    return innerFixtureReader({ dir, pageSize: 1 });
  }

  async function read(order: 'forward' | 'reversed') {
    const tenant = await createTenant(order);
    const reader = stormReader(order);
    await runOnce({ tenantId: tenant.id, db, provider: READER_MODE.FIXTURE, readerFor: () => reader });
    const { data: stored } = await db
      .from('source_items')
      .select('internet_message_id, conversation_id')
      .eq('tenant_id', tenant.id);
    const { data: ledger } = await db
      .from('routing_ledger')
      .select('provider_item_id, decision, conversation_id, internet_message_id')
      .eq('source_id', tenant.sourceIds.get(STORM)!);
    return {
      stored: (stored ?? []) as Array<{ internet_message_id: string; conversation_id: string | null }>,
      ledger: (ledger ?? []) as Array<{
        provider_item_id: string;
        decision: string;
        conversation_id: string | null;
        internet_message_id: string | null;
      }>,
    };
  }

  it('stays unrouted, and its ledger row keeps the ids the eval counts it by', async () => {
    const forward = await read('forward');
    const reversed = await read('reversed');

    // Thread ids on every unrouted message, and only there. Identifiers, not text.
    for (const run of [forward, reversed]) {
      for (const row of run.ledger) {
        if (row.decision === 'unrouted') {
          expect(row.conversation_id).toMatch(/^conv-/);
          expect(row.internet_message_id).toMatch(/^<.+@.+>$/);
        } else {
          expect(row).toMatchObject({ conversation_id: null, internet_message_id: null });
        }
      }
    }

    // Reading newest first loses two Falcon items the forward read routes: a
    // reply that routed on its thread, and a message that routed on the alias
    // "Falcon", learned from an earlier "Project Falcon" message.
    const reversedIds = new Set(reversed.stored.map((i) => i.internet_message_id));
    const lostToOrder = forward.stored.map((i) => i.internet_message_id).filter((id) => !reversedIds.has(id));
    expect(lostToOrder.sort()).toEqual(['<falcon-004@heliotrope.example>', '<falcon-006@bank.example>']);

    // Both were read and ledgered with their Internet message id, so the eval
    // tells them from items never read.
    const seenUnrouted = reversed.ledger.filter((row) => row.decision === 'unrouted').map((row) => row.internet_message_id);
    for (const id of lostToOrder) expect(seenUnrouted).toContain(id);

    // The reply is also in the "late thread" bucket: unrouted, in a
    // conversation the tenant did route. The alias case leaves no thread
    // trace (its conversation has nothing routed), a known limit.
    const routedConversations = new Set(reversed.stored.map((i) => i.conversation_id));
    const lateThread = reversed.ledger
      .filter((row) => row.decision === 'unrouted' && routedConversations.has(row.conversation_id))
      .map((row) => row.internet_message_id);
    expect(lateThread).toContain('<falcon-004@heliotrope.example>');
    expect(lateThread).not.toContain('<falcon-006@bank.example>');
  }, 60_000);
});

describe('a different message that reuses a stored Internet message id', () => {
  const ID = '<falcon-001@bank.example>';
  const [ALEX, MORGAN, STORM] = MAILBOXES;
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Alex and Storm hold the genuine kickoff; Morgan holds another Falcon
   * message sent under its id, and so does Storm, on the same page.
   */
  function collisionReader(): { reader: ContentSource; genuineBody: string } {
    const genuine = fixtureMailboxes()
      .flatMap((box) => box.messages)
      .find((m) => m.internetMessageId === ID)!;
    const forged = {
      ...genuine,
      id: 'morgan-forged-1',
      subject: 'Project Falcon: side letter',
      body: { contentType: 'text' as const, content: 'Project Falcon side letter terms for the preferred bidder only.' },
    };
    const dir = mkdtempSync(join(tmpdir(), 'dd-collision-'));
    dirs.push(dir);
    const write = (name: string, mailbox: string, messages: unknown[]) =>
      writeFileSync(join(dir, `mailbox-${name}.json`), JSON.stringify({ mailbox, messages }));
    write('alex', ALEX, [{ ...genuine, id: 'alex-kickoff-1' }]);
    write('morgan', MORGAN, [forged]);
    // Storm's page holds both: the second collides within the page, before the store.
    write('storm', STORM, [{ ...genuine, id: 'storm-kickoff-1' }, { ...forged, id: 'storm-forged-1' }]);
    return { reader: innerFixtureReader({ dir }), genuineBody: genuine.body!.content };
  }

  async function signIn(label: string, index: number) {
    return signInAs(`dd-resume-${label}-${index}-${RUN}@integration.conductia.dev`);
  }

  it('keeps the first text, gives the other mailbox nothing, and ledgers the collision', async () => {
    const tenant = await createTenant('collide');
    const { reader, genuineBody } = collisionReader();
    await runOnce({ tenantId: tenant.id, db, provider: READER_MODE.FIXTURE, readerFor: () => reader });

    // One item under the id, with the first sighting's subject and text.
    const { data: items } = await db
      .from('source_items')
      .select('id, subject')
      .eq('tenant_id', tenant.id)
      .eq('internet_message_id', ID);
    expect(items).toHaveLength(1);
    const itemId = items![0].id as string;
    expect(items![0].subject).not.toBe('Project Falcon: side letter');
    const { data: text } = await db.from('source_item_texts').select('body_text').eq('source_item_id', itemId).single();
    expect(text!.body_text).not.toContain('side letter');

    // Owned by the two mailboxes that hold the same message, not by Morgan's.
    const { data: provenance } = await db
      .from('source_item_sources')
      .select('content_source_id')
      .eq('source_item_id', itemId);
    expect((provenance ?? []).map((p) => p.content_source_id).sort()).toEqual(
      [tenant.sourceIds.get(ALEX)!, tenant.sourceIds.get(STORM)!].sort(),
    );

    // Both forged sightings are ledgered as collisions, with numbers and no
    // text: Morgan's against the store, Storm's within its page.
    for (const [mailbox, providerItemId] of [
      [MORGAN, 'morgan-forged-1'],
      [STORM, 'storm-forged-1'],
    ]) {
      const { data: ledger } = await db
        .from('routing_ledger')
        .select('decision, skip_reason, collision_similarity, collision_length_ratio, internet_message_id')
        .eq('source_id', tenant.sourceIds.get(mailbox)!)
        .eq('provider_item_id', providerItemId)
        .single();
      expect(ledger).toMatchObject({ decision: 'skipped', skip_reason: 'id_collision', internet_message_id: null });
      expect(ledger!.collision_similarity).toBeGreaterThanOrEqual(0);
      expect(ledger!.collision_similarity).toBeLessThan(1);
      expect(ledger!.collision_length_ratio).toBeGreaterThan(0);
      expect(ledger!.collision_length_ratio).toBeLessThanOrEqual(1);
    }

    // Through RLS: Alex reads the kickoff text, Morgan reads nothing.
    const alex = await signIn('collide', 0);
    const { data: alexText } = await alex.from('source_item_texts').select('body_text').eq('source_item_id', itemId);
    expect(alexText).toHaveLength(1);
    expect(genuineBody).toContain(alexText![0].body_text.split('\n')[0]);
    const morgan = await signIn('collide', 1);
    const { data: morganText } = await morgan.from('source_item_texts').select('body_text').eq('source_item_id', itemId);
    expect(morganText).toEqual([]);

    // A rerun reads nothing new and changes nothing.
    const again = collisionReader();
    await runOnce({ tenantId: tenant.id, db, provider: READER_MODE.FIXTURE, readerFor: () => again.reader });
    const { data: after } = await db.from('source_item_texts').select('body_text').eq('source_item_id', itemId).single();
    expect(after!.body_text).toBe(text!.body_text);
  }, 60_000);
});

// ── A Gmail source: resume, history and an expired cursor (#259 phase 3) ─────

describe('a Gmail source over the replay reader', () => {
  const BIG = 'gina@bank.example';
  const SMALL = 'sam@bank.example';
  const BIG_THREADS = 25;
  const scratch = mkdtempSync(join(tmpdir(), 'discovery-gmail-resume-'));
  let previousWorkerFlag: { enabled: boolean } | null = null;
  let previousEnv: Record<string, string | undefined> = {};

  const seed = (mailbox: string, n: number, over: Partial<SeedMessage> = {}): SeedMessage => ({
    messageId: `<falcon-${mailbox.split('@')[0]}-${n}@bank.example>`,
    date: new Date(Date.parse('2026-03-02T09:00:00Z') + n * 60_000).toISOString(),
    from: { name: 'Gina Park', address: mailbox },
    to: [{ name: 'Casey Buyer', address: 'casey@heliotrope-partners.example' }],
    cc: [],
    subject: `Project Falcon: update ${n}`,
    body: { contentType: 'text', content: `Project Falcon update ${n}: the buyer group reviewed the model.` },
    mailboxes: [mailbox],
    phase: 'seeded',
    ...over,
  });

  async function createGoogleTenant(label: string, address: string): Promise<Tenant> {
    const id = crypto.randomUUID();
    const company = await db
      .from('companies')
      .insert({ tenant_id: id, name: `Resume Gmail ${label} ${RUN}`, type: 'bank' })
      .select('id')
      .single();
    if (company.error) throw new Error(`bank company failed: ${company.error.message}`);
    const companyId = company.data.id as string;
    const email = `dd-resume-${label}-${RUN}@integration.conductia.dev`;
    const { data, error } = await db.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { tenant_id: id, department: 'ib' },
    });
    if (error || !data.user) throw new Error(`auth user create failed: ${error?.message}`);
    const userId = data.user.id;
    const { error: updateError } = await db
      .from('users')
      .update({ tenant_id: id, status: 'active', is_external: false, firm_role: null, company_id: companyId, company_role: 'director' })
      .eq('id', userId);
    if (updateError) throw new Error(`user claim failed: ${updateError.message}`);

    const registration = await db.from('google_reader_registrations').insert({
      tenant_id: id,
      workspace_domain: 'bank.example',
      service_account_email: 'resume-reader@conductia-replay.iam.gserviceaccount.com',
      client_id: '100000000000000000003',
      directory_service_account_email: 'resume-directory@conductia-replay.iam.gserviceaccount.com',
      allowlist_group: 'conductia-ingest@bank.example',
      firm_company_id: companyId,
      status: 'active',
      consented_at: new Date().toISOString(),
    });
    if (registration.error) throw new Error(`google registration failed: ${registration.error.message}`);
    const invite = await db.from('invites').insert({
      tenant_id: id,
      email: address,
      invited_by: userId,
      company_id: companyId,
      company_role: 'member',
      status: 'accepted',
      delivery_status: 'sent',
      accepted_at: new Date().toISOString(),
      accepted_user_id: userId,
    });
    if (invite.error) throw new Error(`invite failed: ${invite.error.message}`);
    // The one-click opt-in needs MD or deal team on a deal of the tenant, and it creates the Google source
    // (the registration admits only a Google domain here): assert that instead of inserting a second row.
    await seatOnDeal(db, { tenantId: id, bankId: companyId, code: `DD-GRESUME-${id.slice(0, 8)}`, userIds: [userId] });
    const session = await signInAs(email);
    const consent = await session.rpc('mailbox_consent_grant');
    if (consent.error) throw new Error(`consent failed: ${consent.error.message}`);
    const source = await db
      .from('content_sources')
      .select('id, address, provider, owner_user_id')
      .eq('tenant_id', id)
      .eq('kind', 'mailbox')
      .eq('address', address)
      .single();
    if (source.error) throw new Error(`google source failed: ${source.error.message}`);
    if (source.data.provider !== 'google' || source.data.owner_user_id !== userId) {
      throw new Error('the opt-in did not create the Google source for its owner');
    }
    const tenant: Tenant = {
      id,
      companyId,
      userIds: [userId],
      adminId: '',
      sessions: [session],
      sourceIds: new Map([[address, source.data.id as string]]),
    };
    tenants.push(tenant);
    return tenant;
  }

  async function setWorkerFlag(enabled: boolean) {
    const { error } = await db
      .from('feature_flags')
      .upsert({ key: 'discovery_worker_enabled', description: 'discovery worker (integration)', enabled }, { onConflict: 'key' });
    if (error) throw new Error(`flag upsert failed: ${error.message}`);
  }

  const phase = (name: string) => {
    process.env.DISCOVERY_GMAIL_REPLAY_PHASE = name;
  };
  const checkpointOf = async (sourceId: string) => parseCheckpoint((await sourceState(sourceId)).delta_checkpoint);
  const ledgerOf = async (sourceId: string) => {
    const { data, error } = await db
      .from('routing_ledger')
      .select('provider_item_id, run_id')
      .eq('source_id', sourceId)
      .order('provider_item_id');
    if (error) throw new Error(`ledger read failed: ${error.message}`);
    return (data ?? []) as Array<{ provider_item_id: string; run_id: string }>;
  };
  const lifecycle = async (sourceId: string) => {
    const { data, error } = await db
      .from('content_sources')
      .select('backfill_started_at, backfill_completed_at, last_synced_at, history_expiry_streak, last_error')
      .eq('id', sourceId)
      .single();
    if (error) throw new Error(`source read failed: ${error.message}`);
    return data as {
      backfill_started_at: string | null;
      backfill_completed_at: string | null;
      last_synced_at: string | null;
      history_expiry_streak: number;
      last_error: string | null;
    };
  };
  const handlersFor = (maxPages?: number) => {
    const sent: Array<{ queue: string; data: unknown; options: unknown }> = [];
    const handlers = createWorkerHandlers({
      db,
      boss: { send: async (queue: string, data: unknown, options: unknown) => (sent.push({ queue, data, options }), 'job') } as never,
      provider: READER_MODE.FIXTURE,
      maxPages,
    });
    return { handlers, sent };
  };
  const pass = async (tenantId: string) => {
    const summary = await runOnce({ tenantId, db, provider: READER_MODE.FIXTURE });
    if (summary.status !== 'ok') throw new Error(`pass skipped: ${summary.reason}`);
    return summary;
  };

  beforeAll(async () => {
    previousEnv = {
      DISCOVERY_GMAIL_REPLAY_DIR: process.env.DISCOVERY_GMAIL_REPLAY_DIR,
      DISCOVERY_GMAIL_REPLAY_PHASE: process.env.DISCOVERY_GMAIL_REPLAY_PHASE,
      DISCOVERY_FIXTURE_PAGE_DELAY_MS: process.env.DISCOVERY_FIXTURE_PAGE_DELAY_MS,
    };
    delete process.env.DISCOVERY_FIXTURE_PAGE_DELAY_MS;
    const { data } = await db.from('feature_flags').select('enabled').eq('key', 'discovery_worker_enabled').maybeSingle();
    previousWorkerFlag = data as { enabled: boolean } | null;
    await setWorkerFlag(true);

    // Two mailboxes, each a replay with three phases. BIG: 25 threads (three
    // chunks) and one message in SPAM. SMALL: three messages and one in SPAM,
    // two imports arrive later, and the spammed one comes back last.
    mkdirSync(scratch, { recursive: true });
    const messages: SeedMessage[] = [
      ...Array.from({ length: BIG_THREADS }, (_, i) => seed(BIG, i + 1)),
      seed(BIG, BIG_THREADS + 1, { labels: ['SPAM'] }),
      seed(SMALL, 1),
      seed(SMALL, 2),
      seed(SMALL, 3),
      seed(SMALL, 4, { labels: ['SPAM'] }),
      seed(SMALL, 5, { phase: 'after-imports' }),
      seed(SMALL, 6, { phase: 'after-imports' }),
    ];
    for (const replay of buildGmailTwin(messages)) writeFileSync(join(scratch, twinFileName(replay.mailbox)), JSON.stringify(replay));
    process.env.DISCOVERY_GMAIL_REPLAY_DIR = scratch;
    phase('seeded');
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
    if (previousWorkerFlag) await setWorkerFlag(previousWorkerFlag.enabled);
    else await db.from('feature_flags').delete().eq('key', 'discovery_worker_enabled');
  });

  it('resumes a worker killed between two pages: the first chunk is not read again, nothing is duplicated', async () => {
    const tenant = await createGoogleTenant('gkill', BIG);
    const sourceId = tenant.sourceIds.get(BIG)!;

    // Slow pages, so the kill lands between the first chunk (ten threads) and the second.
    const first = runWorker(tenant.id, { DISCOVERY_FIXTURE_PAGE_DELAY_MS: '1500', DISCOVERY_GMAIL_REPLAY_DIR: scratch, DISCOVERY_GMAIL_REPLAY_PHASE: 'seeded' });
    await waitFor(async () => {
      const state = await sourceState(sourceId);
      return state.delta_checkpoint !== null ? state : null;
    }, 60_000);
    first.child.kill('SIGKILL');
    await first.exited;

    const killed = await sourceState(sourceId);
    expect(killed.backfill_completed_at).toBeNull();
    expect(parseCheckpoint(killed.delta_checkpoint)).toMatchObject({ phase: 'backfill', nextThreadId: expect.any(String), nextMessageId: null, pageToken: null });
    const firstLedger = await ledgerOf(sourceId);
    // Ten threads of one message each, stored and checkpointed together.
    expect(firstLedger).toHaveLength(THREADS_PER_CHUNK);
    const firstRun = firstLedger[0].run_id;
    expect(new Set(firstLedger.map((row) => row.run_id))).toEqual(new Set([firstRun]));
    expect((await counts(tenant.id)).candidates).toBe(0);

    const second = runWorker(tenant.id, { DISCOVERY_GMAIL_REPLAY_DIR: scratch, DISCOVERY_GMAIL_REPLAY_PHASE: 'seeded' });
    expect(await second.exited, second.output()).toBe(0);

    // Every listed message, once: the SPAM one is never read.
    const done = await ledgerOf(sourceId);
    expect(done).toHaveLength(BIG_THREADS);
    expect(new Set(done.map((row) => row.provider_item_id)).size).toBe(BIG_THREADS);
    expect((await counts(tenant.id)).items).toBe(BIG_THREADS);
    // The first chunk was not read again: its rows keep the first run's id, the rest carry the second's.
    expect(done.filter((row) => row.run_id === firstRun)).toHaveLength(THREADS_PER_CHUNK);
    expect(new Set(done.filter((row) => row.run_id !== firstRun).map((row) => row.run_id)).size).toBe(1);

    const complete = await sourceState(sourceId);
    expect(complete.backfill_completed_at).not.toBeNull();
    expect(complete.last_error).toBeNull();
    // The checkpoint is now the delta cursor: the mailbox's history id (1000 plus its 26 seeded messages, the SPAM one included), taken before the first listing.
    expect(parseCheckpoint(complete.delta_checkpoint)).toMatchObject({ phase: 'delta', historyId: '1026', startHistoryId: '1026' });
    expect((await lifecycle(sourceId)).backfill_started_at).not.toBeNull();

    // The next pass polls history from that id, finds nothing, and reads nothing.
    const again = await pass(tenant.id);
    expect(again.itemsRead).toBe(0);
    expect(await counts(tenant.id)).toMatchObject({ items: BIG_THREADS, ledger: BIG_THREADS });
  }, 180_000);

  describe('one small mailbox, through the worker jobs', () => {
    let tenant: Tenant;
    let sourceId = '';
    beforeAll(async () => {
      tenant = await createGoogleTenant('gsmall', SMALL);
      sourceId = tenant.sourceIds.get(SMALL)!;
      phase('seeded');
    });

    it('stores the one chunk and its delta checkpoint on a job capped at one page, and the next job completes with no read', async () => {
      const capped = handlersFor(1);
      // The job's counts (#344, design R12): three messages fetched, none excluded, three stored; the SPAM one is neither.
      expect(await capped.handlers.sync({ tenantId: tenant.id, sourceId })).toEqual({
        status: 'page_limit',
        pages: 1,
        fetched: 3,
        excluded: 0,
        stored: 3,
        // Incoming-mail screening counts (plan v5 W3); exact values are pinned by tests/discovery/sync-screening.test.ts.
        screened: expect.any(Number),
        flagged: expect.any(Number),
        unchanged: 0,
      });
      // The chunk is stored and the delta cursor is the checkpoint, but the backfill is not marked complete.
      expect(await counts(tenant.id)).toMatchObject({ items: 3, ledger: 3 });
      expect(await checkpointOf(sourceId)).toMatchObject({ phase: 'delta', historyId: '1004' });
      expect((await sourceState(sourceId)).backfill_completed_at).toBeNull();
      // A capped job queues its own continuation, on the source's singleton key.
      expect(capped.sent.filter((s) => s.queue === QUEUE.SYNC)).toEqual([
        { queue: QUEUE.SYNC, data: { tenantId: tenant.id, sourceId }, options: { singletonKey: sourceId } },
      ]);

      const next = handlersFor(1);
      expect(await next.handlers.sync({ tenantId: tenant.id, sourceId })).toEqual({ status: 'complete', pages: 0, fetched: 0, excluded: 0, stored: 0, screened: 0, flagged: 0, unchanged: 0 });
      expect((await sourceState(sourceId)).backfill_completed_at).not.toBeNull();
      expect(await counts(tenant.id)).toMatchObject({ items: 3, ledger: 3 });
    });

    it('reads only the two new messages once the mailbox has them (after-imports), and then reads nothing', async () => {
      phase('after-imports');
      const summary = await pass(tenant.id);
      expect(summary.itemsRead).toBe(2);
      // classify-once's counts: the two new messages fetched, nothing excluded (no policy before #338).
      expect(summary).toMatchObject({ fetched: 2, excluded: 0 });
      expect(await counts(tenant.id)).toMatchObject({ items: 5, ledger: 5 });
      expect(await checkpointOf(sourceId)).toMatchObject({ phase: 'delta', historyId: '1006', historyPageToken: null });
      expect((await pass(tenant.id)).itemsRead).toBe(0);
      expect(await counts(tenant.id)).toMatchObject({ items: 5, ledger: 5 });
      expect(await lifecycle(sourceId)).toMatchObject({ history_expiry_streak: 0, last_error: null });
    });

    it('reads the message that left SPAM (after-unspam), and only it', async () => {
      phase('after-unspam');
      const summary = await pass(tenant.id);
      expect(summary.itemsRead).toBe(1);
      expect(summary).toMatchObject({ fetched: 1, excluded: 0 });
      expect(await counts(tenant.id)).toMatchObject({ items: 6, ledger: 6 });
      expect(await checkpointOf(sourceId)).toMatchObject({ phase: 'delta', historyId: '1007' });
      expect((await pass(tenant.id)).itemsRead).toBe(0);
    });

    it('resets the source when Gmail no longer holds the history id, and the re-sync creates no duplicates', async () => {
      const before = await lifecycle(sourceId);
      const ledgerBefore = await ledgerOf(sourceId);
      const { error } = await db
        .from('content_sources')
        .update({ delta_checkpoint: serializeCheckpoint({ ...parseCheckpoint(null), phase: 'delta', historyId: STALE_HISTORY_ID, startHistoryId: STALE_HISTORY_ID }) })
        .eq('id', sourceId);
      expect(error).toBeNull();

      const job = handlersFor();
      expect(await job.handlers.sync({ tenantId: tenant.id, sourceId })).toEqual({ status: 'reset', pages: 0, fetched: 0, excluded: 0, stored: 0, screened: 0, flagged: 0, unchanged: 0 });
      const reset = await lifecycle(sourceId);
      expect(await sourceState(sourceId)).toMatchObject({ delta_checkpoint: null, backfill_completed_at: null, last_error: null });
      // A normal reset (delta passes ran since the backfill): not counted, and the start of the last backfill is kept.
      expect(reset).toMatchObject({ history_expiry_streak: 0, backfill_started_at: before.backfill_started_at });
      // It queues its own backfill, on the source's singleton key, and does not cluster.
      expect(job.sent).toEqual([{ queue: QUEUE.SYNC, data: { tenantId: tenant.id, sourceId }, options: { singletonKey: sourceId } }]);

      // The re-sync (phase after-unspam: the whole mailbox, six messages) stores nothing twice.
      const resync = await job.handlers.sync({ tenantId: tenant.id, sourceId });
      expect(resync).toMatchObject({ status: 'complete' });
      expect(await counts(tenant.id)).toMatchObject({ items: 6, ledger: 6 });
      const ledgerAfter = await ledgerOf(sourceId);
      expect(ledgerAfter.map((row) => row.provider_item_id)).toEqual(ledgerBefore.map((row) => row.provider_item_id));
      const after = await lifecycle(sourceId);
      expect(after.backfill_completed_at).not.toBeNull();
      expect(Date.parse(after.backfill_started_at!)).toBeGreaterThan(Date.parse(before.backfill_started_at!));
      expect(await checkpointOf(sourceId)).toMatchObject({ phase: 'delta', historyId: '1007' });
      // And the source is back to reading history.
      expect((await pass(tenant.id)).itemsRead).toBe(0);
    });

    it('halts, not resets, when the expired cursor follows a second backfill in a row (streak 2)', async () => {
      const completed = new Date().toISOString();
      const { error } = await db
        .from('content_sources')
        .update({
          delta_checkpoint: serializeCheckpoint({ ...parseCheckpoint(null), phase: 'delta', historyId: STALE_HISTORY_ID, startHistoryId: STALE_HISTORY_ID }),
          backfill_completed_at: completed,
          last_synced_at: completed,
          history_expiry_streak: 1,
        })
        .eq('id', sourceId);
      expect(error).toBeNull();

      const job = handlersFor();
      expect(await job.handlers.sync({ tenantId: tenant.id, sourceId })).toEqual({ status: 'halted', pages: 0, fetched: 0, excluded: 0, stored: 0, screened: 0, flagged: 0, unchanged: 0 });
      const halted = await lifecycle(sourceId);
      expect(halted).toMatchObject({ last_error: HISTORY_WINDOW_EXCEEDED, history_expiry_streak: 2 });
      // Nothing is queued and the source keeps its checkpoint: a reset would only repeat.
      expect(job.sent.filter((s) => s.queue === QUEUE.SYNC)).toEqual([]);
      expect((await sourceState(sourceId)).delta_checkpoint).not.toBeNull();
      expect(halted.backfill_completed_at).not.toBeNull();
      // A halted source is not re-queued by the next tick (reader liveness): it waits for the firm admin's restart.
      const tick = handlersFor();
      await tick.handlers.tick();
      expect(tick.sent.filter((s) => s.queue === QUEUE.SYNC && (s.data as { sourceId: string }).sourceId === sourceId)).toEqual([]);
    });

    it('restarts a halted source as the firm admin, and the next tick queues it (C4)', async () => {
      expect(await lifecycle(sourceId)).toMatchObject({ last_error: HISTORY_WINDOW_EXCEEDED });
      // A firm admin of the tenant: the opt-in's owner is a director, not the admin.
      const email = `dd-resume-gsmall-admin-${RUN}@integration.conductia.dev`;
      const created = await createUserProvisioned(db, {
        email,
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { tenant_id: tenant.id, department: 'admin' },
      });
      if (created.error || !created.data.user) throw new Error(`admin create failed: ${created.error?.message}`);
      const claimed = await db
        .from('users')
        .update({ tenant_id: tenant.id, status: 'active', is_external: false, firm_role: 'admin', company_id: tenant.companyId, company_role: 'member' })
        .eq('id', created.data.user.id);
      if (claimed.error) throw new Error(`admin claim failed: ${claimed.error.message}`);
      const admin = await signInAs(email);

      // The mailbox's own owner is not the firm admin: refused, and nothing changes.
      const refused = await tenant.sessions[0].rpc('discovery_restart_mailbox_source', { p_source_id: sourceId });
      expect(refused.error).toMatchObject({ code: '42501', message: 'not_available' });
      expect(await lifecycle(sourceId)).toMatchObject({ last_error: HISTORY_WINDOW_EXCEEDED, history_expiry_streak: 2 });

      const restarted = await admin.rpc('discovery_restart_mailbox_source', { p_source_id: sourceId });
      expect(restarted.error).toBeNull();
      expect(restarted.data).toEqual({ id: sourceId, restarted: true });
      expect(await lifecycle(sourceId)).toMatchObject({
        last_error: null,
        history_expiry_streak: 0,
        backfill_started_at: null,
        backfill_completed_at: null,
      });
      expect((await sourceState(sourceId)).delta_checkpoint).toBeNull();

      // The next tick queues it again, and the sync reads the mailbox from the start (dedupe drops what is stored).
      const tick = handlersFor();
      await tick.handlers.tick();
      expect(tick.sent.filter((s) => s.queue === QUEUE.SYNC && (s.data as { sourceId: string }).sourceId === sourceId)).toHaveLength(1);
      const job = handlersFor();
      expect(await job.handlers.sync({ tenantId: tenant.id, sourceId })).toMatchObject({ status: 'complete' });
      expect(await counts(tenant.id)).toMatchObject({ items: 6, ledger: 6 });
      expect((await lifecycle(sourceId)).backfill_completed_at).not.toBeNull();
    });

    it('halts when the backfill took longer than the history window, whatever the streak', async () => {
      const completed = new Date();
      const { error } = await db
        .from('content_sources')
        .update({
          // The restart above re-read the mailbox to a fresh cursor, so the expired one is planted again.
          delta_checkpoint: serializeCheckpoint({ ...parseCheckpoint(null), phase: 'delta', historyId: STALE_HISTORY_ID, startHistoryId: STALE_HISTORY_ID }),
          backfill_started_at: new Date(completed.getTime() - (HISTORY_WINDOW_HALT_DAYS + 1) * 86_400_000).toISOString(),
          backfill_completed_at: completed.toISOString(),
          last_synced_at: new Date(completed.getTime() + 60_000).toISOString(),
          history_expiry_streak: 0,
          last_error: null,
        })
        .eq('id', sourceId);
      expect(error).toBeNull();
      const job = handlersFor();
      expect(await job.handlers.sync({ tenantId: tenant.id, sourceId })).toEqual({ status: 'halted', pages: 0, fetched: 0, excluded: 0, stored: 0, screened: 0, flagged: 0, unchanged: 0 });
      expect(await lifecycle(sourceId)).toMatchObject({ last_error: HISTORY_WINDOW_EXCEEDED, history_expiry_streak: 0 });
      expect(job.sent.filter((s) => s.queue === QUEUE.SYNC)).toEqual([]);
    });
  });
});
