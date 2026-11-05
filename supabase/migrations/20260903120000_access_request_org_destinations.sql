-- Roles, assign-access, and Gate 0 notify can be requested the same way as
-- Leads. Also re-seed the bank Compliance role for companies that missed the
-- original backfill (no director/admin at migration time).

do $$
declare
  rec record;
begin
  for rec in
    select conname
    from pg_constraint
    where conrelid = 'access_requests'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%destination%'
  loop
    execute format('alter table access_requests drop constraint %I', rec.conname);
  end loop;
end
$$;

alter table access_requests
  add constraint access_requests_destination_check
  check (destination in (
    'leads',
    'leads_create',
    'organization',
    'roles',
    'access_assign',
    'compliance_notify'
  ));

create or replace function seed_bank_compliance_role(
  p_company_id uuid,
  p_actor_id uuid default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_role uuid;
begin
  if not exists (
    select 1 from companies
    where id = p_company_id and type = 'bank'
  ) then
    return;
  end if;

  v_actor := coalesce(
    p_actor_id,
    (
      select u.id from users u
      where u.company_id = p_company_id and u.company_role = 'director' and u.status = 'active'
      order by u.id limit 1
    ),
    (
      select u.id from users u
      join companies c on c.id = p_company_id
      where u.tenant_id = c.tenant_id and u.firm_role = 'admin' and u.status = 'active'
      order by u.id limit 1
    ),
    (
      select u.id from users u
      where u.company_id = p_company_id and u.status = 'active'
      order by u.id limit 1
    ),
    (
      select u.id from users u
      join companies c on c.id = p_company_id
      where u.tenant_id = c.tenant_id and u.status = 'active'
      order by u.id limit 1
    )
  );
  if v_actor is null then
    return;
  end if;

  select id into v_role
  from company_roles
  where company_id = p_company_id
    and lower(name) = 'compliance'
    and archived_at is null
  limit 1;

  if v_role is null then
    insert into company_roles (company_id, name, description, created_by)
    values (p_company_id, 'Compliance', 'Receives new-mandate notices.', v_actor)
    returning id into v_role;
  end if;

  insert into company_role_permissions (company_id, role_id, permission_key)
  values (p_company_id, v_role, 'company:compliance:notify')
  on conflict do nothing;
end;
$$;

select seed_bank_compliance_role(c.id)
from companies c
where c.type = 'bank';
