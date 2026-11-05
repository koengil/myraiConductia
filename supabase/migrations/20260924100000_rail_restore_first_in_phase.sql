create or replace function rail_restore_step(
  p_deal_id  uuid,
  p_actor_id uuid,
  p_step_id  uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_step    deal_steps;
  v_after   int;
  v_old     int;
  v_current uuid;
begin
  perform 1 from deals where id = p_deal_id for update;
  if not found then
    raise exception 'deal % not found', p_deal_id using errcode = 'P0001';
  end if;

  select * into v_step from deal_steps where id = p_step_id and deal_id = p_deal_id;
  if v_step.id is null then
    raise exception 'step % not found on deal %', p_step_id, p_deal_id using errcode = 'P0001';
  end if;

  select current_deal_step_id into v_current from deals where id = p_deal_id;
  if v_step.removed_at is null then
    return jsonb_build_object('restored', false);
  end if;

  v_old := v_step.display_order;

  update deal_steps set display_order = display_order - 1
    where deal_id = p_deal_id and display_order > v_old;

  if v_step.anchor_step_id is null then
    select coalesce(max(display_order), 0) into v_after from deal_steps
      where deal_id = p_deal_id and removed_at is null and phase_index < v_step.phase_index;
  else
    select display_order into v_after from deal_steps
      where id = v_step.anchor_step_id and deal_id = p_deal_id and removed_at is null;

    if v_after is null then
      select coalesce(max(display_order), 0) into v_after from deal_steps
        where deal_id = p_deal_id and removed_at is null and phase_index <= v_step.phase_index;
    end if;
  end if;

  update deal_steps set display_order = display_order + 1
    where deal_id = p_deal_id and display_order > v_after;

  update deal_steps
     set removed_at = null, removed_by = null, display_order = v_after + 1
   where id = p_step_id;

  if v_step.status = 'current' then
    if v_current is null then
      update deals
         set current_deal_step_id = p_step_id,
             current_step_seq = coalesce(v_step.seq, current_step_seq)
       where id = p_deal_id;

      insert into audit_log (actor_id, action, deal_id, detail)
        values (p_actor_id, 'advance', p_deal_id,
                jsonb_build_object('from', null::int, 'to', v_step.seq,
                                   'fromStepKey', null::text, 'toStepKey', v_step.step_id,
                                   'fromTitle', null::text, 'toTitle', v_step.definition->>'title'));
    elsif v_current <> p_step_id then
      update deal_steps set status = 'pending' where id = p_step_id;
    end if;
  end if;

  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'update', p_deal_id,
            jsonb_build_object('rail', 'restore', 'stepId', p_step_id,
                               'stepKey', v_step.step_id, 'title', v_step.definition->>'title'));

  return jsonb_build_object('restored', true);
end;
$$;

revoke all on function rail_restore_step(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function rail_restore_step(uuid, uuid, uuid) to service_role;
