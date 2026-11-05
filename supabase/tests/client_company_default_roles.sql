-- Default Employee and MD roles for client companies.
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/client_company_default_roles.sql

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
  v_tenant uuid := gen_random_uuid();
  v_company uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_bank uuid := gen_random_uuid();
  v_director uuid := gen_random_uuid();
  v_lead uuid := gen_random_uuid();
  v_onboarded uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
  v_invited uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_admin, 'admin+' || left(v_admin::text, 8) || '@seed.dev')
  on conflict (id) do nothing;
  update users
    set tenant_id = v_tenant,
        firm_role = 'admin',
        is_external = false,
        status = 'active'
    where id = v_admin;

  insert into companies (id, tenant_id, name, type)
    values (v_company, v_tenant, 'Client Role Seed Co', 'client');

  perform seed_client_company_default_roles(v_company, v_admin);

  if not exists (
    select 1 from company_roles
    where company_id = v_company and lower(name) = 'employee' and archived_at is null
  ) then
    raise exception 'FAIL: Employee role was not seeded';
  end if;
  if not exists (
    select 1 from company_roles
    where company_id = v_company and lower(name) = 'md' and archived_at is null
  ) then
    raise exception 'FAIL: MD role was not seeded';
  end if;
  if not exists (
    select 1 from company_role_permissions rp
    join company_roles r on r.id = rp.role_id
    where r.company_id = v_company and lower(r.name) = 'md' and rp.permission_key = 'company:invites:send'
  ) then
    raise exception 'FAIL: MD role permissions were not seeded';
  end if;
  if exists (
    select 1 from company_role_permissions rp
    where rp.company_id = v_company and rp.permission_key = 'company:compliance:notify'
  ) then
    raise exception 'FAIL: client default roles must not receive gate0 notify';
  end if;

  insert into companies (id, tenant_id, name, type)
    values (v_bank, v_tenant, 'Client Role Seed Bank', 'bank');
  insert into auth.users (id, email)
    values (v_director, 'director+' || left(v_director::text, 8) || '@seed.dev')
  on conflict (id) do nothing;
  update users
    set tenant_id = v_tenant,
        company_id = v_bank,
        company_role = 'director',
        is_external = false,
        firm_role = null,
        status = 'active'
    where id = v_director;

  if not exists (
    select 1 from company_roles
    where company_id = v_bank and lower(name) = 'compliance' and archived_at is null
  ) then
    raise exception 'FAIL: bank Compliance role was not seeded on first member';
  end if;

  -- CRM lead registration must not create an org chart.
  insert into companies (id, tenant_id, name, type, registered_by_company_id)
    values (v_lead, v_tenant, 'Lead Without Firm Admin', 'client', v_bank);

  if exists (
    select 1 from company_roles where company_id = v_lead
  ) then
    raise exception 'FAIL: lead insert seeded company roles';
  end if;

  -- First member on a client company seeds the default roles.
  insert into companies (id, tenant_id, name, type, registered_by_company_id)
    values (v_onboarded, v_tenant, 'Onboarded Client Co', 'client', v_bank);
  insert into auth.users (id, email)
    values (v_member, 'member+' || left(v_member::text, 8) || '@seed.dev')
  on conflict (id) do nothing;
  update users
    set tenant_id = v_tenant,
        company_id = v_onboarded,
        company_role = 'director',
        is_external = true,
        firm_role = null,
        status = 'active'
    where id = v_member;

  if not exists (
    select 1 from company_roles
    where company_id = v_onboarded and lower(name) = 'employee' and archived_at is null
      and created_by = v_member
  ) then
    raise exception 'FAIL: first member did not seed Employee';
  end if;
  if not exists (
    select 1 from company_roles
    where company_id = v_onboarded and lower(name) = 'md' and archived_at is null
      and created_by = v_member
  ) then
    raise exception 'FAIL: first member did not seed MD';
  end if;

  -- First invite onto a still-empty client company also seeds the roles.
  insert into companies (id, tenant_id, name, type, registered_by_company_id)
    values (v_invited, v_tenant, 'Invited Client Co', 'client', v_bank);

  if exists (
    select 1 from company_roles where company_id = v_invited
  ) then
    raise exception 'FAIL: empty invited company already had roles';
  end if;

  insert into invites (
    tenant_id, email, invited_by, company_id, company_role
  ) values (
    v_tenant,
    'owner+' || left(v_invited::text, 8) || '@seed.dev',
    v_director,
    v_invited,
    'director'
  );

  if not exists (
    select 1 from company_roles
    where company_id = v_invited and lower(name) = 'md' and archived_at is null
      and created_by = v_director
  ) then
    raise exception 'FAIL: first invite did not seed MD from the inviter';
  end if;

  raise notice 'PASS client company default roles';
end;
$$;

rollback;
