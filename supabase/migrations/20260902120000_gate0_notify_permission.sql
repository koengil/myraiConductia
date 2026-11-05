-- Gate 0 notify recipients are assigned, not implied by a missing CCO title.
-- Eligible: tenant CCO / firm admin, bank directors (access roots), and anyone
-- granted company:compliance:notify on the bank via a role or a direct grant.
-- Client companies do not receive this permission. Seed personas are not involved.

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
  'company:deals:steps:update_unassigned',
  'company:compliance:notify'
));

insert into company_permissions (key, label, description, category, sort_order) values
  ('company:compliance:notify', 'Receive new-mandate notices',
    'Receive the screened Gate 0 notice when a mandate opens on this bank.',
    'Compliance', 110)
on conflict (key) do update set
  label = excluded.label,
  description = excluded.description,
  category = excluded.category,
  sort_order = excluded.sort_order;

-- A bank-only Compliance role so directors can assign the permission to staff
-- who are not access roots. Not granted to client companies.
insert into company_roles (company_id, name, description, created_by)
select
  c.id,
  'Compliance',
  'Receives new-mandate notices.',
  coalesce(
    (
      select u.id from users u
      where u.company_id = c.id and u.company_role = 'director' and u.status = 'active'
      order by u.id limit 1
    ),
    (
      select u.id from users u
      where u.tenant_id = c.tenant_id and u.firm_role = 'admin' and u.status = 'active'
      order by u.id limit 1
    )
  )
from companies c
where c.type = 'bank'
  and not exists (
    select 1 from company_roles cr
    where cr.company_id = c.id and lower(cr.name) = 'compliance' and cr.archived_at is null
  )
  and coalesce(
    (
      select u.id from users u
      where u.company_id = c.id and u.company_role = 'director' and u.status = 'active'
      order by u.id limit 1
    ),
    (
      select u.id from users u
      where u.tenant_id = c.tenant_id and u.firm_role = 'admin' and u.status = 'active'
      order by u.id limit 1
    )
  ) is not null;

insert into company_role_permissions (company_id, role_id, permission_key)
select cr.company_id, cr.id, 'company:compliance:notify'
from company_roles cr
join companies c on c.id = cr.company_id
where c.type = 'bank'
  and lower(cr.name) = 'compliance'
  and cr.archived_at is null
on conflict do nothing;

create or replace function gate0_notify_recipients(
  p_tenant_id uuid,
  p_bank_id uuid
) returns table (
  user_id uuid,
  display_name text,
  full_name text,
  firm_role text,
  company_role text
)
language sql
stable
security definer
set search_path = public
as $$
  with bank as (
    select id, tenant_id
    from companies
    where id = p_bank_id
      and tenant_id = p_tenant_id
      and type = 'bank'
  ),
  eligible as (
    select u.id, u.display_name, u.full_name, u.firm_role, u.company_role
    from users u
    cross join bank b
    where u.tenant_id = b.tenant_id
      and u.status = 'active'
      and not u.is_external
      and (
        u.firm_role in ('cco', 'admin')
        or (u.company_id = b.id and u.company_role = 'director')
        or exists (
          select 1
          from company_member_roles mr
          join company_roles r
            on r.id = mr.role_id
           and r.company_id = mr.company_id
           and r.archived_at is null
          join company_role_permissions rp
            on rp.role_id = r.id
           and rp.company_id = r.company_id
           and rp.permission_key = 'company:compliance:notify'
          where mr.user_id = u.id
            and mr.company_id = b.id
        )
        or exists (
          select 1
          from company_member_permissions mp
          where mp.user_id = u.id
            and mp.company_id = b.id
            and mp.permission_key = 'company:compliance:notify'
        )
      )
  )
  select e.id, e.display_name, e.full_name, e.firm_role, e.company_role
  from eligible e
  group by e.id, e.display_name, e.full_name, e.firm_role, e.company_role
  order by coalesce(e.display_name, e.full_name), e.id;
$$;

revoke all on function gate0_notify_recipients(uuid, uuid) from public;
grant execute on function gate0_notify_recipients(uuid, uuid) to service_role;

-- New banks get the same Compliance role as the backfill. Seed when someone
-- joins the bank (created_by must be a real user). Client companies never get it.
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

revoke all on function seed_bank_compliance_role(uuid, uuid) from public;
grant execute on function seed_bank_compliance_role(uuid, uuid) to service_role;

create or replace function trg_seed_bank_compliance_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.company_id is not null
     and (tg_op = 'INSERT' or new.company_id is distinct from old.company_id)
  then
    perform seed_bank_compliance_role(new.company_id, new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists seed_bank_compliance_role_on_membership on users;
create trigger seed_bank_compliance_role_on_membership
  after insert or update of company_id on users
  for each row execute function trg_seed_bank_compliance_role();

create or replace function create_deal_gate0(
  p_tenant_id        uuid,
  p_actor_id         uuid,
  p_bank_id          uuid,
  p_codename         text,
  p_target_name      text,
  p_target_company_id uuid  default null,
  p_codename_theme   text   default null,
  p_entry_step_seq   int    default 1,
  p_entry_phase      int    default 0,
  p_members          jsonb  default '[]'::jsonb,
  p_screening        jsonb  default '{}'::jsonb,
  p_steps            jsonb  default '[]'::jsonb,
  p_census_version   text   default null,
  p_conflicts        jsonb  default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target       uuid;
  v_deal         uuid;
  v_deal_row     deals;
  v_md_role      uuid;
  v_member       jsonb;
  v_uid          uuid;
  v_role_slug    text;
  v_role_id      uuid;
  v_actor_name   text;
  v_distinctive  text;
  v_prefix       text;
  v_year         int := extract(year from now())::int;
  v_code         text;
  v_attempts     int := 0;
  v_constraint   text;
  v_recipient    record;
  v_step         jsonb;
  v_step_seq     int;
  v_memberships  jsonb;
  v_notified     jsonb;
  v_approved_by  text;
  v_approved_on  date;
begin
  if coalesce(btrim(p_codename), '') = '' then
    raise exception 'codename is required' using errcode = 'P0001';
  end if;

  v_approved_by := btrim(coalesce(p_conflicts->>'approvedBy', ''));
  if v_approved_by = '' then
    raise exception 'conflicts approval is required' using errcode = 'P0001';
  end if;
  begin
    v_approved_on := (p_conflicts->>'approvedOn')::date;
  exception when others then
    v_approved_on := null;
  end;
  if v_approved_on is null then
    raise exception 'conflicts approval date is required' using errcode = 'P0001';
  end if;

  if not exists (select 1 from gate0_notify_recipients(p_tenant_id, p_bank_id)) then
    raise exception 'no gate0 notify recipient' using errcode = 'P0001';
  end if;

  if p_target_company_id is not null then
    select id into v_target
      from companies
      where id = p_target_company_id
        and tenant_id = p_tenant_id;
    if v_target is null then
      raise exception 'target company % is not in tenant %', p_target_company_id, p_tenant_id
        using errcode = 'P0001';
    end if;
  else
    if coalesce(btrim(p_target_name), '') = '' then
      raise exception 'targetName or targetCompanyId is required' using errcode = 'P0001';
    end if;
    select id into v_target
      from companies
      where tenant_id = p_tenant_id
        and type = 'target'
        and lower(name) = lower(btrim(p_target_name))
      limit 1;
    if v_target is null then
      insert into companies (tenant_id, name, type)
        values (p_tenant_id, btrim(p_target_name), 'target')
        returning id into v_target;
    end if;
  end if;

  v_distinctive := regexp_replace(btrim(p_codename), '^\s*project\s+', '', 'i');
  if coalesce(btrim(v_distinctive), '') = '' then
    v_distinctive := btrim(p_codename);
  end if;
  v_prefix := rpad(upper(left(regexp_replace(v_distinctive, '[^a-zA-Z0-9]', '', 'g'), 5)), 5, 'X');
  loop
    v_attempts := v_attempts + 1;
    v_code := v_prefix || '-' || v_year || '-' || lpad((floor(random() * 900) + 100)::int::text, 3, '0');
    begin
      insert into deals (
        tenant_id, code, codename, bank_id, mandate_owner_id, status,
        entry_step_seq, current_step_seq, gate0_completed_at, codename_theme,
        conflicts_approved_by, conflicts_approved_on
      )
      values (
        p_tenant_id, v_code, btrim(p_codename), p_bank_id, p_actor_id, 'intake',
        p_entry_step_seq, p_entry_step_seq, now(), p_codename_theme,
        v_approved_by, v_approved_on
      )
      returning id into v_deal;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'deals_code_key' and v_attempts < 20 then
        continue;
      end if;
      raise;
    end;
  end loop;

  insert into deal_parties (deal_id, company_id, party_role)
    values (v_deal, v_target, 'target')
    on conflict (deal_id, company_id, party_role) do nothing;

  select id into v_md_role from roles where slug = 'md';
  if v_md_role is null then
    raise exception 'md role missing' using errcode = 'P0001';
  end if;
  insert into deal_memberships (deal_id, user_id, role_id, deal_role, phase, added_by)
    values (v_deal, p_actor_id, v_md_role, 'md', p_entry_phase, p_actor_id)
    on conflict (deal_id, user_id) do nothing;
  if found then
    insert into audit_log (actor_id, action, deal_id, detail)
      values (p_actor_id, 'grant', v_deal,
              jsonb_build_object('user', p_actor_id, 'deal_role', 'md'));
  end if;

  for v_member in select * from jsonb_array_elements(p_members)
  loop
    v_uid := (v_member->>'userId')::uuid;
    v_role_slug := coalesce(v_member->>'dealRole', 'deal_team');
    if v_uid is null or v_uid = p_actor_id then
      continue;
    end if;
    select id into v_role_id from roles where slug = v_role_slug;
    if v_role_id is null then
      raise exception 'invalid deal role "%"', v_role_slug using errcode = 'P0001';
    end if;
    insert into deal_memberships (deal_id, user_id, role_id, deal_role, phase, added_by)
      values (v_deal, v_uid, v_role_id, v_role_slug, p_entry_phase, p_actor_id)
      on conflict (deal_id, user_id) do nothing;
    if found then
      insert into audit_log (actor_id, action, deal_id, detail)
        values (p_actor_id, 'grant', v_deal,
                jsonb_build_object('user', v_uid, 'deal_role', v_role_slug));
    end if;
  end loop;

  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'create', v_deal,
            jsonb_build_object('code', v_code, 'codename', btrim(p_codename)));

  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'attest', v_deal,
            jsonb_build_object(
              'checklist', 'conflicts',
              'approved_by', v_approved_by,
              'approved_on', v_approved_on
            ));

  -- COMPLIANCE: payload NEVER carries the target name.
  select coalesce(display_name, full_name) into v_actor_name
    from users where id = p_actor_id;
  for v_recipient in
    select user_id as id from gate0_notify_recipients(p_tenant_id, p_bank_id)
  loop
    insert into notifications (tenant_id, deal_id, recipient_id, event_type, payload)
      values (p_tenant_id, v_deal, v_recipient.id, 'deal_created',
              jsonb_build_object(
                'code', v_code,
                'codename', btrim(p_codename),
                'actor', v_actor_name,
                'screening', p_screening
              ));
    insert into audit_log (actor_id, action, deal_id, detail)
      values (p_actor_id, 'notify', v_deal,
              jsonb_build_object('recipient', v_recipient.id, 'event', 'deal_created'));
  end loop;

  for v_step in select * from jsonb_array_elements(p_steps)
  loop
    v_step_seq := (v_step->>'seq')::int;
    insert into deal_steps (deal_id, step_id, seq, status, census_version)
      values (
        v_deal,
        v_step->>'stepId',
        v_step_seq,
        case
          when v_step_seq = p_entry_step_seq then 'current'
          when v_step_seq < p_entry_step_seq then 'skipped_entry'
          else 'pending'
        end,
        p_census_version
      )
      on conflict (deal_id, step_id) do nothing;
  end loop;

  select * into v_deal_row from deals where id = v_deal;
  select jsonb_agg(jsonb_build_object('userId', user_id, 'dealRole', deal_role) order by access_granted_at)
    into v_memberships from deal_memberships where deal_id = v_deal;
  select coalesce(jsonb_agg(jsonb_build_object('userId', recipient_id, 'at', created_at)), '[]'::jsonb)
    into v_notified from notifications where deal_id = v_deal and event_type = 'deal_created';

  return jsonb_build_object(
    'deal', jsonb_build_object(
      'id', v_deal_row.id,
      'code', v_deal_row.code,
      'codename', v_deal_row.codename,
      'status', v_deal_row.status,
      'entryStepSeq', v_deal_row.entry_step_seq,
      'currentStepSeq', v_deal_row.current_step_seq,
      'conflictsApprovedBy', v_deal_row.conflicts_approved_by,
      'conflictsApprovedOn', v_deal_row.conflicts_approved_on,
      'createdAt', v_deal_row.created_at
    ),
    'memberships', coalesce(v_memberships, '[]'::jsonb),
    'notified', v_notified
  );
end;
$$;

grant execute on function create_deal_gate0(
  uuid, uuid, uuid, text, text, uuid, text, int, int, jsonb, jsonb, jsonb, text, jsonb
) to service_role;
