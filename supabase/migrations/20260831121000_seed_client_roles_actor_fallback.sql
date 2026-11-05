-- Lead registration inserts a client company via the service-role admin client,
-- so auth.uid() is null and the new company has no directors yet. The previous
-- actor lookup only accepted a client director or a firm admin. Team accounts
-- are seeded with firm_role = null, so registering a lead raised
-- seed_client_roles_actor_not_found. Resolve created_by from the registering
-- bank (or any active tenant user) before failing.

create or replace function seed_client_company_default_roles(
  p_company_id uuid,
  p_actor_id uuid default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company companies%rowtype;
  v_actor uuid := p_actor_id;
  v_role_id uuid;
begin
  select * into v_company from companies where id = p_company_id;
  if not found or v_company.type <> 'client' then
    return;
  end if;

  if v_actor is null then
    v_actor := auth.uid();
  end if;

  if v_actor is null then
    select u.id into v_actor
    from users u
    where u.company_id = p_company_id
      and u.company_role = 'director'
      and u.status = 'active'
    order by u.id
    limit 1;
  end if;

  if v_actor is null and v_company.registered_by_company_id is not null then
    select u.id into v_actor
    from users u
    where u.company_id = v_company.registered_by_company_id
      and u.company_role = 'director'
      and u.status = 'active'
    order by u.id
    limit 1;
  end if;

  if v_actor is null and v_company.registered_by_company_id is not null then
    select u.id into v_actor
    from users u
    where u.company_id = v_company.registered_by_company_id
      and u.status = 'active'
    order by u.id
    limit 1;
  end if;

  if v_actor is null then
    select u.id into v_actor
    from users u
    where u.tenant_id = v_company.tenant_id
      and u.firm_role = 'admin'
      and u.status = 'active'
    order by u.id
    limit 1;
  end if;

  if v_actor is null then
    select u.id into v_actor
    from users u
    where u.tenant_id = v_company.tenant_id
      and u.firm_role = 'cco'
      and u.status = 'active'
    order by u.id
    limit 1;
  end if;

  if v_actor is null then
    select u.id into v_actor
    from users u
    where u.tenant_id = v_company.tenant_id
      and u.status = 'active'
    order by
      case when u.company_role = 'director' then 0 else 1 end,
      u.id
    limit 1;
  end if;

  if v_actor is null then
    raise exception 'seed_client_roles_actor_not_found';
  end if;

  if not exists (
    select 1 from company_roles
    where company_id = p_company_id and lower(name) = 'employee' and archived_at is null
  ) then
    insert into company_roles (company_id, name, description, created_by)
    values (
      p_company_id,
      'Employee',
      'Standard platform access for company staff.',
      v_actor
    )
    returning id into v_role_id;
  end if;

  if not exists (
    select 1 from company_roles
    where company_id = p_company_id and lower(name) = 'md' and archived_at is null
  ) then
    insert into company_roles (company_id, name, description, created_by)
    values (
      p_company_id,
      'MD',
      'Managing director with employee directory and invite authority.',
      v_actor
    )
    returning id into v_role_id;

    insert into company_role_permissions (company_id, role_id, permission_key)
    values
      (p_company_id, v_role_id, 'company:directory:view_all'),
      (p_company_id, v_role_id, 'company:invites:send'),
      (p_company_id, v_role_id, 'company:leads:view'),
      (p_company_id, v_role_id, 'company:leads:create'),
      (p_company_id, v_role_id, 'company:deals:create'),
      (p_company_id, v_role_id, 'company:deals:add_members'),
      (p_company_id, v_role_id, 'company:deals:steps:complete'),
      (p_company_id, v_role_id, 'company:deals:steps:assign'),
      (p_company_id, v_role_id, 'company:deals:steps:update_unassigned');
  end if;
end;
$$;

create or replace function trg_seed_client_company_roles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.type = 'client' then
    perform seed_client_company_default_roles(new.id, auth.uid());
  end if;
  return new;
end;
$$;
