import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  REGISTRATION_STATUS,
  SOURCE_KIND,
  SOURCE_STATUS,
  type RegistrationStatus,
  type SourceKind,
} from '../../src/lib/constants/discovery';
import { TABLE } from '../../src/lib/constants/tables';
import { normalizeThumbprint, parseKeyVaultKeyId } from '../../src/lib/graph/registration';

// Step 3 of scripts/m365/README.md: record a bank tenant's Graph reader
// registration and its explicit list of content sources in Conductia
// (ADR-005, design Q3, Q4, Q6). It writes two tables in Conductia's database
// with the service role and never contacts Microsoft.
//
//   node --env-file=<env> --import tsx scripts/m365/write-registration.ts --config <file.json> [--dry-run] [--allow-env-pem] [--allow-ownerless]
//
// The config (register-reader.ps1 writes a starting point; an admin completes
// it, and keeps it outside the repo):
//
//   {
//     "tenantId": "<Conductia tenant uuid>",
//     "msTenantId": "<the bank's Entra tenant id>",
//     "clientId": "<the reader app's application id>",
//     "certThumbprint": "<SHA-256 (or SHA-1) hex of the uploaded certificate>",
//     "certSecretRef": "keyvault:https://<vault>.vault.azure.net/keys/<name>/<version>",
//     "status": "active",
//     "consentedAt": "2026-10-01T09:00:00Z",
//     "firmCompany": "<the bank's company in Conductia: its id or its name>",
//     "mailboxDomains": ["bank.example"],
//     "scopeGroupId": "<the Exchange scope group's Entra object id>",
//     "sources": [
//       { "kind": "mailbox", "address": "md@bank.example", "ownerEmail": "md@bank.example" },
//       { "kind": "sharepoint_site", "address": "bank.sharepoint.com,<guid>,<guid>", "ownerEmail": null }
//     ]
//   }
//
// Ownership is explicit (the phase 3 rule): each source names the Conductia
// user who owns it, or null. Nothing is inferred from the mailbox address, so
// "ownerEmail" must be present on every source. A mailbox is read for one
// person, and the mailbox guard refuses a mailbox source with no owner
// (owner_mismatch, #262), so a mailbox with "ownerEmail": null is refused here
// too, unless --allow-ownerless says the operator means it: the script then
// warns, and the mailbox is read only after its member opts in on their profile,
// which adopts the source. A site has no per-person owner; null is normal there.
// The list is authoritative: a configured source missing from it is paused,
// never deleted (its checkpoint and ledger stay).
//
// The firm and the domains are what the mailbox allowlist joins on (#262): a
// mailbox is read only when its address is on one of mailboxDomains and its
// owner is seated in firmCompany, so a registration that names neither reads
// nothing. firmCompany is resolved to the tenant's own company of type bank, by
// id or by name, and the script refuses one that matches none.
// Re-running it on a registration written earlier sets both.
//
// scopeGroupId names the mail-enabled security group that limits the reader's
// Application Mail.Read (RBAC for Applications), by its Entra object id
// (ExternalDirectoryObjectId, which register-reader.ps1 writes into the starting
// config). The Exchange group mirror (#275) compares that group's members with
// the allowlist on every pass. It is optional here, and a config without it
// records none: with no group recorded the mirror fails closed and no Microsoft
// mailbox is read, so a re-run must keep naming it.
//
// cert_secret_ref names a key and never holds one. An env: reference (a PEM in
// the worker's environment) is the fallback for the Conductia-owned test
// tenant only (Q17), so it needs --allow-env-pem.

export type SourceConfig = { kind: SourceKind; address: string; ownerEmail: string | null };

export type RegistrationConfig = {
  tenantId: string;
  msTenantId: string;
  clientId: string;
  certThumbprint: string;
  certSecretRef: string;
  status: RegistrationStatus;
  consentedAt: string | null;
  /** The bank's company, by id or name; applyRegistration resolves it to a company id. */
  firmCompany: string;
  /** Lower-cased, de-duplicated mail domains the registration reads. */
  mailboxDomains: string[];
  /** The Exchange scope group's Entra object id, lower-cased; null when the config names none (the mirror then fails closed). */
  scopeGroupId: string | null;
  sources: SourceConfig[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A mail domain: dot-separated labels, no address, scheme or path. */
const DOMAIN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** A Graph site id (host,guid,guid) or host:/sites/path. */
const SITE = /^[a-z0-9.-]+\.sharepoint\.(com|us|cn|de)(,[0-9a-f-]{36},[0-9a-f-]{36}|:\/(sites|teams)\/[^\s]+)$/i;

/** The mail domains of a registration: lower-cased and de-duplicated; an address, a url or an empty list is an error. */
export function normalizeMailboxDomains(raw: unknown): { domains: string[]; errors: string[] } {
  const errors: string[] = [];
  const domains: string[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push('mailboxDomains must list the mail domains the registration reads (for example ["bank.example"]): a registration that lists none reads nothing');
  } else {
    raw.forEach((entry, index) => {
      const domain = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
      if (!DOMAIN.test(domain)) errors.push(`mailboxDomains[${index}] must be a mail domain such as bank.example, not an address or a url`);
      else if (!domains.includes(domain)) domains.push(domain);
    });
  }
  return { domains, errors };
}

export function parseRegistrationConfig(
  raw: unknown,
  options: { allowEnvPem?: boolean; allowOwnerless?: boolean } = {},
): { ok: true; config: RegistrationConfig; warnings: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const value = (raw ?? {}) as Record<string, unknown>;
  const text = (key: string): string => (typeof value[key] === 'string' ? (value[key] as string).trim() : '');

  if (JSON.stringify(raw ?? {}).includes('-----BEGIN')) {
    return { ok: false, errors: ['The config holds key material. It must only name where the key is.'] };
  }

  const tenantId = text('tenantId');
  const msTenantId = text('msTenantId');
  const clientId = text('clientId');
  if (!UUID.test(tenantId)) errors.push('tenantId must be the Conductia tenant uuid');
  if (!UUID.test(msTenantId)) errors.push('msTenantId must be the bank\'s Entra tenant id (a GUID), never common');
  if (!UUID.test(clientId)) errors.push('clientId must be the reader app\'s application id (a GUID)');

  let certThumbprint = '';
  try {
    certThumbprint = normalizeThumbprint(text('certThumbprint'));
  } catch (error) {
    errors.push((error as Error).message);
  }

  const certSecretRef = text('certSecretRef');
  if (certSecretRef.startsWith('keyvault:')) {
    try {
      parseKeyVaultKeyId(certSecretRef.slice('keyvault:'.length));
    } catch (error) {
      errors.push(`certSecretRef: ${(error as Error).message}`);
    }
  } else if (certSecretRef.startsWith('env:')) {
    if (!/^env:[A-Z][A-Z0-9_]*$/.test(certSecretRef)) errors.push('certSecretRef env: must name an environment variable');
    if (!options.allowEnvPem) {
      errors.push('An env: certificate is for the Conductia test tenant only; pass --allow-env-pem to confirm');
    }
  } else {
    errors.push('certSecretRef must be keyvault:<key id> or env:<VARIABLE>');
  }

  const status = (text('status') || REGISTRATION_STATUS.PENDING) as RegistrationStatus;
  if (!Object.values(REGISTRATION_STATUS).includes(status)) errors.push(`status must be one of ${Object.values(REGISTRATION_STATUS).join(', ')}`);
  const consentedAt = text('consentedAt') || null;
  if (consentedAt && !Number.isFinite(Date.parse(consentedAt))) errors.push('consentedAt must be an ISO date');
  if (status === REGISTRATION_STATUS.ACTIVE && !consentedAt) errors.push('An active registration needs consentedAt (admin consent given)');

  const firmCompany = text('firmCompany');
  if (!firmCompany) {
    errors.push("firmCompany must name the bank's company in Conductia (its id or name): a registration that names no firm reads nothing");
  }
  const domains = normalizeMailboxDomains(value.mailboxDomains);
  errors.push(...domains.errors);
  const mailboxDomains = domains.domains;

  // Absent or null records no group. Anything else must be the group's object id, never its address or name.
  let scopeGroupId: string | null = null;
  if (value.scopeGroupId !== undefined && value.scopeGroupId !== null) {
    const id = typeof value.scopeGroupId === 'string' ? value.scopeGroupId.trim() : '';
    if (UUID.test(id)) scopeGroupId = id.toLowerCase();
    else errors.push("scopeGroupId must be the scope group's Entra object id (a GUID), not its address or name");
  }

  const sources: SourceConfig[] = [];
  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    errors.push('sources must list every in-scope mailbox and site explicitly');
  } else {
    const seen = new Set<string>();
    value.sources.forEach((entry, index) => {
      const source = (entry ?? {}) as Record<string, unknown>;
      const kind = source.kind as SourceKind;
      const address = typeof source.address === 'string' ? source.address.trim() : '';
      if (!Object.values(SOURCE_KIND).includes(kind)) errors.push(`sources[${index}].kind must be mailbox or sharepoint_site`);
      if (kind === SOURCE_KIND.MAILBOX && !EMAIL.test(address)) errors.push(`sources[${index}].address must be a mailbox address`);
      if (kind === SOURCE_KIND.SHAREPOINT_SITE && !SITE.test(address)) {
        errors.push(`sources[${index}].address must be a Graph site id or host:/sites/path`);
      }
      if (!('ownerEmail' in source)) {
        errors.push(`sources[${index}].ownerEmail must be given (a Conductia user's email, or null): ownership is never inferred`);
      } else if (source.ownerEmail !== null && (typeof source.ownerEmail !== 'string' || !EMAIL.test(source.ownerEmail))) {
        errors.push(`sources[${index}].ownerEmail must be an email or null`);
      }
      if (kind === SOURCE_KIND.MAILBOX && source.ownerEmail === null) {
        if (options.allowOwnerless) {
          warnings.push(
            `sources[${index}] ${address} has no owner: the mailbox guard refuses it until the member opts in on their profile (the opt-in adopts it). ` +
              'Nothing is read from it before then.',
          );
        } else {
          errors.push(
            `sources[${index}].ownerEmail must name the Conductia user who owns ${address}: the mailbox guard refuses a mailbox source with no owner (owner_mismatch). ` +
              'Pass --allow-ownerless to write it anyway and let the member adopt it by opting in.',
          );
        }
      }
      const key = `${kind}:${address.toLowerCase()}`;
      if (seen.has(key)) errors.push(`sources[${index}] repeats ${address}`);
      seen.add(key);
      sources.push({
        kind,
        address,
        ownerEmail: typeof source.ownerEmail === 'string' ? source.ownerEmail.trim().toLowerCase() : null,
      });
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      tenantId,
      msTenantId,
      clientId,
      certThumbprint,
      certSecretRef,
      status,
      consentedAt,
      firmCompany,
      mailboxDomains,
      scopeGroupId,
      sources,
    },
    warnings,
  };
}

export type RegistrationPlan = {
  registration: 'insert' | 'update';
  /** The resolved firm company id the registration will name. */
  firmCompanyId: string;
  sources: Array<{ address: string; kind: SourceKind; action: 'insert' | 'update'; ownerUserId: string | null }>;
  paused: string[];
};

/**
 * The tenant's own company of type bank that `firmCompany` names, by id or by name (names are unique per
 * tenant, ignoring case). The allowlist counts only such a company as the firm (reader_firm_company_ids), so
 * anything else is refused here rather than written as a registration that reads nothing.
 */
export async function resolveFirmCompany(db: SupabaseClient, tenantId: string, firmCompany: string): Promise<string> {
  const { data, error } = await db.from(TABLE.COMPANIES).select('id, name').eq('tenant_id', tenantId).eq('type', 'bank');
  if (error) throw new Error(`write-registration: firm company lookup failed: ${error.message}`);
  const wanted = firmCompany.trim().toLowerCase();
  const match = ((data ?? []) as Array<{ id: string; name: string }>).find(
    (row) => row.id === wanted || row.name.trim().toLowerCase() === wanted,
  );
  if (!match) {
    throw new Error(
      `write-registration: tenant ${tenantId} has no company of type bank matching firmCompany "${firmCompany}". ` +
        'Name the bank company by its id or its name.',
    );
  }
  return match.id;
}

type SourceRow = { id: string; kind: SourceKind; address: string; status: string; owner_user_id: string | null };

/** The live (not archived) source of a tenant's kind and address, matched ignoring case, or undefined. */
async function liveSource(
  db: SupabaseClient,
  tenantId: string,
  kind: SourceKind,
  address: string,
  fail: (step: string, error: { message: string } | null) => void,
): Promise<SourceRow | undefined> {
  const { data, error } = await db
    .from(TABLE.CONTENT_SOURCES)
    .select('id, kind, address, status, owner_user_id')
    .eq('tenant_id', tenantId)
    .eq('kind', kind)
    .is('archived_at', null);
  fail('source re-lookup', error);
  return ((data ?? []) as SourceRow[]).find((row) => row.address.toLowerCase() === address.toLowerCase());
}

/** Resolves owners and writes the registration and sources (or only plans it, with dryRun). */
export async function applyRegistration(
  db: SupabaseClient,
  config: RegistrationConfig,
  options: { dryRun?: boolean } = {},
): Promise<RegistrationPlan> {
  const fail = (step: string, error: { message: string } | null) => {
    if (error) throw new Error(`write-registration: ${step} failed: ${error.message}`);
  };

  const firmCompanyId = await resolveFirmCompany(db, config.tenantId, config.firmCompany);

  // Owners: internal users of this tenant, named explicitly.
  const ownerIds = new Map<string, string>();
  const emails = [...new Set(config.sources.map((s) => s.ownerEmail).filter((e): e is string => e !== null))];
  if (emails.length > 0) {
    const { data, error } = await db
      .from(TABLE.USERS)
      .select('id, email, tenant_id, is_external')
      .in('email', emails);
    fail('owner lookup', error);
    for (const row of (data ?? []) as Array<{ id: string; email: string; tenant_id: string; is_external: boolean }>) {
      if (row.tenant_id === config.tenantId && !row.is_external) ownerIds.set(row.email.toLowerCase(), row.id);
    }
    const missing = emails.filter((email) => !ownerIds.has(email));
    if (missing.length > 0) {
      throw new Error(`write-registration: no internal user in tenant ${config.tenantId} for ${missing.join(', ')}`);
    }
  }

  const { data: existingRegistration, error: registrationLookupError } = await db
    .from(TABLE.GRAPH_READER_REGISTRATIONS)
    .select('tenant_id')
    .eq('tenant_id', config.tenantId)
    .maybeSingle();
  fail('registration lookup', registrationLookupError);

  const { data: existingSources, error: sourceLookupError } = await db
    .from(TABLE.CONTENT_SOURCES)
    .select('id, kind, address, status, owner_user_id, archived_at')
    .eq('tenant_id', config.tenantId);
  fail('source lookup', sourceLookupError);
  // An archived source (mailbox_consent_grant renamed it <address>~xyz and paused it) is no one's to configure: it is
  // never matched by an address, never written, and needs no pausing.
  const existing = ((existingSources ?? []) as Array<SourceRow & { archived_at: string | null }>).filter(
    (row) => row.archived_at === null || row.archived_at === undefined,
  );
  const keyOf = (kind: string, address: string) => `${kind}:${address.toLowerCase()}`;
  const byKey = new Map(existing.map((row) => [keyOf(row.kind, row.address), row]));
  const wanted = new Set(config.sources.map((s) => keyOf(s.kind, s.address)));

  const plan: RegistrationPlan = {
    registration: existingRegistration ? 'update' : 'insert',
    firmCompanyId,
    sources: config.sources.map((s) => {
      const row = byKey.get(keyOf(s.kind, s.address));
      return {
        address: s.address,
        kind: s.kind,
        action: row ? 'update' : 'insert',
        // A mailbox listed with no owner keeps the owner it already has: the member's opt-in adopts an ownerless
        // mailbox source, and a re-run (a certificate rotation, say) must not hand it back to nobody.
        ownerUserId: s.ownerEmail
          ? ownerIds.get(s.ownerEmail)!
          : s.kind === SOURCE_KIND.MAILBOX
            ? (row?.owner_user_id ?? null)
            : null,
      };
    }),
    paused: existing
      .filter((row) => !wanted.has(keyOf(row.kind, row.address)) && row.status !== SOURCE_STATUS.PAUSED)
      .map((row) => row.address),
  };
  if (options.dryRun) return plan;

  const { error: registrationError } = await db.from(TABLE.GRAPH_READER_REGISTRATIONS).upsert(
    {
      tenant_id: config.tenantId,
      ms_tenant_id: config.msTenantId,
      client_id: config.clientId,
      cert_thumbprint: config.certThumbprint,
      cert_secret_ref: config.certSecretRef,
      status: config.status,
      consented_at: config.consentedAt,
      firm_company_id: firmCompanyId,
      mailbox_domains: config.mailboxDomains,
      scope_group_id: config.scopeGroupId,
    },
    { onConflict: 'tenant_id' },
  );
  fail('registration upsert', registrationError);

  for (const [index, source] of plan.sources.entries()) {
    // An existing mailbox listed with no owner leaves owner_user_id OUT of the update, so the database keeps the
    // value it holds NOW: a member's opt-in can adopt the source between the lookup above and this write, and the
    // lookup's value (null) must not overwrite that. The plan still shows the owner seen at lookup time.
    const keepsOwner = source.kind === SOURCE_KIND.MAILBOX && config.sources[index].ownerEmail === null;
    const update = keepsOwner
      ? { status: SOURCE_STATUS.ACTIVE }
      : { owner_user_id: source.ownerUserId, status: SOURCE_STATUS.ACTIVE };
    // An update keeps the checkpoint: re-registering never restarts a backfill. It is conditional on the address the
    // lookup saw and on the row not being archived: the member's opt-in can archive the row (rename, pause, stamp)
    // between the lookup and this write, and an unconditional update would reactivate the archive for the worker.
    // A write that matches nothing re-resolves the live source of the address, or creates it; the archived row is
    // never written to.
    let current: SourceRow | undefined = byKey.get(keyOf(source.kind, source.address));
    let written = false;
    for (let attempt = 0; attempt < 3 && !written; attempt++) {
      if (current) {
        const { data, error } = await db
          .from(TABLE.CONTENT_SOURCES)
          .update(update)
          .eq('id', current.id)
          .eq('address', current.address)
          .is('archived_at', null)
          .select('id');
        fail(`source ${source.address}`, error);
        if ((data ?? []).length > 0) {
          written = true;
          break;
        }
        current = await liveSource(db, config.tenantId, source.kind, source.address, fail);
        if (current) continue;
      }
      const { error } = await db.from(TABLE.CONTENT_SOURCES).insert({
        tenant_id: config.tenantId,
        kind: source.kind,
        address: source.address,
        owner_user_id: source.ownerUserId,
        status: SOURCE_STATUS.ACTIVE,
      });
      if (!error) {
        written = true;
      } else if (error.code === '23505') {
        // Another writer created the address first: write to its row instead.
        current = await liveSource(db, config.tenantId, source.kind, source.address, fail);
      } else {
        fail(`source ${source.address}`, error);
      }
    }
    if (!written) throw new Error(`write-registration: source ${source.address} kept changing while it was written; run it again`);
  }
  for (const address of plan.paused) {
    const row = existing.find((r) => r.address === address)!;
    const { error } = await db.from(TABLE.CONTENT_SOURCES).update({ status: SOURCE_STATUS.PAUSED }).eq('id', row.id);
    fail(`pause ${address}`, error);
  }
  return plan;
}

async function main(argv: string[]): Promise<void> {
  const at = argv.indexOf('--config');
  const path = at === -1 ? null : argv[at + 1];
  if (!path) throw new Error('Usage: write-registration.ts --config <file.json> [--dry-run] [--allow-env-pem] [--allow-ownerless]');
  const parsed = parseRegistrationConfig(JSON.parse(readFileSync(resolve(path), 'utf8')), {
    allowEnvPem: argv.includes('--allow-env-pem'),
    allowOwnerless: argv.includes('--allow-ownerless'),
  });
  if (!parsed.ok) {
    for (const error of parsed.errors) console.error(`- ${error}`);
    throw new Error('The registration config is not valid. Nothing was written.');
  }
  for (const warning of parsed.warnings) console.warn(`warning: ${warning}`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
  const db = createClient(url, key, { auth: { persistSession: false } });

  const dryRun = argv.includes('--dry-run');
  const plan = await applyRegistration(db, parsed.config, { dryRun });
  console.log(`${dryRun ? 'Would write' : 'Wrote'} the reader registration for tenant ${parsed.config.tenantId} (${plan.registration}).`);
  console.log(`  firm company ${plan.firmCompanyId}, mailbox domains ${parsed.config.mailboxDomains.join(', ')}`);
  console.log(`  scope group ${parsed.config.scopeGroupId ?? 'none recorded: the Exchange group mirror reads no mailbox without it'}`);
  for (const source of plan.sources) {
    console.log(`  ${source.action} ${source.kind} ${source.address} -> ${source.ownerUserId ?? 'no owner'}`);
  }
  for (const address of plan.paused) console.log(`  pause ${address} (not in the list)`);
}

if (process.argv[1]?.endsWith('write-registration.ts')) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
