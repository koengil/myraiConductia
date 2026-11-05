import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { requireLocalDatabase, runPsql } from "./localDatabase";

// Deal-discovery ingestion health (20260925150000_discovery_health.sql)
// against a real local Postgres: the firm admin and the control room get
// counts and sync state and no content, an analyst and anon are denied, the
// job queue is out of reach, and a skipped ledger row carries exactly one
// known reason. The suite rolls back.
//
// OPT-IN ONLY: skipped unless RUN_DB_TESTS=1, and localDatabase refuses any
// non-local DATABASE_URL.
//   RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     npx vitest run tests/db/discovery-health.test.ts
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const SUITE = resolve("supabase/tests/discovery_health.sql");

describe.skipIf(!RUN_DB_TESTS)("deal discovery ingestion health", () => {
  it("passes the SQL suite: admin and CCO get counts only, an analyst is denied", () => {
    const target = requireLocalDatabase();
    const output = runPsql(target, ["-v", "ON_ERROR_STOP=1", "-f", SUITE, "-c", "select 'suite-complete'"]);
    expect(output).toContain("ROLLBACK");
    expect(output).toContain("suite-complete");
  });
});
