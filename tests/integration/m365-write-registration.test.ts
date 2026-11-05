import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProvisionedUser } from '@/lib/auth/provisioning';
import { createClient } from '@supabase/supabase-js';

import { applyRegistration, parseRegistrationConfig, type RegistrationConfig } from '../../scripts/m365/write-registration';
import { createGuardedTenant, dropGuardedTenant, type GuardedTenant, type GuardedTenantEnv } from './support/guardedTenant';

/*
 * scripts/m365/write-registration.ts against a REAL database (never
 * Microsoft): it writes the registration and the explicit source list, keeps
 * checkpoints on a re-run, pauses a source dropped from the list, and refuses
 * an owner outside the tenant. It also names the firm and the mail domains the
 * allowlist joins on (#262, C7), resolving the firm to the tenant's own bank
 * company and refusing anything else before it writes.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) throw new Error('needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (local stack)');
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!publishable) throw new Error('needs NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (local stack)');
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const TENANT = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const companies = { bank: '', counterparty: '', foreignBank: '' };
const users: Array<{ id: string; email: string; tenant: string }> = [
  { id: '', email: `wr-owner-${RUN}@integration.conductia.dev`, tenant: TENANT },
  { id: '', email: `wr-outsider-${RUN}@integration.conductia.dev`, tenant: OTHER },
];

// These tests are about the firm, the domains and the source list; a mailbox with no owner is one of their
// fixtures, and tests/m365-write-registration.test.ts covers the refusal of it.
function config(sources: RegistrationConfig['sources'], over: Record<string, unknown> = {}): RegistrationConfig {
  const parsed = parseRegistrationConfig({
    firmCompany: `WR Bank ${RUN}`,
    mailboxDomains: ['bank.example'],
    tenantId: TENANT,
    msTenantId: '11111111-2222-3333-4444-555555555555',
    clientId: '66666666-7777-8888-9999-000000000000',
    certThumbprint: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    certSecretRef: 'keyvault:https://reader-vault.vault.azure.net/keys/conductia-reader/0123abcd',
    status: 'active',
    consentedAt: '2026-10-01T09:00:00Z',
    sources,
    ...over,
  }, { allowOwnerless: true });
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.config;
}

beforeAll(async () => {
  for (const [key, row] of [
    ['bank', { tenant_id: TENANT, name: `WR Bank ${RUN}`, type: 'bank' }],
    ['counterparty', { tenant_id: TENANT, name: `WR Counterparty ${RUN}`, type: 'counterparty' }],
    ['foreignBank', { tenant_id: OTHER, name: `WR Foreign Bank ${RUN}`, type: 'bank' }],
  ] as const) {
    const { data, error } = await db.from('companies').insert(row).select('id').single();
    if (error || !data) throw new Error(`company create failed: ${error?.message}`);
    companies[key] = data.id as string;
  }
  for (const user of users) {
    const created = await createProvisionedUser(db, {
      email: user.email,
      password: `Wr-${RUN}-x9!`,
      email_confirm: true,
      profile: { tenant_id: user.tenant, department: 'ib', is_external: false },
    });
    user.id = created.id;
  }
});

afterAll(async () => {
  await db.from('graph_reader_registrations').delete().eq('tenant_id', TENANT);
  for (const user of users) if (user.id) await db.auth.admin.deleteUser(user.id);
  for (const id of Object.values(companies)) if (id) await db.from('companies').delete().eq('id', id);
});

describe('write-registration', () => {
  it('plans without writing on a dry run', async () => {
    const plan = await applyRegistration(
      db,
      config([{ kind: 'mailbox', address: 'md@bank.example', ownerEmail: users[0].email }]),
      { dryRun: true },
    );
    expect(plan).toMatchObject({ registration: 'insert', sources: [{ action: 'insert', ownerUserId: users[0].id }], paused: [] });
    const { count } = await db.from('graph_reader_registrations').select('*', { count: 'exact', head: true }).eq('tenant_id', TENANT);
    expect(count).toBe(0);
  });

  it('writes the registration and the explicit sources with their owners', async () => {
    await applyRegistration(
      db,
      config([
        { kind: 'mailbox', address: 'md@bank.example', ownerEmail: users[0].email },
        { kind: 'sharepoint_site', address: 'bank.sharepoint.com:/sites/Deals', ownerEmail: null },
      ]),
    );
    const { data: registration } = await db
      .from('graph_reader_registrations')
      .select('ms_tenant_id, client_id, cert_thumbprint, cert_secret_ref, status, firm_company_id, mailbox_domains')
      .eq('tenant_id', TENANT)
      .single();
    expect(registration).toEqual({
      firm_company_id: companies.bank,
      mailbox_domains: ['bank.example'],
      ms_tenant_id: '11111111-2222-3333-4444-555555555555',
      client_id: '66666666-7777-8888-9999-000000000000',
      cert_thumbprint: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      cert_secret_ref: 'keyvault:https://reader-vault.vault.azure.net/keys/conductia-reader/0123abcd',
      status: 'active',
    });
    const { data: sources } = await db
      .from('content_sources')
      .select('kind, address, owner_user_id, status')
      .eq('tenant_id', TENANT)
      .order('address');
    expect(sources).toEqual([
      { kind: 'sharepoint_site', address: 'bank.sharepoint.com:/sites/Deals', owner_user_id: null, status: 'active' },
      { kind: 'mailbox', address: 'md@bank.example', owner_user_id: users[0].id, status: 'active' },
    ]);
  });

  // #275 (design R3): the registration names its Exchange scope group, and a re-run that names none records none,
  // which the group mirror reads as "no group" and fails closed on.
  it('records the scope group, and clears it on a re-run that names none', async () => {
    const GROUP = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111';
    const sources: RegistrationConfig['sources'] = [
      { kind: 'mailbox', address: 'md@bank.example', ownerEmail: users[0].email },
      { kind: 'sharepoint_site', address: 'bank.sharepoint.com:/sites/Deals', ownerEmail: null },
    ];
    const scopeGroup = async () =>
      (await db.from('graph_reader_registrations').select('scope_group_id').eq('tenant_id', TENANT).single()).data;

    await applyRegistration(db, config(sources, { scopeGroupId: GROUP.toUpperCase() }));
    expect(await scopeGroup()).toEqual({ scope_group_id: GROUP });

    await applyRegistration(db, config(sources));
    expect(await scopeGroup()).toEqual({ scope_group_id: null });
  });

  it('keeps checkpoints on a re-run and pauses a source dropped from the list', async () => {
    await db
      .from('content_sources')
      .update({ delta_checkpoint: 'kept', backfill_completed_at: '2026-10-02T00:00:00Z' })
      .eq('tenant_id', TENANT)
      .eq('address', 'md@bank.example');
    const plan = await applyRegistration(db, config([{ kind: 'mailbox', address: 'MD@bank.example', ownerEmail: users[0].email }]));
    expect(plan.paused).toEqual(['bank.sharepoint.com:/sites/Deals']);
    const { data: sources } = await db
      .from('content_sources')
      .select('address, status, delta_checkpoint')
      .eq('tenant_id', TENANT)
      .order('address');
    expect(sources).toEqual([
      { address: 'bank.sharepoint.com:/sites/Deals', status: 'paused', delta_checkpoint: null },
      { address: 'md@bank.example', status: 'active', delta_checkpoint: 'kept' },
    ]);
  });

  it('refuses an owner from another tenant, writing nothing', async () => {
    await expect(
      applyRegistration(db, config([{ kind: 'mailbox', address: 'x@bank.example', ownerEmail: users[1].email }])),
    ).rejects.toThrow(`no internal user in tenant ${TENANT}`);
    const { count } = await db
      .from('content_sources')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', TENANT)
      .eq('address', 'x@bank.example');
    expect(count).toBe(0);
  });

  // The opt-in adopts an ownerless mailbox source. Re-running the script (a certificate rotation, say) with
  // "ownerEmail": null must not hand the source back to nobody, or every adopted mailbox stops being read.
  it('keeps the owner a member adopted when a re-run lists the mailbox with no owner', async () => {
    await db
      .from('content_sources')
      .update({ owner_user_id: users[0].id })
      .eq('tenant_id', TENANT)
      .eq('address', 'md@bank.example');
    const plan = await applyRegistration(db, config([{ kind: 'mailbox', address: 'md@bank.example', ownerEmail: null }]));
    expect(plan.sources[0]).toMatchObject({ action: 'update', ownerUserId: users[0].id });
    const { data } = await db
      .from('content_sources')
      .select('owner_user_id')
      .eq('tenant_id', TENANT)
      .eq('address', 'md@bank.example')
      .single();
    expect(data).toEqual({ owner_user_id: users[0].id });
  });

  // C7: a registration written before #262 has no firm and no domains. Re-running the script with the new
  // fields is the backfill: it sets both and leaves the credential columns as they were.
  it('sets the firm and domains on a registration written earlier, resolving the firm by id', async () => {
    await db
      .from('graph_reader_registrations')
      .update({ firm_company_id: null, mailbox_domains: [] })
      .eq('tenant_id', TENANT);
    const plan = await applyRegistration(
      db,
      config([{ kind: 'mailbox', address: 'md@bank.example', ownerEmail: users[0].email }], {
        firmCompany: companies.bank,
        mailboxDomains: ['bank.example', 'mail.bank.example'],
      }),
    );
    expect(plan).toMatchObject({ registration: 'update', firmCompanyId: companies.bank });
    const { data } = await db
      .from('graph_reader_registrations')
      .select('firm_company_id, mailbox_domains')
      .eq('tenant_id', TENANT)
      .single();
    expect(data).toEqual({ firm_company_id: companies.bank, mailbox_domains: ['bank.example', 'mail.bank.example'] });
  });

  it('refuses a firm that is not the tenant\'s own bank company, writing nothing', async () => {
    const sources: RegistrationConfig['sources'] = [{ kind: 'mailbox', address: 'y@bank.example', ownerEmail: null }];
    for (const [firmCompany, message] of [
      [`WR Counterparty ${RUN}`, 'no company of type bank'],
      [companies.counterparty, 'no company of type bank'],
      [companies.foreignBank, 'no company of type bank'],
      [`No Such Bank ${RUN}`, 'no company of type bank'],
    ] as const) {
      await expect(applyRegistration(db, config(sources, { firmCompany }))).rejects.toThrow(message);
    }
    const { count } = await db
      .from('content_sources')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', TENANT)
      .eq('address', 'y@bank.example');
    expect(count).toBe(0);
  });

  it('matches the firm name ignoring case, as names are unique per tenant that way', async () => {
    const plan = await applyRegistration(
      db,
      config([{ kind: 'mailbox', address: 'md@bank.example', ownerEmail: null }], { firmCompany: `wr BANK ${RUN}` }),
      { dryRun: true },
    );
    expect(plan.firmCompanyId).toBe(companies.bank);
  });
});

/*
 * PR #300 round 4 (Codex 2): the member's opt-in can archive an ownerless source with stored items between the
 * script's lookup and its write. The write is conditional on the address and on the row not being archived, so the
 * archive stays paused and archived and the live source the opt-in created takes the write. The opt-in is the real
 * mailbox_consent_grant, called under the owner's own session at the moment the script's lookup resolves.
 */
describe('write-registration against an archive that lands between the lookup and the write', () => {
  const ADDRESS = 'wr-archive@bank.example';
  const env: GuardedTenantEnv = { db, url: url!, publishableKey: publishable!, run: RUN, password: `Wr-${RUN}-x9!` };
  let tenant: GuardedTenant;
  let sourceId = '';

  const sources: RegistrationConfig['sources'] = [{ kind: 'mailbox', address: ADDRESS, ownerEmail: null }];
  const configFor = () => config(sources, { tenantId: tenant.id, firmCompany: tenant.companyId });

  /** The client, with `hook` awaited once, right after the first content_sources read (the script's lookup) resolves. */
  function afterLookup(hook: () => Promise<void>) {
    let fired = false;
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const query = target.from(table);
          if (table !== 'content_sources') return query;
          return new Proxy(query, {
            get(inner, key) {
              if (key !== 'select') return Reflect.get(inner, key);
              return (...args: Parameters<typeof inner.select>) => {
                const builder = inner.select(...args) as unknown as { then: (a: unknown, b?: unknown) => Promise<unknown> };
                const original = builder.then.bind(builder);
                builder.then = (onFulfilled: unknown, onRejected?: unknown) =>
                  original(async (value: unknown) => {
                    if (!fired) {
                      fired = true;
                      await hook();
                    }
                    return value;
                  }).then(onFulfilled as never, onRejected as never);
                return builder;
              };
            },
          });
        };
      },
    }) as typeof db;
  }

  beforeAll(async () => {
    tenant = await createGuardedTenant(env, 'wra', [ADDRESS]);
    // The script writes the registration and the ownerless source: the earlier holder's mailbox.
    await applyRegistration(db, configFor());
    const source = await db.from('content_sources').select('id').eq('tenant_id', tenant.id).eq('address', ADDRESS).single();
    if (source.error) throw new Error(`source failed: ${source.error.message}`);
    sourceId = source.data.id as string;
    const item = await db
      .from('source_items')
      .insert({ tenant_id: tenant.id, kind: 'message', subject: 'Earlier holder', content_hash: 'h', internet_message_id: `<wra-${RUN}@old>` })
      .select('id')
      .single();
    if (item.error) throw new Error(`item failed: ${item.error.message}`);
    const link = await db
      .from('source_item_sources')
      .insert({ source_item_id: item.data.id, content_source_id: sourceId, provider_item_id: 'p1' });
    if (link.error) throw new Error(`provenance failed: ${link.error.message}`);
  }, 120_000);

  afterAll(async () => {
    if (!tenant) return;
    await dropGuardedTenant(env, tenant);
    await db.from('content_sources').delete().eq('tenant_id', tenant.id);
  });

  it('leaves the archive paused and archived and writes the live source the opt-in created', async () => {
    const optIn = async () => {
      const { error } = await tenant.sessions[0].rpc('mailbox_consent_grant');
      if (error) throw new Error(`consent failed: ${error.message}`);
    };
    await applyRegistration(afterLookup(optIn), configFor());

    const { data } = await db
      .from('content_sources')
      .select('id, address, status, owner_user_id, archived_at')
      .eq('tenant_id', tenant.id);
    const archived = data?.find((row) => row.id === sourceId);
    expect(archived?.address).toMatch(/^wr-archive@bank\.example~[a-z0-9]{3}$/);
    expect(archived).toMatchObject({ status: 'paused', owner_user_id: null });
    expect(archived?.archived_at).not.toBeNull();
    const live = data?.filter((row) => row.id !== sourceId) ?? [];
    expect(live).toHaveLength(1);
    // The opt-in's fresh source, owned by the member and active; the ownerless config did not take the owner away.
    expect(live[0]).toMatchObject({ address: ADDRESS, status: 'active', owner_user_id: tenant.ownerIds[0], archived_at: null });
  });
});
