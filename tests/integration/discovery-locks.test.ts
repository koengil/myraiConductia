import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * The per-tenant discovery lock and the candidate row lock, against a REAL
 * database with two real connections (design "Lock order"). Every writer of
 * candidate rows takes discovery_lock_tenant first, so two writers queue behind
 * one another and never deadlock; #286's FOR UPDATE on the candidate row still
 * holds for a writer that has the tenant lock.
 *
 * The two connections come from DATABASE_URL through the local-database guard
 * (loopback or nothing). `pg` ships no types here, so it is loaded by require.
 */

import { assertLocalDatabaseUrl } from '../db/localDatabase';
import { createDiscoveryTenant } from './helpers/discoveryTenant';

type PgError = Error & { code?: string };
type PgClient = {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
};
const { Client } = createRequire(import.meta.url)('pg') as { Client: new (config: Record<string, unknown>) => PgClient };

const harness = createDiscoveryTenant('lk');
const { tenantId, users } = harness;

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
let kestrel = '';
let harbor = '';
let osprey = '';

/** A classification group for the upsert: one cluster, no links. */
const group = (clusterKey: string, name: string) =>
  JSON.stringify([
    {
      clusterKey,
      proposedName: name,
      codenameGuess: name,
      parties: [],
      firstSeenAt: '2026-10-01T00:00:00Z',
      lastSeenAt: '2026-10-02T00:00:00Z',
      confidence: 0.9,
      links: [],
    },
  ]);
const upsert = (groups: string): [string, unknown[]] => [
  'select discovery_upsert_candidates($1, gen_random_uuid(), $2::jsonb)',
  [tenantId, groups],
];

/** Runs statements as a signed-in user inside the open transaction. */
async function asUser(client: PgClient, userId: string) {
  await client.query('set local role authenticated');
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ]);
}

/** Kestrel's live links to mail Alice owns, so a split of them leaves her a deal she can open. */
const ALICE_LIVE_LINKS = `select el.id, el.source_item_id from evidence_links el
  join source_item_sources sis on sis.source_item_id = el.source_item_id
  join content_sources cs on cs.id = sis.content_source_id
  where el.candidate_id = $1 and el.state <> 'rejected' and cs.owner_user_id = $2
  order by el.id`;

async function failureOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return (error as PgError).code ?? String(error);
  }
}

beforeAll(async () => {
  await harness.setup();
  await harness.seedDemo();
  const { data } = await harness.db.from('deal_candidates').select('id, cluster_key').eq('tenant_id', tenantId);
  const idOf = (key: string) => (data ?? []).find((r) => r.cluster_key === key)?.id as string;
  kestrel = idOf('codename:kestrel');
  harbor = idOf('codename:harbor');
  osprey = idOf('codename:osprey');
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
  await harness.cleanup();
});

describe('discovery write locks', () => {
  it('keeps #286\'s row lock: an upsert waits for a holder of the candidate row and gives up with 55P03', async () => {
    await a.query('begin');
    await a.query('select id from deal_candidates where id = $1 for update', [kestrel]); // no tenant lock
    await b.query('begin');
    await b.query("set local lock_timeout = '200ms'");
    const code = await failureOf(b.query(...upsert(group('codename:kestrel', 'Project Kestrel'))));
    expect(code).toBe('55P03');
    await b.query('rollback');
    await a.query('rollback');
  });

  it('makes a correction wait for the tenant lock and fail with 55P03 when it is not released', async () => {
    await a.query('begin');
    await a.query('select discovery_lock_tenant($1)', [tenantId]);
    await b.query('begin');
    await asUser(b, users.alice.id);
    const started = Date.now();
    // The RPC carries its own lock_timeout (5 s), which wins over the session's.
    const code = await failureOf(b.query('select discovery_rename_candidate($1, $2, null)', [osprey, 'Project Osprey Renamed']));
    expect(code).toBe('55P03');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    await b.query('rollback');
    await a.query('rollback');
    const { rows } = await a.query('select proposed_name, pinned from deal_candidates where id = $1', [osprey]);
    expect(rows[0]).toEqual({ proposed_name: 'Project Osprey', pinned: false }); // nothing was written
  });

  it('queues a correction behind a writer that releases in time, instead of failing it', async () => {
    await a.query('begin');
    await a.query('select discovery_lock_tenant($1)', [tenantId]);
    await b.query('begin');
    await asUser(b, users.alice.id);
    const rename = b.query('select discovery_rename_candidate($1, $2, null) as id', [osprey, 'Project Osprey Renamed']);
    await sleep(300);
    await a.query('commit'); // the holder finishes
    const { rows } = await rename;
    expect(rows[0].id).toEqual(expect.any(String));
    await b.query('commit');
    const after = await a.query('select proposed_name, pinned from deal_candidates where id = $1', [osprey]);
    expect(after.rows[0]).toEqual({ proposed_name: 'Project Osprey Renamed', pinned: true });
  });

  it('commits both an upsert that creates a candidate and a merge on an existing pair, in either order, with no deadlock', async () => {
    // Upsert first, holding the tenant lock while the merge arrives.
    const writer = (async () => {
      await a.query('begin');
      await a.query(...upsert(group('codename:zephyr', 'Project Zephyr')));
      await sleep(400);
      await a.query('commit');
    })();
    await sleep(100);
    const merger = (async () => {
      await b.query('begin');
      await asUser(b, users.alice.id);
      await b.query('select discovery_merge_candidates($1, $2, $3)', [harbor, kestrel, 'Same process']);
      await b.query('commit');
    })();
    const first = await Promise.all([failureOf(writer), failureOf(merger)]);
    expect(first).toEqual([undefined, undefined]);

    // Merge first, holding the tenant lock while an upsert that creates a candidate arrives.
    const merger2 = (async () => {
      await b.query('begin');
      await asUser(b, users.alice.id);
      await b.query('select discovery_merge_candidates($1, $2, $3)', [osprey, kestrel, 'Also the same process']);
      await sleep(400);
      await b.query('commit');
    })();
    await sleep(100);
    const writer2 = (async () => {
      await a.query('begin');
      await a.query(...upsert(group('codename:yarrow', 'Project Yarrow')));
      await a.query('commit');
    })();
    const second = await Promise.all([failureOf(merger2), failureOf(writer2)]);
    expect(second).toEqual([undefined, undefined]);

    const { rows } = await a.query(
      "select cluster_key, discovery_state from deal_candidates where tenant_id = $1 and cluster_key in ('codename:zephyr','codename:yarrow','codename:harbor','codename:osprey') order by cluster_key",
      [tenantId],
    );
    expect(rows).toEqual([
      { cluster_key: 'codename:harbor', discovery_state: 'merged_into' },
      { cluster_key: 'codename:osprey', discovery_state: 'merged_into' },
      { cluster_key: 'codename:yarrow', discovery_state: 'proposed' },
      { cluster_key: 'codename:zephyr', discovery_state: 'proposed' },
    ]);
  });

  it('makes a split and a reassign wait for the tenant lock too, and write nothing when they give up (55P03)', async () => {
    const { rows: links } = await a.query(ALICE_LIVE_LINKS + ' limit 2', [kestrel, users.alice.id]);
    expect(links).toHaveLength(2);
    const before = await a.query('select count(*)::int as n from evidence_links where candidate_id = $1 and state = $2', [kestrel, 'rejected']);

    await a.query('begin');
    await a.query('select discovery_lock_tenant($1)', [tenantId]);
    await b.query('begin');
    await asUser(b, users.alice.id);
    const split = await failureOf(
      b.query('select discovery_split_candidate($1, $2::uuid[], $3, $4)', [kestrel, [links[0].source_item_id], 'Project Kestrel Annex', 'Different deal']),
    );
    expect(split).toBe('55P03');
    await b.query('rollback');

    await b.query('begin');
    await asUser(b, users.alice.id);
    const reassign = await failureOf(b.query('select discovery_reassign_link($1, $2, $3)', [links[1].id, osprey, 'Different deal']));
    expect(reassign).toBe('55P03');
    await b.query('rollback');
    await a.query('rollback');

    const after = await a.query('select count(*)::int as n from evidence_links where candidate_id = $1 and state = $2', [kestrel, 'rejected']);
    expect(after.rows[0]).toEqual(before.rows[0]);
    const annex = await a.query("select count(*)::int as n from deal_candidates where tenant_id = $1 and proposed_name = 'Project Kestrel Annex'", [tenantId]);
    expect(annex.rows[0]).toEqual({ n: 0 });
  }, 30_000);

  it('queues a split behind a writer that releases in time, and the split lands', async () => {
    const { rows: links } = await a.query(ALICE_LIVE_LINKS + ' limit 1', [kestrel, users.alice.id]);
    await a.query('begin');
    await a.query('select discovery_lock_tenant($1)', [tenantId]);
    await b.query('begin');
    await asUser(b, users.alice.id);
    const split = b.query('select discovery_split_candidate($1, $2::uuid[], $3, $4) as id', [
      kestrel, [links[0].source_item_id], 'Project Kestrel Annex', 'Different deal',
    ]);
    await sleep(300);
    await a.query('commit');
    const { rows } = await split;
    expect(rows[0].id).toEqual(expect.any(String));
    await b.query('commit');
    const created = await a.query("select cluster_key, discovery_state, pinned from deal_candidates where tenant_id = $1 and proposed_name = 'Project Kestrel Annex'", [tenantId]);
    expect(created.rows).toHaveLength(1);
    expect(created.rows[0]).toMatchObject({ discovery_state: 'proposed', pinned: true });
    expect(String(created.rows[0].cluster_key)).toMatch(/^correction:/);
  }, 30_000);
});
