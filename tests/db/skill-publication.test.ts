import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  requireLocalDatabase,
  runPsql,
  type DatabaseTarget,
} from "./localDatabase";
import { CASES } from "../support/skillPublicationProbeCases";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const PROBE = resolve("supabase/tests/skill_publication.sql");

type Footprint = {
  schema: boolean;
  auth: boolean;
  serviceRole: boolean;
  anonRole: boolean;
  authenticatedRole: boolean;
  pgcrypto: boolean;
  extensionsSchema: boolean;
};

function footprint(target: DatabaseTarget, schema: string): Footprint {
  const query = `select json_build_object(
    'schema', to_regnamespace('${schema}') is not null,
    'auth', to_regnamespace('auth') is not null,
    'serviceRole', exists (select from pg_roles where rolname = 'service_role'),
    'anonRole', exists (select from pg_roles where rolname = 'anon'),
    'authenticatedRole', exists (select from pg_roles where rolname = 'authenticated'),
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

describe.skipIf(!RUN_DB_TESTS)("skill publication database probe", () => {
  it("proves every durable publication invariant inside a rolled-back local schema", () => {
    const target = requireLocalDatabase();
    const schema = `conductia_skill_publication_${randomUUID().replaceAll("-", "")}`;
    const before = footprint(target, schema);
    expect(before.schema).toBe(false);
    try {
      expect(passedCases(target, schema)).toEqual(CASES);
    } finally {
      expect(footprint(target, schema)).toEqual(before);
    }
  });
});
