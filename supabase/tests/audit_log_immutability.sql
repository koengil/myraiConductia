-- Verifies audit_log is append-only (Issue #49). Run via psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/audit_log_immutability.sql
-- Wrapped in a transaction that always ROLLBACKs: leaves no test data behind.
-- Raises (and, with ON_ERROR_STOP, exits non-zero) if any guarantee is violated.

begin;
-- #316: new auth users are contained; promote each fixture the way the seed
-- script does (authorize_provisioned_profile over its metadata) and give it a
-- live session whose id is the user id, so impersonating claims can carry
-- session_id = sub.
create or replace function pg_temp.authorize_fixture() returns trigger language plpgsql as $fx$
begin
  perform public.authorize_provisioned_profile(new.id, new.raw_user_meta_data);
  insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values (new.id, new.id, now(), now(), 'aal1') on conflict (id) do nothing;
  return new;
end
$fx$;
drop trigger if exists zz_authorize_fixture on auth.users;
create trigger zz_authorize_fixture after insert on auth.users
  for each row execute function pg_temp.authorize_fixture();

do $$
declare
  v_user    uuid := gen_random_uuid();
  v_audit   uuid;
  v_blocked boolean;
begin
  -- Throwaway actor: insert into auth.users; the on_auth_user_created trigger
  -- mirrors it into public.users automatically (Option A). Email is required so the
  -- mirrored public.users.email (NOT NULL) is satisfied; full_name derives from it.
  insert into auth.users (id, email) values (v_user, 's03-immutability-test@example.com');

  -- INSERT must still work (sentinel row)
  insert into audit_log (actor_id, action) values (v_user, 'view') returning id into v_audit;

  -- service_role must no longer hold UPDATE/DELETE (the grant half of AC1)
  if has_table_privilege('service_role', 'public.audit_log', 'UPDATE') then
    raise exception 'FAIL: service_role still has UPDATE on audit_log';
  end if;
  if has_table_privilege('service_role', 'public.audit_log', 'DELETE') then
    raise exception 'FAIL: service_role still has DELETE on audit_log';
  end if;

  -- UPDATE must be blocked by the trigger (the trigger half of AC1)
  v_blocked := false;
  begin
    update audit_log set action = 'download' where id = v_audit;
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: UPDATE on audit_log was not blocked';
  end if;

  -- DELETE must be blocked by the trigger
  v_blocked := false;
  begin
    delete from audit_log where id = v_audit;
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: DELETE on audit_log was not blocked';
  end if;

  -- INSERT must still work for every current action value (AC2)
  insert into audit_log (actor_id, action) values
    (v_user, 'view'), (v_user, 'download'), (v_user, 'upload'),
    (v_user, 'export'), (v_user, 'grant'), (v_user, 'revoke');

  raise notice 'PASS: audit_log is append-only (service_role UPDATE/DELETE revoked, trigger blocks UPDATE/DELETE, INSERT ok)';
end $$;

rollback;
