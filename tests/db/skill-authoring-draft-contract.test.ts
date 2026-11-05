import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAuthoritativeDraft } from "@/lib/skillAuthoring/browserRoute";
import {
  requireLocalDatabase,
  runPsql,
  type DatabaseTarget,
} from "./localDatabase";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const PROBE = resolve("supabase/tests/skill-authoring-draft-contract.sql");

function footprint(target: DatabaseTarget, schema: string): boolean {
  const query = `select to_regnamespace('${schema}') is not null`;
  return runPsql(target, ["-Atc", query]).trim() === "t";
}

function readDraft(target: DatabaseTarget, schema: string): unknown {
  const output = runPsql(
    target,
    ["-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-v", `schema=${schema}`],
    `begin;\n\\i '${PROBE}'\nrollback;\n`,
  );
  return JSON.parse(output.trim());
}

describe.skipIf(!RUN_DB_TESTS)("skill authoring draft contract probe", () => {
  it("normalizes an authoritative draft read with a succeeded and a running attempt", () => {
    const target = requireLocalDatabase();
    const schema = `conductia_draft_contract_${randomUUID().replaceAll("-", "")}`;
    expect(footprint(target, schema)).toBe(false);
    let raw: { draft?: unknown };
    try {
      raw = readDraft(target, schema) as { draft?: unknown };
    } finally {
      expect(footprint(target, schema)).toBe(false);
    }

    const draft = normalizeAuthoritativeDraft(raw.draft);
    expect(draft).not.toBeNull();
    expect(draft?.activeAttempt).not.toBeNull();
    expect(draft?.activeAttempt?.responseText).toBe(
      "working on the follow-up column",
    );
    expect(draft?.candidate?.name).toBe("buyer-outreach-tracker");
  });
});
