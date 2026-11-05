import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Demo only (#460), G-02a (#173), audit D1 and D5. Against a REAL database with two real connections: the dismiss
 * RPC (20261023120100) covers exactly the proposal rows it read under the tenant lock, whatever their created_at.
 * The proposal writer takes no tenant lock, so its created_at and the dismissal's dismissed_at are not ordered:
 *
 *   - a row its writer stamped BEFORE the dismissal but committed AFTER the dismissal read is not covered, so the
 *     owner can still see it and a retry covers it;
 *   - a row stamped AFTER the dismisser's transaction began but committed BEFORE the read is covered, and a retry
 *     writes no second dismissal and no second audit row;
 *   - two tabs dismissing at once queue on the tenant lock: one writes, the other returns 0.
 *
 * Under a timestamp rule (dismissed_at >= created_at) the first two fail. Each case uses its own deal key. The
 * connections come from DATABASE_URL through the local-database guard (loopback or nothing).
 */

import { messageKey } from '@/lib/discovery/propose/key';
import { assertLocalDatabaseUrl } from '../db/localDatabase';
import { createDiscoveryTenant } from './helpers/discoveryTenant';

type PgClient = {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
};
const { Client } = createRequire(import.meta.url)('pg') as { Client: new (config: Record<string, unknown>) => PgClient };

const tenant = createDiscoveryTenant('pr');
const { db, tenantId, users } = tenant;
const STORM = 'storm.duncan@bank.example';
const RUN = '0b9a1c3e-5d7f-4a2b-8c4d-6e8f0a1b2c3d';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(): PgClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const target = assertLocalDatabaseUrl(url); // loopback or nothing
  return new Client({
    host: target.host,
    port: Number(target.port),
    user: target.user,
    password: target.password,
    database: target.database,
  });
}

let a: PgClient;
let b: PgClient;
let sourceId = '';

/** One model proposal of `key` from Alice's mailbox, through the writer, on `client` (as the table owner). */
async function record(client: PgClient, messageId: string, key: string) {
  await client.query('select discovery_record_model_proposal($1, $2::jsonb)', [
    tenantId,
    JSON.stringify({
      content_source_id: sourceId,
      message_key: messageKey(messageId),
      item_hash: messageKey(`text of ${messageId}`),
      sent_at: '2026-03-02T10:00:00Z',
      party_domains: [],
      outcome: 'deal',
      deal_key: key,
      deal_name: 'Project Race',
      candidate_id: null,
      phase: 'phase-2',
      p_deal: 0.9,
      p_phase: 0.6,
      model: 'anthropic/claude-haiku-5.5',
      prompt_version: 'v1',
      prompt_hash: 'hash-v1',
      response_id: null,
      run_id: RUN,
    }),
  ]);
}

/** Runs statements as Alice inside the open transaction. */
async function asAlice(client: PgClient) {
  await client.query('set local role authenticated');
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: users.alice.id, role: 'authenticated' }),
  ]);
}

type Dismissed = { dismissed: number; operationId: string | null };

async function dismiss(client: PgClient, key: string): Promise<Dismissed> {
  const { rows } = await client.query('select discovery_dismiss_model_proposal($1) as r', [key]);
  return rows[0].r as Dismissed;
}

/** Alice dismisses `key` in a transaction of its own. */
async function dismissNow(client: PgClient, key: string): Promise<Dismissed> {
  await client.query('begin');
  await asAlice(client);
  const result = await dismiss(client, key);
  await client.query('commit');
  return result;
}

/** The audit detail of one dismiss operation. */
async function auditOf(operationId: string) {
  const { data, error } = await db
    .from('audit_log')
    .select('detail')
    .eq('tenant_id', tenantId)
    .eq('action', 'discovery.model_proposal_dismissed')
    .eq('detail->>operationId', operationId);
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{ detail: { rowCount: number; sourceCount: number } }>;
}

async function dismissalsOf(key: string) {
  const { data, error } = await db
    .from('discovery_model_proposal_dismissals')
    .select('id, operation_id, proposal_ids')
    .eq('tenant_id', tenantId)
    .eq('deal_key', key);
  if (error) throw new Error(error.message);
  return data ?? [];
}

beforeAll(async () => {
  await tenant.setup();
  await tenant.seedDemo();
  sourceId = await tenant.sourceIdOf(STORM);
  a = connect();
  b = connect();
  await Promise.all([a.connect(), b.connect()]);
});

afterAll(async () => {
  for (const client of [a, b]) {
    try {
      await client?.query('rollback');
    } catch {
      /* nothing open */
    }
    await client?.end();
  }
  // The dismissals go with the source (on delete cascade).
  await db.from('discovery_model_proposals').delete().eq('tenant_id', tenantId);
  await db.from('content_sources').delete().eq('tenant_id', tenantId);
  await tenant.cleanup();
});

describe('a dismissal covers the rows it read, not a time window (G-02a, audit D1)', () => {
  it('leaves a row stamped before it but committed after its read uncovered, and a retry covers that row', async () => {
    const key = 'm:race-unseen';
    await record(a, '<race-unseen-1@harbourline.example>', key);
    // The writer begins first: its row is stamped now, and stays uncommitted.
    await b.query('begin');
    await record(b, '<race-unseen-2@harbourline.example>', key);
    await sleep(20);
    const first = await dismissNow(a, key);
    expect(first.dismissed).toBe(1);
    expect((await auditOf(first.operationId!))[0].detail.rowCount).toBe(1);
    await b.query('commit');

    // The owner never saw the second row, so it is not covered: a retry covers exactly it.
    const retry = await dismissNow(a, key);
    expect(retry.dismissed).toBe(1);
    expect(retry.operationId).not.toBe(first.operationId);
    expect((await auditOf(retry.operationId!))[0].detail.rowCount).toBe(1);
  });

  it('covers a row stamped after its transaction began but committed before its read, and a retry writes nothing', async () => {
    const key = 'm:race-seen';
    await record(b, '<race-seen-1@harbourline.example>', key);
    // The dismisser's transaction begins first; the writer stamps and commits its row after that.
    await a.query('begin');
    await a.query('select now()');
    await sleep(20);
    await record(b, '<race-seen-2@harbourline.example>', key);
    await asAlice(a);
    const first = await dismiss(a, key);
    await a.query('commit');
    expect(first.dismissed).toBe(1);
    expect((await auditOf(first.operationId!))[0].detail.rowCount).toBe(2);

    const retry = await dismissNow(a, key);
    expect(retry).toEqual({ dismissed: 0, operationId: null });
    const rows = await dismissalsOf(key);
    expect(rows).toHaveLength(1);
    expect((rows[0].proposal_ids as string[]).length).toBe(2);
    expect(await auditOf(first.operationId!)).toHaveLength(1);
  });
});

describe('two tabs dismissing one proposal at once (G-02a, audit D5)', () => {
  it('queue on the tenant lock: one writes the dismissal and its audit row, the other returns 0', async () => {
    const key = 'm:race-tabs';
    await record(b, '<race-tabs-1@harbourline.example>', key);
    await a.query('begin');
    await asAlice(a);
    const first = await dismiss(a, key); // holds the tenant lock until commit
    await b.query('begin');
    await asAlice(b);
    const second = dismiss(b, key); // waits for it
    await sleep(100);
    await a.query('commit');
    const late = await second;
    await b.query('commit');

    expect(first.dismissed).toBe(1);
    expect(late).toEqual({ dismissed: 0, operationId: null });
    expect(await dismissalsOf(key)).toHaveLength(1);
    expect(await auditOf(first.operationId!)).toHaveLength(1);
  });
});
