// @vitest-environment node
import { randomUUID } from 'node:crypto';
// @ts-expect-error pg ships no declarations and @types/pg is not a dependency.
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { requireLocalDatabase } from './localDatabase';

describe.skipIf(process.env.RUN_DB_TESTS !== '1')('concurrent send census refresh (#425)', () => {
  it('serializes refreshes for the same tenant without duplicate weeks', async () => {
    const target = requireLocalDatabase();
    const clients = [new Client(target), new Client(target)];
    const tenant = randomUUID();
    const source = randomUUID();
    try {
      await Promise.all(clients.map((client) => client.connect()));
      await clients[0].query("insert into google_reader_registrations (tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email, allowlist_group) values ($1, 'census.example', 'dwd-reader@proj-1.iam.gserviceaccount.com', '123456789012345678', 'dir-reader@proj-1.iam.gserviceaccount.com', 'ingest@census.example')", [tenant]);
      await clients[0].query("insert into content_sources (id, tenant_id, kind, provider, address, backfill_completed_at, last_synced_at) values ($1, $2, 'mailbox', 'google', 'test@example.test', now(), now())", [source, tenant]);
      await Promise.all(clients.map((client) => client.query('set role service_role')));
      const results = await Promise.all(clients.map((client) => client.query('select send_census_refresh($1, 8)', [tenant])));
      expect(results.map((result: { rows: Array<{ send_census_refresh: { rows: number } }> }) => result.rows[0].send_census_refresh.rows)).toEqual([8, 8]);
      const { rows } = await clients[0].query('select week, count(*)::integer as n from send_census_weekly where tenant_id = $1 group by week', [tenant]);
      expect(rows).toHaveLength(8);
      expect(rows.every((row: { n: number }) => row.n === 1)).toBe(true);
    } finally {
      await clients[0].query('reset role').catch(() => undefined);
      await clients[0].query('delete from send_census_weekly where tenant_id = $1', [tenant]).catch(() => undefined);
      await clients[0].query('delete from content_sources where id = $1', [source]).catch(() => undefined);
      await clients[0].query('delete from google_reader_registrations where tenant_id = $1', [tenant]).catch(() => undefined);
      await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
    }
  });
});
