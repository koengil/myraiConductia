import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createProvisionedUser } from '@/lib/auth/provisioning';
import { assertLocalDatabaseUrl } from '../db/localDatabase';
import { addDealMembers } from './support/guardedTenant';

/*
 * #312: rail_skip_approver locks the approver's user row and then their seat FOR SHARE,
 * and the lock stays until the skip commits. Against a REAL database with two real
 * connections: a removal or a company move that arrives while a skip is open waits for
 * it (55P03 with a lock_timeout), and one that commits first makes the skip refuse the
 * approver (42501 skip_approver_ineligible). The company move is the case that fixes the
 * lock order: UPDATE users takes the user row and the AFTER trigger then deletes the
 * seats, so a helper that locked the seat first would deadlock (40P01) against it.
 *
 * Every case goes through rail_skip_step, the definer that calls the helper. The two
 * connections come from DATABASE_URL through the local-database guard (loopback or
 * nothing). `pg` ships no types here, so it is loaded by require.
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

async function failureOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    const failure = error as PgError;
    return failure.code === '42501' ? `42501 ${failure.message}` : (failure.code ?? String(error));
  }
}

/** Opens a transaction that runs as the service, as the API's definers expect. */
async function begin(client: PgClient, lockTimeout?: string) {
  await client.query('begin');
  await client.query("select set_config('request.jwt.claim.role', 'service_role', true)");
  await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
  if (lockTimeout) await client.query(`set local lock_timeout = '${lockTimeout}'`);
}

type Person = { id: string; email: string };
let a: PgClient;
let b: PgClient;
let bankId = '';
let dealId = '';
let md: Person = { id: '', email: '' };
const people: Person[] = [];
const stepIds: string[] = [];

/** A fresh active deal_team member of the bank: the approver of one case. */
async function approver(label: string): Promise<Person> {
  const email = `skip-lock-${label}-${RUN}@integration.conductia.dev`;
  const user = await createProvisionedUser(db, {
    email,
    password: `Integration-${RUN}-x9!`,
    email_confirm: true,
    profile: { tenant_id: TENANT },
  });
  const person = { id: user.id, email };
  people.push(person);
  const { error } = await db
    .from('users')
    .update({ company_id: bankId, company_role: 'member', is_external: false })
    .eq('id', person.id);
  if (error) throw new Error(`approver company failed: ${error.message}`);
  await addDealMembers(db, dealId, [person.id], 'deal_team');
  return person;
}

const skip = (client: PgClient, step: string, approverId: string) =>
  client.query('select rail_skip_step($1, $2, $3, $4, $5)', [dealId, md.id, step, approverId, REASON]);

const seatCount = async (userId: string) =>
  (await db.from('deal_memberships').select('id').eq('deal_id', dealId).eq('user_id', userId)).data?.length ?? 0;
const stepStatus = async (step: string) =>
  (await db.from('deal_steps').select('status').eq('id', step).single()).data?.status;

const MOVE_OUT_OF_COMPANY = 'update users set company_id = null, company_role = null where id = $1';
const DELETE_SEAT = 'delete from deal_memberships where deal_id = $1 and user_id = $2';

beforeAll(async () => {
  const bank = await db
    .from('companies')
    .insert({ tenant_id: TENANT, name: `Skip Lock Bank ${RUN}`, type: 'bank' })
    .select('id')
    .single();
  if (bank.error || !bank.data) throw new Error(`bank seed failed: ${bank.error?.message}`);
  bankId = bank.data.id as string;

  const email = `skip-lock-md-${RUN}@integration.conductia.dev`;
  const user = await createProvisionedUser(db, {
    email,
    password: `Integration-${RUN}-x9!`,
    email_confirm: true,
    profile: { tenant_id: TENANT },
  });
  md = { id: user.id, email };
  people.push(md);
  const seated = await db
    .from('users')
    .update({ company_id: bankId, company_role: 'director', is_external: false })
    .eq('id', md.id);
  if (seated.error) throw new Error(`director seat failed: ${seated.error.message}`);

  const created = await db.rpc('create_deal_gate0', {
    p_tenant_id: TENANT,
    p_actor_id: md.id,
    p_bank_id: bankId,
    p_codename: `Project Skip Lock ${RUN}`,
    p_target_name: 'Atlassian',
    p_entry_step_seq: 1,
    p_steps: [1, 2, 3, 4, 5].map((n) => ({ stepId: `p1-s${n}`, seq: n, phaseIndex: 1, displayOrder: n })),
    p_census_version: 'test-1x5',
    p_conflicts: { approvedBy: 'Avery Lindqvist', approvedOn: '2026-09-01' },
  });
  if (created.error) throw new Error(`deal create failed: ${created.error.message}`);
  dealId = (created.data as { deal: { id: string } }).deal.id;

  const steps = await db.from('deal_steps').select('id, step_id').eq('deal_id', dealId).order('seq');
  for (const row of steps.data ?? []) stepIds.push(row.id as string);

  a = connect();
  b = connect();
  await Promise.all([a.connect(), b.connect()]);
});

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
  for (const client of [a, b]) await client?.end();
  // Best-effort teardown, as the other integration suites do: a committed skip wrote an
  // audit row, and audit_log is append-only, so the deal and the users it names stay on a
  // shared database. The hermetic CI stack is destroyed whole.
  if (dealId) {
    for (const table of ['notifications', 'deal_steps', 'deal_memberships', 'deal_parties']) {
      await db.from(table).delete().eq('deal_id', dealId);
    }
    await db.from('deals').delete().eq('id', dealId);
  }
  await db.from('companies').delete().eq('tenant_id', TENANT);
  for (const person of people) {
    await db.from('users').delete().eq('id', person.id);
    await db.auth.admin.deleteUser(person.id);
  }
});

describe('the skip approver stays eligible until the skip commits', () => {
  it('1. an open skip holds the seat: a removal waits and gives up with 55P03', async () => {
    const person = await approver('seat-held');
    await begin(a);
    await skip(a, stepIds[0], person.id);
    await begin(b, '200ms');
    expect(await failureOf(b.query(DELETE_SEAT, [dealId, person.id]))).toBe('55P03');
    await b.query('rollback');
    await a.query('rollback');
    expect(await seatCount(person.id)).toBe(1);
  });

  it('2. a removal that commits first makes the skip refuse the approver (42501)', async () => {
    const person = await approver('seat-gone');
    await begin(b);
    await b.query(DELETE_SEAT, [dealId, person.id]); // not committed yet
    await begin(a);
    let settled = false;
    const refused = failureOf(skip(a, stepIds[1], person.id)).finally(() => {
      settled = true;
    });
    await sleep(300);
    expect(settled, 'the skip must wait for the removal').toBe(false);
    await b.query('commit');
    expect(await refused).toBe('42501 skip_approver_ineligible');
    await a.query('rollback');
    expect(await stepStatus(stepIds[1])).not.toBe('skipped');
  });

  it('3. an open skip holds the user row: a company move waits (55P03, never 40P01) and completes once the skip commits', async () => {
    const person = await approver('move-held');
    await begin(a);
    await skip(a, stepIds[2], person.id);
    await begin(b, '200ms');
    expect(await failureOf(b.query(MOVE_OUT_OF_COMPANY, [person.id]))).toBe('55P03');
    await b.query('rollback');

    // No timeout: the move queues behind the skip and goes through once it commits.
    await begin(b);
    let settled = false;
    const moved = failureOf(b.query(MOVE_OUT_OF_COMPANY, [person.id])).finally(() => {
      settled = true;
    });
    await sleep(300);
    expect(settled, 'the move must wait for the skip').toBe(false);
    await a.query('commit');
    expect(await moved).toBeUndefined();
    await b.query('commit');
    expect(await stepStatus(stepIds[2])).toBe('skipped');
    expect(await seatCount(person.id)).toBe(0); // the cascade removed the seat
  });

  it('4. a company move that commits first removes the seat, so the skip refuses the approver (42501)', async () => {
    const person = await approver('move-gone');
    await begin(b);
    await b.query(MOVE_OUT_OF_COMPANY, [person.id]); // the cascade deletes the seat, not committed yet
    await begin(a);
    let settled = false;
    const refused = failureOf(skip(a, stepIds[3], person.id)).finally(() => {
      settled = true;
    });
    await sleep(300);
    expect(settled, 'the skip must wait for the move').toBe(false);
    await b.query('commit');
    expect(await refused).toBe('42501 skip_approver_ineligible');
    await a.query('rollback');
    expect(await stepStatus(stepIds[3])).not.toBe('skipped');
  });
});
