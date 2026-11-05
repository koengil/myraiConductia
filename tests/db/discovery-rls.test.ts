import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { requireLocalDatabase, runPsql } from "./localDatabase";

// Deal-discovery RLS (20260925120000_discovery_core.sql) against a real local
// Postgres: Alice sees Falcon, Bob (no items) sees nothing, the CCO sees
// everything in the tenant, the firm admin sees nothing, and a colleague's
// item is metadata only. The suite rolls back.
//
// OPT-IN ONLY: skipped unless RUN_DB_TESTS=1, and localDatabase refuses any
// non-local DATABASE_URL.
//   RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     npx vitest run tests/db/discovery-rls.test.ts
// The suite evaluates the RLS helpers row by row for every persona and takes
// about 15 seconds, so it gets its own timeout instead of the 15 second default.
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const SUITE = resolve("supabase/tests/discovery_rls.sql");

describe.skipIf(!RUN_DB_TESTS)("deal discovery RLS", () => {
  it("passes the SQL suite: per-user candidate, link, item and text visibility", () => {
    const target = requireLocalDatabase();
    const output = runPsql(target, ["-v", "ON_ERROR_STOP=1", "-f", SUITE, "-c", "select 'suite-complete'"]);
    expect(output).toContain("ROLLBACK");
    expect(output).toContain("suite-complete");
  }, 90_000);
});
