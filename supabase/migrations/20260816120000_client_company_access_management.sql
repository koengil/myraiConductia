-- Extend company access management to client companies (#160 follow-on).
-- Phase B originally scoped roles/permissions to bank companies with internal
-- employees only. Client-company directors (external HR admins) need the same
-- custom role and permission tooling for their employees.

create or replace function app_company_access_managed(p_type text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_type in ('bank', 'client');
$$;

revoke all on function app_company_access_managed(text) from public;
grant execute on function app_company_access_managed(text) to authenticated, service_role;

create or replace function enforce_company_access_eligibility()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_company companies%rowtype;
  v_user users%rowtype;
begin
  select * into v_company from companies where id = new.company_id;
  if not found or not app_company_access_managed(v_company.type) then
    raise exception 'company_access_requires_managed_company';
  end if;

  if tg_table_name = 'company_member_access' then
    select * into v_user from users where id = new.user_id;
    if not found
       or v_user.status <> 'active'
       or v_user.company_id is distinct from new.company_id
       or v_user.tenant_id is distinct from v_company.tenant_id then
      raise exception 'company_member_not_eligible';
    end if;
    if v_company.type = 'bank' and v_user.is_external then
      raise exception 'company_member_not_eligible';
    end if;
  end if;
  return new;
end;
$$;

create or replace function app_company_is_access_root(
  p_actor_id uuid,
  p_company_id uuid
) returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select (
    coalesce(auth.role(), '') = 'service_role'
    or p_actor_id = auth.uid()
  ) and coalesce((
    select
      u.status = 'active'
      and u.tenant_id = c.tenant_id
      and app_company_access_managed(c.type)
      and (
        (
          c.type = 'bank'
          and not u.is_external
          and u.company_id = c.id
          and u.company_role = 'director'
        )
        or (
          c.type = 'client'
          and u.company_id = c.id
          and u.company_role = 'director'
        )
        or u.firm_role = 'admin'
      )
    from users u
    join companies c on c.id = p_company_id
    where u.id = p_actor_id
  ), false);
$$;

create or replace function app_company_effective_permissions(
  p_user_id uuid,
  p_company_id uuid
) returns table (
  permission_key text,
  source_type text,
  source_id uuid,
  source_name text
)
language sql
security definer
stable
set search_path = public
as $$
  with eligible as (
    select u.id, u.company_role, u.firm_role
    from users u
    join companies c
      on c.id = p_company_id
     and app_company_access_managed(c.type)
     and c.tenant_id = u.tenant_id
    where u.id = p_user_id
      and u.status = 'active'
      and (c.type = 'client' or not u.is_external)
      and (
        (u.company_id = p_company_id)
        or u.firm_role = 'admin'
      )
  ), root_source as (
    select
      p.key as permission_key,
      'root'::text as source_type,
      null::uuid as source_id,
      case
        when e.firm_role = 'admin' then 'Firm administrator'
        else 'Company director'
      end as source_name
    from eligible e
    cross join company_permissions p
    where app_company_is_access_root(p_user_id, p_company_id)
  ), role_source as (
    select
      rp.permission_key,
      'role'::text as source_type,
      r.id as source_id,
      r.name as source_name
    from eligible e
    join company_member_roles mr
      on mr.company_id = p_company_id and mr.user_id = e.id
    join company_roles r
      on r.company_id = mr.company_id
     and r.id = mr.role_id
     and r.archived_at is null
    join company_role_permissions rp
      on rp.company_id = r.company_id and rp.role_id = r.id
    where not app_company_is_access_root(p_user_id, p_company_id)
  ), direct_source as (
    select
      mp.permission_key,
      'direct'::text as source_type,
      null::uuid as source_id,
      'Direct grant'::text as source_name
    from eligible e
    join company_member_permissions mp
      on mp.company_id = p_company_id and mp.user_id = e.id
    where not app_company_is_access_root(p_user_id, p_company_id)
  )
  select * from root_source
  union all
  select * from role_source
  union all
  select * from direct_source;
$$;

create or replace function company_access_lock_actor(
  p_actor_id uuid,
  p_company_id uuid,
  p_required_permission text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_root boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_company_id::text, 160));
  perform 1 from companies where id = p_company_id and app_company_access_managed(type) for share;
  if not found then raise exception 'company_not_eligible'; end if;
  perform 1 from users where id = p_actor_id for share;
  if not found then raise exception 'actor_not_found'; end if;

  v_root := app_company_is_access_root(p_actor_id, p_company_id);
  if not v_root then
    perform 1 from company_member_access
      where company_id = p_company_id and user_id = p_actor_id for share;
    perform 1 from company_roles r
      join company_member_roles mr
        on mr.company_id = r.company_id and mr.role_id = r.id
      where mr.company_id = p_company_id
        and mr.user_id = p_actor_id
        and r.archived_at is null
      for share of r;
  end if;

  if not app_has_company_permission(p_actor_id, p_company_id, p_required_permission) then
    raise exception 'not_permitted';
  end if;
  return v_root;
end;
$$;

create or replace function replace_company_member_access(
  p_actor_id uuid,
  p_company_id uuid,
  p_user_id uuid,
  p_expected_version bigint,
  p_role_ids uuid[] default array[]::uuid[],
  p_direct_permission_keys text[] default array[]::text[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_root boolean;
  v_target users%rowtype;
  v_company companies%rowtype;
  v_access company_member_access%rowtype;
  v_role_ids uuid[];
  v_direct text[];
  v_bundle text[];
  v_before_roles uuid[];
  v_before_direct text[];
  v_permission text;
  v_created boolean := false;
  v_changed boolean;
  v_new_version bigint;
begin
  v_root := company_access_lock_actor(
    p_actor_id, p_company_id, 'company:access:assign'
  );
  select * into v_company from companies where id = p_company_id for share;
  select * into v_target from users where id = p_user_id for share;
  if not found
     or v_target.status <> 'active'
     or v_target.company_id is distinct from p_company_id
     or v_target.tenant_id is distinct from v_company.tenant_id then
    raise exception 'company_member_not_eligible';
  end if;
  if v_company.type = 'bank' and v_target.is_external then
    raise exception 'company_member_not_eligible';
  end if;
  if app_company_is_access_root(p_user_id, p_company_id) then
    raise exception 'protected_access_root';
  end if;

  select coalesce(array_agg(distinct id order by id), array[]::uuid[])
    into v_role_ids from unnest(coalesce(p_role_ids, array[]::uuid[])) requested(id);
  select coalesce(array_agg(distinct key order by key), array[]::text[])
    into v_direct from unnest(coalesce(p_direct_permission_keys, array[]::text[])) requested(key);
  perform company_access_validate_envelope(
    p_actor_id, p_company_id, v_direct, v_root
  );
  if exists (
    select 1 from unnest(v_role_ids) requested(id)
    left join company_roles r
      on r.company_id = p_company_id and r.id = requested.id and r.archived_at is null
    where r.id is null
  ) then
    raise exception 'invalid_company_role';
  end if;
  select coalesce(array_agg(distinct rp.permission_key order by rp.permission_key), array[]::text[])
    into v_bundle
    from company_role_permissions rp
    where rp.company_id = p_company_id and rp.role_id = any(v_role_ids);
  perform company_access_validate_envelope(
    p_actor_id, p_company_id, v_bundle, v_root
  );

  select * into v_access from company_member_access
    where company_id = p_company_id and user_id = p_user_id for update;
  if found then
    if v_access.version is distinct from p_expected_version then raise exception 'stale_version'; end if;
  else
    if p_expected_version is distinct from 0 then raise exception 'stale_version'; end if;
    insert into company_member_access (company_id, user_id)
    values (p_company_id, p_user_id)
    returning * into v_access;
    v_created := true;
  end if;
  select coalesce(array_agg(role_id order by role_id), array[]::uuid[])
    into v_before_roles from company_member_roles
    where company_id = p_company_id and user_id = p_user_id;
  select coalesce(array_agg(permission_key order by permission_key), array[]::text[])
    into v_before_direct from company_member_permissions
    where company_id = p_company_id and user_id = p_user_id;
  v_changed := v_created
    or v_before_roles is distinct from v_role_ids
    or v_before_direct is distinct from v_direct;
  v_new_version := case
    when v_created then v_access.version
    when v_changed then v_access.version + 1
    else v_access.version
  end;

  insert into audit_log (actor_id, action, detail)
  select
    p_actor_id,
    'revoke',
    jsonb_build_object(
        'reason', 'company_member_role_revoked', 'company_id', p_company_id,
        'user_id', p_user_id, 'source_type', 'role', 'source_id', previous.id,
        'permission_key', permission.permission_key,
        'access_version', v_new_version
      )
  from unnest(v_before_roles) previous(id)
  left join company_role_permissions permission on permission.role_id = previous.id
  where not (previous.id = any(v_role_ids));

  insert into audit_log (actor_id, action, detail)
  select
    p_actor_id,
    'grant',
    jsonb_build_object(
        'reason', 'company_member_role_granted', 'company_id', p_company_id,
        'user_id', p_user_id, 'source_type', 'role', 'source_id', requested.id,
        'permission_key', permission.permission_key,
        'access_version', v_new_version
      )
  from unnest(v_role_ids) requested(id)
  left join company_role_permissions permission on permission.role_id = requested.id
  where not (requested.id = any(v_before_roles));
  for v_permission in
    select key from unnest(v_before_direct) previous(key) where not (key = any(v_direct))
  loop
    insert into audit_log (actor_id, action, detail) values (
      p_actor_id, 'revoke', jsonb_build_object(
        'reason', 'company_member_permission_revoked', 'company_id', p_company_id,
        'user_id', p_user_id, 'source_type', 'direct',
        'permission_key', v_permission, 'access_version', v_new_version
      )
    );
  end loop;
  for v_permission in
    select key from unnest(v_direct) requested(key) where not (key = any(v_before_direct))
  loop
    insert into audit_log (actor_id, action, detail) values (
      p_actor_id, 'grant', jsonb_build_object(
        'reason', 'company_member_permission_granted', 'company_id', p_company_id,
        'user_id', p_user_id, 'source_type', 'direct',
        'permission_key', v_permission, 'access_version', v_new_version
      )
    );
  end loop;

  delete from company_member_roles
    where company_id = p_company_id
      and user_id = p_user_id
      and not (role_id = any(v_role_ids));
  insert into company_member_roles (company_id, user_id, role_id, assigned_by)
  select p_company_id, p_user_id, id, p_actor_id
  from unnest(v_role_ids) requested(id)
  where not (id = any(v_before_roles));
  delete from company_member_permissions
    where company_id = p_company_id
      and user_id = p_user_id
      and not (permission_key = any(v_direct));
  insert into company_member_permissions (company_id, user_id, permission_key, granted_by)
  select p_company_id, p_user_id, key, p_actor_id
  from unnest(v_direct) requested(key)
  where not (key = any(v_before_direct));

  if v_changed then
    update company_member_access set version = v_new_version, updated_at = now()
      where company_id = p_company_id and user_id = p_user_id
      returning * into v_access;
    update users set can_invite = ('company:invites:send' = any(v_direct))
      where id = p_user_id;
  end if;

  return jsonb_build_object(
    'company_id', p_company_id,
    'user_id', p_user_id,
    'version', v_access.version,
    'role_ids', to_jsonb(v_role_ids),
    'direct_permissions', to_jsonb(v_direct),
    'effective_permissions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'permission_key', effective.permission_key,
          'source_type', effective.source_type,
          'source_id', effective.source_id,
          'source_name', effective.source_name
        ) order by effective.permission_key, effective.source_type, effective.source_id
      )
      from app_company_effective_permissions(p_user_id, p_company_id) effective
    ), '[]'::jsonb)
  );
end;
$$;
