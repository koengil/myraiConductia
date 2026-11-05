import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createProvisionedUser } from '@/lib/auth/provisioning';
import { assertLocalDatabaseUrl } from '../db/localDatabase';
import { addDealMembers } from './support/guardedTenant';

/*
 * #312 [3/3]: a step skip and replace_company_member_access on the same user must not
 * deadlock. The skip holds the approver's user row FOR SHARE (rail_skip_approver) and
 * writes its audit row last, so its order is user -> seat -> audit chain.
 * replace_company_member_access used to take the target's row FOR SHARE, write its
 * audit rows (the tenant's chain lock) and only then UPDATE users.can_invite: with the
 * approver as the target, the skip waited for the chain while the access change waited
 * for the row, and Postgres aborted one with 40P01. It now locks the row FOR NO KEY
 * UPDATE before any audit row, so whichever locks the user first finishes.
 *
 * Against a REAL database with real connections. Connection a stands in for a skip
 * that has passed its approver check: it holds the user row FOR SHARE, as
 * rail_skip_approver's first statement does, then calls rail_skip_step, which writes
 * the skip's audit row. Connection b runs the access change. A third connection,
 * watch, holds no transaction and only reads lock state. The connections come from
 * DATABASE_URL through the local-database guard (loopback or nothing). `pg` ships no
 * types here, so it is loaded by require.
 *
 * No sleeps: each case waits on a lock-state barrier (waitUntilBlockedBy). It polls
 * pg_blocking_pids(b) from watch until it names a's backend, and fails the test after
 * a bounded timeout. pg_blocking_pids reads the live lock manager; pg_stat_activity
 * is not used because a transaction caches its snapshot.
 *
 * Why case 1 fails with 40P01 on the old function (FOR SHARE on the target). Its
 * statements, in order: the company advisory lock, the company row and the actor row
 * FOR SHARE, the target row FOR SHARE (compatible with a's FOR SHARE), the
 * company_member_access row, then the grant audit row, whose BEFORE INSERT trigger
 * takes the tenant's chain lock (a holds none yet, so it is granted), then the
 * company_member_permissions insert (its foreign key takes FOR KEY SHARE on the
 * target, still compatible), and only then the UPDATE of users.can_invite on the
 * target, which conflicts with a's FOR SHARE. That UPDATE is b's first wait on a. So
 * when the barrier sees b blocked by a, b already holds the chain lock. a's skip then
 * inserts its own audit row in the same tenant and waits for b's chain lock while b
 * waits for a's row lock: a cycle, which Postgres breaks by aborting one of them with
 * 40P01, and one of the two calls the case expects to succeed fails.
 *
 * With the new function (FOR NO KEY UPDATE on the target), b's first wait on a is that
 * lock, before any audit row, so b holds no chain lock at the barrier. a's skip
 * re-takes locks it already holds and the free chain lock, commits, and b goes on.
 */

type PgError = Error & { code?: string };
type PgClient = {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
};
const { Client } = createRequire(import.meta.url)('pg') as { Client: new (config: Record<string, unknown>) => PgClient };

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  throw new Error('Integration suite needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.');
}
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const TENANT = crypto.randomUUID();
const REASON = 'Handled off platform';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(): PgClient {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const target = assertLocalDatabaseUrl(databaseUrl); // loopback or nothing
  return new Client({
    host: target.host,
    port: Number(target.port),
    user: target.user,
    password: target.password,
    database: target.database,
  });
}

/** The SQLSTATE a call failed with, or undefined when it succeeded. */
async function failureOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return (error as PgError).code ?? String(error);
  }
}

/** Opens a transaction that runs as the service, as the API's definers expect. */
async function begin(client: PgClient) {
  await client.query('begin');
  await client.query("select set_config('request.jwt.claim.role', 'service_role', true)");
  await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
}

type Person = { id: string; email: string };
let a: PgClient;
let b: PgClient;
let watch: PgClient;
let aPid = 0;
let bPid = 0;
let bankId = '';
let dealId = '';
let director: Person = { id: '', email: '' };
const people: Person[] = [];
const stepIds: string[] = [];

async function person(label: string, companyRole: 'director' | 'member'): Promise<Person> {
  const email = `access-skip-lock-${label}-${RUN}@integration.conductia.dev`;
  const user = await createProvisionedUser(db, {
    email,
    password: `Integration-${RUN}-x9!`,
    email_confirm: true,
    profile: { tenant_id: TENANT },
  });
  const created = { id: user.id, email };
  people.push(created);
  const { error } = await db
    .from('users')
    .update({ company_id: bankId, company_role: companyRole, is_external: false })
    .eq('id', created.id);
  if (error) throw new Error(`${label} company failed: ${error.message}`);
  return created;
}

/** A fresh deal_team member of the bank, seated on the deal: the approver of one case. */
async function approver(label: string): Promise<Person> {
  const created = await person(label, 'member');
  await addDealMembers(db, dealId, [created.id], 'deal_team');
  return created;
}

const LOCK_AS_THE_SKIP_DOES = 'select 1 from users where id = $1 for share';

const skip = (client: PgClient, step: string, approverId: string) =>
  client.query('select rail_skip_step($1, $2, $3, $4, $5)', [dealId, director.id, step, approverId, REASON]);

/** Grants the target the direct invite permission, which updates users.can_invite. */
async function grantInvites(client: PgClient, targetId: string) {
  const version = await client.query(
    'select coalesce((select version from company_member_access where company_id = $1 and user_id = $2), 0) as v',
    [bankId, targetId],
  );
  return client.query(
    "select replace_company_member_access($1, $2, $3, $4, array[]::uuid[], array['company:invites:send'])",
    [director.id, bankId, targetId, version.rows[0].v],
  );
}

const stepStatus = async (step: string) =>
  (await db.from('deal_steps').select('status').eq('id', step).single()).data?.status;
const canInvite = async (userId: string) =>
  (await db.from('users').select('can_invite').eq('id', userId).single()).data?.can_invite;

beforeAll(async () => {
  const bank = await db
    .from('companies')
    .insert({ tenant_id: TENANT, name: `Access Skip Lock Bank ${RUN}`, type: 'bank' })
    .select('id')
    .single();
  if (bank.error || !bank.data) throw new Error(`bank seed failed: ${bank.error?.message}`);
  bankId = bank.data.id as string;
  director = await person('director', 'director');

  const created = await db.rpc('create_deal_gate0', {
    p_tenant_id: TENANT,
    p_actor_id: director.id,
    p_bank_id: bankId,
    p_codename: `Project Access Skip Lock ${RUN}`,
    p_target_name: 'Atlassian',
    p_entry_step_seq: 1,
    p_steps: [1, 2, 3].map((n) => ({ stepId: `p1-s${n}`, seq: n, phaseIndex: 1, displayOrder: n })),
    p_census_version: 'test-1x3',
    p_conflicts: { approvedBy: 'Avery Lindqvist', approvedOn: '2026-09-01' },
  });
  if (created.error) throw new Error(`deal create failed: ${created.error.message}`);
  dealId = (created.data as { deal: { id: string } }).deal.id;

  const steps = await db.from('deal_steps').select('id').eq('deal_id', dealId).order('seq');
  for (const row of steps.data ?? []) stepIds.push(row.id as string);

  a = connect();
  b = connect();
  watch = connect();
  await Promise.all([a.connect(), b.connect(), watch.connect()]);
  aPid = Number((await a.query('select pg_backend_pid() as pid')).rows[0].pid);
  bPid = Number((await b.query('select pg_backend_pid() as pid')).rows[0].pid);
});

const BARRIER_TIMEOUT_MS = 10_000;

/**
 * Resolves once `waiterPid` is blocked by a lock `holderPid` holds. Fails the test when
 * the waiting call finished instead (`settled`), or after BARRIER_TIMEOUT_MS.
 */
async function waitUntilBlockedBy(waiterPid: number, holderPid: number, settled: () => boolean, what: string) {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  for (;;) {
    const { rows } = await watch.query('select $2::int = any(pg_blocking_pids($1::int)) as blocked', [
      waiterPid,
      holderPid,
    ]);
    if (rows[0].blocked === true) return;
    if (settled()) throw new Error(`barrier: ${what} finished without waiting for the other connection`);
    if (Date.now() > deadline) {
      throw new Error(`barrier: ${what} was not blocked by the other connection within ${BARRIER_TIMEOUT_MS} ms`);
    }
    await sleep(20);
  }
}

/** A case that fails halfway leaves a transaction open: close both before the next case. */
async function rollbackBoth() {
  for (const client of [a, b]) {
    try {
      await client?.query('rollback');
    } catch {
      /* nothing open */
    }
  }
}

afterEach(rollbackBoth);

afterAll(async () => {
  await rollbackBoth();
  for (const client of [a, b, watch]) await client?.end();
  // Best-effort teardown, as the other integration suites do: committed skips and
  // grants wrote audit rows, and audit_log is append-only, so the deal and the users it
  // names stay on a shared database. The hermetic CI stack is destroyed whole.
  if (dealId) {
    for (const table of ['notifications', 'deal_steps', 'deal_memberships', 'deal_parties']) {
      await db.from(table).delete().eq('deal_id', dealId);
    }
    await db.from('deals').delete().eq('id', dealId);
  }
  for (const table of ['company_member_permissions', 'company_member_roles', 'company_member_access']) {
    await db.from(table).delete().eq('company_id', bankId);
  }
  await db.from('companies').delete().eq('tenant_id', TENANT);
  for (const each of people) {
    await db.from('users').delete().eq('id', each.id);
    await db.auth.admin.deleteUser(each.id);
  }
});

describe('a skip and an access change on the same user do not deadlock', () => {
  it('1. an access change waits for an open skip before auditing, so the skip finishes (never 40P01)', async () => {
    const target = await approver('skip-first');

    await begin(a);
    await a.query(LOCK_AS_THE_SKIP_DOES, [target.id]);

    await begin(b);
    let settled = false;
    const granted = failureOf(grantInvites(b, target.id)).finally(() => {
      settled = true;
    });
    // b is now waiting on a's row lock. With the old function it reached that wait
    // only after its audit row, so it holds the chain lock and the skip's audit insert
    // below closes the cycle (40P01 on one side). With the fix it holds no chain lock.
    await waitUntilBlockedBy(bPid, aPid, () => settled, 'the access change');
    expect(await failureOf(skip(a, stepIds[0], target.id))).toBeUndefined();
    await a.query('commit');

    expect(await granted).toBeUndefined();
    await b.query('commit');
    expect(await stepStatus(stepIds[0])).toBe('skipped');
    expect(await canInvite(target.id)).toBe(true);
  });

  it('2. a skip waits for an open access change on its approver, then goes through', async () => {
    const target = await approver('access-first');

    await begin(b);
    expect(await failureOf(grantInvites(b, target.id))).toBeUndefined();

    await begin(a);
    let settled = false;
    const skipped = failureOf(
      a.query(LOCK_AS_THE_SKIP_DOES, [target.id]).then(() => skip(a, stepIds[1], target.id)),
    ).finally(() => {
      settled = true;
    });
    await waitUntilBlockedBy(aPid, bPid, () => settled, 'the skip');
    await b.query('commit');

    expect(await skipped).toBeUndefined();
    await a.query('commit');
    expect(await stepStatus(stepIds[1])).toBe('skipped');
    expect(await canInvite(target.id)).toBe(true);
  });
});
