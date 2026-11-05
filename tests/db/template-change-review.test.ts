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

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const SUITE = resolve("supabase/tests/template_change_review.sql");

function runPsqlAsync(target: DatabaseTarget, script: string): Promise<void> {
  const invocation = psqlInvocation(target, ["-q", "-v", "ON_ERROR_STOP=1"], process.env);
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

function manifest(steps: object[]): string {
  return JSON.stringify({ schemaVersion: 2, censusVersion: "race", skills: [], steps });
}

const BASE_STEP = {
  key: "t0",
  templateStepKey: "p1-s10",
  catalogStepId: "p1-s10",
  seq: 4,
  phaseIndex: 1,
  displayOrder: 1,
  definition: null,
  skillKey: null,
};

const ADDED_STEP = {
  key: "t1",
  templateStepKey: "custom-race",
  catalogStepId: null,
  seq: null,
  phaseIndex: 1,
  displayOrder: 2,
  definition: { title: "Fairness opinion", description: "Independent fairness opinion." },
  skillKey: null,
};

describe.skipIf(!RUN_DB_TESTS)("template change review", () => {
  it("passes the SQL suite: comparison, decisions, the notice and grants", () => {
    const target = requireLocalDatabase();
    const output = runPsql(target, ["-v", "ON_ERROR_STOP=1", "-f", SUITE, "-c", "select 'suite-complete'"]);
    expect(output).toContain("ROLLBACK");
    expect(output).toContain("suite-complete");
  });

  it("serialises two decisions on one change: the second is refused as stale", async () => {
    const target = requireLocalDatabase();
    const tenant = randomUUID();
    const bank = randomUUID();
    const director = randomUUID();
    const member = randomUUID();
    const template = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    const deal = randomUUID();

    runPsql(
      target,
      ["-q", "-At", "-v", "ON_ERROR_STOP=1"],
      `begin;
insert into auth.users (id, email, raw_user_meta_data) values
  ('${director}', 'tcr-race-director-${director}@example.test', '{"tenant_id": "${tenant}", "department": "ib"}'),
  ('${member}', 'tcr-race-member-${member}@example.test', '{"tenant_id": "${tenant}", "department": "ib"}');
select authorize_provisioned_profile(id, raw_user_meta_data) from auth.users where id in ('${director}', '${member}');
insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  select id, id, now(), now(), 'aal1' from auth.users where id in ('${director}', '${member}');
insert into companies (id, tenant_id, name, type) values ('${bank}', '${tenant}', 'Race Bank ${bank}', 'bank');
update users set company_id = '${bank}', company_role = 'director', status = 'active', is_external = false where id = '${director}';
update users set company_id = '${bank}', company_role = 'member', status = 'active', is_external = false where id = '${member}';
insert into rail_templates (id, tenant_id, company_id, name, created_by)
  values ('${template}', '${tenant}', '${bank}', 'Race rail', '${director}');
insert into rail_catalog_templates (company_id, name, created_by, rail_template_id)
  values ('${bank}', 'Race rail', '${director}', '${template}');
insert into rail_template_revisions (
  id, template_id, actor_id, request_id, request_digest, command, source_catalog_template_id, manifest, state, version
)
select r.id, '${template}', '${director}', gen_random_uuid(), repeat('c', 64), '{}'::jsonb, c.id, r.manifest, 'ready', r.version
  from rail_catalog_templates c,
       (values ('${first}'::uuid, 1, '${manifest([BASE_STEP])}'::jsonb),
               ('${second}'::uuid, 2, '${manifest([BASE_STEP, ADDED_STEP])}'::jsonb)) as r(id, version, manifest)
 where c.rail_template_id = '${template}';
update rail_templates set current_revision_id = '${second}' where id = '${template}';
insert into deals (id, tenant_id, code, codename, bank_id, status, rail_template_revision_id, rail_template_name)
  values ('${deal}', '${tenant}', 'RACE-${deal}', 'Race', '${bank}', 'active', '${first}', 'Race rail');
insert into deal_steps (deal_id, step_id, seq, status, phase_index, display_order, origin, template_step_key)
  values ('${deal}', 'p1-s10', 4, 'current', 1, 1, 'catalog', 'p1-s10');
commit;
`,
    );

    const decide = (actor: string) =>
      `select deal_template_change_decide('${deal}', '${actor}', 'added:custom-race', 'accepted', '${second}', array[]::text[]);`;
    const [held, late] = await Promise.allSettled([
      runPsqlAsync(target, `begin;\n${decide(director)}\nselect pg_sleep(2);\ncommit;\n`),
      runPsqlAsync(target, `select pg_sleep(0.8);\n${decide(member)}\n`),
    ]);

    expect(held.status).toBe("fulfilled");
    expect(late.status).toBe("rejected");
    expect(late.status === "rejected" ? String(late.reason) : "").toContain("stale_change");

    const state = runPsql(
      target,
      ["-q", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1"],
      `select
  (select count(*) from deal_template_change_decisions where deal_id = '${deal}'),
  (select count(*) from deal_steps where deal_id = '${deal}' and template_step_key = 'custom-race');`,
    ).trim();
    expect(state).toBe("1|1");
  }, 60_000);
});
