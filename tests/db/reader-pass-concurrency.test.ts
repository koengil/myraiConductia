import { randomUUID } from "node:crypto";
// @ts-expect-error pg ships no declarations and @types/pg is not a dependency.
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { requireLocalDatabase, type DatabaseTarget } from "./localDatabase";

// The reader pass writer (#370, R2-M3) against a real local Postgres: a start
// and its end that arrive together are judged against each other. The writer
// takes the chain trigger's per-tenant advisory lock before it reads the
// counterpart, so the second writer waits for the first to commit and then sees
// its row (each statement of a plpgsql function takes a fresh snapshot under
// READ COMMITTED). Each case checks that B really waited on the lock.
//
// OPT-IN ONLY: skipped unless RUN_DB_TESTS=1, and localDatabase refuses any
// non-local DATABASE_URL.
//   RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     npx vitest run --no-file-parallelism tests/db/reader-pass-concurrency.test.ts
//
// Concurrency only shows between committed transactions, so each case commits
// its rows under a fresh random tenant (audit_log is append-only, so they stay).
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

type Detail = Record<string, unknown>;
/** The part of pg's Client this test uses. */
type PgClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

const iso = (ms: number) => new Date(ms).toISOString();

function started(passId: string, sourceId: string, runId: string, at: number): Detail {
  return {
    v: 1,
    passId,
    runId,
    jobId: null,
    sourceId,
    startedAt: iso(at),
    worker: { deployment: "local", revision: null },
  };
}

function finished(start: Detail, ended: number): Detail {
  return {
    ...start,
    provider: "google",
    registration: null,
    endedAt: iso(ended),
    status: "complete",
    reason: null,
    pages: 1,
    fetched: 2,
    excluded: 0,
    stored: 1,
    checkpointAdvanced: true,
  };
}

function connect(target: DatabaseTarget): PgClient {
  return new Client({
    host: target.host,
    port: Number(target.port),
    user: target.user,
    password: target.password,
    database: target.database,
  }) as PgClient;
}

async function record(client: PgClient, event: "started" | "finished", tenant: string, detail: Detail): Promise<void> {
  await client.query("select discovery_record_reader_pass($1, $2, $3::jsonb)", [event, tenant, JSON.stringify(detail)]);
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

describe.skipIf(!RUN_DB_TESTS)("reader pass writer under concurrent arrival (#370, R2-M3)", () => {
  const clients: PgClient[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.end().catch(() => undefined)));
  });

  async function three() {
    const target = requireLocalDatabase();
    const [a, b, observer] = [connect(target), connect(target), connect(target)];
    clients.push(a, b, observer);
    await Promise.all([a.connect(), b.connect(), observer.connect()]);
    return { a, b, observer };
  }

  type Case = {
    order: string;
    first: "started" | "finished";
    second: (start: Detail, end: Detail) => { event: "started" | "finished"; detail: Detail };
    outcome: "ok" | "reader_pass_mismatch";
  };

  const cases: Case[] = [
    { order: "start first, matching end", first: "started", second: (_s, e) => ({ event: "finished", detail: e }), outcome: "ok" },
    { order: "end first, matching start", first: "finished", second: (s) => ({ event: "started", detail: s }), outcome: "ok" },
    {
      order: "start first, end with a different runId",
      first: "started",
      second: (_s, e) => ({ event: "finished", detail: { ...e, runId: randomUUID() } }),
      outcome: "reader_pass_mismatch",
    },
    {
      order: "end first, start with a different sourceId",
      first: "finished",
      second: (s) => ({ event: "started", detail: { ...s, sourceId: randomUUID() } }),
      outcome: "reader_pass_mismatch",
    },
  ];

  it.each(cases)("$order", async ({ first, second, outcome }) => {
    const { a, b, observer } = await three();
    const tenant = randomUUID();
    const passId = randomUUID();
    const now = Date.now();
    const start = started(passId, randomUUID(), passId, now);
    const end = finished(start, now + 1_000);

    await a.query("begin");
    await a.query("set local role service_role");
    await record(a, first, tenant, first === "started" ? start : end);

    const { rows } = await b.query("select pg_backend_pid() as pid");
    await b.query("begin");
    await b.query("set local role service_role");
    const next = second(start, end);
    const pending = record(b, next.event, tenant, next.detail).then(
      () => "ok" as const,
      (error: { message?: string }) => error.message ?? "error",
    );

    // B blocks on the tenant lock while A is open: it cannot judge against a stale snapshot.
    expect(await waitsOnAdvisoryLock(observer, rows[0].pid as number)).toBe(true);
    await a.query("commit");

    const answer = await pending;
    expect(answer).toBe(outcome);
    await b.query(answer === "ok" ? "commit" : "rollback");

    const { rows: stored } = await observer.query(
      `select action, chain_seq::text, encode(hash, 'hex') as hash from audit_log
       where tenant_id = $1 and detail->>'passId' = $2 order by chain_seq`,
      [tenant, passId],
    );
    expect(stored.every((row) => row.hash !== null)).toBe(true);
    expect(stored.map((row) => row.chain_seq)).toEqual(outcome === "ok" ? ["1", "2"] : ["1"]);
    expect(stored).toHaveLength(outcome === "ok" ? 2 : 1);
  });
});
