import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { COMPANY_TYPE } from '../../src/lib/constants/companies';
import { GOOGLE_READER_TABLE, GOOGLE_REGISTRATION_STATUSES } from '../../src/lib/constants/googleReader';
import {
  MAILBOX_PROVIDER,
  REGISTRATION_STATUS,
  SOURCE_KIND,
  SOURCE_STATUS,
  type MailboxProvider,
  type SourceStatus,
} from '../../src/lib/constants/discovery';
import { TABLE } from '../../src/lib/constants/tables';
import { keyMaterialProblems } from '../../src/lib/secrets/keyMaterial';
import { argValue, assertSecretsFolderKeyless } from './lib/live';

// Writes one google_reader_registrations row from .secrets/google/registration.json
// (the bank's super admin provides the values; for the trial, the owner does).
//
//   node --env-file=.env.local --import tsx scripts/google/write-registration.ts \
//     --config .secrets/google/registration.json [--dry-run]
//
// The row names the signer (the DWD service account, by email) and never holds a
// key. `sources` (Phase 2) lists the mailboxes to read: each becomes a Google
// content_sources row, created before the first read because the #262 guard
// judges an address by its source row. It is the operator's way to place a
// mailbox for a local or trial tenant. A member's own one-click opt-in
// (mailbox_consent_grant) also creates or adopts the member's source, so a
// config with no `sources` key writes the registration only and touches no
// source. With the key present the list is authoritative, as in
// scripts/m365/write-registration.ts: a Google source omitted from it is
// paused, never deleted; Microsoft rows are never touched.
//
// The lifecycle is #262's. An archived source (mailbox_consent_grant renamed it
// <address>~xyz, paused it and stamped archived_at: an orphaned mailbox kept
// with its history) belongs to no one. It is never matched by an address, never
// renamed, resumed, re-owned or re-providered, and needs no pausing; every write
// to a live source is conditional on it still being live, since the opt-in can
// archive it between the lookup and the write. An address that is a live source
// of another provider is refused: one address has one provider.

export type GoogleRegistrationConfig = {
  tenantId: string;
  workspaceDomain: string;
  serviceAccountEmail: string;
  clientId: string;
  directoryServiceAccountEmail: string;
  allowlistGroup: string;
  firmCompanyId: string;
  status: (typeof GOOGLE_REGISTRATION_STATUSES)[number];
  consentedAt: string | null;
  /** True when the config carries a `sources` key: only then is the list authoritative (omitted sources are paused). */
  sourcesListed: boolean;
  sources: GoogleSourceConfig[];
};

/** One mailbox to read: its address in the workspace domain and the tenant user who owns it. */
export type GoogleSourceConfig = { address: string; ownerEmail: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const SA_EMAIL = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/;
const CLIENT_ID = /^[0-9]{10,30}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ParsedRegistration = { ok: true; config: GoogleRegistrationConfig } | { ok: false; errors: string[] };

export function parseGoogleRegistrationConfig(raw: unknown): ParsedRegistration {
  const errors: string[] = [];
  for (const problem of keyMaterialProblems(raw)) errors.push(`configuration ${problem}; it must name a signer, never hold a key`);
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (key: string): string => (typeof r[key] === 'string' ? (r[key] as string) : '');

  const tenantId = str('tenantId');
  if (!UUID.test(tenantId)) errors.push('tenantId must be a UUID');
  const workspaceDomain = str('workspaceDomain');
  if (workspaceDomain !== workspaceDomain.toLowerCase() || !DOMAIN.test(workspaceDomain)) {
    errors.push('workspaceDomain must be a lowercase domain');
  }
  const serviceAccountEmail = str('serviceAccountEmail');
  if (!SA_EMAIL.test(serviceAccountEmail)) errors.push('serviceAccountEmail must be a service account email (…@<project>.iam.gserviceaccount.com)');
  const directoryServiceAccountEmail = str('directoryServiceAccountEmail');
  if (!SA_EMAIL.test(directoryServiceAccountEmail)) {
    errors.push('directoryServiceAccountEmail must be a service account email (…@<project>.iam.gserviceaccount.com)');
  }
  if (serviceAccountEmail && serviceAccountEmail === directoryServiceAccountEmail) {
    errors.push('serviceAccountEmail and directoryServiceAccountEmail must differ (the reader never produces the evidence that audits it)');
  }
  const clientId = str('clientId');
  if (!CLIENT_ID.test(clientId)) errors.push('clientId must be the numeric DWD client ID');
  const allowlistGroup = str('allowlistGroup');
  if (allowlistGroup !== allowlistGroup.toLowerCase() || !allowlistGroup.includes('@')) {
    errors.push('allowlistGroup must be a lowercase group address');
  } else if (allowlistGroup.split('@')[1] !== workspaceDomain) {
    errors.push('allowlistGroup must be in the workspace domain');
  }
  const firmCompanyId = str('firmCompanyId');
  if (!UUID.test(firmCompanyId)) errors.push('firmCompanyId must be a UUID');

  const status = (r.status === undefined ? REGISTRATION_STATUS.PENDING : r.status) as GoogleRegistrationConfig['status'];
  if (!GOOGLE_REGISTRATION_STATUSES.includes(status)) {
    errors.push(`status must be one of ${GOOGLE_REGISTRATION_STATUSES.join(', ')}`);
  }
  let consentedAt: string | null = null;
  if (r.consentedAt !== undefined && r.consentedAt !== null) {
    if (typeof r.consentedAt !== 'string' || Number.isNaN(Date.parse(r.consentedAt))) {
      errors.push('consentedAt must be an ISO timestamp');
    } else {
      consentedAt = r.consentedAt;
    }
  }
  if (status === REGISTRATION_STATUS.ACTIVE && !consentedAt) errors.push('an active registration requires consentedAt');

  const sources: GoogleSourceConfig[] = [];
  const sourcesListed = r.sources !== undefined;
  if (r.sources !== undefined) {
    if (!Array.isArray(r.sources)) {
      errors.push('sources must be a list of { address, ownerEmail }');
    } else {
      const seen = new Set<string>();
      r.sources.forEach((entry: unknown, i: number) => {
        const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
        const address = typeof e.address === 'string' ? e.address : '';
        const ownerEmail = typeof e.ownerEmail === 'string' ? e.ownerEmail : '';
        if (address !== address.toLowerCase() || !EMAIL.test(address)) {
          errors.push(`sources[${i}].address must be a lowercase address`);
        } else if (address.split('@')[1] !== workspaceDomain) {
          errors.push(`sources[${i}].address must be in the workspace domain ${workspaceDomain}`);
        } else if (seen.has(address)) {
          errors.push(`sources[${i}].address ${address} is listed twice`);
        }
        seen.add(address);
        if (!EMAIL.test(ownerEmail)) errors.push(`sources[${i}].ownerEmail must be the owner's email address`);
        sources.push({ address, ownerEmail: ownerEmail.toLowerCase() });
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      tenantId,
      workspaceDomain,
      serviceAccountEmail,
      clientId,
      directoryServiceAccountEmail,
      allowlistGroup,
      firmCompanyId,
      status,
      consentedAt,
      sourcesListed,
      sources,
    },
  };
}

export type SourceRecord = {
  id: string;
  provider: MailboxProvider;
  address: string;
  status: SourceStatus;
  /** Set once #262 archived the source (an orphaned mailbox kept with its history): it is no one's to configure. */
  archivedAt?: string | null;
};

/** The database operations the writer needs, so tests run against a fake. */
export type RegistrationDb = {
  findCompany(id: string): Promise<{ id: string; tenant_id: string; type: string } | null>;
  upsertRegistration(row: Record<string, unknown>): Promise<void>;
  /** An internal (non-external) user of the tenant, by email. */
  findInternalUser(tenantId: string, email: string): Promise<{ id: string } | null>;
  /** Every mailbox source of the tenant, whatever its provider and whether or not it is archived. */
  listMailboxSources(tenantId: string): Promise<SourceRecord[]>;
  /** The live (not archived) mailbox source of an address, matched ignoring case, whatever its provider. */
  findLiveSource(tenantId: string, address: string): Promise<SourceRecord | null>;
  /**
   * The generated registration columns are never written: only these fields. `exists` is the unique index
   * answering for the address (another writer created it first).
   */
  insertSource(row: { tenant_id: string; kind: 'mailbox'; provider: 'google'; address: string; owner_user_id: string; status: 'active' }): Promise<'inserted' | 'exists'>;
  /**
   * Updates a source only while it is still the live Google source at this address: not archived, not renamed
   * and not on another provider. True when it matched. The provider is never a field here.
   */
  updateLiveSource(id: string, address: string, fields: { owner_user_id?: string; status: SourceStatus }): Promise<boolean>;
};

export type SourceAction = { address: string; action: 'insert' | 'update' | 'pause' | 'unchanged' };

export function registrationRow(config: GoogleRegistrationConfig): Record<string, unknown> {
  return {
    tenant_id: config.tenantId,
    workspace_domain: config.workspaceDomain,
    service_account_email: config.serviceAccountEmail,
    client_id: config.clientId,
    directory_service_account_email: config.directoryServiceAccountEmail,
    allowlist_group: config.allowlistGroup,
    firm_company_id: config.firmCompanyId,
    status: config.status,
    consented_at: config.consentedAt,
  };
}

export async function applyGoogleRegistration(
  db: RegistrationDb,
  config: GoogleRegistrationConfig,
  options: { dryRun?: boolean } = {},
): Promise<{ written: boolean; row: Record<string, unknown>; sources: SourceAction[] }> {
  const company = await db.findCompany(config.firmCompanyId);
  if (!company || company.type !== COMPANY_TYPE.BANK || company.tenant_id !== config.tenantId) {
    throw new Error("firm company is not this tenant's bank");
  }

  // Plan every source before anything is written, so a bad owner or a Microsoft
  // clash leaves the database untouched. An archived row is no one's to configure
  // (#262): it is not matched by an address (its address was renamed), never
  // written and never paused, so only live rows are planned.
  const existing = (await db.listMailboxSources(config.tenantId)).filter((source) => !source.archivedAt);
  const byAddress = new Map(existing.map((source) => [source.address.toLowerCase(), source]));
  type Step = SourceAction & { owner?: string; id?: string; rowAddress?: string };
  const plan: Step[] = [];
  if (config.sourcesListed) {
    for (const wanted of config.sources) {
      const owner = await db.findInternalUser(config.tenantId, wanted.ownerEmail);
      if (!owner) throw new Error(`source ${wanted.address}: owner ${wanted.ownerEmail} is not an internal user of this tenant`);
      const current = byAddress.get(wanted.address);
      if (current && current.provider !== MAILBOX_PROVIDER.GOOGLE) {
        throw new Error(
          `source ${wanted.address}: already a ${current.provider} source in this tenant; one address has one provider`,
        );
      }
      plan.push(
        current
          ? { address: wanted.address, action: 'update', owner: owner.id, id: current.id, rowAddress: current.address }
          : { address: wanted.address, action: 'insert', owner: owner.id },
      );
    }
    // Omitted Google sources are paused (their history stays); Microsoft rows are not ours to touch.
    const listed = new Set(config.sources.map((s) => s.address));
    for (const current of existing) {
      if (current.provider !== MAILBOX_PROVIDER.GOOGLE || listed.has(current.address.toLowerCase())) continue;
      plan.push(
        current.status === SOURCE_STATUS.PAUSED
          ? { address: current.address, action: 'unchanged' }
          : { address: current.address, action: 'pause', id: current.id, rowAddress: current.address },
      );
    }
  }
  const actions: SourceAction[] = plan.map(({ address, action }) => ({ address, action }));

  const row = registrationRow(config);
  if (options.dryRun) return { written: false, row, sources: actions };
  await db.upsertRegistration(row);
  for (const step of plan) {
    if (step.action === 'pause') {
      // Conditional: a source archived since the lookup needs no pause, and is never written.
      await db.updateLiveSource(step.id as string, step.rowAddress as string, { status: SOURCE_STATUS.PAUSED });
    } else if (step.action === 'insert' || step.action === 'update') {
      await writeListedSource(db, config.tenantId, step);
    }
  }
  return { written: true, row, sources: actions };
}

/**
 * Writes one listed source. An update keeps the checkpoint, so re-registering never restarts a backfill, and is
 * conditional on the row still being the live Google source at the address the lookup saw: the member's opt-in
 * can archive it (rename, pause, stamp) between the lookup and this write, and an unconditional update would
 * reactivate the archive for the worker. A write that matches nothing re-resolves the live source of the address,
 * or creates it; the archived row is never written to.
 */
async function writeListedSource(
  db: RegistrationDb,
  tenantId: string,
  step: { address: string; owner?: string; id?: string; rowAddress?: string },
): Promise<void> {
  const fields = { owner_user_id: step.owner as string, status: SOURCE_STATUS.ACTIVE };
  let current: { id: string; address: string } | undefined =
    step.id !== undefined ? { id: step.id, address: step.rowAddress as string } : undefined;
  const resolve = async (): Promise<{ id: string; address: string } | undefined> => {
    const live = await db.findLiveSource(tenantId, step.address);
    if (live && live.provider !== MAILBOX_PROVIDER.GOOGLE) {
      throw new Error(`source ${step.address}: became a ${live.provider} source while it was written; one address has one provider`);
    }
    return live ? { id: live.id, address: live.address } : undefined;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (current) {
      if (await db.updateLiveSource(current.id, current.address, fields)) return;
      current = await resolve();
      if (current) continue;
    }
    const inserted = await db.insertSource({
      tenant_id: tenantId,
      kind: SOURCE_KIND.MAILBOX,
      provider: MAILBOX_PROVIDER.GOOGLE,
      address: step.address,
      owner_user_id: fields.owner_user_id,
      status: SOURCE_STATUS.ACTIVE,
    });
    if (inserted === 'inserted') return;
    current = await resolve(); // another writer created the address first: write to its row instead
  }
  throw new Error(`source ${step.address} kept changing while it was written; run it again`);
}

/** The RegistrationDb over a service-role client. Also the one scripts/seed-discovery.ts uses, so the lifecycle rules live once. */
export function registrationDbFor(client: SupabaseClient): RegistrationDb {
  return {
    async findCompany(id) {
      const { data, error } = await client.from(TABLE.COMPANIES).select('id, tenant_id, type').eq('id', id).maybeSingle();
      if (error) throw error;
      return data as { id: string; tenant_id: string; type: string } | null;
    },
    async upsertRegistration(row) {
      const { error } = await client.from(GOOGLE_READER_TABLE).upsert(row, { onConflict: 'tenant_id' });
      if (error) throw error;
    },
    async findInternalUser(tenantId, email) {
      const { data, error } = await client
        .from(TABLE.USERS)
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('is_external', false)
        .ilike('email', email)
        .maybeSingle();
      if (error) throw error;
      return data as { id: string } | null;
    },
    async listMailboxSources(tenantId) {
      const { data, error } = await client
        .from(TABLE.CONTENT_SOURCES)
        .select('id, provider, address, status, archived_at')
        .eq('tenant_id', tenantId)
        .eq('kind', SOURCE_KIND.MAILBOX);
      if (error) throw error;
      return ((data ?? []) as Array<Omit<SourceRecord, 'archivedAt'> & { archived_at: string | null }>).map(
        ({ archived_at, ...source }) => ({ ...source, archivedAt: archived_at }),
      );
    },
    async findLiveSource(tenantId, address) {
      const { data, error } = await client
        .from(TABLE.CONTENT_SOURCES)
        .select('id, provider, address, status')
        .eq('tenant_id', tenantId)
        .eq('kind', SOURCE_KIND.MAILBOX)
        .is('archived_at', null);
      if (error) throw error;
      return ((data ?? []) as SourceRecord[]).find((row) => row.address.toLowerCase() === address.toLowerCase()) ?? null;
    },
    async insertSource(row) {
      const { error } = await client.from(TABLE.CONTENT_SOURCES).insert(row);
      if (!error) return 'inserted';
      if (error.code === '23505') return 'exists';
      throw error;
    },
    async updateLiveSource(id, address, fields) {
      const { data, error } = await client
        .from(TABLE.CONTENT_SOURCES)
        .update(fields)
        .eq('id', id)
        .eq('address', address)
        .eq('provider', MAILBOX_PROVIDER.GOOGLE)
        .is('archived_at', null)
        .select('id');
      if (error) throw error;
      return (data ?? []).length > 0;
    },
  };
}

async function main(): Promise<void> {
  const configPath = argValue(process.argv, '--config');
  if (!configPath) throw new Error('Usage: write-registration.ts --config .secrets/google/registration.json [--dry-run]');
  const dryRun = process.argv.includes('--dry-run');
  assertSecretsFolderKeyless(resolve('.secrets'));

  const parsed = parseGoogleRegistrationConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  if (!parsed.ok) throw new Error(`Invalid registration:\n- ${parsed.errors.join('\n- ')}`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set (see .env.example)');
  console.log(`Database: ${new URL(url).host}${dryRun ? ' (dry run)' : ''}`);

  const db = registrationDbFor(createClient(url, key, { auth: { persistSession: false } }));
  const result = await applyGoogleRegistration(db, parsed.config, { dryRun });
  console.log(`${result.written ? 'Upserted' : 'Would upsert'} ${GOOGLE_READER_TABLE}:`);
  console.log(JSON.stringify(result.row, null, 2));
  if (!parsed.config.sourcesListed) console.log('  no sources listed: no source was touched');
  for (const source of result.sources) console.log(`  source ${source.address}: ${source.action}`);
}

if (process.argv[1]?.endsWith('write-registration.ts')) {
  main().catch((error: unknown) => {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
