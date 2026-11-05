import { randomUUID } from "node:crypto";
// @ts-expect-error pg ships no declarations and @types/pg is not a dependency.
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { requireLocalDatabase, runPsql, type DatabaseTarget } from "./localDatabase";

// Adding a member to a team inbox while the worker upserts candidates (#581, design R5, review round 2 M-C).
// discovery_upsert_candidates takes the tenant's discovery lock, refreshes candidate visibility, then writes
// audit (which takes the audit chain's lock). The member RPC and its visibility trigger take the same
// discovery lock FIRST, so the two queue behind each other instead of crossing on the audit chain. This runs
// both orderings with two real sessions and asserts neither deadlocks, that the second really waited on the
// advisory lock, and that the member ends up with a visibility row for the candidate in both.
//
// OPT-IN ONLY: skipped unless RUN_DB_TESTS=1, and localDatabase refuses any non-local DATABASE_URL.
//   RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     npx vitest run --no-file-parallelism tests/db/team-mailbox-lock-order.test.ts
//
// Concurrency only shows between committed transactions, so each case commits its rows under a fresh
// random tenant (audit_log is append-only, so they stay), the pattern tests/db/reader-pass-concurrency.test.ts
// and invite-authority-concurrency.test.ts use. The deal_discovery flag is switched on only while the
// fixture connects the inbox, and put back.
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

/** The part of pg's Client this test uses. */
type PgClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

type Fixture = {
  tenant: string;
  bank: string;
  admin: string;
  member: string;
  teamMailbox: string;
  item: string;
  tag: string;
  domain: string;
};

function connect(target: DatabaseTarget): PgClient {
  return new Client({
    host: target.host,
    port: Number(target.port),
    user: target.user,
    password: target.password,
    database: target.database,
  }) as PgClient;
}

/** Polls until `pid` waits on an advisory lock, or fails after `ms`. */
async function waitsOnAdvisoryLock(observer: PgClient, pid: number, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      "select exists (select 1 from pg_locks where pid = $1 and locktype = 'advisory' and not granted) as waiting",
      [pid],
    );
    if (rows[0]?.waiting) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return false;
}

/** A tenant with a firm, its admin, one colleague, and a verified team inbox holding one message. Committed. */
function createFixture(target: DatabaseTarget): Fixture {
  const tenant = randomUUID();
  const bank = randomUUID();
  const admin = randomUUID();
  const member = randomUUID();
  const item = randomUUID();
  const tag = tenant.slice(0, 8);
  const domain = `lock-${tag}.example`;
  const clientId = `9${Array.from({ length: 17 }, () => Math.floor(Math.random() * 10)).join("")}`;
  const flag = "deal_discovery";

  runPsql(
    target,
    ["-q", "-At", "-v", "ON_ERROR_STOP=1"],
    `begin;
insert into auth.users (id, email, raw_user_meta_data) values
  ('${admin}', 'lock-admin-${admin}@example.test', '{"tenant_id": "${tenant}", "department": "admin"}'),
  ('${member}', 'lock-member-${member}@example.test', '{"tenant_id": "${tenant}", "department": "ib"}');
-- #316: new auth users are contained; authorize them.
select authorize_provisioned_profile(id, raw_user_meta_data) from auth.users where id in ('${admin}', '${member}');
update users set status = 'active', is_external = false where id in ('${admin}', '${member}');
insert into companies (id, tenant_id, name, type) values ('${bank}', '${tenant}', 'Lock Bank ${tag}', 'bank');
-- The director first: company_has_director refuses a bank of members only.
update users set company_id = '${bank}', company_role = 'director' where id = '${admin}';
update users set company_id = '${bank}', company_role = 'member' where id = '${member}';
update users set firm_role = 'admin' where id = '${admin}';
insert into google_reader_registrations
  (tenant_id, workspace_domain, service_account_email, client_id,
   directory_service_account_email, allowlist_group, firm_company_id, status, consented_at)
values
  ('${tenant}', '${domain}', 'dwd-reader@lock-${tag}.iam.gserviceaccount.com', '${clientId}',
   'dir-reader@lock-${tag}.iam.gserviceaccount.com', 'conductia-ingest@${domain}', '${bank}', 'active', now());
do $$
declare v_prev boolean;
begin
  select enabled into v_prev from feature_flags where key = '${flag}';
  insert into feature_flags (key, enabled) values ('${flag}', true) on conflict (key) do update set enabled = true;
  perform set_config('request.jwt.claims', '{"sub": "${admin}", "role": "authenticated"}', true);
  perform discovery_connect_team_mailbox('deals@${domain}', 1);
  update feature_flags set enabled = coalesce(v_prev, false) where key = '${flag}';
end $$;
select discovery_record_team_mailbox_check(id, 'verified', null, 'dir-lock') from team_mailboxes where tenant_id = '${tenant}';
insert into source_items (id, tenant_id, kind, subject, sent_at, internet_message_id, content_hash)
  values ('${item}', '${tenant}', 'message', 'Project Lock ${tag}', '2026-02-03', '<lock-${tag}@t>', 'lk-${tag}');
insert into source_item_sources (source_item_id, content_source_id, provider_item_id)
  select '${item}', cs.id, 'lock-1' from content_sources cs
  where cs.tenant_id = '${tenant}' and cs.team_mailbox_id is not null;
commit;
`,
  );
  const teamMailbox = runPsql(
    target,
    ["-q", "-At", "-v", "ON_ERROR_STOP=1"],
    `select id from team_mailboxes where tenant_id = '${tenant}' and disconnected_at is null;`,
  ).trim();
  expect(teamMailbox, "the fixture connected one team inbox").toMatch(/^[0-9a-f-]{36}$/);
  return { tenant, bank, admin, member, teamMailbox, item, tag, domain };
}

describe.skipIf(!RUN_DB_TESTS)("team inbox member add against the worker's candidate upsert (#581, R5)", () => {
  const clients: PgClient[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.end().catch(() => undefined)));
  });

  async function three() {
    const target = requireLocalDatabase();
    const [a, b, observer] = [connect(target), connect(target), connect(target)];
    clients.push(a, b, observer);
    await Promise.all([a.connect(), b.connect(), observer.connect()]);
    return { target, a, b, observer };
  }

  const cases = [
    { order: "the upsert holds the lock first, the member add waits", first: "upsert" as const },
    { order: "the member add holds the lock first, the upsert waits", first: "add" as const },
  ];

  it.each(cases)("$order", async ({ first }) => {
    const { target, a, b, observer } = await three();
    const fx = createFixture(target);
    const groups = JSON.stringify([
      {
        clusterKey: `codename:lock-${fx.tag}`,
        proposedName: "Project Lock",
        codenameGuess: "Project Lock",
        parties: [],
        firstSeenAt: "2026-02-03T00:00:00Z",
        lastSeenAt: "2026-02-03T00:00:00Z",
        confidence: 0.9,
        links: [{ sourceItemId: fx.item, method: "codename", confidence: 0.9 }],
      },
    ]);

    // Each statement runs in its own open transaction, as the role that really runs it.
    const upsert = async (client: PgClient) => {
      await client.query("begin");
      await client.query("set local role service_role");
      return () => client.query("select discovery_upsert_candidates($1, $2, $3::jsonb)", [fx.tenant, randomUUID(), groups]);
    };
    const add = async (client: PgClient) => {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: fx.admin, role: "authenticated" }),
      ]);
      return () => client.query("select discovery_add_team_mailbox_member($1, $2)", [fx.teamMailbox, fx.member]);
    };

    const [startFirst, startSecond] = first === "upsert" ? [upsert, add] : [add, upsert];
    const runFirst = await startFirst(a);
    const runSecond = await startSecond(b);

    // The first session does its work and keeps the transaction open, holding the tenant's discovery lock.
    await runFirst();

    // The second must queue on the advisory lock; had it gone ahead it would cross the first on the audit chain.
    const { rows } = await b.query("select pg_backend_pid() as pid");
    const pending = runSecond().then(
      () => "ok" as const,
      (error: { code?: string; message?: string }) => error.code ?? error.message ?? "error",
    );
    expect(await waitsOnAdvisoryLock(observer, rows[0].pid as number)).toBe(true);

    await a.query("commit");
    const answer = await pending;
    expect(answer, "the second session finished without a deadlock (40P01)").toBe("ok");
    await b.query("commit");

    // Both orderings end the same way: the member is open on the inbox and sees the candidate.
    const { rows: members } = await observer.query(
      "select count(*)::int as n from team_mailbox_members where team_mailbox_id = $1 and user_id = $2 and removed_at is null",
      [fx.teamMailbox, fx.member],
    );
    expect(members[0].n).toBe(1);
    const { rows: visible } = await observer.query(
      `select cv.source_item_count::int as n
       from candidate_visibility cv join deal_candidates dc on dc.id = cv.candidate_id
       where dc.tenant_id = $1 and cv.person_id = $2`,
      [fx.tenant, fx.member],
    );
    expect(visible).toEqual([{ n: 1 }]);
    const { rows: audited } = await observer.query(
      `select action from audit_log where tenant_id = $1
         and action in ('discovery.candidate_proposed', 'discovery.team_mailbox_member_added')
       order by chain_seq`,
      [fx.tenant],
    );
    expect(audited.map((row) => row.action).sort()).toEqual([
      "discovery.candidate_proposed",
      "discovery.team_mailbox_member_added",
    ]);
  }, 60_000);

  // Audit item 4: a member's seat loss closes the membership in an after-row trigger on users, behind
  // mailbox_consents_close_on_seat_loss, which can write audit first. The tenant's discovery lock is taken in a
  // BEFORE trigger, so a seat loss and the worker's upsert still queue on it, in either order, and never cross on
  // the audit chain.
  const seatCases = [
    { order: "the upsert holds the lock first, the seat loss waits", first: "upsert" as const },
    { order: "the seat loss holds the lock first, the upsert waits", first: "seat" as const },
  ];

  it.each(seatCases)("seat loss: $order", async ({ first }) => {
    const { target, a, b, observer } = await three();
    const fx = createFixture(target);
    // The member also opted in their OWN mailbox (audit item 4): mailbox_consents_close_on_seat_loss sorts before
    // the team trigger and writes audit when it withdraws this consent, the order that could deadlock. The one-click
    // opt-in needs a live session, a seat on a deal (deal team) and an accepted invite in a registered domain.
    const personal = `seat-${fx.tag}@${fx.domain}`;
    runPsql(
      target,
      ["-q", "-At", "-v", "ON_ERROR_STOP=1"],
      `begin;
insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values ('${fx.member}', '${fx.member}', now(), now(), 'aal1') on conflict (id) do nothing;
with d as (
  insert into deals (id, tenant_id, code, codename, bank_id)
  values (gen_random_uuid(), '${fx.tenant}', 'SEAT-${fx.tag}', 'Seat', '${fx.bank}') returning id)
insert into deal_memberships (deal_id, user_id, role_id, deal_role)
  select d.id, '${fx.member}', (select id from roles where slug = 'deal_team'), 'deal_team' from d;
insert into invites (tenant_id, email, invited_by, company_id, company_role, status, delivery_status, accepted_at, accepted_user_id)
  values ('${fx.tenant}', '${personal}', '${fx.admin}', '${fx.bank}', 'member', 'accepted', 'sent', now(), '${fx.member}');
select set_config('request.jwt.claims', '{"sub": "${fx.member}", "session_id": "${fx.member}", "role": "authenticated"}', true);
select mailbox_consent_grant();
commit;`,
    );
    const { rows: before } = await observer.query(
      "select count(*)::int as open from mailbox_consents where user_id = $1 and withdrawn_at is null",
      [fx.member],
    );
    expect(before, "the member holds an open personal consent before the race").toEqual([{ open: 1 }]);

    // The member is on the inbox before the race, committed.
    runPsql(
      target,
      ["-q", "-At", "-v", "ON_ERROR_STOP=1"],
      `begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "${fx.admin}", "role": "authenticated"}', true);
select discovery_add_team_mailbox_member('${fx.teamMailbox}', '${fx.member}');
commit;`,
    );
    const groups = JSON.stringify([
      {
        clusterKey: `codename:seat-${fx.tag}`,
        proposedName: "Project Seat",
        codenameGuess: "Project Seat",
        parties: [],
        firstSeenAt: "2026-02-03T00:00:00Z",
        lastSeenAt: "2026-02-03T00:00:00Z",
        confidence: 0.9,
        links: [{ sourceItemId: fx.item, method: "codename", confidence: 0.9 }],
      },
    ]);
    const upsert = async (client: PgClient) => {
      await client.query("begin");
      await client.query("set local role service_role");
      return () => client.query("select discovery_upsert_candidates($1, $2, $3::jsonb)", [fx.tenant, randomUUID(), groups]);
    };
    // As the operator would: the users row changes, the triggers do the rest.
    const seat = async (client: PgClient) => {
      await client.query("begin");
      return () => client.query("update users set status = 'suspended' where id = $1", [fx.member]);
    };

    const [startFirst, startSecond] = first === "upsert" ? [upsert, seat] : [seat, upsert];
    const runFirst = await startFirst(a);
    const runSecond = await startSecond(b);
    await runFirst();

    const { rows } = await b.query("select pg_backend_pid() as pid");
    const pending = runSecond().then(
      () => "ok" as const,
      (error: { code?: string; message?: string }) => error.code ?? error.message ?? "error",
    );
    expect(await waitsOnAdvisoryLock(observer, rows[0].pid as number)).toBe(true);

    await a.query("commit");
    const answer = await pending;
    expect(answer, "the second session finished without a deadlock (40P01)").toBe("ok");
    await b.query("commit");

    // Either way the membership is closed for the lost seat, once.
    const { rows: closed } = await observer.query(
      "select removed_reason from team_mailbox_members where team_mailbox_id = $1 and user_id = $2",
      [fx.teamMailbox, fx.member],
    );
    expect(closed).toEqual([{ removed_reason: "seat_lost" }]);
    // And the member's own consent was withdrawn by its after-row trigger in the same update, audit row and all: the
    // path that wrote audit before the team trigger took the lock, which the BEFORE trigger now precedes.
    const { rows: consents } = await observer.query(
      "select count(*)::int as open from mailbox_consents where user_id = $1 and withdrawn_at is null",
      [fx.member],
    );
    expect(consents).toEqual([{ open: 0 }]);
    const { rows: withdrawn } = await observer.query(
      "select count(*)::int as n from audit_log where tenant_id = $1 and action = 'discovery.mailbox_consent_withdrawn'",
      [fx.tenant],
    );
    expect(withdrawn[0].n).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
