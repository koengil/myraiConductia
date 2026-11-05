import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runProbe, type ProbeDeps, type ProbeResult } from '../../scripts/google/lib/probe';
import { buildProbeGuard } from '../../scripts/google/lib/probeGuard';
import { MAILBOX_GUARD_PURPOSE, MAILBOX_PROVIDER } from '@/lib/constants/discovery';
import { assertMailboxAllowed, createFixtureAllowlistMirror, MailboxAccessRefusedError } from '@/lib/mailboxAccess';
import { DIR_SA, DWD, namedIn, world } from '../google/probeWorld';
import { createGuardedTenant, dropGuardedTenant, optInOwners, type GuardedTenant, type GuardedTenantEnv } from './support/guardedTenant';

/*
 * The connection probe's guard against the REAL SQL verdict (#344, design R15, round 2 blocker 1):
 * mailbox_guard_check on a local stack, asked by buildProbeGuard exactly as the worker asks it
 * (the source owner bound, provider google, the group decision applied). Google is faked
 * (tests/google/probeWorld.ts); nothing contacts it. Self-contained: a throwaway tenant with a
 * Google registration, a consented test persona and a second allowlisted mailbox; everything is
 * deleted afterwards (audit rows stay: audit_log is append-only).
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !secret || !publishable) {
  throw new Error(
    'The probe guard test needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (local `supabase start` stack).',
  );
}
// The guard is asked with the service role: never anything but a local stack.
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
  throw new Error('The probe guard test runs against a local Supabase only (127.0.0.1 or localhost).');
}
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const DOMAIN = `pg-${RUN}.example`;
const PERSONA = `persona-${RUN}@${DOMAIN}`;
/** Allowlisted for its own owner, then its source is handed to someone else: a misconfigured allowlist. */
const MISCONFIGURED = `allowed-${RUN}@${DOMAIN}`;
/** The registered out-of-scope test account: no user, invite, allowlist row or source anywhere. */
const OUT_OF_SCOPE = `oos-${RUN}@${DOMAIN}`;

const env: GuardedTenantEnv = { db, url, publishableKey: publishable, run: RUN, password: `Probe-${RUN}-x9!` };
let tenant: GuardedTenant;
let dir: string;
let credentials: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'probe-guard-'));
  credentials = join(dir, 'worker-credentials.json');
  writeFileSync(credentials, JSON.stringify({ type: 'external_account' }));

  tenant = await createGuardedTenant(env, 'pg', [PERSONA, MISCONFIGURED]);
  const registration = await db.from('google_reader_registrations').insert({
    tenant_id: tenant.id,
    workspace_domain: DOMAIN,
    service_account_email: DWD,
    client_id: '123456789012345678',
    directory_service_account_email: DIR_SA,
    allowlist_group: `conductia-ingest@${DOMAIN}`,
    firm_company_id: tenant.companyId,
    status: 'active',
    consented_at: new Date().toISOString(),
  });
  if (registration.error) throw new Error(`google registration failed: ${registration.error.message}`);
  // Each owner opts in signed in as themself; the opt-in creates the Google source they own.
  await optInOwners(tenant);

  // The misconfiguration: the allowlisted mailbox's source now belongs to the firm admin.
  const handed = await db
    .from('content_sources')
    .update({ owner_user_id: tenant.adminId })
    .eq('tenant_id', tenant.id)
    .eq('address', MISCONFIGURED)
    .select('id');
  if (handed.error || handed.data?.length !== 1) throw new Error(`source hand-over failed: ${handed.error?.message}`);
});

afterAll(async () => {
  if (tenant) {
    await db.from('content_sources').delete().eq('tenant_id', tenant.id);
    await db.from('google_reader_registrations').delete().eq('tenant_id', tenant.id);
    await dropGuardedTenant(env, tenant);
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const statusOf = (results: ProbeResult[], id: string) => results.find((r) => r.id === id)?.status;
const detailOf = (results: ProbeResult[], id: string) => results.find((r) => r.id === id)?.detail;

function deps(fetchImpl: typeof fetch, extra: Partial<ProbeDeps>): ProbeDeps {
  return {
    env: { GOOGLE_APPLICATION_CREDENTIALS: credentials },
    callerToken: async () => 'caller-token',
    fetchImpl,
    registration: {
      tenantId: tenant.id,
      workspaceDomain: DOMAIN,
      serviceAccountEmail: DWD,
      clientId: '123456789012345678',
      directoryServiceAccountEmail: DIR_SA,
      allowlistGroup: `conductia-ingest@${DOMAIN}`,
    },
    mailbox: PERSONA,
    secretsDir: join(dir, 'no-secrets'),
    ...extra,
  };
}

/** The group holds exactly the allowlist, as a well-run tenant's group does. */
const guard = () => buildProbeGuard(db, tenant.id, createFixtureAllowlistMirror(db));

describe('the probe asks the real #262 guard the way the worker does', () => {
  it('admits the consented persona with its own source: P14 PASS, then the persona checks run', async () => {
    const w = world();
    const results = await runProbe(deps(w.fetchImpl, { ...guard() }));
    expect(statusOf(results, 'P14')).toBe('PASS');
    expect(statusOf(results, 'P03')).toBe('PASS');
    expect(namedIn(w, PERSONA).signedFor.length).toBeGreaterThan(0);
  });

  it('regression (round 2): the same persona asked with owner null is owner_mismatch, and P14 fails', async () => {
    const ownerless = async (address: string) => {
      try {
        await assertMailboxAllowed(tenant.id, address, {
          purpose: MAILBOX_GUARD_PURPOSE.PROVIDER_READ,
          caller: 'google-probe',
          owner: { userId: null },
          provider: MAILBOX_PROVIDER.GOOGLE,
        });
        return null;
      } catch (error) {
        if (error instanceof MailboxAccessRefusedError) return error.reason;
        throw error;
      }
    };
    const w = world();
    const results = await runProbe(deps(w.fetchImpl, { ...guard(), guardFor: ownerless }));
    expect(statusOf(results, 'P14')).toBe('FAIL');
    expect(detailOf(results, 'P14')).toBe('refused owner_mismatch');
    expect(namedIn(w, PERSONA)).toEqual({ gmailRequests: [], signedFor: [], issuedFor: [] });
  });

  it('refuses an allowlisted address as the out-of-scope account before any Google call', async () => {
    const w = world();
    await expect(runProbe(deps(w.fetchImpl, { ...guard(), outOfScope: { address: MISCONFIGURED } }))).rejects.toMatchObject({
      code: 'out_of_scope_not_registered',
    });
    expect(w.requests).toEqual([]);
  });

  it('a misconfigured allowlist (allowed for one user, source owned by another) is owner_mismatch: P13 UNAVAILABLE, never PASS', async () => {
    // Past the registration check on purpose: the verdict itself must not read as a pass.
    const w = world();
    const results = await runProbe(
      deps(w.fetchImpl, { ...guard(), registeredOutOfScope: async () => true, outOfScope: { address: MISCONFIGURED } }),
    );
    expect(statusOf(results, 'P13')).toBe('UNAVAILABLE');
    expect(detailOf(results, 'P13')).toBe('inconclusive: refused owner_mismatch, a reason other than not being allowlisted');
    expect(namedIn(w, MISCONFIGURED)).toEqual({ gmailRequests: [], signedFor: [], issuedFor: [] });
  });

  it('an out-of-scope account with no source is no_source: one token minted and discarded, P13 PASS', async () => {
    const w = world();
    const results = await runProbe(deps(w.fetchImpl, { ...guard(), outOfScope: { address: OUT_OF_SCOPE } }));
    expect(statusOf(results, 'P13')).toBe('PASS');
    expect(detailOf(results, 'P13')).toContain('refused no_source');
    const named = namedIn(w, OUT_OF_SCOPE);
    expect(named.gmailRequests).toEqual([]);
    expect(named.signedFor).toHaveLength(1);
    expect(named.issuedFor).toHaveLength(1);
  });
});
