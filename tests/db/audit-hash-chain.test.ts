import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalRow,
  chainSeq,
  verifyChain,
  type AuditChainRow,
} from "@/lib/audit/chain";
import {
  psqlInvocation,
  requireLocalDatabase,
  runPsql,
  type DatabaseTarget,
} from "./localDatabase";

// The per-tenant audit_log hash chain (20260925100000_audit_hash_chain.sql)
// against a real local Postgres.
//
// OPT-IN ONLY: skipped unless RUN_DB_TESTS=1, and localDatabase refuses any
// non-local DATABASE_URL.
//   RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     npx vitest run tests/db/audit-hash-chain.test.ts
//
// The SQL suite and the canonical-form comparison roll back. The concurrency
// case cannot: forks only show between committed transactions, so it commits
// its rows under a fresh random tenant, where they form a valid chain of
// their own (audit_log is append-only, so they stay).
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const SUITE = resolve("supabase/tests/discovery_audit_chain.sql");

type SqlRow = AuditChainRow & { canonical: string };

function selectChain(where: string): string {
  // A non-UTC session zone: the SQL canonical form must not depend on it, and
  // the TypeScript side must parse the +05:30 rendering it produces.
  return `set timezone = 'Asia/Kolkata';
select coalesce(json_agg(json_build_object(
  'id', id, 'ts', ts, 'tenant_id', tenant_id, 'chain_seq', chain_seq::text,
  'actor_type', actor_type, 'actor_id', actor_id, 'service_identity', service_identity,
  'action', action, 'deal_id', deal_id, 'document_id', document_id,
  'detail_text', detail::text, 'prev_hash', encode(prev_hash, 'hex'), 'hash', encode(hash, 'hex'),
  'canonical', audit_canonical_row(a)) order by chain_seq), '[]'::json)
from audit_log a where ${where};`;
}

function parseRows(output: string): SqlRow[] {
  const line = output.trim().split("\n").at(-1) ?? "[]";
  return JSON.parse(line) as SqlRow[];
}

function runPsqlAsync(target: DatabaseTarget, script: string): Promise<void> {
  const invocation = psqlInvocation(
    target,
    ["-q", "-v", "ON_ERROR_STOP=1"],
    process.env,
  );
  return new Promise((done, fail) => {
    const child = spawn("psql", invocation.args, {
      env: invocation.env,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0 ? done() : fail(new Error(`psql exited ${code}: ${stderr.trim()}`)),
    );
    child.stdin.end(script);
  });
}

// Characters that stress jsonb's string escaping, without `$` (the dollar
// quote below) or NUL (jsonb rejects it).
const ALPHABET = [
  ..."abcXYZ019 ",
  '"',
  "\\",
  "/",
  "\n",
  "\t",
  "\r",
  "\b",
  "\f",
  "\u0001",
  "\u001f",
  "\u007f",
  "é",
  "ß",
  " ",
  " ",
  "中",
  "😀",
];
const NUMBERS = ["0", "-0", "1", "1.0", "1.50", "1e3", "-2.5E-4", "12345678901234567890", "0.1"];

function pick<T>(list: readonly T[], random: () => number): T {
  return list[Math.floor(random() * list.length)];
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe.skipIf(!RUN_DB_TESTS)("audit_log hash chain", () => {
  it("passes the SQL suite: continuity, genesis per tenant, system tenant, discovery tenant rule", () => {
    const target = requireLocalDatabase();
    const output = runPsql(target, ["-v", "ON_ERROR_STOP=1", "-f", SUITE]);
    expect(output).toContain("ROLLBACK");
  });

  it("computes the same canonical text in TypeScript as audit_canonical_row, for hostile details", () => {
    const target = requireLocalDatabase();
    const tenant = randomUUID();
    const random = seeded(20260925);
    const inserts: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      // Whole characters, so no surrogate pair is ever split.
      const chars = Array.from({ length: 12 }, () => pick(ALPHABET, random));
      const text = chars.join("");
      const detail = `{"s": ${JSON.stringify(text)}, "n": ${pick(NUMBERS, random)}, "k${index}": [${pick(NUMBERS, random)}, null, true], "a": {"zz": ${JSON.stringify(chars.slice(3).join(""))}, "b": {}}}`;
      const ts = `2026-0${1 + (index % 9)}-1${index % 10} 0${index % 10}:3${index % 6}:0${index % 10}.${String(index * 7919).padStart(6, "0").slice(0, 6)}+0${index % 10}:${index % 2 ? "30" : "00"}`;
      inserts.push(
        `insert into audit_log (service_identity, action, tenant_id, ts, detail) values ('audit-chain-test', 'view', '${tenant}', '${ts}', $d$${detail}$d$::jsonb);`,
      );
    }
    const output = runPsql(
      target,
      ["-q", "-At", "-v", "ON_ERROR_STOP=1"],
      `begin;\n${inserts.join("\n")}\n${selectChain(`tenant_id = '${tenant}'`)}\nrollback;\n`,
    );
    const rows = parseRows(output);
    expect(rows).toHaveLength(40);
    for (const row of rows) expect(canonicalRow(row)).toBe(row.canonical);
    expect(verifyChain(rows)).toEqual({ ok: true, length: 40 });
  });

  it("does not fork under concurrent writers to one tenant", async () => {
    const target = requireLocalDatabase();
    const tenant = randomUUID();
    const WORKERS = 8;
    const TRANSACTIONS = 10;
    const scripts = Array.from({ length: WORKERS }, (_, worker) =>
      Array.from(
        { length: TRANSACTIONS },
        (_, tx) => `begin;
insert into audit_log (service_identity, action, tenant_id, detail)
  values ('audit-chain-test', 'view', '${tenant}', '{"worker": ${worker}, "tx": ${tx}, "row": 1}');
select pg_sleep(0.005);
insert into audit_log (service_identity, action, tenant_id, detail)
  values ('audit-chain-test', 'view', '${tenant}', '{"worker": ${worker}, "tx": ${tx}, "row": 2}'),
         ('audit-chain-test', 'view', '${tenant}', '{"worker": ${worker}, "tx": ${tx}, "row": 3}');
commit;`,
      ).join("\n"),
    );
    await Promise.all(scripts.map((script) => runPsqlAsync(target, script)));

    const rows = parseRows(
      runPsql(target, ["-q", "-At", "-v", "ON_ERROR_STOP=1"], selectChain(`tenant_id = '${tenant}'`)),
    );
    const total = WORKERS * TRANSACTIONS * 3;
    expect(rows).toHaveLength(total);
    expect(rows.map((row) => chainSeq(row.chain_seq))).toEqual(
      Array.from({ length: total }, (_, index) => BigInt(index + 1)),
    );
    for (const row of rows) expect(canonicalRow(row)).toBe(row.canonical);
    expect(verifyChain(rows)).toEqual({ ok: true, length: total });
  }, 60_000);
});
