-- Extend the company permission catalogue with deal-step and lead-creation capabilities.

alter table company_permissions drop constraint company_permissions_key_check;

alter table company_permissions add constraint company_permissions_key_check check (key in (
  'company:directory:view_all',
  'company:invites:send',
  'company:roles:manage',
  'company:access:assign',
  'company:leads:view',
  'company:leads:create',
  'company:deals:create',
  'company:deals:add_members',
  'company:deals:steps:complete',
  'company:deals:steps:assign',
  'company:deals:steps:update_unassigned'
));

insert into company_permissions (key, label, description, category, sort_order) values
  ('company:leads:create', 'Create leads',
    'Register a new lead company in the platform.', 'Platform', 55),
  ('company:deals:steps:complete', 'Mark deal steps complete',
    'Mark an assigned deal step complete on deals the company participates in.', 'Deals', 80),
  ('company:deals:steps:assign', 'Assign deal steps',
    'Assign deal steps to other deal team members.', 'Deals', 90),
  ('company:deals:steps:update_unassigned', 'Update unassigned deal steps',
    'Save work on deal steps that have no assignee yet.', 'Deals', 100)
on conflict (key) do update set
  label = excluded.label,
  description = excluded.description,
  category = excluded.category,
  sort_order = excluded.sort_order;

insert into company_role_permissions (company_id, role_id, permission_key)
select cr.company_id, cr.id, permission.key
from company_roles cr
cross join (
  values
    ('company:leads:create'),
    ('company:deals:steps:complete'),
    ('company:deals:steps:assign'),
    ('company:deals:steps:update_unassigned')
) as permission(key)
join companies c on c.id = cr.company_id
where c.type = 'client'
  and lower(cr.name) = 'md'
  and cr.archived_at is null
on conflict do nothing;

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
    select u.id into v_actor
    from users u
    where u.company_id = p_company_id
      and u.company_role = 'director'
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
