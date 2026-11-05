import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { requireLocalDatabase, runPsql } from "./localDatabase";

// #461: withdrawing consent deletes the banker's stored mail
// (20261014120500_discovery_purge.sql), against a real local Postgres. A sole
// holder's items, texts, evidence, milestones and candidate are deleted through
// the real mailbox_consent_withdraw() RPC; a message a colleague's mailbox also
// holds stays; one discovery.mailbox_purged row is written; a second withdraw is
// a no-op; the collector keeps in-flight orphans, documents and other tenants.
// Phase 2: shared evidence, promoted deals, legal hold, the correction log's
// guard, merged children, SharePoint survival and the rebase of a candidate a
// document still evidences. Slice 2: group removal withdraws only after the
// grace on a fresh check, and the backstop collects orphans in every tenant with
// one audit row each. Any FAIL raises, and ON_ERROR_STOP turns it into a psql
// failure. The suite rolls back.
//
// OPT-IN ONLY: skipped unless RUN_DB_TESTS=1, and localDatabase refuses any
// non-local DATABASE_URL.
//   RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     npx vitest run tests/db/discovery-purge.test.ts
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const SUITE = resolve("supabase/tests/discovery_purge.sql");

describe.skipIf(!RUN_DB_TESTS)("discovery purge on consent end (#461)", () => {
  it("passes the SQL suite: a sole holder's mail is deleted, shared mail stays, one audit row", () => {
    const target = requireLocalDatabase();
    const output = runPsql(target, ["-v", "ON_ERROR_STOP=1", "-f", SUITE, "-c", "select 'suite-complete'"]);
    expect(output).toContain("ROLLBACK");
    expect(output).toContain("suite-complete");
  });
});
