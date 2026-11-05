import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  requireLocalDatabase,
  runPsql,
  type DatabaseTarget,
} from "./localDatabase";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const PROBE = resolve("supabase/tests/skill_authoring.sql");
const CASES = [
  "get_or_create_draft returns the same active draft on a second call",
  "a second member cannot read or patch the first authors draft",
  "a member without the structure permission is refused by lock_author",
  "patch_draft stale revision conflict and empty name accepted",
  "submit_message creates a running attempt and replays or conflicts correctly",
  "stale running attempt is projected and then failed on the next submission",
  "run_context pairs history and returns the current candidate",
  "record_progress and complete_attempt succeed once, then no-op",
  "candidate after discard is completed but not selected",
  "a retried attempt projects its message_id and retry_request_id",
  "only service_role can execute skill_authoring_read_draft",
  "audit rows exist for the lifecycle without leaking message or reply text",
];

type Footprint = {
  schema: boolean;
  auth: boolean;
  serviceRole: boolean;
  pgcrypto: boolean;
  extensionsSchema: boolean;
};

function footprint(target: DatabaseTarget, schema: string): Footprint {
  const query = `select json_build_object(
    'schema', to_regnamespace('${schema}') is not null,
    'auth', to_regnamespace('auth') is not null,
    'serviceRole', exists (select from pg_roles where rolname = 'service_role'),
    'pgcrypto', exists (select from pg_extension where extname = 'pgcrypto'),
    'extensionsSchema', to_regnamespace('extensions') is not null)`;
  return JSON.parse(runPsql(target, ["-Atc", query])) as Footprint;
}

function passedCases(target: DatabaseTarget, schema: string): string[] {
  const output = runPsql(
    target,
    ["-q", "-v", "ON_ERROR_STOP=1", "-v", `schema=${schema}`],
    `begin;\n\\i '${PROBE}'\nrollback;\n`,
  );
  return output
    .split("\n")
    .filter((line) => line.startsWith("ok: "))
    .map((line) => line.slice(4));
}

describe.skipIf(!RUN_DB_TESTS)("skill authoring database probe", () => {
  it("proves every durable authoring invariant inside a rolled-back local schema", () => {
    const target = requireLocalDatabase();
    const schema = `conductia_task18_${randomUUID().replaceAll("-", "")}`;
    const before = footprint(target, schema);
    expect(before.schema).toBe(false);
    try {
      expect(passedCases(target, schema)).toEqual(CASES);
    } finally {
      expect(footprint(target, schema)).toEqual(before);
    }
  });
});
