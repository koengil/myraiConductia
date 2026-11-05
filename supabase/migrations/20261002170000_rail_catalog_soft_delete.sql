-- Removing a template hides it. Copies that started from it keep their steps
-- and the link to the source, so the source name can still be shown.

alter table rail_catalog_templates
  add column if not exists deleted_at timestamptz;

drop index if exists rail_catalog_templates_company_name_idx;

create unique index if not exists rail_catalog_templates_company_name_idx
  on rail_catalog_templates (company_id, lower(btrim(name)))
  where deleted_at is null;

create or replace function rail_template_reject_removed()
returns trigger
language plpgsql
as $$
declare
  v_template uuid := coalesce(new.template_id, old.template_id);
begin
  if exists (
    select 1 from rail_catalog_templates
    where id = v_template and deleted_at is not null
  ) then
    raise exception 'template_removed' using errcode = 'P0003';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists rail_catalog_steps_reject_removed on rail_catalog_steps;
create trigger rail_catalog_steps_reject_removed
  before insert or update or delete on rail_catalog_steps
  for each row execute function rail_template_reject_removed();

drop trigger if exists rail_catalog_changes_reject_removed on rail_catalog_changes;
create trigger rail_catalog_changes_reject_removed
  before insert or update or delete on rail_catalog_changes
  for each row execute function rail_template_reject_removed();

drop trigger if exists rail_catalog_skill_drafts_reject_removed on rail_catalog_skill_drafts;
create trigger rail_catalog_skill_drafts_reject_removed
  before insert or update or delete on rail_catalog_skill_drafts
  for each row execute function rail_template_reject_removed();

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
    where company_id = p_company_id
      and lower(btrim(name)) = lower(v_name)
      and deleted_at is null
  ) then
    raise exception 'template_name_taken' using errcode = 'P0002';
  end if;

  if p_forked_from is not null and not exists (
    select 1 from rail_catalog_templates
    where id = p_forked_from
      and company_id = p_company_id
      and deleted_at is null
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

create or replace function delete_rail_template(
  p_company_id  uuid,
  p_actor_id    uuid,
  p_template_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  update rail_catalog_templates
    set deleted_at = now()
    where id = p_template_id
      and company_id = p_company_id
      and deleted_at is null
    returning name into v_name;
  if not found then
    raise exception 'template_missing' using errcode = 'P0003';
  end if;

  insert into audit_log (actor_id, action, detail)
    values (
      p_actor_id,
      'update',
      jsonb_build_object('railTemplate', p_template_id, 'name', v_name, 'removed', true)
    );

  return jsonb_build_object('id', p_template_id, 'deleted', true);
end;
$$;

revoke all on function delete_rail_template(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function delete_rail_template(uuid, uuid, uuid) to service_role;
