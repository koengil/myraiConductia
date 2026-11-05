-- Phase B company access schema, resolver, mutation, lifecycle, and rollback.
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/company_access_management.sql

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

-- Model the PostgREST service-role JWT context used by the service-only RPCs.
select set_config('request.jwt.claim.role', 'service_role', true);

do $$
declare
  v_tenant uuid := gen_random_uuid();
  v_other_tenant uuid := gen_random_uuid();
  v_bank uuid := gen_random_uuid();
  v_other_bank uuid := gen_random_uuid();
  v_director uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_delegate uuid := gen_random_uuid();
  v_target uuid := gen_random_uuid();
  v_external uuid := gen_random_uuid();
  v_role uuid;
  v_child_role uuid;
  v_result jsonb;
  v_audit_count bigint;
begin
  insert into companies (id, tenant_id, name, type) values
    (v_bank, v_tenant, 'Phase B Bank', 'bank'),
    (v_other_bank, v_other_tenant, 'Foreign Bank', 'bank');

  insert into auth.users (id, email) values
    (v_director, 'phase-b-director@example.test'),
    (v_admin, 'phase-b-admin@example.test'),
    (v_delegate, 'phase-b-delegate@example.test'),
    (v_target, 'phase-b-target@example.test'),
    (v_external, 'phase-b-external@example.test')
  on conflict (id) do nothing;

  -- Install the director first to satisfy the existing last-director trigger.
  update users set tenant_id = v_tenant, company_id = v_bank,
    company_role = 'director', is_external = false, firm_role = null,
    status = 'active', can_invite = false where id = v_director;
  update users set tenant_id = v_tenant, company_id = v_bank,
    company_role = 'member', is_external = false, firm_role = 'admin',
    status = 'active', can_invite = false where id = v_admin;
  update users set tenant_id = v_tenant, company_id = v_bank,
    company_role = 'member', is_external = false, firm_role = null,
    status = 'active', can_invite = false where id in (v_delegate, v_target);
  update users set tenant_id = v_tenant, company_id = v_bank,
    company_role = 'member', is_external = true, firm_role = null,
    status = 'active', can_invite = false where id = v_external;

  if (select count(*) from company_permissions) <> 14 then
    raise exception 'FAIL: permission catalogue does not contain exactly fourteen rows';
  end if;
  if (select count(*) from app_company_effective_permissions(v_director, v_bank)) <> 14 then
    raise exception 'FAIL: company director did not resolve all root permissions';
  end if;
  if exists (
    select 1 from app_company_effective_permissions(v_director, v_bank)
    where source_type <> 'root'
  ) then
    raise exception 'FAIL: root permission source attribution is wrong';
  end if;
  if not app_company_is_access_root(v_admin, v_bank)
     or app_company_is_access_root(v_admin, v_other_bank) then
    raise exception 'FAIL: firm-admin root resolution ignored tenant scope';
  end if;
  if exists (select 1 from app_company_effective_permissions(v_external, v_bank)) then
    raise exception 'FAIL: external employee received company permissions';
  end if;

  v_result := create_company_role(
    v_director, v_bank, 'Access delegate', 'Delegated access manager',
    array[
      'company:roles:manage',
      'company:access:assign',
      'company:invites:send'
    ]
  );
  v_role := (v_result->>'id')::uuid;
  if (v_result->>'version')::bigint <> 1 then
    raise exception 'FAIL: new role version is not one';
  end if;

  begin
    perform replace_company_member_access(
      v_director, v_bank, v_director, 0, array[v_role], array[]::text[]
    );
    raise exception 'FAIL: protected root accepted custom access';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%protected_access_root%' then
      raise exception 'FAIL: protected-root refusal was %', sqlerrm;
    end if;
  end;
  if exists (select 1 from company_member_access where user_id = v_director) then
    raise exception 'FAIL: protected-root refusal left member access behind';
  end if;

  v_result := replace_company_member_access(
    v_director, v_bank, v_delegate, 0, array[v_role], array[]::text[]
  );
  if (v_result->>'version')::bigint <> 1 then
    raise exception 'FAIL: first member-access version is not one';
  end if;
  if (select count(*) from app_company_effective_permissions(v_delegate, v_bank)) <> 3
     or exists (
       select 1 from app_company_effective_permissions(v_delegate, v_bank)
       where source_type <> 'role' or source_id is distinct from v_role
     ) then
    raise exception 'FAIL: role permission resolution or attribution is wrong';
  end if;

  -- A delegated role manager can grant only authority already in its envelope.
  begin
    perform create_company_role(
      v_delegate, v_bank, 'Escalation', null,
      array['company:directory:view_all']
    );
    raise exception 'FAIL: delegated actor escaped its grant envelope';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%grant_outside_envelope%' then
      raise exception 'FAIL: grant-envelope refusal was %', sqlerrm;
    end if;
  end;

  v_result := create_company_role(
    v_delegate, v_bank, 'Inviter', null, array['company:invites:send']
  );
  v_child_role := (v_result->>'id')::uuid;

  v_result := replace_company_member_access(
    v_director, v_bank, v_target, 0, array[v_child_role],
    array['company:invites:send']
  );
  if not (select can_invite from users where id = v_target) then
    raise exception 'FAIL: legacy direct-grant projection was not set';
  end if;
  if (select count(*) from app_company_effective_permissions(v_target, v_bank)
      where permission_key = 'company:invites:send') <> 2 then
    raise exception 'FAIL: role and direct sources did not union with attribution';
  end if;

  -- Removing the direct source leaves the inherited permission effective while
  -- the deprecated projection correctly reports only the direct grant.
  v_result := replace_company_member_access(
    v_director, v_bank, v_target, 1, array[v_child_role], array[]::text[]
  );
  if (select can_invite from users where id = v_target) then
    raise exception 'FAIL: legacy direct-grant projection was not cleared';
  end if;
  if not app_has_company_permission(v_target, v_bank, 'company:invites:send') then
    raise exception 'FAIL: clearing direct grant removed inherited permission';
  end if;

  -- Exact-set retries are idempotent: no assignment timestamps, version, or
  -- audit rows change when the requested set already matches.
  select count(*) into v_audit_count from audit_log;
  v_result := replace_company_member_access(
    v_director, v_bank, v_target, 2, array[v_child_role], array[]::text[]
  );
  if (v_result->>'version')::bigint <> 2
     or (select count(*) from audit_log) <> v_audit_count then
    raise exception 'FAIL: no-op member-access retry changed version or audit';
  end if;

  -- Stale writes leave assignments and audit rows untouched.
  select count(*) into v_audit_count from audit_log;
  begin
    perform replace_company_member_access(
      v_director, v_bank, v_target, 1, array[]::uuid[], array[]::text[]
    );
    raise exception 'FAIL: stale member-access version was accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%stale_version%' then
      raise exception 'FAIL: stale-version refusal was %', sqlerrm;
    end if;
  end;
  if (select count(*) from audit_log) <> v_audit_count
     or not exists (
       select 1 from company_member_roles
       where user_id = v_target and role_id = v_child_role
     ) then
    raise exception 'FAIL: stale write partially mutated access or audit';
  end if;

  begin
    perform archive_company_role(v_director, v_bank, v_child_role, 1);
    raise exception 'FAIL: assigned role was archived';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%role_assigned%' then
      raise exception 'FAIL: assigned-role archival refusal was %', sqlerrm;
    end if;
  end;

  perform replace_company_member_access(
    v_director, v_bank, v_target, 2, array[]::uuid[], array[]::text[]
  );
  v_result := archive_company_role(v_director, v_bank, v_child_role, 1);
  if (v_result->>'version')::bigint <> 2
     or exists (
       select 1 from app_company_effective_permissions(v_target, v_bank)
       where source_id = v_child_role
     ) then
    raise exception 'FAIL: role archival or resolver exclusion failed';
  end if;

  begin
    insert into company_member_access (company_id, user_id)
    values (v_bank, v_external);
    raise exception 'FAIL: external employee received an access parent';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%company_member_not_eligible%' then
      raise exception 'FAIL: external eligibility refusal was %', sqlerrm;
    end if;
  end;

  -- Existing company-removal behavior and custom access cascade together.
  update users set company_id = null, company_role = null where id = v_delegate;
  if exists (select 1 from company_member_access where user_id = v_delegate)
     or exists (select 1 from company_member_roles where user_id = v_delegate) then
    raise exception 'FAIL: company removal left custom access behind';
  end if;

  raise notice 'PASS: company access management resolver and lifecycle';
end $$;

-- Force only a designated role-create audit row to fail, proving the role and
-- permission bundle roll back with its required audit insert.
create or replace function test_reject_company_role_audit()
returns trigger language plpgsql as $$
begin
  if new.detail->>'name' = 'Audit rollback role' then
    raise exception 'test_audit_failure';
  end if;
  return new;
end;
$$;
create trigger test_reject_company_role_audit
  before insert on audit_log
  for each row execute function test_reject_company_role_audit();

do $$
declare
  v_director uuid;
  v_bank uuid;
begin
  select id, company_id into v_director, v_bank
  from users where email = 'phase-b-director@example.test';
  begin
    perform create_company_role(
      v_director, v_bank, 'Audit rollback role', null,
      array['company:invites:send']
    );
    raise exception 'FAIL: audit failure did not abort role creation';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%test_audit_failure%' then
      raise exception 'FAIL: forced audit refusal was %', sqlerrm;
    end if;
  end;
  if exists (
    select 1 from company_roles
    where company_id = v_bank and name = 'Audit rollback role'
  ) then
    raise exception 'FAIL: audit failure left a role behind';
  end if;
  raise notice 'PASS: company access audit rollback';
end $$;

drop trigger test_reject_company_role_audit on audit_log;
drop function test_reject_company_role_audit();

-- Mutation RPCs and direct table writes must not be available to authenticated.
do $$
begin
  if has_function_privilege(
    'authenticated',
    'create_company_role(uuid,uuid,text,text,text[])',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'replace_company_member_access(uuid,uuid,uuid,bigint,uuid[],text[])',
    'execute'
  ) then
    raise exception 'FAIL: authenticated can execute company access mutation RPCs';
  end if;
  if has_table_privilege('authenticated', 'company_roles', 'insert')
     or has_table_privilege('authenticated', 'company_member_permissions', 'delete') then
    raise exception 'FAIL: authenticated has direct company access write privileges';
  end if;
  if has_function_privilege(
    'authenticated',
    'app_company_effective_permissions(uuid,uuid)',
    'execute'
  ) then
    raise exception 'FAIL: authenticated can execute source-aware resolver directly';
  end if;
  if has_function_privilege(
    'authenticated',
    'company_access_lock_actor(uuid,uuid,text)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'company_access_validate_envelope(uuid,uuid,text[],boolean)',
    'execute'
  ) then
    raise exception 'FAIL: authenticated can execute internal mutation helpers';
  end if;
  raise notice 'PASS: company access mutation privileges';
end $$;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000002',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
begin
  if app_company_is_access_root(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'FAIL: authenticated cross-user root probe did not fail closed';
  end if;
  if app_has_company_permission(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'company:roles:manage'
  ) then
    raise exception 'FAIL: authenticated cross-user permission probe did not fail closed';
  end if;
  raise notice 'PASS: company access cross-user probes fail closed';
end $$;

reset role;

rollback;
