-- The job queue's database role (20260925160000_discovery_queue_role.sql):
-- discovery_queue runs a pg-boss job and reaches nothing else.
--
--   1. Attributes: login, not superuser, no createdb / createrole /
--      replication / bypassrls, a member of no role, the owner of nothing.
--   2. Grants: DML on every pgboss table and nothing on any table or
--      sequence in public; no create on either schema; no truncate,
--      references or trigger anywhere.
--   3. As the role: a queue is created and a job goes created -> active ->
--      completed. A partitioned queue (DDL) is refused. audit_log cannot be
--      read, written, truncated or have its triggers disabled, pgboss.job's
--      triggers cannot be touched, session_replication_role cannot be set,
--      and nothing can be created in public or pgboss.
--
-- tests/integration/discovery-resume.test.ts runs the real pg-boss consumer
-- logged in as this role.
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/discovery_queue_role.sql
-- Everything rolls back, including the grant that lets this session SET ROLE.

begin;

create function pg_temp.expect(actual bigint, expected bigint, label text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (expected %, got %)', label, expected, actual;
  end if;
end;
$$;

-- ── 1. Attributes ──────────────────────────────────────────────────────────
do $$
declare
  r pg_roles%rowtype;
begin
  select * into r from pg_roles where rolname = 'discovery_queue';
  if not found then raise exception 'FAIL: the discovery_queue role is missing'; end if;
  if not r.rolcanlogin then raise exception 'FAIL: discovery_queue cannot log in'; end if;
  if r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls then
    raise exception 'FAIL: discovery_queue holds a role attribute beyond login';
  end if;
  if r.rolinherit then raise exception 'FAIL: discovery_queue inherits'; end if;

  perform pg_temp.expect(
    (select count(*) from pg_auth_members where member = 'discovery_queue'::regrole),
    0, 'discovery_queue is a member of another role');
  perform pg_temp.expect(
    (select count(*) from pg_class where relowner = 'discovery_queue'::regrole)
    + (select count(*) from pg_proc where proowner = 'discovery_queue'::regrole)
    + (select count(*) from pg_namespace where nspowner = 'discovery_queue'::regrole)
    + (select count(*) from pg_type where typowner = 'discovery_queue'::regrole),
    0, 'objects owned by discovery_queue');
  raise notice 'PASS: discovery_queue logs in, holds no other attribute, belongs to no role and owns nothing';
end $$;

-- ── 2. Grants ──────────────────────────────────────────────────────────────
do $$
begin
  if not has_schema_privilege('discovery_queue', 'pgboss', 'USAGE') then
    raise exception 'FAIL: discovery_queue has no usage on pgboss';
  end if;
  if has_schema_privilege('discovery_queue', 'pgboss', 'CREATE') then
    raise exception 'FAIL: discovery_queue can create in pgboss';
  end if;
  if has_schema_privilege('discovery_queue', 'public', 'CREATE') then
    raise exception 'FAIL: discovery_queue can create in public';
  end if;

  -- Every pgboss table: all four DML privileges, none of the other three.
  perform pg_temp.expect(
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'pgboss' and c.relkind in ('r', 'p')
       and not (has_table_privilege('discovery_queue', c.oid, 'SELECT')
            and has_table_privilege('discovery_queue', c.oid, 'INSERT')
            and has_table_privilege('discovery_queue', c.oid, 'UPDATE')
            and has_table_privilege('discovery_queue', c.oid, 'DELETE'))),
    0, 'pgboss tables missing a DML grant');
  perform pg_temp.expect(
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('pgboss', 'public') and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and has_table_privilege('discovery_queue', c.oid, 'TRUNCATE, REFERENCES, TRIGGER')),
    0, 'tables where discovery_queue holds truncate, references or trigger');

  -- Nothing in public: no table, view or sequence privilege of any kind.
  perform pg_temp.expect(
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and has_table_privilege('discovery_queue', c.oid,
             'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')),
    0, 'public tables discovery_queue can reach');
  perform pg_temp.expect(
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and case when c.relkind = 'S'
             then has_sequence_privilege('discovery_queue', c.oid, 'USAGE, SELECT, UPDATE')
             else false end),
    0, 'public sequences discovery_queue can reach');
  perform pg_temp.expect(
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef and p.proname like 'discovery\_%'
       and has_function_privilege('discovery_queue', p.oid, 'EXECUTE')),
    0, 'discovery definer functions discovery_queue can execute');
  raise notice 'PASS: discovery_queue has DML on pgboss and no grant in public';
end $$;

-- ── 3. As the role ─────────────────────────────────────────────────────────
-- postgres created the role, so it holds the ADMIN option, but PG16+ gives
-- the creator no SET. Grant it here; the rollback removes it.
grant discovery_queue to postgres with inherit false, set true;

do $$
declare
  v_job     uuid;
  v_state   text;
  v_blocked boolean;
begin
  set local role discovery_queue;

  -- A job, the way pg-boss runs one: queue row, insert, fetch, complete.
  perform pgboss.create_queue('discovery.queue-role-probe',
    '{"policy": "standard", "retryLimit": 0, "partition": false}'::jsonb);
  insert into pgboss.job (name, data, policy)
    values ('discovery.queue-role-probe', '{"probe": true}'::jsonb, 'standard')
    returning id into v_job;
  update pgboss.job set state = 'active', started_on = now()
    where name = 'discovery.queue-role-probe' and id = v_job and state = 'created';
  update pgboss.job set state = 'completed', completed_on = now(), output = '{"ok": true}'::jsonb
    where name = 'discovery.queue-role-probe' and id = v_job and state = 'active';
  select state::text into v_state from pgboss.job where name = 'discovery.queue-role-probe' and id = v_job;
  if v_state is distinct from 'completed' then
    raise exception 'FAIL: the probe job ended %, not completed', v_state;
  end if;

  -- A partitioned queue is a new table: refused.
  v_blocked := false;
  begin
    perform pgboss.create_queue('discovery.queue-role-partitioned',
      '{"policy": "standard", "partition": true}'::jsonb);
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: discovery_queue created a partitioned queue (DDL)'; end if;

  -- audit_log: every read and write is refused.
  v_blocked := false;
  begin perform 1 from public.audit_log limit 1;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: discovery_queue read audit_log'; end if;

  v_blocked := false;
  begin
    insert into public.audit_log (action, detail) values ('view', '{}'::jsonb);
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: discovery_queue wrote audit_log'; end if;

  v_blocked := false;
  begin update public.audit_log set detail = '{}'::jsonb where false;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: discovery_queue updated audit_log'; end if;

  v_blocked := false;
  begin delete from public.audit_log where false;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: discovery_queue deleted from audit_log'; end if;

  v_blocked := false;
  begin truncate public.audit_log;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: discovery_queue truncated audit_log'; end if;

  -- Triggers: disabling or adding one needs ownership.
  v_blocked := false;
  begin alter table public.audit_log disable trigger all;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: discovery_queue disabled audit_log triggers'; end if;

  v_blocked := false;
  begin alter table pgboss.job disable trigger all;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: discovery_queue disabled pgboss.job triggers'; end if;

  v_blocked := false;
  begin
    create trigger queue_role_probe before insert on pgboss.queue
      for each row execute function pgboss.job_now();
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: discovery_queue created a trigger'; end if;

  v_blocked := false;
  begin set local session_replication_role = replica;
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: discovery_queue set session_replication_role'; end if;

  -- No DDL in either schema.
  v_blocked := false;
  begin create table public.queue_role_probe (id int);
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: discovery_queue created a table in public'; end if;

  v_blocked := false;
  begin create table pgboss.queue_role_probe (id int);
  exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'FAIL: discovery_queue created a table in pgboss'; end if;

  reset role;
  raise notice 'PASS: discovery_queue runs a job and cannot touch audit_log, triggers, or either schema''s DDL';
end $$;

rollback;
