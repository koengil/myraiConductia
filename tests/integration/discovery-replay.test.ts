import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/*
 * Deal discovery over a recorded Graph cassette (CDT-277): the full pass runs
 * offline, against a REAL database, through the real mail reader and the
 * worker's runOnce({ readerFor }), with the committed synthetic cassette
 * standing in for Microsoft Graph.
 *
 * The totals must equal the fixture reader's plus the site's (the siteReader
 * case of discovery-resume.test.ts): 20 ledger rows, 9 items, Falcon and Cobra
 * proposed. The real extractor runs here, over the teaser PDF and the menu. A
 * difference in the mail's share means the
 * cassette's page order or size drifted from the fixture reader's, since
 * routing learns per page. Do not change EXPECTED to make this pass.
 *
 * Every recorded interaction must be requested (a reader that stops asking is
 * drift too) and none may miss.
 *
 * Every read goes through the guard (#262), so each tenant is set up the way the
 * allowlist admits it: a bank company, a replay registration naming it and the
 * mail domain (the flags replay-discovery takes), seated owners with accepted
 * invites, their own opt-in, and a site registered by the firm admin. A replay
 * registration is disabled at rest and an opt-in needs an active one, so the
 * opt-in happens while the registration is briefly active, as a worker would see it.
 */

import { FAKE_SITE_ADDRESS } from '../../scripts/m365/cassette/fakeTenant';
import { loadCassette } from '../../scripts/m365/cassette/replayFetch';
import { SYNTHETIC_CASSETTE_DIR } from '../../scripts/m365/build-synthetic-cassette';
import { assertSupabaseTarget } from '../../scripts/m365/cassette/target';
import { openOptinWindow, replayDiscovery, seedReplayTenant } from '../../scripts/m365/replay-discovery';
import { replayFetch } from '../../scripts/m365/cassette/replayFetch';
import {
  createGuardedTenant,
  dropGuardedTenant,
  enableDiscoveryFlag,
  optInOwners,
  registerSite,
  type GuardedTenant,
  type GuardedTenantEnv,
} from './support/guardedTenant';
import { EXPECTED_SYNTHETIC } from './support/replayCassette';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  throw new Error('The discovery replay test needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (local stack).');
}
// The same loopback-only guard the replay script applies: this file writes fixtures too, and never to a hosted project.
assertSupabaseTarget(url, null);
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!publishable) {
  throw new Error('The discovery replay test needs NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (local stack).');
}
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const env: GuardedTenantEnv = { db, url, publishableKey: publishable, run: RUN, password: `Replay-${RUN}-x9!` };
// Sorted, as the cassette's sources are: mailbox i belongs to user i.
const MAILBOXES = ['alex.chen@bank.example', 'morgan.vale@bank.example', 'storm.duncan@bank.example'];
const EXPECTED = EXPECTED_SYNTHETIC; // the siteReader case's figures, shared with discovery-replay-cassette.test.ts

// What replay-discovery takes beside the cassette: the firm and the mail domains (C7).
const FIRM_FLAGS = { mailboxDomains: ['bank.example'] };

const tenants: GuardedTenant[] = [];
let restoreFlag: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  restoreFlag = await enableDiscoveryFlag(db);
});

async function createTenant(label: string): Promise<GuardedTenant> {
  const tenant = await createGuardedTenant(env, label, MAILBOXES);
  tenants.push(tenant);
  return tenant;
}

/** The owners' opt-in and the site's registration, for a tenant replay has just seeded (disabled at rest). */
async function admit(tenant: GuardedTenant): Promise<void> {
  await setRegistration(tenant.id, 'active');
  try {
    await optInOwners(tenant);
  } finally {
    await setRegistration(tenant.id, 'disabled');
  }
  await registerSite(tenant, FAKE_SITE_ADDRESS);
}

async function setRegistration(tenantId: string, status: 'active' | 'disabled'): Promise<void> {
  const { error } = await db.from('graph_reader_registrations').update({ status }).eq('tenant_id', tenantId);
  if (error) throw new Error(`registration ${status} failed: ${error.message}`);
}

/** Seeds the replay tenant with the firm and domains, then admits its people. */
async function seed(tenant: GuardedTenant, cassette: ReturnType<typeof loadCassette>, extra: { resetReplayTenant?: boolean } = {}) {
  await seedReplayTenant(db, {
    tenantId: tenant.id,
    cassette,
    owners: ownersFor(tenant),
    firmCompany: tenant.companyId,
    ...FIRM_FLAGS,
    ...extra,
  });
}

// Storm owns the site, as in the siteReader case of discovery-resume.test.ts.
const ownersFor = (tenant: GuardedTenant) =>
  new Map([
    ...MAILBOXES.map((address, index): [string, string] => [address, tenant.ownerIds[index]]),
    [FAKE_SITE_ADDRESS.toLowerCase(), tenant.ownerIds[2]] as [string, string],
  ]);

async function registrationStatus(tenantId: string): Promise<string | undefined> {
  const { data, error } = await db.from('graph_reader_registrations').select('status').eq('tenant_id', tenantId).maybeSingle();
  if (error) throw new Error(`registration read failed: ${error.message}`);
  return (data as { status: string } | null)?.status;
}

/** The open consents of the tenant's mailbox invites. */
async function openConsents(tenant: GuardedTenant): Promise<number> {
  const { data: invites, error } = await db.from('invites').select('id').eq('tenant_id', tenant.id);
  if (error) throw new Error(`invite read failed: ${error.message}`);
  const { count, error: countError } = await db
    .from('mailbox_consents')
    .select('*', { count: 'exact', head: true })
    .in('invite_id', (invites ?? []).map((i) => i.id as string))
    .is('withdrawn_at', null);
  if (countError) throw new Error(`consent count failed: ${countError.message}`);
  return count ?? 0;
}

/** Waits until the registration holds the status: how an owner (here, the test) knows the window is open. */
async function waitForRegistration(tenantId: string, status: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await registrationStatus(tenantId)) !== status) {
    if (Date.now() > deadline) throw new Error(`the registration never became ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A ceiling the test never reaches (the owners opt in at once); a window nobody answers ends the test, not the suite. */
const OPTIN_TIMEOUT_MS = 30_000;

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

afterAll(async () => {
  for (const tenant of tenants) await dropGuardedTenant(env, tenant);
  await restoreFlag();
});

describe('discovery over a recorded Graph cassette', () => {
  it('runs the full discovery pass offline from the committed cassette, then an idempotent delta', async () => {
    const cassette = loadCassette(SYNTHETIC_CASSETTE_DIR);
    const tenant = await createTenant('replay');
    await seed(tenant, cassette);
    await admit(tenant);
    const { second } = await replayDiscovery(db, { tenantId: tenant.id, cassette });

    expect(await counts(tenant.id)).toMatchObject(EXPECTED);
    expect(second.candidates.filter((c) => c.created).length).toBe(0);
    expect(cassette.fetch.misses.length).toBe(0); // a length: a failed assertion prints a number, not the lines
    // The worker selects only 'active' registrations: a finished replay must not be one.
    expect(await registrationStatus(tenant.id)).toBe('disabled');

    // The site's ledger, and the teaser as a document row.
    const { data: site } = await db
      .from('content_sources')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('kind', 'sharepoint_site')
      .single();
    const { data: ledger } = await db
      .from('routing_ledger')
      .select('provider_item_id, decision, method, skip_reason')
      .eq('source_id', site!.id)
      .order('provider_item_id');
    expect(ledger).toEqual([
      { provider_item_id: 'canteen-menu', decision: 'unrouted', method: null, skip_reason: null },
      { provider_item_id: 'falcon-teaser', decision: 'routed', method: 'codename', skip_reason: null },
      { provider_item_id: 'logo', decision: 'skipped', method: null, skip_reason: 'image_only' },
    ]);
    const { data: docs } = await db
      .from('source_items')
      .select('kind, subject, drive_item_key, drive_path')
      .eq('tenant_id', tenant.id)
      .eq('kind', 'document');
    expect(docs).toEqual([
      {
        kind: 'document',
        subject: 'Falcon teaser.pdf',
        drive_item_key: 'D-deals:falcon-teaser',
        drive_path: '/Falcon/Falcon teaser.pdf',
      },
    ]);

    // Every recorded interaction was asked for: a reader that stops asking is drift too.
    expect(cassette.fetch.unrequested()).toBe(0);
  });

  it('never leaves a replay registration selectable: seeded disabled, and disabled again after a failed replay', async () => {
    const cassette = loadCassette(SYNTHETIC_CASSETTE_DIR);
    const tenant = await createTenant('paused');
    await seed(tenant, cassette);
    await admit(tenant);
    expect(await registrationStatus(tenant.id)).toBe('disabled'); // a worker that shares this database skips it

    // A cassette that answers nothing: the first read misses and the run fails. The registration ends disabled.
    const empty = { ...cassette, fetch: replayFetch({ ...cassette, interactions: [] }) };
    await expect(replayDiscovery(db, { tenantId: tenant.id, cassette: empty })).rejects.toThrow(/no recorded response/);
    expect(empty.fetch.misses.length).toBeGreaterThan(0);
    expect(await registrationStatus(tenant.id)).toBe('disabled');
  });

  it('a SIGTERM in the middle of a replay sets the registration back to disabled, then exits 143', async () => {
    const cassette = loadCassette(SYNTHETIC_CASSETTE_DIR);
    const tenant = await createTenant('signalled');
    await seed(tenant, cassette);
    await admit(tenant);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const signals = new EventEmitter();
    let statusWhenSignalled: string | undefined;
    // The first read never answers: the process is killed while the registration is active.
    const hanging = Object.assign(
      (async () => {
        statusWhenSignalled = await registrationStatus(tenant.id);
        signals.emit('SIGTERM');
        return new Promise<Response>(() => undefined);
      }) as typeof fetch,
      { requests: [], misses: [], unrequested: () => 0 },
    );
    const exited = new Promise<number>((resolve) => {
      void replayDiscovery(db, { tenantId: tenant.id, cassette: { ...cassette, fetch: hanging }, signals, exit: resolve });
    });
    expect(await exited).toBe(143);
    expect(statusWhenSignalled).toBe('active');
    expect(await registrationStatus(tenant.id)).toBe('disabled');
    expect(signals.listenerCount('SIGTERM')).toBe(1); // the handler stays until the (never finishing) run ends; nothing was added twice
    vi.restoreAllMocks();
  });

  // D68: --activate-for-optin opens the window only. Without it the owners have not opted in and the pass reads
  // nothing (no_consent). With it the registration is active while the OWNERS opt in themselves (here the test is
  // each owner, under that owner's own signed-in session, as the profile card's button is), the script only reads
  // the consent, and the registration is disabled again before the pass reads.
  it('--activate-for-optin: the owners opt in themselves during the window, then the pass reads where it refused no_consent', async () => {
    const cassette = loadCassette(SYNTHETIC_CASSETTE_DIR);
    const tenant = await createTenant('optin');
    await seed(tenant, cassette);

    const before = await replayDiscovery(db, { tenantId: tenant.id, cassette });
    expect(before.first.itemsRead).toBe(0);
    expect(before.first.refused.filter((r) => r.reason === 'no_consent').length).toBe(MAILBOXES.length);

    // The flag's path: seed (reset: the pass above wrote ledger rows), open the window, owners opt in, close it.
    await seed(tenant, cassette, { resetReplayTenant: true });
    expect(await registrationStatus(tenant.id)).toBe('disabled');
    expect(await openConsents(tenant)).toBe(0);
    const lines: string[] = [];
    const windowRun = openOptinWindow(db, tenant.id, ownersFor(tenant), {
      timeoutMs: OPTIN_TIMEOUT_MS,
      pollMs: 100,
      appUrl: 'http://localhost:3000',
      log: (line) => lines.push(line),
      signals: new EventEmitter(),
      stdin: null,
    });
    await waitForRegistration(tenant.id, 'active'); // the window is open: this is what the owners wait for
    expect(await openConsents(tenant)).toBe(0); // the script has consented for nobody
    await optInOwners(tenant); // each owner's own session, mailbox_consent_grant
    const result = await windowRun;

    expect(result?.endedBy).toBe('all_consented');
    expect(result?.owners.map((o) => o.consented)).toEqual([true, true, true]);
    expect(await registrationStatus(tenant.id)).toBe('disabled'); // back at rest before the replay pass
    expect(await openConsents(tenant)).toBe(MAILBOXES.length);
    expect(lines.join('\n')).toContain('/profile');

    const after = await replayDiscovery(db, { tenantId: tenant.id, cassette });
    expect(after.first.itemsRead).toBeGreaterThan(0);
    expect(after.first.refused.filter((r) => r.reason === 'no_consent').length).toBe(0);
    expect(await registrationStatus(tenant.id)).toBe('disabled');
  });

  it('--activate-for-optin: when no owner opts in the window times out, closes, and has consented for nobody', async () => {
    const cassette = loadCassette(SYNTHETIC_CASSETTE_DIR);
    const tenant = await createTenant('optin-timeout');
    await seed(tenant, cassette);
    const result = await openOptinWindow(db, tenant.id, ownersFor(tenant), {
      timeoutMs: 800,
      pollMs: 100,
      appUrl: 'http://localhost:3000',
      log: () => undefined,
      signals: new EventEmitter(),
      stdin: null,
    });
    expect(result?.endedBy).toBe('timeout');
    expect(result?.owners.every((o) => !o.consented)).toBe(true);
    expect(await registrationStatus(tenant.id)).toBe('disabled');
    expect(await openConsents(tenant)).toBe(0);
  });

  describe('the script, with --activate-for-optin', () => {
    const script = (args: string[], env: Record<string, string> = {}) =>
      spawnSync('node', ['--import', 'tsx', 'scripts/m365/replay-discovery.ts', ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        timeout: 120_000,
      });
    const cassetteArgs = (tenantId: string, firmCompany: string) => [
      '--cassette',
      SYNTHETIC_CASSETTE_DIR,
      '--tenant',
      tenantId,
      '--firm-company',
      firmCompany,
      '--mailbox-domains',
      'bank.example',
    ];

    /** The script as a child that does not block this process: the test is the owners while the window is open. */
    const scriptAsync = (args: string[]) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
        const child = spawn('node', ['--import', 'tsx', 'scripts/m365/replay-discovery.ts', ...args], {
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
        child.on('error', reject);
        child.on('close', (status) => {
          clearTimeout(timer);
          resolveRun({ status, stdout, stderr });
        });
      });

    async function ownersFileFor(tenant: GuardedTenant, dir: string): Promise<string> {
      const emails = await Promise.all(
        tenant.ownerIds.map(async (id) => (await db.from('users').select('email').eq('id', id).single()).data!.email as string),
      );
      const ownersFile = join(dir, 'owners.json');
      writeFileSync(ownersFile, JSON.stringify({ ...Object.fromEntries(MAILBOXES.map((a, i) => [a, emails[i]])), [FAKE_SITE_ADDRESS]: emails[2] }));
      return ownersFile;
    }

    it('opens the window, the owners opt in themselves, then it replays, reads, and reports per owner', async () => {
      const tenant = await createTenant('cli');
      const dir = mkdtempSync(join(tmpdir(), 'replay-owners-'));
      try {
        const ownersFile = await ownersFileFor(tenant, dir);
        const running = scriptAsync([
          ...cassetteArgs(tenant.id, tenant.companyId),
          '--owners',
          ownersFile,
          '--activate-for-optin',
          '--optin-timeout',
          '60',
          '--app-url',
          'http://localhost:3999',
        ]);
        await waitForRegistration(tenant.id, 'active'); // the window is open
        expect(await openConsents(tenant)).toBe(0); // the script consented for nobody
        await optInOwners(tenant); // each owner's own session
        const run = await running;

        expect(run.stderr).toBe('');
        expect(run.status).toBe(0);
        expect(run.stdout).toContain('http://localhost:3999/profile');
        for (const address of MAILBOXES) expect(run.stdout).toContain(address); // the window prompt names the mailboxes
        expect(run.stdout).toContain('the replay registration is disabled again');
        expect(run.stdout).toMatch(/run 1: read [1-9]\d*,/);
        expect(run.stdout).toMatch(/owner 1: consented, read [1-9]\d*, refused 0/);
        expect(await registrationStatus(tenant.id)).toBe('disabled');
        expect(await openConsents(tenant)).toBe(MAILBOXES.length);
        // After the window the results name owners by number: no address outside the prompt, no subject.
        const results = run.stdout.slice(run.stdout.indexOf('run 1:'));
        for (const address of MAILBOXES) expect(results).not.toContain(address);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a window nobody answers times out, closes, consents for nobody, and does not run the replay pass', async () => {
      const tenant = await createTenant('cli-timeout');
      const dir = mkdtempSync(join(tmpdir(), 'replay-owners-'));
      try {
        const ownersFile = await ownersFileFor(tenant, dir);
        const run = await scriptAsync([...cassetteArgs(tenant.id, tenant.companyId), '--owners', ownersFile, '--activate-for-optin', '--optin-timeout', '2']);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain('no owner opted in');
        expect(run.stdout).not.toContain('run 1:');
        expect(await registrationStatus(tenant.id)).toBe('disabled');
        expect(await openConsents(tenant)).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('SIGINT during the window ends the wait, closes it, and the process exits on its own', async () => {
      const tenant = await createTenant('cli-sigint');
      const dir = mkdtempSync(join(tmpdir(), 'replay-owners-'));
      try {
        const ownersFile = await ownersFileFor(tenant, dir);
        const child = spawn('node', ['--import', 'tsx', 'scripts/m365/replay-discovery.ts', ...cassetteArgs(tenant.id, tenant.companyId), '--owners', ownersFile, '--activate-for-optin', '--optin-timeout', '120'], {
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => (stderr += chunk));
        const closed = new Promise<number | null>((resolveClose) => child.on('close', resolveClose));
        await waitForRegistration(tenant.id, 'active');
        child.kill('SIGINT');
        expect(await closed).toBe(1); // no owner had opted in: the replay pass is not run, and the exit says so
        expect(stderr).toContain('no owner opted in');
        expect(await registrationStatus(tenant.id)).toBe('disabled');
        expect(await openConsents(tenant)).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('refuses a non-loopback host, even with --allow-remote-supabase, and with --no-owners, before any write', async () => {
      const tenant = await createTenant('cli-refused');
      const remote = script(
        [...cassetteArgs(tenant.id, tenant.companyId), '--no-owners', '--activate-for-optin', '--allow-remote-supabase', 't3.example.com'],
        { NEXT_PUBLIC_SUPABASE_URL: 'https://t3.example.com' },
      );
      expect(remote.status).toBe(1);
      expect(remote.stderr).toContain('Refusing --activate-for-optin against t3.example.com');
      const none = script([...cassetteArgs(tenant.id, tenant.companyId), '--no-owners', '--activate-for-optin']);
      expect(none.status).toBe(1);
      expect(none.stderr).toContain('--activate-for-optin needs --owners');
      expect(await registrationStatus(tenant.id)).toBeUndefined(); // nothing was written
    });
  });

  it('never activates, or pauses, a registration that is not a replay one', async () => {
    const cassette = loadCassette(SYNTHETIC_CASSETTE_DIR);
    const tenant = await createTenant('live-run');
    const { error } = await db.from('graph_reader_registrations').insert({
      tenant_id: tenant.id,
      ms_tenant_id: crypto.randomUUID(),
      client_id: crypto.randomUUID(),
      status: 'active',
    });
    if (error) throw new Error(`registration failed: ${error.message}`);
    await expect(replayDiscovery(db, { tenantId: tenant.id, cassette })).rejects.toThrow('has no replay registration');
    expect(await registrationStatus(tenant.id)).toBe('active'); // left exactly as it was
    expect(cassette.fetch.requests.length).toBe(0);
  });

  it('refuses a tenant that already holds discovery data, unless it is reset, and then the counts are the cassette\'s alone', async () => {
    const cassette = loadCassette(SYNTHETIC_CASSETTE_DIR);
    const tenant = await createTenant('reset');
    await seed(tenant, cassette);
    await admit(tenant);
    await replayDiscovery(db, { tenantId: tenant.id, cassette });
    expect(await counts(tenant.id)).toMatchObject(EXPECTED);

    // A second replay into the same tenant would add to the first: refused, and nothing changes.
    await expect(seed(tenant, cassette)).rejects.toThrow(
      'already holds discovery data; replay into a fresh --tenant, or pass --reset-replay-tenant',
    );
    expect(await counts(tenant.id)).toMatchObject(EXPECTED);

    // With the reset the tenant starts empty again. audit_log is append-only, so the two proposal
    // audits of the first pass stay: everything the reset can delete is back to EXPECTED.
    await seed(tenant, cassette, { resetReplayTenant: true });
    const { proposedAudit: auditAfterReset, ...afterReset } = await counts(tenant.id);
    expect(afterReset).toMatchObject({ candidates: 0, items: 0, links: 0, visibility: 0, ledger: 0 });
    expect(auditAfterReset).toBe(EXPECTED.proposedAudit);
    await replayDiscovery(db, { tenantId: tenant.id, cassette });
    const { proposedAudit, ...again } = await counts(tenant.id);
    const expected: Partial<typeof EXPECTED> = { ...EXPECTED };
    delete expected.proposedAudit;
    expect(again).toMatchObject(expected);
    expect(proposedAudit).toBe(EXPECTED.proposedAudit * 2);
  });

  it('never resets a tenant whose registration is live', async () => {
    const cassette = loadCassette(SYNTHETIC_CASSETTE_DIR);
    const tenant = await createTenant('live-reset');
    const { error } = await db.from('graph_reader_registrations').insert({
      tenant_id: tenant.id,
      ms_tenant_id: crypto.randomUUID(),
      client_id: crypto.randomUUID(),
      status: 'active',
    });
    if (error) throw new Error(`registration failed: ${error.message}`);
    await expect(seed(tenant, cassette, { resetReplayTenant: true })).rejects.toThrow('has a live reader registration');
  });

  it('refuses a tenant that holds a live registration, and writes nothing', async () => {
    const cassette = loadCassette(SYNTHETIC_CASSETTE_DIR);
    const tenant = await createTenant('live');
    const { error } = await db.from('graph_reader_registrations').insert({
      tenant_id: tenant.id,
      ms_tenant_id: crypto.randomUUID(),
      client_id: crypto.randomUUID(),
      status: 'active',
    });
    if (error) throw new Error(`registration failed: ${error.message}`);

    await expect(seed(tenant, cassette)).rejects.toThrow('has a live reader registration');

    const { count } = await db
      .from('content_sources')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id);
    expect(count).toBe(0);
  });

  it('refuses a firm that is not the tenant\'s bank company, or no domain, before it writes anything (C7)', async () => {
    const cassette = loadCassette(SYNTHETIC_CASSETTE_DIR);
    const tenant = await createTenant('no-firm');
    const base = { tenantId: tenant.id, cassette, owners: ownersFor(tenant), mailboxDomains: ['bank.example'] };
    await expect(seedReplayTenant(db, { ...base, firmCompany: 'No Such Bank' })).rejects.toThrow('no company of type bank');
    await expect(seedReplayTenant(db, { ...base, firmCompany: tenant.companyId, mailboxDomains: [] })).rejects.toThrow('mailboxDomains');
    await expect(seedReplayTenant(db, { ...base, firmCompany: tenant.companyId, mailboxDomains: ['a@bank.example'] })).rejects.toThrow('mailboxDomains[0]');
    expect(await registrationStatus(tenant.id)).toBeUndefined();
  });

  // #262 round 3, A2: an owner's own opt-in needs MD or deal team on a deal of the tenant, so the seed seats each
  // owner on one replay deal. A tenant whose owners sit on no deal is the proof: they cannot opt in until it runs.
  it('seats each seeded owner on a replay deal as deal_team, so their own opt-in is accepted, and again changes nothing', async () => {
    const cassette = loadCassette(SYNTHETIC_CASSETTE_DIR);
    const tenant = await createGuardedTenant(env, 'dealless', MAILBOXES, null);
    tenants.push(tenant);
    expect(tenant.dealId).toBeNull();

    await seed(tenant, cassette);
    await setRegistration(tenant.id, 'active');
    try {
      await optInOwners(tenant);
    } finally {
      await setRegistration(tenant.id, 'disabled');
    }
    expect(await openConsents(tenant)).toBe(MAILBOXES.length);

    const memberships = async () => {
      const { data, error } = await db
        .from('deal_memberships')
        .select('user_id, deal_role, deals!inner(code, tenant_id)')
        .eq('deals.tenant_id', tenant.id);
      if (error) throw new Error(`membership read failed: ${error.message}`);
      return data ?? [];
    };
    const seated = await memberships();
    expect(seated.map((row) => row.user_id).sort()).toEqual(
      [...new Set(ownersFor(tenant).values())].sort(),
    );
    expect(new Set(seated.map((row) => row.deal_role))).toEqual(new Set(['deal_team']));

    await seed(tenant, cassette, { resetReplayTenant: true });
    expect(await memberships()).toHaveLength(seated.length);
  });
});
