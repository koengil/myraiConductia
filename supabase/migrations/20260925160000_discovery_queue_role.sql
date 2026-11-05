-- supabase/migrations/20260925160000_discovery_queue_role.sql
-- Deal discovery, phase 4: the job queue's own database role.
--
-- pg-boss runs on a direct Postgres connection (DISCOVERY_QUEUE_DATABASE_URL,
-- worker/boss.ts). 20260925140000_pgboss_schema.sql grants the pgboss schema
-- to no role, so until now that connection had to be the table owner
-- (postgres), which can also rewrite audit_log with its triggers disabled.
-- discovery_queue is the role that connection uses instead:
--
--   - usage on the pgboss schema, and select/insert/update/delete on its
--     tables, usage on its sequences, execute on its functions. That is all
--     pg-boss needs at run time with migrate: false and unpartitioned queues;
--   - no create on pgboss, so a partitioned queue (a new table) fails, and a
--     pg-boss upgrade stays a reviewed migration;
--   - nothing in public: no table, view, sequence or function grant, and no
--     create. Domain writes go through the supabase-js service client;
--   - it owns nothing and holds no truncate, references or trigger privilege,
--     so it cannot alter a table, create a trigger, or disable one (both need
--     ownership); and it is not superuser, so it cannot set
--     session_replication_role either;
--   - it is a member of no role.
--
-- It is created with login and no password. The operator sets one out of
-- band, never in a migration (scripts/m365/README.md, step 5):
--   alter role discovery_queue with password '<from the secret store>';
--
-- Residual: Postgres grants every role, through PUBLIC, usage on schema
-- public and execute on functions that have not revoked it. That default is
-- closed for security definer functions by
-- 20260924120000_close_definer_function_grants.sql (pending on its own
-- branch); the discovery definer functions already revoke PUBLIC.
-- supabase/tests/discovery_queue_role.sql proves the role runs a job and
-- cannot read or write audit_log.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'discovery_queue') then
    create role discovery_queue with login;
  end if;
end
$$;

-- Re-asserted on every run, so a hand edit to the role is undone by a replay.
-- SUPERUSER, REPLICATION and BYPASSRLS default off at create, and only a
-- superuser can change them (postgres is not one on Supabase), so they are
-- asserted by the test rather than restated here.
alter role discovery_queue with login nocreatedb nocreaterole noinherit connection limit 20;
alter role discovery_queue set search_path = pgboss;
alter role discovery_queue set statement_timeout = '60s';

grant usage on schema pgboss to discovery_queue;
grant select, insert, update, delete on all tables in schema pgboss to discovery_queue;
grant usage, select on all sequences in schema pgboss to discovery_queue;
grant execute on all functions in schema pgboss to discovery_queue;

-- Explicitly nothing more, should a grant have been made by hand.
revoke create on schema pgboss from discovery_queue;
revoke truncate, references, trigger on all tables in schema pgboss from discovery_queue;
revoke all on schema public from discovery_queue;
revoke all on all tables in schema public from discovery_queue;
revoke all on all sequences in schema public from discovery_queue;
revoke all on all functions in schema public from discovery_queue;
