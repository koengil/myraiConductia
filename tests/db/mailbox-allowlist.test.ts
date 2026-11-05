import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  psqlInvocation,
  requireLocalDatabase,
  runPsql,
  type DatabaseTarget,
} from "./localDatabase";

// The mailbox allowlist (20261001130000_mailbox_allowlist.sql, #262) against a
// real local Postgres: the views, the guard's reasons and audit rows, the two
// consent RPCs, the seat-loss trigger and the grants. The SQL suite rolls back.
// The race case cannot: two sessions only meet between committed transactions,
// so it commits its rows under a fresh random tenant (audit_log is append-only,
// so the users who wrote audit rows stay; the registration is removed so the
// worker never picks the tenant up).
//
// OPT-IN ONLY: skipped unless RUN_DB_TESTS=1, and localDatabase refuses any
// non-local DATABASE_URL.
//   RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     npx vitest run tests/db/mailbox-allowlist.test.ts
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const SUITE = resolve("supabase/tests/mailbox_allowlist.sql");

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

describe.skipIf(!RUN_DB_TESTS)("mailbox allowlist", () => {
  it("passes the SQL suite: views, guard reasons, consent RPCs, seat loss and grants", () => {
    const target = requireLocalDatabase();
    const output = runPsql(target, ["-v", "ON_ERROR_STOP=1", "-f", SUITE, "-c", "select 'suite-complete'"]);
    expect(output).toContain("ROLLBACK");
    expect(output).toContain("suite-complete");
  });

  it("holds the seat still while a grant decides: a concurrent removal waits, then withdraws the new consent", async () => {
    const target = requireLocalDatabase();
    const tenant = randomUUID();
    const bank = randomUUID();
    const director = randomUUID();
    const member = randomUUID();
    const deal = randomUUID();
    const address = `race-${member.slice(0, 8)}@bank.example`;

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
insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status, mailbox_domains, firm_company_id)
  values ('${tenant}', 'fixture', 'fixture', 'active', '{bank.example}', '${bank}');
-- The one-click opt-in needs MD or deal team on a deal of the tenant (#262 A2).
insert into deals (id, tenant_id, code, codename, bank_id) values ('${deal}', '${tenant}', 'RACE-${deal}', 'Race', '${bank}');
insert into deal_memberships (deal_id, user_id, role_id, deal_role)
  values ('${deal}', '${member}', (select id from roles where slug = 'deal_team'), 'deal_team');
insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status, accepted_at, accepted_user_id)
  values ('${tenant}', '${address}', '${director}', '${bank}', 'member', 'accepted', 'sent', now(), '${member}');
commit;
`,
    );

    try {
      // A grants and holds its transaction open; B starts after A holds the
      // seat and tries to remove the member.
      const grant = runPsqlAsync(
        target,
        `begin;
select set_config('request.jwt.claims', '{"sub": "${member}", "session_id": "${member}", "role": "authenticated"}', true);
select mailbox_consent_grant();
select pg_sleep(2);
commit;
`,
      );
      const removal = runPsqlAsync(
        target,
        `select pg_sleep(0.8);
update users set company_id = null, company_role = null, status = 'suspended' where id = '${member}';
`,
      );
      await Promise.all([grant, removal]);

      const state = runPsql(
        target,
        ["-q", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1"],
        `select
  (select count(*) from mailbox_consents where user_id = '${member}'),
  (select count(*) from mailbox_consents where user_id = '${member}' and withdrawn_at is null),
  (select count(*) from audit_log where tenant_id = '${tenant}' and action = 'discovery.mailbox_consent_withdrawn'
     and detail->>'reason' = 'seat_lost'),
  (select count(*) from allowed_mailboxes where tenant_id = '${tenant}');`,
      ).trim();
      // One consent, none open, one seat_lost audit row, nothing allowed.
      expect(state).toBe("1|0|1|0");
    } finally {
      // Sources first: a registration with sources cannot be deleted (on delete restrict, #259 plan D1).
      runPsql(
        target,
        ["-q", "-v", "ON_ERROR_STOP=1"],
        `delete from content_sources where tenant_id = '${tenant}'; delete from graph_reader_registrations where tenant_id = '${tenant}';`,
      );
    }
  }, 60_000);
});
