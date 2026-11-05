import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { MAILBOX_PROVIDER, SOURCE_KIND } from '@/lib/constants/discovery';
import {
  createGuardedContentSource,
  MailboxAccessRefusedError,
  type ContentSource,
  type SourceItemPage,
  type SourceRow,
} from '@/lib/mailboxAccess';
import { createUserProvisioned } from './support/provisioned';

/*
 * The SharePoint site guard (#262, R23), against a REAL database. A site is
 * read only while an active, internal firm admin of the bank's own firm holds
 * an open registration for its address:
 *
 *   stub sharepoint_site ContentSource -> createGuardedContentSource ->
 *   site_guard_check (service role); the admin registers and unregisters
 *   through their own signed-in session (site_register, site_unregister).
 *
 * What is real: the guard, the SQL functions, the audit rows, Postgres and
 * the admin's session. What is stubbed: the provider reader (#243's drive
 * reader does not exist here), which yields three pages.
 *
 * Self-contained: a throwaway tenant, bank company and admin. registered_sites
 * is append-only and names the admin and the company, and the admin owns
 * user-actor audit rows, so teardown suspends and unseats the admin instead of
 * deleting them, and the company row stays behind.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !secret || !publishable) {
  throw new Error(
    'The site guard test needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and ' +
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (local `supabase start` stack).',
  );
}
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const TENANT = crypto.randomUUID();
const PASSWORD = `SiteGuard-${RUN}-x9!`;
const ADMIN_EMAIL = `sg-admin-${RUN}@integration.conductia.dev`;
const ADDRESS = `bank.sharepoint.com:/sites/deals-${RUN}`;

let adminId = '';
let companyId = '';
let admin: SupabaseClient;
let sourceRow: SourceRow;

/** Stands in for #243's drive reader: three pages of a sharepoint_site source. */
function siteStub() {
  const stub = { opened: 0, nexts: 0 };
  const inner: ContentSource = {
    kind: SOURCE_KIND.SHAREPOINT_SITE,
    backfill() {
      stub.opened += 1;
      return {
        [Symbol.asyncIterator]() {
          let page = 0;
          return {
            async next() {
              stub.nexts += 1;
              page += 1;
              if (page > 3) return { done: true as const, value: undefined };
              return { done: false as const, value: { items: [], nextCheckpoint: `site:${page}` } as SourceItemPage };
            },
          };
        },
      };
    },
    delta() {
      throw new Error('not used');
    },
  };
  return { inner, stub };
}

async function refusalRows(): Promise<number> {
  const { count, error } = await db
    .from('audit_log')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', TENANT)
    .eq('action', 'discovery.site_refused');
  if (error) throw new Error(`audit count failed: ${error.message}`);
  return count ?? 0;
}

beforeAll(async () => {
  const { data, error } = await createUserProvisioned(db, {
    email: ADMIN_EMAIL,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { tenant_id: TENANT, department: 'admin' },
  });
  if (error || !data.user) throw new Error(`auth user create failed: ${error?.message}`);
  adminId = data.user.id;
  const claim = await db
    .from('users')
    .update({ tenant_id: TENANT, status: 'active', firm_role: 'admin', is_external: false })
    .eq('id', adminId);
  if (claim.error) throw new Error(`user claim failed: ${claim.error.message}`);

  const company = await db
    .from('companies')
    .insert({ tenant_id: TENANT, name: `Site Guard Bank ${RUN}`, type: 'bank' })
    .select('id')
    .single();
  if (company.error) throw new Error(`bank company failed: ${company.error.message}`);
  companyId = company.data.id as string;
  const seat = await db.from('users').update({ company_id: companyId, company_role: 'director' }).eq('id', adminId);
  if (seat.error) throw new Error(`seating the admin failed: ${seat.error.message}`);

  const registration = await db.from('graph_reader_registrations').insert({
    tenant_id: TENANT,
    ms_tenant_id: 'fixture',
    client_id: 'fixture',
    status: 'active',
    mailbox_domains: ['bank.example'],
    firm_company_id: companyId,
  });
  if (registration.error) throw new Error(`registration failed: ${registration.error.message}`);

  const source = await db
    .from('content_sources')
    .insert({ tenant_id: TENANT, kind: 'sharepoint_site', address: ADDRESS })
    .select('id')
    .single();
  if (source.error) throw new Error(`content source failed: ${source.error.message}`);
  sourceRow = {
    id: source.data.id as string,
    tenantId: TENANT,
    kind: SOURCE_KIND.SHAREPOINT_SITE,
    provider: MAILBOX_PROVIDER.MICROSOFT,
    address: ADDRESS,
    ownerUserId: null,
    deltaCheckpoint: null,
  };

  admin = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await admin.auth.signInWithPassword({ email: ADMIN_EMAIL, password: PASSWORD });
  if (signIn.error) throw new Error(`sign-in failed: ${signIn.error.message}`);
});

afterAll(async () => {
  await admin?.auth.signOut();
  // content_sources go first: a registration with sources cannot be deleted (on
  // delete restrict, #259 plan D1). registered_sites cannot be deleted
  // (append-only) and keeps the admin and the company alive.
  await db.from('content_sources').delete().eq('tenant_id', TENANT);
  await db.from('graph_reader_registrations').delete().eq('tenant_id', TENANT);
  await db.from('mailbox_guard_state').delete().eq('tenant_id', TENANT);
  if (adminId) {
    const { error } = await db.auth.admin.deleteUser(adminId);
    if (error) {
      await db.from('users').update({ status: 'suspended', company_id: null, company_role: null }).eq('id', adminId);
    }
  }
  if (companyId) await db.from('companies').delete().eq('id', companyId);
});

async function readAll(reader: ContentSource): Promise<SourceItemPage[]> {
  const pages: SourceItemPage[] = [];
  for await (const page of reader.backfill(sourceRow, null)) pages.push(page);
  return pages;
}

describe('site guard: a firm admin registers a SharePoint site, the guard reads it', () => {
  it('refuses an unregistered site before the first page, with one site_refused row', async () => {
    const { inner, stub } = siteStub();
    const reader = createGuardedContentSource(inner, { tenantId: TENANT });
    const error = await readAll(reader).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailboxAccessRefusedError);
    expect(error).toMatchObject({ reason: 'site_not_registered', purpose: 'provider_read', address: ADDRESS });
    expect(stub.opened).toBe(0);
    expect(await refusalRows()).toBe(1);
  });

  it('reads all three pages once the admin has registered the site', async () => {
    const { data, error } = await admin.rpc('site_register', { p_address: ADDRESS });
    expect(error).toBeNull();
    expect(data).toMatchObject({ registered: true, address: ADDRESS });

    const { inner, stub } = siteStub();
    const reader = createGuardedContentSource(inner, { tenantId: TENANT });
    expect(await readAll(reader)).toHaveLength(3);
    expect(stub.nexts).toBe(4);
    expect(await refusalRows()).toBe(1);

    const { data: audit } = await db
      .from('audit_log')
      .select('actor_type, actor_id')
      .eq('tenant_id', TENANT)
      .eq('action', 'discovery.site_registered');
    expect(audit).toEqual([{ actor_type: 'user', actor_id: adminId }]);
  });

  it('stops the next page after the admin unregisters, with exactly one new audit row', async () => {
    const { inner, stub } = siteStub();
    const reader = createGuardedContentSource(inner, { tenantId: TENANT });
    const pages: SourceItemPage[] = [];
    const before = await refusalRows();
    let refusal: unknown = null;
    try {
      for await (const page of reader.backfill(sourceRow, null)) {
        pages.push(page);
        if (pages.length === 1) {
          const { error } = await admin.rpc('site_unregister', { p_address: ADDRESS });
          expect(error).toBeNull();
        }
      }
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toBeInstanceOf(MailboxAccessRefusedError);
    expect(refusal).toMatchObject({ reason: 'registration_inactive' });
    expect(pages).toHaveLength(1);
    expect(stub.nexts).toBe(1);
    expect(await refusalRows()).toBe(before + 1);

    // A second pass is refused again and adds no row (provider_read audits on change).
    const again = siteStub();
    const secondReader = createGuardedContentSource(again.inner, { tenantId: TENANT });
    await expect(readAll(secondReader)).rejects.toMatchObject({ reason: 'registration_inactive' });
    expect(again.stub.opened).toBe(0);
    expect(await refusalRows()).toBe(before + 1);

    const { data: audit } = await db
      .from('audit_log')
      .select('actor_type, actor_id')
      .eq('tenant_id', TENANT)
      .eq('action', 'discovery.site_unregistered');
    expect(audit).toEqual([{ actor_type: 'user', actor_id: adminId }]);
  });

  it('reads all three pages again after the admin re-registers', async () => {
    const { error } = await admin.rpc('site_register', { p_address: ADDRESS });
    expect(error).toBeNull();
    const { inner } = siteStub();
    const reader = createGuardedContentSource(inner, { tenantId: TENANT });
    expect(await readAll(reader)).toHaveLength(3);
    const { count } = await db
      .from('registered_sites')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', TENANT)
      .eq('address', ADDRESS);
    expect(count).toBe(2);
  });
});
