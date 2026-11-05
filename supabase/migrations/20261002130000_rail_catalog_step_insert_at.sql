-- Insert a template step at a chosen position. The previous function placed
-- every new step at the end of its phase.

drop function if exists add_rail_template_step(uuid, uuid, uuid, text, int, int, text, jsonb);

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

revoke all on function add_rail_template_step(uuid, uuid, uuid, text, int, int, text, jsonb, int)
  from public, anon, authenticated;
grant execute on function add_rail_template_step(uuid, uuid, uuid, text, int, int, text, jsonb, int) to service_role;
