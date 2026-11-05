import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  psqlInvocation,
  requireLocalDatabase,
  runPsql,
  type DatabaseTarget,
} from "./localDatabase";

// #296 (design Q1, review C1): create_invite reads invitation authority through
// the permission resolver, which reads role and permission rows WITHOUT locking
// them. Every grant mutation takes a company-scoped advisory lock first
// (company_access_lock_actor), so create_invite takes the same key in SHARED mode
// as its first statement. A revocation in flight therefore finishes before the
// invite reads authority, and two invites never block each other.
//
// The race cannot run inside one rolled-back transaction: two sessions only meet
// between committed transactions. So this commits its rows under a fresh random
// tenant (audit_log is append-only, so the users who wrote audit rows stay), the
// pattern tests/db/mailbox-allowlist.test.ts uses.
//
//   A  replace_company_role drops company:invites:send from the role, then holds
//      its transaction open.
//   B  starts after A holds the lock and calls create_invite as a member whose
//      ONLY source of the permission is that role.
//
// With the lock, B waits for A to commit and then refuses (not_permitted). Without
// it, B reads the role as it was before A commits and ISSUES the invite. The
// OUTCOME is what discriminates: without the lock B still waits, but later, at the
// per-tenant audit chain lock A also holds, and then issues, so elapsed time alone
// proves nothing.
//
// OPT-IN ONLY: skipped unless RUN_DB_TESTS=1, and localDatabase refuses any
// non-local DATABASE_URL.
//   RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     npx vitest run --no-file-parallelism tests/db/invite-authority-concurrency.test.ts
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

const HOLD_MS = 2500;
const B_START_MS = 800;

type Captured = { stdout: string; stderr: string };

function runPsqlAsync(target: DatabaseTarget, script: string): Promise<Captured> {
  const invocation = psqlInvocation(target, ["-q", "-At", "-v", "ON_ERROR_STOP=1"], process.env);
  return new Promise((done, fail) => {
    const child = spawn("psql", invocation.args, {
      env: invocation.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0
        ? done({ stdout, stderr })
        : fail(new Error(`psql exited ${code}: ${stderr.trim()}`)),
    );
    child.stdin.end(script);
  });
}

describe.skipIf(!RUN_DB_TESTS)("invite authority concurrency", () => {
  it("makes a create_invite wait for an in-flight revocation, then refuse", async () => {
    const target = requireLocalDatabase();
    const tenant = randomUUID();
    const bank = randomUUID();
    const director = randomUUID();
    const member = randomUUID();
    const role = randomUUID();
    const domain = `race-${bank.slice(0, 8)}.example`;

    runPsql(
      target,
      ["-q", "-At", "-v", "ON_ERROR_STOP=1"],
      `begin;
insert into auth.users (id, email, raw_user_meta_data) values
  ('${director}', 'race-dir-${director}@example.test', '{"tenant_id": "${tenant}", "department": "ib"}'),
  ('${member}', 'race-member-${member}@example.test', '{"tenant_id": "${tenant}", "department": "ib"}');
-- #316: new auth users are contained; authorize them and give each a live session (id = user id).
select authorize_provisioned_profile(id, raw_user_meta_data) from auth.users where id in ('${director}', '${member}');
insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  select id, id, now(), now(), 'aal1' from auth.users where id in ('${director}', '${member}');
update users set status = 'active', is_external = false where id in ('${director}', '${member}');
insert into companies (id, tenant_id, name, type) values ('${bank}', '${tenant}', 'Race Bank ${bank}', 'bank');
update users set company_id = '${bank}', company_role = 'director' where id = '${director}';
update users set company_id = '${bank}', company_role = 'member' where id = '${member}';
insert into company_verified_domains (tenant_id, company_id, domain, source)
  values ('${tenant}', '${bank}', '${domain}', 'test');
-- The member's ONLY source of company:invites:send is this company role.
insert into company_member_access (company_id, user_id) values ('${bank}', '${member}');
insert into company_roles (id, company_id, name, created_by) values ('${role}', '${bank}', 'Race Inviters', '${director}');
insert into company_role_permissions (company_id, role_id, permission_key)
  values ('${bank}', '${role}', 'company:invites:send');
insert into company_member_roles (company_id, user_id, role_id, assigned_by)
  values ('${bank}', '${member}', '${role}', '${director}');
commit;
`,
    );

    try {
      // Positive control: before the race the member's role-held permission lets
      // create_invite succeed (rolled back), so the later refusal is the revocation.
      const control = runPsql(
        target,
        ["-q", "-At", "-v", "ON_ERROR_STOP=1"],
        `begin;
select create_invite('${member}', 'control@${domain}', '${bank}', 'member', repeat('a', 64)) is not null;
rollback;
`,
      );
      expect(control.trim().split("\n")[0]).toBe("t");

      // A: the director drops the permission from the role and holds the transaction.
      const revocation = runPsqlAsync(
        target,
        `begin;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
select replace_company_role('${director}', '${bank}', '${role}',
  (select version from company_roles where id = '${role}'), 'Race Inviters', null, array[]::text[]);
select pg_sleep(${HOLD_MS / 1000});
commit;
`,
      );
      // B: starts after A holds the lock; reports how long create_invite took and
      // what it did.
      const invite = runPsqlAsync(
        target,
        `select pg_sleep(${B_START_MS / 1000});
do $$
declare
  v_t0 timestamptz := clock_timestamp();
  v_outcome text;
begin
  begin
    perform create_invite('${member}', 'race@${domain}', '${bank}', 'member', repeat('a', 64));
    v_outcome := 'issued';
  exception when others then
    v_outcome := sqlerrm;
  end;
  raise notice 'RACE|%|%', round(extract(epoch from clock_timestamp() - v_t0) * 1000), v_outcome;
end $$;
`,
      );
      const [, b] = await Promise.all([revocation, invite]);

      const line = b.stderr.split("\n").find((l) => l.includes("RACE|"));
      expect(line, `no RACE line in: ${b.stderr}`).toBeTruthy();
      const [, elapsedMs, outcome] = line!.slice(line!.indexOf("RACE|")).split("|");
      // B waited for A's commit (A held ~HOLD_MS, B started B_START_MS in) ...
      expect(Number(elapsedMs)).toBeGreaterThanOrEqual(HOLD_MS - B_START_MS - 600);
      // ... and, reading authority only after that commit, no longer held the
      // permission. Without the lock line this is 'issued'.
      expect(outcome.trim()).toBe("not_permitted");

      const issued = runPsql(
        target,
        ["-q", "-At", "-v", "ON_ERROR_STOP=1"],
        `select count(*) from invites where tenant_id = '${tenant}';`,
      ).trim();
      expect(issued).toBe("0");
    } finally {
      runPsql(
        target,
        ["-q", "-v", "ON_ERROR_STOP=1"],
        `delete from invites where tenant_id = '${tenant}';`,
      );
    }
  }, 60_000);
});
