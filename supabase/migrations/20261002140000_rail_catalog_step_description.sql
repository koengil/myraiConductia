-- Save context on one template step. The write stays on rail_catalog_steps
-- and does not touch deal_steps.

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
  v_step        rail_catalog_steps;
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

  update rail_catalog_steps
     set definition = coalesce(definition, '{}'::jsonb) || jsonb_build_object('description', v_description)
   where id = p_step_row_id and template_id = p_template_id
   returning * into v_step;

  if v_step.id is null then
    raise exception 'template_step_missing' using errcode = 'P0003';
  end if;

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

revoke all on function set_rail_template_step_description(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function set_rail_template_step_description(uuid, uuid, uuid, uuid, text) to service_role;
