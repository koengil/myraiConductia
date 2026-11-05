-- Company access management Phase B (#160).
--
-- The fixed catalogue below is authoritative. Custom roles are company-scoped,
-- additive, and intentionally cannot grant protected company or deal authority.

-- Keep the audit enum synchronized with the newest historical widening, adding
-- `update` for role metadata, bundle, and archival changes.
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check
  check (action in (
    'view','download','upload','export','grant','revoke',
    'hold_placed','hold_lifted','create','notify','advance','attest',
    'screen','send','release','invite_sent','invite_accepted','invite_revoked','reject',
    'invite_domain_override','invite_challenge_issued','invite_challenge_rotated',
    'invite_verification_succeeded','invite_verification_locked',
    'mfa_enrolled','mfa_challenged',
    'assign_step','complete_step','step_work','update'
  )) not valid;

create table company_permissions (
  key text primary key,
  label text not null,
  description text not null,
  category text not null,
  sort_order integer not null unique,
  constraint company_permissions_key_check check (key in (
    'company:directory:view_all',
    'company:invites:send',
    'company:roles:manage',
    'company:access:assign'
  ))
);

insert into company_permissions (key, label, description, category, sort_order) values
  ('company:directory:view_all', 'View full employee directory',
    'View identity rows for all internal employees in this company.', 'Directory', 10),
  ('company:invites:send', 'Send company invitations',
    'Invite internal members to this company. This does not grant deal invitation authority.', 'People', 20),
  ('company:roles:manage', 'Manage company roles',
    'Create, edit, and archive custom roles within the actor grant envelope.', 'Access', 30),
  ('company:access:assign', 'Assign employee access',
    'Assign custom roles and direct permissions within the actor grant envelope.', 'Access', 40);

create table company_roles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  name text not null,
  description text,
  version bigint not null default 1 check (version > 0),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint company_roles_name_check check (
    name = btrim(name) and char_length(name) between 2 and 80
  ),
  constraint company_roles_description_check check (
    description is null or description = btrim(description)
  ),
  unique (company_id, id)
);

create unique index company_roles_active_name_unique
  on company_roles (company_id, lower(name))
  where archived_at is null;
create index company_roles_company_id_idx on company_roles (company_id);

create table company_role_permissions (
  company_id uuid not null,
  role_id uuid not null,
  permission_key text not null references company_permissions (key),
  primary key (role_id, permission_key),
  foreign key (company_id, role_id)
    references company_roles (company_id, id) on delete cascade
);
create index company_role_permissions_company_id_idx
  on company_role_permissions (company_id);

create table company_member_access (
  company_id uuid not null references companies (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  primary key (company_id, user_id)
);
create index company_member_access_user_id_idx on company_member_access (user_id);

create table company_member_roles (
  company_id uuid not null,
  user_id uuid not null,
  role_id uuid not null,
  assigned_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  primary key (user_id, role_id),
  foreign key (company_id, user_id)
    references company_member_access (company_id, user_id) on delete cascade,
  foreign key (company_id, role_id)
    references company_roles (company_id, id) on delete cascade
);
create index company_member_roles_company_id_idx on company_member_roles (company_id);
create index company_member_roles_role_id_idx on company_member_roles (role_id);

create table company_member_permissions (
  company_id uuid not null,
  user_id uuid not null,
  permission_key text not null references company_permissions (key),
  granted_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  primary key (user_id, permission_key),
  foreign key (company_id, user_id)
    references company_member_access (company_id, user_id) on delete cascade
);
create index company_member_permissions_company_id_idx
  on company_member_permissions (company_id);

-- Roles may exist only for bank companies. Member access additionally requires
-- an active, internal employee attached to that exact company and tenant.
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
  if not found or v_company.type <> 'bank' then
    raise exception 'company_access_requires_bank_company';
  end if;

  if tg_table_name = 'company_member_access' then
    select * into v_user from users where id = new.user_id;
    if not found
       or v_user.status <> 'active'
       or v_user.is_external
       or v_user.company_id is distinct from new.company_id
       or v_user.tenant_id is distinct from v_company.tenant_id then
      raise exception 'company_member_not_eligible';
    end if;
  end if;
  return new;
end;
$$;

create trigger company_roles_eligibility
  before insert or update of company_id on company_roles
  for each row execute function enforce_company_access_eligibility();
create trigger company_member_access_eligibility
  before insert or update of company_id, user_id on company_member_access
  for each row execute function enforce_company_access_eligibility();

-- Replace the historical company-removal trigger function. Moving away from a
-- company now drops both deal seats and the concurrency parent for custom
-- company access; role and direct children cascade from that parent.
create or replace function cascade_revoke_on_company_removal()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.company_id is not null
     and new.company_id is distinct from old.company_id then
    delete from deal_memberships where user_id = new.id;
    delete from company_member_access where user_id = new.id;
  end if;
  return null;
end;
$$;

-- Protected roots are active internal directors of the bank company, or active
-- internal firm admins in the same tenant. Every condition is explicit so NULL
-- or an inconsistent row fails closed.
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
      and not u.is_external
      and c.type = 'bank'
      and u.tenant_id = c.tenant_id
      and (
        (u.company_id = c.id and u.company_role = 'director')
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
     and c.type = 'bank'
     and c.tenant_id = u.tenant_id
    where u.id = p_user_id
      and u.status = 'active'
      and not u.is_external
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

create or replace function app_has_company_permission(
  p_user_id uuid,
  p_company_id uuid,
  p_permission_key text
) returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    (
      coalesce(auth.role(), '') = 'service_role'
      or p_user_id = auth.uid()
    )
    and exists (select 1 from company_permissions where key = p_permission_key)
    and exists (
      select 1
      from app_company_effective_permissions(p_user_id, p_company_id) ep
      where ep.permission_key = p_permission_key
    );
$$;

revoke all on function app_company_is_access_root(uuid, uuid) from public;
revoke all on function app_company_effective_permissions(uuid, uuid) from public;
revoke all on function app_has_company_permission(uuid, uuid, text) from public;
grant execute on function app_company_is_access_root(uuid, uuid) to authenticated, service_role;
grant execute on function app_company_effective_permissions(uuid, uuid) to service_role;
grant execute on function app_has_company_permission(uuid, uuid, text) to authenticated, service_role;

-- Shared validation helpers for the service-role write RPCs. They are not
-- exposed to API roles.
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
  perform 1 from companies where id = p_company_id and type = 'bank' for share;
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

create or replace function company_access_validate_envelope(
  p_actor_id uuid,
  p_company_id uuid,
  p_permission_keys text[],
  p_is_root boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from unnest(coalesce(p_permission_keys, array[]::text[])) requested(key)
    where requested.key is null
       or not exists (select 1 from company_permissions p where p.key = requested.key)
  ) then
    raise exception 'invalid_company_permission';
  end if;

  if not p_is_root and exists (
    select 1 from unnest(coalesce(p_permission_keys, array[]::text[])) requested(key)
    where not app_has_company_permission(p_actor_id, p_company_id, requested.key)
  ) then
    raise exception 'grant_outside_envelope';
  end if;
end;
$$;

revoke all on function company_access_lock_actor(uuid, uuid, text) from public;
revoke all on function company_access_validate_envelope(uuid, uuid, text[], boolean) from public;

create or replace function create_company_role(
  p_actor_id uuid,
  p_company_id uuid,
  p_name text,
  p_description text,
  p_permission_keys text[] default array[]::text[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_root boolean;
  v_role company_roles%rowtype;
  v_name text := btrim(p_name);
  v_description text := nullif(btrim(p_description), '');
  v_keys text[];
begin
  v_root := company_access_lock_actor(
    p_actor_id, p_company_id, 'company:roles:manage'
  );
  if v_name is null or char_length(v_name) not between 2 and 80 then
    raise exception 'invalid_role_name';
  end if;
  select coalesce(array_agg(distinct key order by key), array[]::text[])
    into v_keys
    from unnest(coalesce(p_permission_keys, array[]::text[])) requested(key);
  perform company_access_validate_envelope(
    p_actor_id, p_company_id, v_keys, v_root
  );

  begin
    insert into company_roles (company_id, name, description, created_by)
    values (p_company_id, v_name, v_description, p_actor_id)
    returning * into v_role;
  exception when unique_violation then
    raise exception 'role_name_conflict';
  end;

  insert into company_role_permissions (company_id, role_id, permission_key)
  select p_company_id, v_role.id, key from unnest(v_keys) requested(key);

  insert into audit_log (actor_id, action, detail) values (
    p_actor_id, 'create', jsonb_build_object(
      'reason', 'company_role_created',
      'company_id', p_company_id,
      'role_id', v_role.id,
      'source_type', 'role',
      'name', v_role.name,
      'permission_keys', to_jsonb(v_keys),
      'version', v_role.version
    )
  );
  return jsonb_build_object(
    'id', v_role.id,
    'company_id', v_role.company_id,
    'name', v_role.name,
    'description', v_role.description,
    'permission_keys', to_jsonb(v_keys),
    'version', v_role.version,
    'archived_at', v_role.archived_at
  );
end;
$$;

create or replace function replace_company_role(
  p_actor_id uuid,
  p_company_id uuid,
  p_role_id uuid,
  p_expected_version bigint,
  p_name text,
  p_description text,
  p_permission_keys text[] default array[]::text[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_root boolean;
  v_role company_roles%rowtype;
  v_before_name text;
  v_before_description text;
  v_name text := btrim(p_name);
  v_description text := nullif(btrim(p_description), '');
  v_keys text[];
  v_before_keys text[];
  v_added text[];
  v_removed text[];
begin
  v_root := company_access_lock_actor(
    p_actor_id, p_company_id, 'company:roles:manage'
  );
  select * into v_role from company_roles
    where company_id = p_company_id and id = p_role_id for update;
  if not found then raise exception 'role_not_found'; end if;
  if v_role.archived_at is not null then raise exception 'role_archived'; end if;
  if v_role.version is distinct from p_expected_version then raise exception 'stale_version'; end if;
  v_before_name := v_role.name;
  v_before_description := v_role.description;
  if v_name is null or char_length(v_name) not between 2 and 80 then
    raise exception 'invalid_role_name';
  end if;

  select coalesce(array_agg(distinct key order by key), array[]::text[])
    into v_keys
    from unnest(coalesce(p_permission_keys, array[]::text[])) requested(key);
  perform company_access_validate_envelope(
    p_actor_id, p_company_id, v_keys, v_root
  );
  select coalesce(array_agg(permission_key order by permission_key), array[]::text[])
    into v_before_keys from company_role_permissions where role_id = p_role_id;
  select coalesce(array_agg(key order by key), array[]::text[]) into v_added
    from unnest(v_keys) requested(key) where not (key = any(v_before_keys));
  select coalesce(array_agg(key order by key), array[]::text[]) into v_removed
    from unnest(v_before_keys) previous(key) where not (key = any(v_keys));

  begin
    update company_roles set
      name = v_name,
      description = v_description,
      version = version + 1,
      updated_at = now()
    where id = p_role_id
    returning * into v_role;
  exception when unique_violation then
    raise exception 'role_name_conflict';
  end;
  delete from company_role_permissions where role_id = p_role_id;
  insert into company_role_permissions (company_id, role_id, permission_key)
  select p_company_id, p_role_id, key from unnest(v_keys) requested(key);

  insert into audit_log (actor_id, action, detail) values (
    p_actor_id, 'update', jsonb_build_object(
      'reason', 'company_role_updated',
      'company_id', p_company_id,
      'role_id', p_role_id,
      'source_type', 'role',
      'before', jsonb_build_object(
        'name', v_before_name,
        'description', v_before_description,
        'permission_keys', to_jsonb(v_before_keys)
      ),
      'after', jsonb_build_object(
        'name', v_role.name,
        'description', v_role.description,
        'permission_keys', to_jsonb(v_keys)
      ),
      'permissions_added', to_jsonb(v_added),
      'permissions_removed', to_jsonb(v_removed),
      'version', v_role.version
    )
  );
  return jsonb_build_object(
    'id', v_role.id,
    'company_id', v_role.company_id,
    'name', v_role.name,
    'description', v_role.description,
    'permission_keys', to_jsonb(v_keys),
    'version', v_role.version,
    'archived_at', v_role.archived_at
  );
end;
$$;

create or replace function archive_company_role(
  p_actor_id uuid,
  p_company_id uuid,
  p_role_id uuid,
  p_expected_version bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_root boolean;
  v_role company_roles%rowtype;
  v_assignment_count bigint;
begin
  v_root := company_access_lock_actor(
    p_actor_id, p_company_id, 'company:roles:manage'
  );
  select * into v_role from company_roles
    where company_id = p_company_id and id = p_role_id for update;
  if not found then raise exception 'role_not_found'; end if;
  if v_role.archived_at is not null then raise exception 'role_archived'; end if;
  if v_role.version is distinct from p_expected_version then raise exception 'stale_version'; end if;
  select count(*) into v_assignment_count from company_member_roles
    where company_id = p_company_id and role_id = p_role_id;
  if v_assignment_count > 0 then raise exception 'role_assigned'; end if;

  update company_roles set
    archived_at = now(), updated_at = now(), version = version + 1
  where id = p_role_id returning * into v_role;
  insert into audit_log (actor_id, action, detail) values (
    p_actor_id, 'update', jsonb_build_object(
      'reason', 'company_role_archived',
      'company_id', p_company_id,
      'role_id', p_role_id,
      'source_type', 'role',
      'name', v_role.name,
      'version', v_role.version
    )
  );
  return jsonb_build_object(
    'id', v_role.id,
    'company_id', v_role.company_id,
    'name', v_role.name,
    'description', v_role.description,
    'version', v_role.version,
    'archived_at', v_role.archived_at,
    'assignment_count', v_assignment_count
  );
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
     or v_target.is_external
     or v_target.company_id is distinct from p_company_id
     or v_target.tenant_id is distinct from v_company.tenant_id then
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

revoke all on function create_company_role(uuid, uuid, text, text, text[]) from public;
revoke all on function replace_company_role(uuid, uuid, uuid, bigint, text, text, text[]) from public;
revoke all on function archive_company_role(uuid, uuid, uuid, bigint) from public;
revoke all on function replace_company_member_access(uuid, uuid, uuid, bigint, uuid[], text[]) from public;
grant execute on function create_company_role(uuid, uuid, text, text, text[]) to service_role;
grant execute on function replace_company_role(uuid, uuid, uuid, bigint, text, text, text[]) to service_role;
grant execute on function archive_company_role(uuid, uuid, uuid, bigint) to service_role;
grant execute on function replace_company_member_access(uuid, uuid, uuid, bigint, uuid[], text[]) to service_role;

-- Synchronize the deprecated legacy output for every direct-grant mutation,
-- including service-role maintenance outside the RPCs. It is a projection of
-- the direct grant only; authorization must use app_has_company_permission.
create or replace function sync_company_invite_projection()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := coalesce(new.user_id, old.user_id);
begin
  if coalesce(new.permission_key, old.permission_key) = 'company:invites:send' then
    update users set can_invite = exists (
      select 1 from company_member_permissions
      where user_id = v_user_id and permission_key = 'company:invites:send'
    ) where id = v_user_id;
  end if;
  return null;
end;
$$;
create trigger company_invite_projection
  after insert or delete on company_member_permissions
  for each row execute function sync_company_invite_projection();

-- Preserve existing delegated invitation authority as a direct grant.
insert into company_member_access (company_id, user_id)
select u.company_id, u.id
from users u
join companies c on c.id = u.company_id and c.type = 'bank' and c.tenant_id = u.tenant_id
where u.can_invite
  and u.status = 'active'
  and not u.is_external
on conflict (company_id, user_id) do nothing;

insert into company_member_permissions (company_id, user_id, permission_key, granted_by)
select u.company_id, u.id, 'company:invites:send', u.id
from users u
join companies c on c.id = u.company_id and c.type = 'bank' and c.tenant_id = u.tenant_id
where u.can_invite
  and u.status = 'active'
  and not u.is_external
on conflict (user_id, permission_key) do nothing;

-- The latest invite writer is public.create_invite(..., p_phase integer), from
-- 20260808120000_invite_phase.sql. Preserve that security-sensitive function
-- verbatim except for its one company-only delegation predicate. The guarded
-- replacement makes migration-chain drift fail loudly instead of silently
-- leaving users.can_invite authoritative. Deal-attached invitation authority
-- and the protected director-invite check remain unchanged.
do $$
declare
  v_signature regprocedure := to_regprocedure(
    'public.create_invite(uuid,text,uuid,text,text,uuid,uuid,text,integer)'
  );
  v_definition text;
  v_legacy_predicate constant text :=
    'coalesce(v_actor.company_id = p_company_id and v_actor.can_invite, false)';
  v_permission_predicate constant text :=
    'public.app_has_company_permission(p_actor, p_company_id, ''company:invites:send'')';
begin
  if v_signature is null then
    raise exception 'create_invite_phase_signature_not_found';
  end if;
  select pg_get_functiondef(v_signature) into v_definition;
  if length(v_definition) - length(replace(v_definition, v_legacy_predicate, ''))
       <> length(v_legacy_predicate) then
    raise exception 'create_invite_legacy_authority_predicate_not_found_once';
  end if;
  execute replace(v_definition, v_legacy_predicate, v_permission_predicate);
end;
$$;

revoke all on function public.create_invite(
  uuid, text, uuid, text, text, uuid, uuid, text, integer
) from public, authenticated;
grant execute on function public.create_invite(
  uuid, text, uuid, text, text, uuid, uuid, text, integer
) to service_role;

-- RLS is read-only for authenticated clients. Write privileges and mutation
-- RPC execution remain service-role-only.
alter table company_permissions enable row level security;
alter table company_roles enable row level security;
alter table company_role_permissions enable row level security;
alter table company_member_access enable row level security;
alter table company_member_roles enable row level security;
alter table company_member_permissions enable row level security;

grant select, insert, update, delete on company_permissions, company_roles,
  company_role_permissions, company_member_access, company_member_roles,
  company_member_permissions to service_role;
grant select on company_permissions, company_roles, company_role_permissions,
  company_member_access, company_member_roles, company_member_permissions
  to authenticated;

create policy company_permissions_select on company_permissions
  for select to authenticated using (true);
create policy company_roles_select on company_roles
  for select to authenticated using (
    app_company_is_access_root(auth.uid(), company_id)
    or app_has_company_permission(auth.uid(), company_id, 'company:roles:manage')
    or app_has_company_permission(auth.uid(), company_id, 'company:access:assign')
  );
create policy company_role_permissions_select on company_role_permissions
  for select to authenticated using (
    app_company_is_access_root(auth.uid(), company_id)
    or app_has_company_permission(auth.uid(), company_id, 'company:roles:manage')
    or app_has_company_permission(auth.uid(), company_id, 'company:access:assign')
  );
create policy company_member_access_select on company_member_access
  for select to authenticated using (
    user_id = auth.uid()
    or app_company_is_access_root(auth.uid(), company_id)
    or app_has_company_permission(auth.uid(), company_id, 'company:access:assign')
  );
create policy company_member_roles_select on company_member_roles
  for select to authenticated using (
    user_id = auth.uid()
    or app_company_is_access_root(auth.uid(), company_id)
    or app_has_company_permission(auth.uid(), company_id, 'company:access:assign')
  );
create policy company_member_permissions_select on company_member_permissions
  for select to authenticated using (
    user_id = auth.uid()
    or app_company_is_access_root(auth.uid(), company_id)
    or app_has_company_permission(auth.uid(), company_id, 'company:access:assign')
  );

drop policy if exists users_select on users;
create policy users_select on users for select to authenticated
  using (
    id = auth.uid()
    or (app_is_overseer(auth.uid()) and tenant_id = app_user_tenant(auth.uid()))
    or (
      company_id is not null
      and company_id = app_user_company(auth.uid())
      and (
        app_user_is_director(auth.uid())
        or app_has_company_permission(
          auth.uid(), company_id, 'company:directory:view_all'
        )
      )
    )
  );
