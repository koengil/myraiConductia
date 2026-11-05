import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { READER_MODE } from '@/lib/constants/discovery';
import { runOnce } from '../../../worker/classify';
import { seatOnDeal } from '../support/guardedTenant';

/*
 * A throwaway discovery tenant for integration tests against a REAL database.
 * It copies the setup of tests/integration/discovery-tracer.test.ts (which
 * stays as it is): a throwaway tenant, a throwaway bank company and five
 * throwaway users, the fixture mailboxes mapped to them (Alice is Storm's
 * mailbox, the colleague is Morgan's, Bob is Alex's), each mailbox readable
 * only through the allowlist (#262): the owner is seated at the bank by an
 * accepted invite and opts in through their own session. The opt-in needs MD or deal team on a deal of the
 * tenant (#262 round 3, A2), so the three mailbox owners are seated on one throwaway deal as deal_team
 * (`fixtureDealId`); that seat grants no deal-create authority, and the deal is not a promoted one, so a test
 * that counts deals excludes it. Each opt-in creates its owner's mailbox source. Cleanup deletes the
 * discovery rows, invites, companies and users; audit rows stay (audit_log is
 * append-only), so a user who wrote one is suspended and unseated instead.
 *
 * The route tests mock `createSupabaseServerClient` to return `activeSession()`
 * (the cookie layer needs a Next runtime); everything else is real.
 */

export type Persona = 'alice' | 'colleague' | 'bob' | 'cco' | 'admin';
const PERSONAS: Persona[] = ['alice', 'colleague', 'bob', 'cco', 'admin'];

export const DEMO_GRAPH_DIRECTORY = 'tests/fixtures/discovery/demo/graph';
/** Every mailbox's full set with the late mail appended last (a delta read sees exactly the late mail). */
export const DEMO_LATE_MAIL_DIRECTORY = 'tests/fixtures/discovery/demo/graph-after-imports';

const MAILBOXES: Array<{ address: string; owner: Persona }> = [
  { address: 'storm.duncan@bank.example', owner: 'alice' },
  { address: 'morgan.vale@bank.example', owner: 'colleague' },
  { address: 'alex.chen@bank.example', owner: 'bob' },
];

export type DiscoveryTenant = ReturnType<typeof createDiscoveryTenant>;

export function createDiscoveryTenant(label: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !secret || !publishable) {
    throw new Error(
      'The discovery integration tests need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and ' +
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (local `supabase start` stack).',
    );
  }
  const db = createClient(url, secret, { auth: { persistSession: false } });
  const run = Date.now().toString(36);
  const tenantId = crypto.randomUUID();
  const password = `Discovery-${run}-x9!`;
  const users: Record<Persona, { id: string; email: string; firmRole: 'cco' | 'admin' | null; department: string }> = {
    alice: { id: '', email: `${label}-alice-${run}@integration.conductia.dev`, firmRole: null, department: 'ib' },
    colleague: { id: '', email: `${label}-colleague-${run}@integration.conductia.dev`, firmRole: null, department: 'ib' },
    bob: { id: '', email: `${label}-bob-${run}@integration.conductia.dev`, firmRole: null, department: 'ib' },
    cco: { id: '', email: `${label}-cco-${run}@integration.conductia.dev`, firmRole: 'cco', department: 'compliance' },
    admin: { id: '', email: `${label}-admin-${run}@integration.conductia.dev`, firmRole: 'admin', department: 'admin' },
  };
  const sessions = new Map<Persona, SupabaseClient>();
  let acting: Persona = 'alice';
  let bankCompanyId = '';
  let fixtureDealId = '';
  let previousFlag: { enabled: boolean } | null = null;
  let previousMfa: string | undefined;

  async function setFlag(enabled: boolean): Promise<void> {
    const { error } = await db
      .from('feature_flags')
      .upsert({ key: 'deal_discovery', description: 'deal discovery (integration)', enabled }, { onConflict: 'key' });
    if (error) throw new Error(`flag upsert failed: ${error.message}`);
  }

  /** The session of the persona the next route call runs as. */
  const activeSession = (): SupabaseClient => {
    const client = sessions.get(acting);
    if (!client) throw new Error(`no session for ${acting}`);
    return client;
  };

  return {
    db,
    tenantId,
    users,
    /** The throwaway deal the mailbox owners are seated on so that they can opt in: never a promoted deal. */
    get fixtureDealId(): string {
      return fixtureDealId;
    },
    setFlag,
    activeSession,
    /** Act as a persona for the next route calls, and return their client. */
    sessionFor(persona: Persona): SupabaseClient {
      acting = persona;
      return activeSession();
    },
    /**
     * Run the classification worker over a committed fixture directory (the
     * demo corpus by default) through the fixture reader: DISCOVERY_FIXTURE_DIR
     * is set for the run only.
     */
    async seedDemo(dir: string = DEMO_GRAPH_DIRECTORY) {
      const before = process.env.DISCOVERY_FIXTURE_DIR;
      process.env.DISCOVERY_FIXTURE_DIR = dir;
      try {
        const summary = await runOnce({ tenantId, db, provider: READER_MODE.FIXTURE });
        if (summary.status !== 'ok') throw new Error(`classification skipped: ${summary.reason}`);
        return summary;
      } finally {
        if (before === undefined) delete process.env.DISCOVERY_FIXTURE_DIR;
        else process.env.DISCOVERY_FIXTURE_DIR = before;
      }
    },
    /** Forget each source's checkpoint, so the next pass reads every mailbox from the start. */
    async rewindSources(): Promise<void> {
      const { error } = await db
        .from('content_sources')
        .update({ delta_checkpoint: null, backfill_completed_at: null })
        .eq('tenant_id', tenantId);
      if (error) throw new Error(`checkpoint rewind failed: ${error.message}`);
    },
    sourceIdOf: async (address: string) => {
      const { data, error } = await db
        .from('content_sources')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('address', address)
        .single();
      if (error) throw new Error(`source lookup failed: ${error.message}`);
      return data.id as string;
    },

    async setup(): Promise<void> {
      previousMfa = process.env.MFA_ENFORCEMENT;
      // Password-created accounts are established accounts: no TOTP needed.
      process.env.MFA_ENFORCEMENT = 'invite_only';

      const { data: flagRow } = await db.from('feature_flags').select('enabled').eq('key', 'deal_discovery').maybeSingle();
      previousFlag = flagRow as { enabled: boolean } | null;
      await setFlag(true);

      for (const persona of PERSONAS) {
        const user = users[persona];
        const { data, error } = await db.auth.admin.createUser({
          email: user.email,
          password,
          email_confirm: true,
          user_metadata: { tenant_id: tenantId, department: user.department },
        });
        if (error || !data.user) throw new Error(`auth user create failed: ${error?.message}`);
        user.id = data.user.id;
        const { error: updateError } = await db
          .from('users')
          .update({ tenant_id: tenantId, status: 'active', firm_role: user.firmRole, is_external: false })
          .eq('id', user.id);
        if (updateError) throw new Error(`user claim failed: ${updateError.message}`);

        const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
        const { error: signInError } = await client.auth.signInWithPassword({ email: user.email, password });
        if (signInError) throw new Error(`sign-in failed for ${persona}: ${signInError.message}`);
        sessions.set(persona, client);
      }

      // The bank: alice seated first, as director (a company holds no member without one), then the others.
      const company = await db
        .from('companies')
        .insert({ tenant_id: tenantId, name: `Discovery Bank ${label} ${run}`, type: 'bank' })
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
      for (const persona of ['colleague', 'bob', 'cco', 'admin'] as const) await seat(persona, 'member');

      const { error: registrationError } = await db.from('graph_reader_registrations').insert({
        tenant_id: tenantId,
        ms_tenant_id: 'fixture',
        client_id: 'fixture',
        status: 'active',
        mailbox_domains: ['bank.example'],
        firm_company_id: bankCompanyId,
      });
      if (registrationError) throw new Error(`registration failed: ${registrationError.message}`);

      const { error: inviteError } = await db.from('invites').insert(
        MAILBOXES.map(({ address, owner }) => ({
          tenant_id: tenantId,
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
      fixtureDealId = await seatOnDeal(db, {
        tenantId,
        bankId: bankCompanyId,
        code: `DD-FIXTURE-${label}-${run}`,
        userIds: MAILBOXES.map(({ owner }) => users[owner].id),
      });
      for (const persona of ['alice', 'colleague', 'bob'] as const) {
        const { error } = await sessions.get(persona)!.rpc('mailbox_consent_grant');
        if (error) throw new Error(`consent for ${persona} failed: ${error.message}`);
      }

      // Each opt-in created its owner's mailbox source (C20): assert that instead of inserting a second row.
      const { data: sources, error: sourceError } = await db
        .from('content_sources')
        .select('address, owner_user_id')
        .eq('tenant_id', tenantId)
        .eq('kind', 'mailbox');
      if (sourceError) throw new Error(`content sources failed: ${sourceError.message}`);
      const created = new Map((sources ?? []).map((row) => [row.address as string, row.owner_user_id as string]));
      for (const { address, owner } of MAILBOXES) {
        if (created.get(address) !== users[owner].id) {
          throw new Error(`the opt-in did not create ${address}'s source for its owner`);
        }
      }
    },

    async cleanup(): Promise<void> {
      if (previousMfa === undefined) delete process.env.MFA_ENFORCEMENT;
      else process.env.MFA_ENFORCEMENT = previousMfa;

      // Discovery rows first (cascades take links, visibility, texts, provenance, the ledger,
      // milestone events, model calls and assessments), then the users.
      await db.from('ai_usage').delete().eq('tenant_id', tenantId);
      await db.from('deal_candidates').delete().eq('tenant_id', tenantId);
      await db.from('source_items').delete().eq('tenant_id', tenantId);
      await db.from('graph_reader_registrations').delete().eq('tenant_id', tenantId);
      await db.from('mailbox_allowlist_drift').delete().eq('tenant_id', tenantId);
      await db.from('mailbox_group_absence').delete().eq('tenant_id', tenantId);
      await db.from('discovery_message_index').delete().eq('tenant_id', tenantId);
      await db.from('notifications').delete().eq('tenant_id', tenantId);
      // Invites take their consents with them, and must go before the users they name.
      await db.from('invites').delete().eq('tenant_id', tenantId);
      // The fixture deal and its memberships, before the users and the company they name.
      if (fixtureDealId) await db.from('deals').delete().eq('id', fixtureDealId);
      for (const client of sessions.values()) await client.auth.signOut();
      // Members before the director (alice is first in PERSONAS): a company may not keep a member once its director is gone.
      for (const persona of [...PERSONAS].reverse()) {
        const user = users[persona];
        if (!user.id) continue;
        const { error } = await db.auth.admin.deleteUser(user.id);
        // A user who wrote a user-actor audit row (a consent) cannot be deleted: suspend and unseat them.
        if (error) {
          await db.from('users').update({ status: 'suspended', company_id: null, company_role: null }).eq('id', user.id);
        }
      }
      if (bankCompanyId) await db.from('companies').delete().eq('id', bankCompanyId);

      if (previousFlag) await setFlag(previousFlag.enabled);
      else await db.from('feature_flags').delete().eq('key', 'deal_discovery');
    },
  };
}
