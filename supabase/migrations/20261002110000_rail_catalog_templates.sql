-- Company rail catalog. These tables are separate from the deal-captured
-- rail_templates table (20260921100000), which stores a revision manifest of
-- a live deal. A catalog row is a named copy of the house rail, or of another
-- catalog template, stored as editable step rows.
--
-- The house default is not a row: it is the catalogue the application copies
-- (MVP_DEAL_RAIL). A permitted user starts from that default, or from a
-- template this company already saved, and stores a new named copy. Later
-- edits to the source do not rewrite the copy.
--
-- Configuring templates is a different authority from working a deal's steps
-- and from adding or removing steps on one live deal
-- (company:deals:steps:structure).

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
  'company:deals:steps:structure',
  'company:rails:templates:manage',
  'company:compliance:notify'
));

insert into company_permissions (key, label, description, category, sort_order) values
  ('company:rails:templates:manage', 'Configure rail templates',
    'Create a named rail template by copying the house default or a template this company already saved.',
    'Deals', 76)
on conflict (key) do update set
  label = excluded.label,
  description = excluded.description,
  category = excluded.category,
  sort_order = excluded.sort_order;

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
    'compliance_notify',
    'rail_templates'
  ));

create table if not exists rail_catalog_templates (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies (id) on delete cascade,
  name           text not null,
  forked_from_id uuid references rail_catalog_templates (id),
  created_by     uuid not null references users (id),
  created_at     timestamptz not null default now(),
  constraint rail_catalog_templates_name_check check (
    char_length(btrim(name)) between 1 and 80
    and lower(btrim(name)) <> 'default'
  )
);

create unique index if not exists rail_catalog_templates_company_name_idx
  on rail_catalog_templates (company_id, lower(btrim(name)));

create index if not exists rail_catalog_templates_company_created_idx
  on rail_catalog_templates (company_id, created_at);

create table if not exists rail_catalog_steps (
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid not null references rail_catalog_templates (id) on delete cascade,
  step_id       text not null,
  seq           int,
  phase_index   int not null,
  display_order int not null,
  origin        text not null default 'catalog',
  definition    jsonb,
  constraint rail_catalog_steps_origin_check check (origin in ('catalog', 'custom')),
  unique (template_id, step_id),
  unique (template_id, display_order)
);

create index if not exists rail_catalog_steps_template_idx
  on rail_catalog_steps (template_id, display_order);

alter table rail_catalog_templates enable row level security;
alter table rail_catalog_steps enable row level security;
revoke all on rail_catalog_templates from public, anon, authenticated;
revoke all on rail_catalog_steps from public, anon, authenticated;
grant select, insert, update, delete on rail_catalog_templates to service_role;
grant select, insert, update, delete on rail_catalog_steps to service_role;

-- One write, so a failed step copy cannot leave a named template with no steps.
create or replace function create_rail_template(
  p_company_id   uuid,
  p_actor_id     uuid,
  p_name         text,
  p_forked_from  uuid,
  p_steps        jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(p_name);
  v_id   uuid;
  v_step jsonb;
begin
  if v_name is null
     or char_length(v_name) < 1
     or char_length(v_name) > 80
     or lower(v_name) = 'default' then
    raise exception 'template_name' using errcode = 'P0001';
  end if;

  if jsonb_typeof(p_steps) is distinct from 'array' or jsonb_array_length(p_steps) < 1 then
    raise exception 'template_steps' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from rail_catalog_templates
    where company_id = p_company_id and lower(btrim(name)) = lower(v_name)
  ) then
    raise exception 'template_name_taken' using errcode = 'P0002';
  end if;

  if p_forked_from is not null and not exists (
    select 1 from rail_catalog_templates
    where id = p_forked_from and company_id = p_company_id
  ) then
    raise exception 'template_source' using errcode = 'P0003';
  end if;

  insert into rail_catalog_templates (company_id, name, forked_from_id, created_by)
    values (p_company_id, v_name, p_forked_from, p_actor_id)
    returning id into v_id;

  for v_step in select value from jsonb_array_elements(p_steps)
  loop
    if coalesce(v_step->>'stepId', '') = '' then
      raise exception 'template_steps' using errcode = 'P0001';
    end if;
    if coalesce(v_step->>'origin', 'catalog') not in ('catalog', 'custom') then
      raise exception 'template_steps' using errcode = 'P0001';
    end if;

    insert into rail_catalog_steps (
      template_id, step_id, seq, phase_index, display_order, origin, definition
    ) values (
      v_id,
      v_step->>'stepId',
      (v_step->>'seq')::int,
      (v_step->>'phaseIndex')::int,
      (v_step->>'displayOrder')::int,
      coalesce(v_step->>'origin', 'catalog'),
      case when v_step->'definition' = 'null'::jsonb then null else v_step->'definition' end
    );
  end loop;

  insert into audit_log (actor_id, action, detail)
    values (
      p_actor_id,
      'create',
      jsonb_build_object(
        'railTemplate', v_id,
        'name', v_name,
        'forkedFrom', p_forked_from
      )
    );

  return jsonb_build_object(
    'id', v_id,
    'name', v_name,
    'forkedFromId', p_forked_from
  );
end;
$$;

revoke all on function create_rail_template(uuid, uuid, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function create_rail_template(uuid, uuid, text, uuid, jsonb) to service_role;
