-- History of template edits. Undoing a change writes a new change that
-- reverses it. Deal rails are not involved.

create table if not exists rail_catalog_changes (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references rail_catalog_templates (id) on delete cascade,
  company_id  uuid not null references companies (id) on delete cascade,
  actor_id    uuid not null references users (id),
  created_at  timestamptz not null default now(),
  action      text not null,
  summary     text not null,
  before      jsonb,
  after       jsonb,
  undoes_id   uuid references rail_catalog_changes (id),
  constraint rail_catalog_changes_action_check
    check (action in ('add_step', 'remove_step', 'set_description'))
);

create index if not exists rail_catalog_changes_template_idx
  on rail_catalog_changes (template_id, created_at desc);

alter table rail_catalog_changes enable row level security;
revoke all on rail_catalog_changes from public, anon, authenticated;
grant select, insert on rail_catalog_changes to service_role;

create or replace function rail_template_step_snapshot(p_step rail_catalog_steps)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'stepRowId', p_step.id,
    'stepId', p_step.step_id,
    'seq', p_step.seq,
    'phaseIndex', p_step.phase_index,
    'displayOrder', p_step.display_order,
    'origin', p_step.origin,
    'definition', p_step.definition,
    'title', coalesce(nullif(btrim(p_step.definition->>'title'), ''), p_step.step_id)
  );
$$;

create or replace function record_rail_template_change(
  p_template_id uuid,
  p_company_id  uuid,
  p_actor_id    uuid,
  p_action      text,
  p_summary     text,
  p_before      jsonb,
  p_after       jsonb,
  p_undoes_id   uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into rail_catalog_changes (
    template_id, company_id, actor_id, action, summary, before, after, undoes_id
  ) values (
    p_template_id, p_company_id, p_actor_id, p_action, p_summary, p_before, p_after, p_undoes_id
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function record_rail_template_change(uuid, uuid, uuid, text, text, jsonb, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function record_rail_template_change(uuid, uuid, uuid, text, text, jsonb, jsonb, uuid)
  to service_role;

create or replace function add_rail_template_step(
  p_company_id  uuid,
  p_actor_id    uuid,
  p_template_id uuid,
  p_step_id     text,
  p_seq         int,
  p_phase_index int,
  p_origin      text,
  p_definition  jsonb,
  p_at          int default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_at        int;
  v_phase_end int;
  v_limit     int;
  v_id        uuid;
  v_step      rail_catalog_steps;
  v_title     text;
begin
  perform 1 from rail_catalog_templates
    where id = p_template_id and company_id = p_company_id
    for update;
  if not found then
    raise exception 'template_missing' using errcode = 'P0003';
  end if;

  if coalesce(btrim(p_step_id), '') = '' or p_origin not in ('catalog', 'custom') then
    raise exception 'template_step' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from rail_catalog_steps
    where template_id = p_template_id and step_id = p_step_id
  ) then
    raise exception 'template_step_taken' using errcode = 'P0002';
  end if;

  select coalesce(max(display_order), 0) + 1 into v_limit
    from rail_catalog_steps
   where template_id = p_template_id;

  if p_at is not null then
    if p_at < 1 then
      raise exception 'template_step' using errcode = 'P0001';
    end if;
    v_at := least(p_at, v_limit);
  else
    select max(display_order) into v_phase_end
      from rail_catalog_steps
     where template_id = p_template_id and phase_index = p_phase_index;

    if v_phase_end is not null then
      v_at := v_phase_end + 1;
    else
      select min(display_order) into v_at
        from rail_catalog_steps
       where template_id = p_template_id and phase_index > p_phase_index;
      if v_at is null then
        v_at := v_limit;
      end if;
    end if;
  end if;

  update rail_catalog_steps
     set display_order = -display_order
   where template_id = p_template_id and display_order >= v_at;

  update rail_catalog_steps
     set display_order = -display_order + 1
   where template_id = p_template_id and display_order < 0;

  insert into rail_catalog_steps (
    template_id, step_id, seq, phase_index, display_order, origin, definition
  ) values (
    p_template_id,
    p_step_id,
    p_seq,
    p_phase_index,
    v_at,
    p_origin,
    case when p_definition = 'null'::jsonb then null else p_definition end
  )
  returning * into v_step;

  v_id := v_step.id;
  v_title := coalesce(nullif(btrim(v_step.definition->>'title'), ''), v_step.step_id);

  perform record_rail_template_change(
    p_template_id, p_company_id, p_actor_id, 'add_step',
    format('Added "%s"', v_title),
    null,
    rail_template_step_snapshot(v_step),
    null
  );

  insert into audit_log (actor_id, action, detail)
    values (
      p_actor_id,
      'update',
      jsonb_build_object(
        'railTemplate', p_template_id,
        'rail', 'add',
        'stepId', v_id,
        'stepKey', p_step_id,
        'title', v_title
      )
    );

  return jsonb_build_object('id', v_id, 'stepId', p_step_id, 'displayOrder', v_at);
end;
$$;

create or replace function remove_rail_template_step(
  p_company_id  uuid,
  p_actor_id    uuid,
  p_template_id uuid,
  p_step_row_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_step  rail_catalog_steps;
  v_title text;
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

  if (select count(*) from rail_catalog_steps where template_id = p_template_id) <= 1 then
    raise exception 'template_last_step' using errcode = 'P0004';
  end if;

  v_title := coalesce(nullif(btrim(v_step.definition->>'title'), ''), v_step.step_id);

  delete from rail_catalog_steps where id = p_step_row_id;

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
    null
  );

  insert into audit_log (actor_id, action, detail)
    values (
      p_actor_id,
      'update',
      jsonb_build_object(
        'railTemplate', p_template_id,
        'rail', 'remove',
        'stepId', p_step_row_id,
        'stepKey', v_step.step_id
      )
    );

  return jsonb_build_object('removed', true, 'stepId', p_step_row_id);
end;
$$;

create or replace function set_rail_template_step_description(
  p_company_id  uuid,
  p_actor_id    uuid,
  p_template_id uuid,
  p_step_row_id uuid,
  p_description text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_description text := btrim(coalesce(p_description, ''));
  v_previous    text;
  v_step        rail_catalog_steps;
  v_title       text;
  v_before      jsonb;
begin
  perform 1 from rail_catalog_templates
    where id = p_template_id and company_id = p_company_id
    for update;
  if not found then
    raise exception 'template_missing' using errcode = 'P0003';
  end if;

  if char_length(v_description) > 4000 then
    raise exception 'template_step' using errcode = 'P0001';
  end if;

  select * into v_step from rail_catalog_steps
    where id = p_step_row_id and template_id = p_template_id;
  if v_step.id is null then
    raise exception 'template_step_missing' using errcode = 'P0003';
  end if;

  v_previous := coalesce(v_step.definition->>'description', '');
  v_title := coalesce(nullif(btrim(v_step.definition->>'title'), ''), v_step.step_id);
  v_before := rail_template_step_snapshot(v_step) || jsonb_build_object('description', v_previous);

  update rail_catalog_steps
     set definition = coalesce(definition, '{}'::jsonb) || jsonb_build_object('description', v_description)
   where id = p_step_row_id
   returning * into v_step;

  perform record_rail_template_change(
    p_template_id, p_company_id, p_actor_id, 'set_description',
    format('Updated the description of "%s"', v_title),
    v_before,
    rail_template_step_snapshot(v_step) || jsonb_build_object('description', v_description),
    null
  );

  insert into audit_log (actor_id, action, detail)
    values (
      p_actor_id,
      'update',
      jsonb_build_object(
        'railTemplate', p_template_id,
        'rail', 'describe',
        'stepId', p_step_row_id,
        'stepKey', v_step.step_id
      )
    );

  return jsonb_build_object('id', v_step.id, 'description', v_description);
end;
$$;

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
  else
    raise exception 'template_change' using errcode = 'P0001';
  end if;

  return jsonb_build_object('undone', p_change_id);
end;
$$;

revoke all on function undo_rail_template_change(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function undo_rail_template_change(uuid, uuid, uuid, uuid) to service_role;
