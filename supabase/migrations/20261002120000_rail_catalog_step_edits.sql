-- Add and remove steps on a saved rail template. The house default is not a
-- row, so these functions only touch rail_catalog_templates. display_order is unique
-- per template, so shifts go through negative values before settling.

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
  v_step rail_catalog_steps;
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

revoke all on function remove_rail_template_step(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function remove_rail_template_step(uuid, uuid, uuid, uuid) to service_role;

create or replace function add_rail_template_step(
  p_company_id  uuid,
  p_actor_id    uuid,
  p_template_id uuid,
  p_step_id     text,
  p_seq         int,
  p_phase_index int,
  p_origin      text,
  p_definition  jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_at        int;
  v_phase_end int;
  v_id        uuid;
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
      select coalesce(max(display_order), 0) + 1 into v_at
        from rail_catalog_steps
       where template_id = p_template_id;
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
  returning id into v_id;

  insert into audit_log (actor_id, action, detail)
    values (
      p_actor_id,
      'update',
      jsonb_build_object(
        'railTemplate', p_template_id,
        'rail', 'add',
        'stepId', v_id,
        'stepKey', p_step_id,
        'title', p_definition->>'title'
      )
    );

  return jsonb_build_object('id', v_id, 'stepId', p_step_id, 'displayOrder', v_at);
end;
$$;

revoke all on function add_rail_template_step(uuid, uuid, uuid, text, int, int, text, jsonb)
  from public, anon, authenticated;
grant execute on function add_rail_template_step(uuid, uuid, uuid, text, int, int, text, jsonb) to service_role;
