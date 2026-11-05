import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createUserProvisioned } from './provisioned';

/*
 * A throwaway tenant set up the way the #262 allowlist admits a mailbox, for the integration tests that read
 * through the guard: a bank company, one seated owner per mailbox plus a firm admin, an accepted invite per
 * mailbox (email = the mailbox address), and each owner's own opt-in under their signed-in session
 * (mailbox_consent_grant, which no other writer can do). The reader registration is the caller's: it
 * names the firm and the mail domain (registerFixtureReader), or is written by the script under test.
 * The opt-in needs MD or deal team on a deal of the tenant (#262 round 3, A2), so each owner is seated on one
 * throwaway deal as deal_team (`ownerDealRole` says otherwise; null seats no one).
 * Nothing here weakens the guard; it is the production path, run against a local stack.
 */

export type GuardedTenant = {
  id: string;
  companyId: string;
  /** The mailbox owners, in `mailboxes` order. */
  ownerIds: string[];
  adminId: string;
  /** The throwaway deal the owners are seated on, or null when none was. */
  dealId: string | null;
  /** Every user id, owners then the admin. */
  userIds: string[];
  mailboxes: string[];
  /** Signed-in sessions, owners then the admin. */
  sessions: SupabaseClient[];
};

export type GuardedTenantEnv = {
  db: SupabaseClient;
  url: string;
  publishableKey: string;
  run: string;
  password: string;
};

async function signInAs(env: GuardedTenantEnv, email: string): Promise<SupabaseClient> {
  const client = createClient(env.url, env.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: env.password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}

/**
 * One deal of the tenant, banked by the firm, with each user a member in `dealRole`. The one-click opt-in needs
 * MD or deal team on a deal of the tenant (#262 round 3, A2); the integration suites that build their own tenants
 * call this before their owners opt in. dropGuardedTenant removes the deal.
 */
export async function seatOnDeal(
  db: SupabaseClient,
  seat: { tenantId: string; bankId: string; code: string; userIds: string[]; dealRole?: 'md' | 'deal_team' },
): Promise<string> {
  const dealRole = seat.dealRole ?? 'deal_team';
  const deal = await db
    .from('deals')
    .insert({ tenant_id: seat.tenantId, code: seat.code.slice(0, 80), codename: 'Integration fixture', bank_id: seat.bankId })
    .select('id')
    .single();
  if (deal.error) throw new Error(`deal failed: ${deal.error.message}`);
  await addDealMembers(db, deal.data.id as string, seat.userIds, dealRole);
  return deal.data.id as string;
}

/**
 * Members of a deal in `dealRole`. A user who loses the company loses their memberships (the removal cascade), so a
 * test that re-seats someone calls this again before they opt in.
 */
export async function addDealMembers(
  db: SupabaseClient,
  dealId: string,
  userIds: string[],
  dealRole: 'md' | 'deal_team' = 'deal_team',
): Promise<void> {
  const role = await db.from('roles').select('id').eq('slug', dealRole).single();
  if (role.error) throw new Error(`role lookup failed: ${role.error.message}`);
  const { error } = await db
    .from('deal_memberships')
    .insert(userIds.map((userId) => ({ deal_id: dealId, user_id: userId, role_id: role.data.id, deal_role: dealRole })));
  if (error) throw new Error(`deal membership failed: ${error.message}`);
}

/** The bank company, the seated users and the accepted invites. No registration, no consent yet. */
export async function createGuardedTenant(
  env: GuardedTenantEnv,
  label: string,
  mailboxes: string[],
  ownerDealRole: 'md' | 'deal_team' | null = 'deal_team',
): Promise<GuardedTenant> {
  const { db, run } = env;
  const id = crypto.randomUUID();
  const company = await db
    .from('companies')
    .insert({ tenant_id: id, name: `Guarded Bank ${label} ${run}`, type: 'bank' })
    .select('id')
    .single();
  if (company.error) throw new Error(`bank company failed: ${company.error.message}`);
  const companyId = company.data.id as string;

  // The first owner is seated as director: a company holds no member without one.
  const people = [
    ...mailboxes.map((_, index) => ({ email: `dd-${label}-${index}-${run}@integration.conductia.dev`, admin: false })),
    { email: `dd-${label}-admin-${run}@integration.conductia.dev`, admin: true },
  ];
  const userIds: string[] = [];
  for (const [index, person] of people.entries()) {
    const { data, error } = await createUserProvisioned(db, {
      email: person.email,
      password: env.password,
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

  const { error: inviteError } = await db.from('invites').insert(
    mailboxes.map((address, index) => ({
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

  const dealId = ownerDealRole
    ? await seatOnDeal(db, {
        tenantId: id,
        bankId: companyId,
        code: `GT-${label}-${run}`,
        userIds: userIds.slice(0, mailboxes.length),
        dealRole: ownerDealRole,
      })
    : null;

  const sessions: SupabaseClient[] = [];
  for (const person of people) sessions.push(await signInAs(env, person.email));
  return {
    id,
    companyId,
    ownerIds: userIds.slice(0, mailboxes.length),
    adminId: userIds[mailboxes.length],
    dealId,
    userIds,
    mailboxes,
    sessions,
  };
}

/** The fixture Graph registration, naming the bank's firm and its mail domain. */
export async function registerFixtureReader(env: GuardedTenantEnv, tenant: GuardedTenant, domains = ['bank.example']): Promise<void> {
  const { error } = await env.db.from('graph_reader_registrations').insert({
    tenant_id: tenant.id,
    ms_tenant_id: 'fixture',
    client_id: 'fixture',
    status: 'active',
    mailbox_domains: domains,
    firm_company_id: tenant.companyId,
  });
  if (error) throw new Error(`registration failed: ${error.message}`);
}

/** Each owner's own opt-in. The registration must be active while they do it. */
export async function optInOwners(tenant: GuardedTenant): Promise<void> {
  for (const session of tenant.sessions.slice(0, tenant.mailboxes.length)) {
    const { error } = await session.rpc('mailbox_consent_grant');
    if (error) throw new Error(`consent failed: ${error.message}`);
  }
}

/** Registers a SharePoint site as the tenant's firm admin, so the site guard admits it (R23). */
export async function registerSite(tenant: GuardedTenant, address: string): Promise<void> {
  const { error } = await tenant.sessions[tenant.mailboxes.length].rpc('site_register', { p_address: address });
  if (error) throw new Error(`site registration failed: ${error.message}`);
}

/** The #262 teardown: invites take their consents with them and go before the users they name. */
export async function dropGuardedTenant(env: GuardedTenantEnv, tenant: GuardedTenant): Promise<void> {
  const { db } = env;
  await db.from('deal_candidates').delete().eq('tenant_id', tenant.id);
  await db.from('source_items').delete().eq('tenant_id', tenant.id);
  await db.from('graph_reader_registrations').delete().eq('tenant_id', tenant.id);
  await db.from('mailbox_allowlist_drift').delete().eq('tenant_id', tenant.id);
  await db.from('mailbox_guard_state').delete().eq('tenant_id', tenant.id);
  await db.from('notifications').delete().eq('tenant_id', tenant.id);
  await db.from('invites').delete().eq('tenant_id', tenant.id);
  // Deals reference the bank company; their memberships go with them.
  await db.from('deals').delete().eq('tenant_id', tenant.id);
  for (const session of tenant.sessions) await session.auth.signOut();
  // A user who wrote a user-actor audit row (a consent, a site registration) cannot be deleted:
  // suspend and unseat them instead.
  for (const id of [...tenant.userIds].reverse()) {
    const { error } = await db.auth.admin.deleteUser(id);
    if (error) await db.from('users').update({ status: 'suspended', company_id: null, company_role: null }).eq('id', id);
  }
  // registered_sites is append-only and keeps a company with a site alive.
  await db.from('companies').delete().eq('id', tenant.companyId);
}

/** deal_discovery on, remembering what it was. The worker reads nothing while it is off (#262). */
export async function enableDiscoveryFlag(db: SupabaseClient): Promise<() => Promise<void>> {
  const { data } = await db.from('feature_flags').select('enabled').eq('key', 'deal_discovery').maybeSingle();
  const previous = data as { enabled: boolean } | null;
  const { error } = await db
    .from('feature_flags')
    .upsert({ key: 'deal_discovery', description: 'deal discovery (integration)', enabled: true }, { onConflict: 'key' });
  if (error) throw new Error(`flag upsert failed: ${error.message}`);
  return async () => {
    if (previous) await db.from('feature_flags').update({ enabled: previous.enabled }).eq('key', 'deal_discovery');
    else await db.from('feature_flags').delete().eq('key', 'deal_discovery');
  };
}
