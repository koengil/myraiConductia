-- Save rail on the catalog (sub-project 3, slice 2). Catalog templates gain a
-- description and a logged way to change a step's skill, and a deal's rail can
-- be saved to the catalog as a new template or onto an existing one.

alter table rail_catalog_templates add column if not exists description text not null default '';
alter table rail_catalog_templates drop constraint if exists rail_catalog_templates_description_check;
alter table rail_catalog_templates add constraint rail_catalog_templates_description_check
  check (char_length(description) <= 500);

alter table rail_catalog_changes drop constraint if exists rail_catalog_changes_action_check;
alter table rail_catalog_changes add constraint rail_catalog_changes_action_check
  check (action in ('add_step', 'remove_step', 'set_description', 'set_template_description', 'set_step_skill'));

drop function if exists create_rail_template(uuid, uuid, text, uuid, jsonb);

create or replace function create_rail_template(
  p_company_id   uuid,
  p_actor_id     uuid,
  p_name         text,
  p_forked_from  uuid,
  p_steps        jsonb,
  p_description  text default ''
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name        text := btrim(p_name);
  v_description text := btrim(coalesce(p_description, ''));
  v_id          uuid;
  v_step        jsonb;
begin
  if v_name is null
     or char_length(v_name) < 1
     or char_length(v_name) > 80
     or lower(v_name) = 'default' then
    raise exception 'template_name' using errcode = 'P0001';
  end if;

  if char_length(v_description) > 500 then
    raise exception 'template_description' using errcode = 'P0001';
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

  insert into rail_catalog_templates (company_id, name, forked_from_id, created_by, description)
    values (p_company_id, v_name, p_forked_from, p_actor_id, v_description)
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

revoke all on function create_rail_template(uuid, uuid, text, uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function create_rail_template(uuid, uuid, text, uuid, jsonb, text) to service_role;

create or replace function set_rail_template_description(
  p_company_id  uuid,
  p_actor_id    uuid,
  p_template_id uuid,
  p_description text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_description text := btrim(coalesce(p_description, ''));
  v_template    rail_catalog_templates;
begin
  select * into v_template from rail_catalog_templates
   where id = p_template_id and company_id = p_company_id and deleted_at is null
   for update;
  if not found then
    raise exception 'template_missing' using errcode = 'P0003';
  end if;

  if char_length(v_description) > 500 then
    raise exception 'template_description' using errcode = 'P0001';
  end if;

  if v_description = v_template.description then
    return jsonb_build_object('id', p_template_id, 'description', v_description, 'changed', false);
  end if;

  update rail_catalog_templates set description = v_description where id = p_template_id;

  perform record_rail_template_change(
    p_template_id, p_company_id, p_actor_id, 'set_template_description',
    'Updated the template description',
    jsonb_build_object('description', v_template.description),
    jsonb_build_object('description', v_description),
    null
  );

  insert into audit_log (actor_id, action, detail)
    values (p_actor_id, 'update',
            jsonb_build_object('railTemplate', p_template_id, 'rail', 'describe_template'));

  return jsonb_build_object('id', p_template_id, 'description', v_description, 'changed', true);
end;
$$;

revoke all on function set_rail_template_description(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function set_rail_template_description(uuid, uuid, uuid, text) to service_role;

create or replace function set_rail_template_step_skill(
  p_company_id  uuid,
  p_actor_id    uuid,
  p_template_id uuid,
  p_step_row_id uuid,
  p_skill       jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_skill  jsonb := case when p_skill is null or p_skill = 'null'::jsonb then null else p_skill end;
  v_step   rail_catalog_steps;
  v_before jsonb;
  v_title  text;
begin
  perform 1 from rail_catalog_templates
    where id = p_template_id and company_id = p_company_id
    for update;
  if not found then
    raise exception 'template_missing' using errcode = 'P0003';
  end if;

  select * into v_step from rail_catalog_steps
    where id = p_step_row_id and template_id = p_template_id;
  if v_step.id is null then
    raise exception 'template_step_missing' using errcode = 'P0003';
  end if;

  if v_skill is not null and (
       jsonb_typeof(v_skill) is distinct from 'object'
       or coalesce(btrim(v_skill ->> 'name'), '') = ''
       or jsonb_typeof(v_skill -> 'contract') is distinct from 'object'
       or jsonb_typeof(v_skill -> 'source') is distinct from 'object') then
    raise exception 'template_step' using errcode = 'P0001';
  end if;
  if v_skill is null and v_step.definition ->> 'type' = 'skill' then
    raise exception 'template_step' using errcode = 'P0001';
  end if;

  v_before := rail_template_step_snapshot(v_step);
  v_title := coalesce(nullif(btrim(v_step.definition->>'title'), ''), v_step.step_id);

  update rail_catalog_steps
     set definition = case
           when v_skill is null then nullif(coalesce(definition, '{}'::jsonb) - 'skill', '{}'::jsonb)
           else coalesce(definition, '{}'::jsonb) || jsonb_build_object('skill', v_skill) end
   where id = p_step_row_id
   returning * into v_step;

  perform record_rail_template_change(
    p_template_id, p_company_id, p_actor_id, 'set_step_skill',
    format('Updated the skill of "%s"', v_title),
    v_before,
    rail_template_step_snapshot(v_step),
    null
  );

  insert into audit_log (actor_id, action, detail)
    values (p_actor_id, 'update', jsonb_build_object(
      'railTemplate', p_template_id, 'rail', 'step_skill',
      'stepId', p_step_row_id, 'stepKey', v_step.step_id));

  return jsonb_build_object('id', v_step.id);
end;
$$;

revoke all on function set_rail_template_step_skill(uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function set_rail_template_step_skill(uuid, uuid, uuid, uuid, jsonb) to service_role;

create or replace function rail_catalog_draft_differs(p_template_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           'steps', rail_catalog_manifest_steps(p_template_id),
           'skills', rail_catalog_manifest_skills(p_template_id),
           'description', (select description from rail_catalog_templates where id = p_template_id))
         is distinct from (
    select jsonb_build_object(
             'steps', r.manifest -> 'steps',
             'skills', r.manifest -> 'skills',
             'description', r.description)
      from rail_catalog_templates c
      join rail_templates t on t.id = c.rail_template_id
      join rail_template_revisions r on r.id = t.current_revision_id
     where c.id = p_template_id
  );
$$;

revoke all on function rail_catalog_draft_differs(uuid) from public, anon, authenticated;
grant execute on function rail_catalog_draft_differs(uuid) to service_role;

create or replace function undo_rail_template_change(
  p_company_id  uuid,
  p_actor_id    uuid,
  p_template_id uuid,
  p_change_id   uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_change      rail_catalog_changes;
  v_step        rail_catalog_steps;
  v_before      jsonb;
  v_at          int;
  v_limit       int;
  v_title       text;
  v_description text;
begin
  perform 1 from rail_catalog_templates
    where id = p_template_id and company_id = p_company_id
    for update;
  if not found then
    raise exception 'template_missing' using errcode = 'P0003';
  end if;

  select * into v_change from rail_catalog_changes
    where id = p_change_id and template_id = p_template_id and company_id = p_company_id;
  if v_change.id is null then
    raise exception 'template_change_missing' using errcode = 'P0003';
  end if;

  if exists (select 1 from rail_catalog_changes where undoes_id = p_change_id) then
    raise exception 'template_change_done' using errcode = 'P0002';
  end if;

  if v_change.action = 'add_step' then
    select * into v_step from rail_catalog_steps
      where id = (v_change.after->>'stepRowId')::uuid and template_id = p_template_id;
    if v_step.id is null then
      raise exception 'template_step_missing' using errcode = 'P0003';
    end if;
    if (select count(*) from rail_catalog_steps where template_id = p_template_id) <= 1 then
      raise exception 'template_last_step' using errcode = 'P0004';
    end if;
    v_title := coalesce(nullif(btrim(v_step.definition->>'title'), ''), v_step.step_id);
    delete from rail_catalog_steps where id = v_step.id;
    update rail_catalog_steps as step
       set display_order = -ordered.n
      from (
        select id, row_number() over (order by display_order) as n
        from rail_catalog_steps
        where template_id = p_template_id
      ) as ordered
     where step.id = ordered.id;
    update rail_catalog_steps
       set display_order = -display_order
     where template_id = p_template_id and display_order < 0;
    perform record_rail_template_change(
      p_template_id, p_company_id, p_actor_id, 'remove_step',
      format('Removed "%s"', v_title),
      rail_template_step_snapshot(v_step),
      null,
      p_change_id
    );

  elsif v_change.action = 'remove_step' then
    v_before := v_change.before;
    if exists (
      select 1 from rail_catalog_steps
      where template_id = p_template_id and step_id = v_before->>'stepId'
    ) then
      raise exception 'template_step_taken' using errcode = 'P0002';
    end if;
    select coalesce(max(display_order), 0) + 1 into v_limit
      from rail_catalog_steps where template_id = p_template_id;
    v_at := least(greatest(coalesce((v_before->>'displayOrder')::int, v_limit), 1), v_limit);
    update rail_catalog_steps
       set display_order = -display_order
     where template_id = p_template_id and display_order >= v_at;
    update rail_catalog_steps
       set display_order = -display_order + 1
     where template_id = p_template_id and display_order < 0;
    insert into rail_catalog_steps (
      id, template_id, step_id, seq, phase_index, display_order, origin, definition
    ) values (
      (v_before->>'stepRowId')::uuid,
      p_template_id,
      v_before->>'stepId',
      (v_before->>'seq')::int,
      (v_before->>'phaseIndex')::int,
      v_at,
      coalesce(v_before->>'origin', 'custom'),
      v_before->'definition'
    )
    returning * into v_step;
    v_title := coalesce(nullif(btrim(v_step.definition->>'title'), ''), v_step.step_id);
    perform record_rail_template_change(
      p_template_id, p_company_id, p_actor_id, 'add_step',
      format('Added "%s"', v_title),
      null,
      rail_template_step_snapshot(v_step),
      p_change_id
    );

  elsif v_change.action = 'set_description' then
    select * into v_step from rail_catalog_steps
      where id = (v_change.after->>'stepRowId')::uuid and template_id = p_template_id;
    if v_step.id is null then
      raise exception 'template_step_missing' using errcode = 'P0003';
    end if;
    v_description := coalesce(v_change.before->>'description', '');
    v_title := coalesce(nullif(btrim(v_step.definition->>'title'), ''), v_step.step_id);
    update rail_catalog_steps
       set definition = coalesce(definition, '{}'::jsonb) || jsonb_build_object('description', v_description)
     where id = v_step.id
     returning * into v_step;
    perform record_rail_template_change(
      p_template_id, p_company_id, p_actor_id, 'set_description',
      format('Updated the description of "%s"', v_title),
      rail_template_step_snapshot(v_step) || jsonb_build_object('description', coalesce(v_change.after->>'description', '')),
      rail_template_step_snapshot(v_step) || jsonb_build_object('description', v_description),
      p_change_id
    );
  elsif v_change.action = 'set_template_description' then
    update rail_catalog_templates
       set description = coalesce(v_change.before ->> 'description', '')
     where id = p_template_id;
    perform record_rail_template_change(
      p_template_id, p_company_id, p_actor_id, 'set_template_description',
      'Updated the template description',
      jsonb_build_object('description', coalesce(v_change.after ->> 'description', '')),
      jsonb_build_object('description', coalesce(v_change.before ->> 'description', '')),
      p_change_id
    );

  elsif v_change.action = 'set_step_skill' then
    select * into v_step from rail_catalog_steps
      where id = (v_change.after->>'stepRowId')::uuid and template_id = p_template_id;
    if v_step.id is null then
      raise exception 'template_step_missing' using errcode = 'P0003';
    end if;
    v_before := rail_template_step_snapshot(v_step);
    v_title := coalesce(nullif(btrim(v_step.definition->>'title'), ''), v_step.step_id);
    update rail_catalog_steps
       set definition = case
             when jsonb_typeof(v_change.before -> 'definition' -> 'skill') = 'object'
               then coalesce(definition, '{}'::jsonb)
                    || jsonb_build_object('skill', v_change.before -> 'definition' -> 'skill')
             else nullif(coalesce(definition, '{}'::jsonb) - 'skill', '{}'::jsonb) end
     where id = v_step.id
     returning * into v_step;
    perform record_rail_template_change(
      p_template_id, p_company_id, p_actor_id, 'set_step_skill',
      format('Updated the skill of "%s"', v_title),
      v_before,
      rail_template_step_snapshot(v_step),
      p_change_id
    );
  else
    raise exception 'template_change' using errcode = 'P0001';
  end if;

  return jsonb_build_object('undone', p_change_id);
end;
$$;

revoke all on function undo_rail_template_change(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function undo_rail_template_change(uuid, uuid, uuid, uuid) to service_role;

create or replace function publish_rail_template(
  p_template_id   uuid,
  p_company_id    uuid,
  p_actor_id      uuid,
  p_protected_ids text[],
  p_revision_id   uuid default null,
  p_receipt       jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_catalog  rail_catalog_templates;
  v_manifest jsonb;
  v_skills   jsonb;
  v_steps    int;
  v_template uuid;
  v_previous uuid;
  v_tenant   uuid;
  v_request  uuid := gen_random_uuid();
  v_revision rail_template_revisions;
begin
  select * into v_catalog from rail_catalog_templates
   where id = p_template_id and company_id = p_company_id
   for update;
  if not found then
    raise exception 'template_missing' using errcode = 'P0003';
  end if;

  if v_catalog.rail_template_id is not null then
    select id, current_revision_id into v_template, v_previous
      from rail_templates where id = v_catalog.rail_template_id
      for update;
  end if;

  v_manifest := rail_catalog_publish_check(p_template_id, p_company_id, p_protected_ids) -> 'manifest';
  v_steps := jsonb_array_length(v_manifest -> 'steps');
  v_skills := v_manifest -> 'skills';

  if jsonb_array_length(v_skills) = 0 then
    if p_revision_id is not null or p_receipt is not null then
      raise exception 'draft_changed' using errcode = 'P0002';
    end if;
  elsif p_revision_id is null
     or jsonb_typeof(p_receipt) is distinct from 'object'
     or jsonb_typeof(p_receipt -> 'assets') is distinct from 'array' then
    raise exception 'draft_changed' using errcode = 'P0002';
  elsif rail_template_uuid(p_receipt ->> 'revisionId') is distinct from p_revision_id
     or jsonb_array_length(p_receipt -> 'assets') <> jsonb_array_length(v_skills)
     or exists (
          select 1 from jsonb_array_elements(v_skills) skill
           where not exists (
             select 1 from jsonb_array_elements(p_receipt -> 'assets') asset
              where asset ->> 'key' = skill ->> 'key'
                and coalesce(asset ->> 'packageDigest', '') ~ '^[0-9a-f]{64}$'
                and (skill -> 'source' ->> 'kind' = 'mount'
                     or asset ->> 'packageDigest' = skill -> 'source' ->> 'digest'))) then
    raise exception 'draft_changed' using errcode = 'P0002';
  end if;

  if v_template is null then
    select tenant_id into v_tenant from companies where id = p_company_id;
    insert into rail_templates (tenant_id, company_id, name, created_by)
      values (v_tenant, p_company_id, v_catalog.name, p_actor_id)
      returning id into v_template;
    update rail_catalog_templates set rail_template_id = v_template where id = p_template_id;
  end if;

  insert into rail_template_revisions (
    id, template_id, actor_id, request_id, request_digest, command,
    source_catalog_template_id, expected_revision_id, manifest, state, provider_receipt, description
  ) values (
    coalesce(p_revision_id, gen_random_uuid()), v_template, p_actor_id, v_request,
    encode(sha256(convert_to(v_request::text, 'UTF8')), 'hex'),
    jsonb_build_object('kind', 'publish', 'catalogTemplateId', p_template_id),
    p_template_id, v_previous, v_manifest, 'ready', p_receipt, v_catalog.description
  ) returning * into v_revision;

  begin
    update rail_templates
       set current_revision_id = v_revision.id, updated_at = now()
     where id = v_template;
  exception when unique_violation then
    raise exception 'name_taken' using errcode = 'P0002';
  end;

  insert into audit_log (actor_id, action, detail)
  values (p_actor_id, 'rail.template_published', jsonb_build_object(
    'catalogTemplateId', p_template_id,
    'templateId', v_template,
    'revisionId', v_revision.id,
    'previousRevisionId', v_previous,
    'version', v_revision.version,
    'stepCount', v_steps,
    'skillCount', jsonb_array_length(v_skills)
  ));

  perform rail_template_notify_deals(v_revision.id, p_actor_id, p_protected_ids);

  return jsonb_build_object(
    'templateId', v_template,
    'revisionId', v_revision.id,
    'version', v_revision.version,
    'stepCount', v_steps,
    'skillCount', jsonb_array_length(v_skills)
  );
end;
$$;

revoke all on function publish_rail_template(uuid, uuid, uuid, text[], uuid, jsonb)
  from public, anon, authenticated;
grant execute on function publish_rail_template(uuid, uuid, uuid, text[], uuid, jsonb) to service_role;

create or replace function rail_catalog_apply_rail(
  p_company_id  uuid,
  p_actor_id    uuid,
  p_template_id uuid,
  p_steps       jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_removed int := 0;
  v_added   int := 0;
  v_updated int := 0;
  v_row     record;
  v_step    rail_catalog_steps;
begin
  perform 1 from rail_catalog_templates
    where id = p_template_id and company_id = p_company_id and deleted_at is null
    for update;
  if not found then
    raise exception 'template_missing' using errcode = 'P0003';
  end if;
  if jsonb_typeof(p_steps) is distinct from 'array' or jsonb_array_length(p_steps) < 1 then
    raise exception 'template_steps' using errcode = 'P0001';
  end if;

  if exists (
    with matched as (
      select t.ord, c.display_order
        from jsonb_array_elements(p_steps) with ordinality as t(step, ord)
        join rail_catalog_steps c
          on c.template_id = p_template_id and c.step_id = t.step ->> 'stepId'
    )
    select 1 from matched a join matched b on a.ord < b.ord and a.display_order > b.display_order
  ) then
    raise exception 'order_differs' using errcode = 'P0002';
  end if;

  for v_row in
    select c.id
      from rail_catalog_steps c
     where c.template_id = p_template_id
       and not exists (
         select 1 from jsonb_array_elements(p_steps) step where step ->> 'stepId' = c.step_id)
     order by c.display_order
  loop
    perform remove_rail_template_step(p_company_id, p_actor_id, p_template_id, v_row.id);
    v_removed := v_removed + 1;
  end loop;

  for v_row in
    select t.step, t.ord
      from jsonb_array_elements(p_steps) with ordinality as t(step, ord)
     order by t.ord
  loop
    select * into v_step from rail_catalog_steps
     where template_id = p_template_id and step_id = v_row.step ->> 'stepId';

    if v_step.id is null then
      perform add_rail_template_step(
        p_company_id, p_actor_id, p_template_id,
        v_row.step ->> 'stepId',
        (v_row.step ->> 'seq')::int,
        (v_row.step ->> 'phaseIndex')::int,
        v_row.step ->> 'origin',
        case when v_row.step -> 'definition' = 'null'::jsonb then null else v_row.step -> 'definition' end,
        v_row.ord::int);
      v_added := v_added + 1;
      continue;
    end if;

    if v_step.origin = 'custom'
       and coalesce(btrim(v_row.step -> 'definition' ->> 'description'), '')
           is distinct from coalesce(btrim(v_step.definition ->> 'description'), '') then
      perform set_rail_template_step_description(
        p_company_id, p_actor_id, p_template_id, v_step.id,
        coalesce(v_row.step -> 'definition' ->> 'description', ''));
      v_updated := v_updated + 1;
    end if;

    if (case when jsonb_typeof(v_row.step -> 'definition' -> 'skill') = 'object'
             then v_row.step -> 'definition' -> 'skill' end)
       is distinct from
       (case when jsonb_typeof(v_step.definition -> 'skill') = 'object'
             then v_step.definition -> 'skill' end) then
      perform set_rail_template_step_skill(
        p_company_id, p_actor_id, p_template_id, v_step.id,
        case when jsonb_typeof(v_row.step -> 'definition' -> 'skill') = 'object'
             then v_row.step -> 'definition' -> 'skill' end);
      v_updated := v_updated + 1;
    end if;
  end loop;

  return jsonb_build_object('removed', v_removed, 'added', v_added, 'updated', v_updated);
end;
$$;

revoke all on function rail_catalog_apply_rail(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function rail_catalog_apply_rail(uuid, uuid, uuid, jsonb) to service_role;

create or replace function rail_template_assert_manage(p_actor_id uuid, p_company_id uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if exists (select 1 from feature_flags where key = 'company_access_management' and enabled)
     and not exists (
       select 1 from users u where u.id = p_actor_id and u.firm_role in ('admin', 'cco')
     )
     and not app_has_company_permission(p_actor_id, p_company_id, 'company:rails:templates:manage')
  then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function rail_template_assert_manage(uuid, uuid) from public, anon, authenticated;
grant execute on function rail_template_assert_manage(uuid, uuid) to service_role;

create or replace function rail_catalog_save_check(
  p_actor_id           uuid,
  p_company_id         uuid,
  p_deal_id            uuid,
  p_target             jsonb,
  p_source_fingerprint text
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_deal     deals;
  v_kind     text := p_target ->> 'kind';
  v_name     text := btrim(coalesce(p_target ->> 'name', ''));
  v_catalog  rail_catalog_templates;
  v_template rail_templates;
  v_revision rail_template_revisions;
  v_target   jsonb := 'null'::jsonb;
begin
  select * into v_deal from deals where id = p_deal_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_deal.bank_id is distinct from p_company_id then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from users u where u.id = p_actor_id and u.tenant_id = v_deal.tenant_id
  ) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  perform rail_template_assert_source_actor(p_actor_id, p_deal_id);
  perform rail_template_assert_manage(p_actor_id, p_company_id);

  if rail_template_source_fingerprint(p_deal_id) is distinct from p_source_fingerprint then
    raise exception 'source_changed' using errcode = 'P0001';
  end if;

  if v_kind = 'new' then
    if char_length(v_name) < 1 or char_length(v_name) > 80 or lower(v_name) = 'default' then
      raise exception 'invalid_command' using errcode = 'P0001';
    end if;
    if exists (
         select 1 from rail_catalog_templates
          where company_id = p_company_id and deleted_at is null
            and lower(btrim(name)) = lower(v_name))
       or exists (
         select 1 from rail_templates t
          where t.company_id = p_company_id
            and t.current_revision_id is not null
            and t.normalized_name = rail_template_normalized_name(v_name)) then
      raise exception 'name_taken' using errcode = 'P0002';
    end if;
  elsif v_kind = 'replace' then
    select * into v_catalog from rail_catalog_templates
     where rail_template_id = rail_template_uuid(p_target ->> 'templateId')
       and company_id = p_company_id and deleted_at is null;
    if not found then
      raise exception 'not_found' using errcode = 'P0001';
    end if;
    select * into v_template from rail_templates where id = v_catalog.rail_template_id;
    if v_template.current_revision_id is null
       or v_template.current_revision_id
          is distinct from rail_template_uuid(p_target ->> 'expectedRevisionId') then
      raise exception 'stale_template' using errcode = 'P0002';
    end if;
    if rail_catalog_draft_differs(v_catalog.id) then
      raise exception 'unpublished_changes' using errcode = 'P0002';
    end if;
    select * into v_revision from rail_template_revisions where id = v_template.current_revision_id;

    v_target := jsonb_build_object(
      'catalogTemplateId', v_catalog.id,
      'description', v_catalog.description,
      'steps', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'stepId', c.step_id,
                 'skill', case when jsonb_typeof(c.definition -> 'skill') = 'object'
                               then c.definition -> 'skill' end,
                 'retainedDigest', (
                   select asset ->> 'packageDigest'
                     from jsonb_array_elements(v_revision.manifest -> 'steps') step
                     join jsonb_array_elements(
                            coalesce(v_revision.provider_receipt -> 'assets', '[]'::jsonb)) asset
                       on asset ->> 'key' = step ->> 'skillKey'
                    where step ->> 'templateStepKey' = c.step_id)
               ) order by c.display_order)
          from rail_catalog_steps c where c.template_id = v_catalog.id), '[]'::jsonb));
  else
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'tenantId', (select tenant_id from companies where id = p_company_id),
    'target', v_target);
end;
$$;

revoke all on function rail_catalog_save_check(uuid, uuid, uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function rail_catalog_save_check(uuid, uuid, uuid, jsonb, text) to service_role;

create or replace function rail_template_read_source(p_actor_id uuid, p_deal_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_deal deals;
begin
  select * into v_deal from deals where id = p_deal_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform rail_template_assert_source_actor(p_actor_id, p_deal_id);

  return jsonb_build_object(
    'dealId', v_deal.id,
    'companyId', v_deal.bank_id,
    'tenantId', v_deal.tenant_id,
    'censusVersion', rail_template_census_version(p_deal_id),
    'steps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'stepId', s.step_id, 'origin', s.origin, 'seq', s.seq,
        'status', s.status, 'phaseIndex', s.phase_index, 'displayOrder', s.display_order,
        'definition', s.definition, 'anchorStepId', s.anchor_step_id,
        'censusVersion', s.census_version, 'removedAt', s.removed_at,
        'templateStepKey', s.template_step_key
      ) order by s.display_order, s.id)
      from deal_steps s where s.deal_id = p_deal_id), '[]'::jsonb),
    'bindings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'dealStepId', b.deal_step_id, 'kind', b.kind, 'skillId', b.skill_id,
        'versionId', b.version_id, 'mountName', b.mount_name,
        'mountVersion', b.mount_version, 'digest', b.digest
      ) order by b.deal_step_id)
      from deal_step_skill_bindings b where b.deal_id = p_deal_id), '[]'::jsonb),
    'sourceFingerprint', rail_template_source_fingerprint(p_deal_id)
  );
end;
$$;

revoke all on function rail_template_read_source(uuid, uuid) from public, anon, authenticated;
grant execute on function rail_template_read_source(uuid, uuid) to service_role;

create or replace function rail_catalog_validate_rail_steps(
  p_deal_id       uuid,
  p_steps         jsonb,
  p_protected_ids text[]
) returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(p_steps) is distinct from 'array' or jsonb_array_length(p_steps) < 1 then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  if (select coalesce(jsonb_agg(t.step ->> 'dealStepId' order by t.ord), '[]'::jsonb)
        from jsonb_array_elements(p_steps) with ordinality as t(step, ord))
     is distinct from
     (select coalesce(jsonb_agg(s.id::text order by s.display_order, s.id), '[]'::jsonb)
        from deal_steps s where s.deal_id = p_deal_id and s.removed_at is null) then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_steps) step
      join deal_steps s on s.id = rail_template_uuid(step ->> 'dealStepId')
     where step ->> 'origin' is distinct from s.origin
        or (step ->> 'phaseIndex')::int is distinct from s.phase_index
        or coalesce(btrim(step ->> 'stepId'), '') = ''
        or (s.origin = 'catalog' and step ->> 'stepId' is distinct from s.step_id)
        or (s.origin = 'custom' and step ->> 'stepId' !~ '^custom-')
        or (s.origin = 'custom' and s.template_step_key is not null
            and step ->> 'stepId' is distinct from s.template_step_key)
  ) then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  if (select count(distinct step ->> 'stepId') from jsonb_array_elements(p_steps) step)
     <> jsonb_array_length(p_steps) then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from unnest(coalesce(p_protected_ids, array[]::text[])) protected_id
     where not exists (
       select 1 from jsonb_array_elements(p_steps) step
        where step ->> 'origin' = 'catalog' and step ->> 'stepId' = protected_id)
  ) then
    raise exception 'missing_protected_step' using errcode = 'P0004';
  end if;
end;
$$;

revoke all on function rail_catalog_validate_rail_steps(uuid, jsonb, text[])
  from public, anon, authenticated;
grant execute on function rail_catalog_validate_rail_steps(uuid, jsonb, text[]) to service_role;

create or replace function rail_catalog_save_replay(p_actor_id uuid, p_request_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select detail -> 'result'
    from audit_log
   where actor_id = p_actor_id
     and action in ('rail.template_created', 'rail.template_replaced')
     and detail ->> 'requestId' = p_request_id::text
   order by ts desc
   limit 1;
$$;

revoke all on function rail_catalog_save_replay(uuid, uuid) from public, anon, authenticated;
grant execute on function rail_catalog_save_replay(uuid, uuid) to service_role;

create or replace function save_rail_to_catalog(
  p_actor_id           uuid,
  p_company_id         uuid,
  p_deal_id            uuid,
  p_request_id         uuid,
  p_target             jsonb,
  p_description        text,
  p_steps              jsonb,
  p_source_fingerprint text,
  p_protected_ids      text[],
  p_revision_id        uuid default null,
  p_receipt            jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind      text := p_target ->> 'kind';
  v_replay    jsonb;
  v_catalog   uuid;
  v_published jsonb;
  v_revision  rail_template_revisions;
  v_name      text;
  v_result    jsonb;
begin
  perform 1 from deals where id = p_deal_id for update;

  v_replay := rail_catalog_save_replay(p_actor_id, p_request_id);
  if v_replay is not null then
    return v_replay;
  end if;

  if v_kind = 'replace' then
    perform 1 from rail_catalog_templates
     where rail_template_id = rail_template_uuid(p_target ->> 'templateId')
       and company_id = p_company_id and deleted_at is null
     for update;
  end if;

  perform rail_catalog_save_check(p_actor_id, p_company_id, p_deal_id, p_target, p_source_fingerprint);
  perform rail_catalog_validate_rail_steps(p_deal_id, p_steps, p_protected_ids);

  if v_kind = 'new' then
    begin
      v_catalog := (create_rail_template(
        p_company_id, p_actor_id, p_target ->> 'name', null,
        (select jsonb_agg(t.step || jsonb_build_object('displayOrder', t.ord) order by t.ord)
           from jsonb_array_elements(p_steps) with ordinality as t(step, ord)),
        p_description) ->> 'id')::uuid;
    exception
      when sqlstate 'P0002' then
        raise exception 'name_taken' using errcode = 'P0002';
      when sqlstate 'P0001' then
        raise exception 'invalid_command' using errcode = 'P0001';
    end;
  else
    select id into v_catalog from rail_catalog_templates
     where rail_template_id = rail_template_uuid(p_target ->> 'templateId')
       and company_id = p_company_id and deleted_at is null
     for update;
    begin
      perform rail_catalog_apply_rail(p_company_id, p_actor_id, v_catalog, p_steps);
      perform set_rail_template_description(p_company_id, p_actor_id, v_catalog, p_description);
    exception
      when sqlstate 'P0001' then
        raise exception 'invalid_command' using errcode = 'P0001';
    end;
  end if;

  update deal_steps s
     set template_step_key = step ->> 'stepId'
    from jsonb_array_elements(p_steps) step
   where s.deal_id = p_deal_id
     and s.id = rail_template_uuid(step ->> 'dealStepId');

  update deal_steps
     set template_step_key = step_id
   where deal_id = p_deal_id
     and origin = 'catalog'
     and removed_at is not null
     and template_step_key is null;

  begin
    v_published := publish_rail_template(
      v_catalog, p_company_id, p_actor_id, p_protected_ids, p_revision_id, p_receipt);
  exception when sqlstate 'P0002' then
    if sqlerrm = 'draft_changed' then
      raise exception 'source_changed' using errcode = 'P0001';
    end if;
    raise;
  end;

  select * into v_revision from rail_template_revisions
   where id = (v_published ->> 'revisionId')::uuid;
  select name into v_name from rail_templates where id = v_revision.template_id;

  update deals
     set rail_template_revision_id = v_revision.id,
         rail_template_name = v_name
   where id = p_deal_id;

  v_result := jsonb_build_object(
    'id', v_revision.template_id,
    'revisionId', v_revision.id,
    'name', v_name,
    'description', v_revision.description,
    'stepCount', v_published -> 'stepCount',
    'skillCount', v_published -> 'skillCount',
    'version', v_published -> 'version',
    'updatedAt', to_char(v_revision.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));

  insert into audit_log (actor_id, action, deal_id, detail)
  values (
    p_actor_id,
    case when v_kind = 'new' then 'rail.template_created' else 'rail.template_replaced' end,
    p_deal_id,
    jsonb_strip_nulls(jsonb_build_object(
      'requestId', p_request_id,
      'catalogTemplateId', v_catalog,
      'templateId', v_revision.template_id,
      'revisionId', v_revision.id,
      'previousRevisionId', v_revision.expected_revision_id,
      'companyId', p_company_id,
      'stepCount', v_published -> 'stepCount',
      'skillCount', v_published -> 'skillCount',
      'version', v_published -> 'version',
      'result', v_result)));

  return v_result;
end;
$$;

revoke all on function save_rail_to_catalog(uuid, uuid, uuid, uuid, jsonb, text, jsonb, text, text[], uuid, jsonb)
  from public, anon, authenticated;
grant execute on function save_rail_to_catalog(uuid, uuid, uuid, uuid, jsonb, text, jsonb, text, text[], uuid, jsonb)
  to service_role;
