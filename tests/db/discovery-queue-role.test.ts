import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { requireLocalDatabase, runPsql } from "./localDatabase";

// The job queue's database role (20260925160000_discovery_queue_role.sql)
// against a real local Postgres: discovery_queue has DML on the pgboss schema
// and nothing in public, runs a job, and cannot read or write audit_log or
// alter or disable a trigger. The suite rolls back.
//
// OPT-IN ONLY: skipped unless RUN_DB_TESTS=1, and localDatabase refuses any
// non-local DATABASE_URL.
//   RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     npx vitest run tests/db/discovery-queue-role.test.ts
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const SUITE = resolve("supabase/tests/discovery_queue_role.sql");

describe.skipIf(!RUN_DB_TESTS)("deal discovery queue role", () => {
  it("passes the SQL suite: discovery_queue runs a job and cannot touch audit_log", () => {
    const target = requireLocalDatabase();
    const output = runPsql(target, ["-v", "ON_ERROR_STOP=1", "-f", SUITE, "-c", "select 'suite-complete'"]);
    expect(output).toContain("ROLLBACK");
    expect(output).toContain("suite-complete");
  });
});
