import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
// @ts-expect-error pg ships no declarations and @types/pg is not a dependency.
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { requireLocalDatabase, runPsql, type DatabaseTarget } from "./localDatabase";

// #461 slice 3: the tenant purge (20261014140000_discovery_purge_tenant.sql),
// against a real local Postgres. Every mailbox source of the tenant goes with
// its mail and the mail-derived rows; SharePoint site rows, consents and audit
// rows stay; legal hold keeps its residue and lists it; one
// discovery.tenant_purged row, ids and counts only; another tenant is
// untouched. Any FAIL raises, and ON_ERROR_STOP turns it into
// a psql failure. The suite rolls back.
//
// The race case needs two sessions, which only meet between committed
// transactions: it commits one disabled registration under a fresh random
// tenant and deletes it afterwards.
//
// OPT-IN ONLY: skipped unless RUN_DB_TESTS=1, and localDatabase refuses any
// non-local DATABASE_URL.
//   RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     npx vitest run tests/db/discovery-tenant-purge.test.ts
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const SUITE = resolve("supabase/tests/discovery_tenant_purge.sql");

/** The part of pg's Client this test uses. */
type PgClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

function connect(target: DatabaseTarget): PgClient {
  return new Client({
    host: target.host,
    port: Number(target.port),
    user: target.user,
    password: target.password,
    database: target.database,
  }) as PgClient;
}

/** Polls until `pid` waits on an advisory lock, or fails after `ms`. */
async function waitsOnAdvisoryLock(observer: PgClient, pid: number, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      "select exists (select 1 from pg_locks where pid = $1 and locktype = 'advisory' and not granted) as waiting",
      [pid],
    );
    if (rows[0]?.waiting) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return false;
}

describe.skipIf(!RUN_DB_TESTS)("discovery tenant purge (#461)", () => {
  const clients: PgClient[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.end().catch(() => undefined)));
  });

  it("passes the SQL suite: zero mail rows, site rows unchanged, held residue listed, one audit row", () => {
    const target = requireLocalDatabase();
    const output = runPsql(target, ["-v", "ON_ERROR_STOP=1", "-f", SUITE, "-c", "select 'suite-complete'"]);
    expect(output).toContain("ROLLBACK");
    expect(output).toContain("suite-complete");
  });

  it("refuses when a registration is activated while the purge waits for the tenant lock", async () => {
    const target = requireLocalDatabase();
    const [a, b, observer] = [connect(target), connect(target), connect(target)];
    clients.push(a, b, observer);
    await Promise.all([a.connect(), b.connect(), observer.connect()]);
    const tenant = randomUUID();
    await observer.query(
      "insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status) values ($1, 'race', 'race', 'disabled')",
      [tenant],
    );
    try {
      // A holds the tenant's discovery lock, as every writer of the tenant does.
      await a.query("begin");
      await a.query("select discovery_lock_tenant($1)", [tenant]);

      const { rows } = await b.query("select pg_backend_pid() as pid");
      await b.query("begin");
      const pending = b.query("select discovery_purge_tenant($1, 'race-probe')", [tenant]).then(
        () => "ran",
        (error: { message?: string }) => error.message ?? "error",
      );
      expect(await waitsOnAdvisoryLock(observer, rows[0].pid as number)).toBe(true);

      // The registration turns active while the purge waits: it must see that and refuse.
      await a.query("update graph_reader_registrations set status = 'active' where tenant_id = $1", [tenant]);
      await a.query("commit");

      expect(await pending).toContain("a reader registration of the tenant is active");
      await b.query("rollback");
    } finally {
      await observer.query("delete from graph_reader_registrations where tenant_id = $1", [tenant]);
    }
  });
});
