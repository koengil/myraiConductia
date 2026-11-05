-- Client-company access management smoke test.
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/client_company_access_management.sql

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

select set_config('request.jwt.claim.role', 'service_role', true);

do $$
declare
  v_tenant uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_director uuid := gen_random_uuid();
  v_employee uuid := gen_random_uuid();
  v_role uuid;
  v_result jsonb;
begin
  insert into auth.users (id, email) values
    (v_admin, 'client-seed-admin@example.test'),
    (v_director, 'client-director@example.test'),
    (v_employee, 'client-employee@example.test')
  on conflict (id) do nothing;

  update users set tenant_id = v_tenant, company_id = null,
    company_role = null, is_external = false, firm_role = 'admin',
    status = 'active', can_invite = false where id = v_admin;

  insert into companies (id, tenant_id, name, type) values
    (v_client, v_tenant, 'Playboot Client Co', 'client');

  update users set tenant_id = v_tenant, company_id = v_client,
    company_role = 'director', is_external = true, firm_role = null,
    status = 'active', can_invite = false where id = v_director;
  update users set tenant_id = v_tenant, company_id = v_client,
    company_role = 'member', is_external = true, firm_role = null,
    status = 'active', can_invite = false where id = v_employee;

  if (select count(*) from app_company_effective_permissions(v_director, v_client)) <> 14 then
    raise exception 'FAIL: client director did not resolve all root permissions';
  end if;

  v_result := create_company_role(
    v_director, v_client, 'HR Manager', 'Can invite employees',
    array['company:invites:send', 'company:access:assign']
  );
  v_role := (v_result->>'id')::uuid;

  v_result := replace_company_member_access(
    v_director, v_client, v_employee, 0,
    array[v_role], array[]::text[]
  );
  if not app_has_company_permission(v_employee, v_client, 'company:invites:send') then
    raise exception 'FAIL: employee did not receive delegated invite permission';
  end if;

  raise notice 'PASS: client company access management';
end;
$$;

rollback;
