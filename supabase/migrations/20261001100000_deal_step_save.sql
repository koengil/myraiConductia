-- #200 (PL-08): a step write, its audit rows and the rail advance commit
-- together. The step route used to update deal_steps, then insert the audit
-- rows and advance the rail as separate writes whose errors went unchecked,
-- so a failure between them left an audit trail claiming a change that never
-- landed, or a completed step with the rail still parked on it. In one
-- function, a rejected audit insert rolls the step write and the advance back.
--
-- p_patch carries the deal_steps columns the route sets (assignment, work,
-- bench session, completion or skip); columns it omits keep their value.
-- p_expected_updated_at is the compare-and-set on a work save (#249): when it
-- no longer matches, or the step left the rail meanwhile, or a completion or
-- skip finds the step already closed (a concurrent skip or completion won the
-- deal lock first), the function raises SQLSTATE P0409, which the route
-- answers with 409.
-- p_advance promotes the next unfinished step on the rail to current and
-- moves the deal cursor onto it, writing the same `advance {from, to}` audit
-- row deal_move_cursor writes: the step completion owns that advance.
-- It only does so when the completed step is the deal's current one.
-- The function is new in this migration; dropping also permits replay of an
-- earlier, unmerged revision that returned only the step composite.
drop function if exists deal_step_save(uuid, uuid, uuid, jsonb, timestamptz, jsonb, boolean);
create function deal_step_save(
  p_deal_id             uuid,
  p_step_id             uuid,
  p_actor_id            uuid,
  p_patch               jsonb,
  p_expected_updated_at timestamptz,
  p_audits              jsonb,
  p_advance             boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_step  deal_steps;
  v_new   deal_steps;
  v_next  deal_steps;
  v_audit jsonb;
  v_from  int;
  v_cursor uuid;
begin
  -- The same per-deal lock the structural rail writes take.
  select current_deal_step_id into v_cursor from deals where id = p_deal_id for update;
  if not found then
    raise exception 'deal % not found', p_deal_id using errcode = 'P0001';
  end if;

  select * into v_step from deal_steps where id = p_step_id and deal_id = p_deal_id for update;
  if v_step.id is null then
    raise exception 'step % not found on deal %', p_step_id, p_deal_id using errcode = 'P0001';
  end if;
  -- Closed steps intentionally still accept work and assignment edits. Only
  -- another status transition is refused.
  if v_step.removed_at is not null
     or (p_expected_updated_at is not null and v_step.updated_at is distinct from p_expected_updated_at)
     or (p_patch ? 'status' and v_step.status in ('complete', 'skipped', 'skipped_entry')) then
    raise exception 'step_changed' using errcode = 'P0409';
  end if;

  v_new := jsonb_populate_record(v_step, p_patch);
  update deal_steps
     set assigned_to = v_new.assigned_to, assigned_by = v_new.assigned_by,
         assigned_at = v_new.assigned_at, work = v_new.work, status = v_new.status,
         completed_by = v_new.completed_by, completed_at = v_new.completed_at,
         completion_note = v_new.completion_note,
         bench_conversation_id = v_new.bench_conversation_id, bench_run_id = v_new.bench_run_id,
         bench_run_status = v_new.bench_run_status, bench_run_started_at = v_new.bench_run_started_at,
         updated_at = v_new.updated_at
   where id = v_step.id
  returning * into v_new;

  for v_audit in select * from jsonb_array_elements(coalesce(p_audits, '[]'::jsonb)) loop
    insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, v_audit->>'action', p_deal_id, coalesce(v_audit->'detail', '{}'::jsonb));
  end loop;

  -- Only completing the deal's current step moves the cursor: finishing a
  -- later step out of order must not drag the position past the current one.
  -- A deal with no recorded cursor falls back to the step's own status.
  if p_advance
     and (v_cursor = v_step.id or (v_cursor is null and v_step.status = 'current')) then
    -- The next unfinished step after this one: by display_order on the
    -- project rail, by seq on a deal whose rows carry none. Removed steps are
    -- never current; with nothing left the position stays where it is.
    select * into v_next from deal_steps
     where deal_id = p_deal_id
       and removed_at is null
       and status in ('pending', 'current')
       and case when v_step.display_order is not null then display_order > v_step.display_order
                else seq > v_step.seq end
     order by case when v_step.display_order is not null then display_order else seq end
     limit 1;

    if v_next.id is not null then
      select current_step_seq into v_from from deals where id = p_deal_id;
      update deal_steps set status = 'current', updated_at = now() where id = v_next.id;
      update deals
         set current_deal_step_id = v_next.id,
             current_step_seq = coalesce(v_next.seq, current_step_seq)
       where id = p_deal_id;

      insert into audit_log (actor_id, action, deal_id, detail)
      values (p_actor_id, 'advance', p_deal_id,
              jsonb_build_object('from', v_from, 'to', coalesce(v_next.seq, v_from),
                                 'fromStepId', v_step.id, 'toStepId', v_next.id));
    end if;
  end if;

  select current_deal_step_id into v_cursor from deals where id = p_deal_id;
  return jsonb_build_object('step', to_jsonb(v_new), 'currentStepId', v_cursor);
end;
$$;

revoke all on function deal_step_save(uuid, uuid, uuid, jsonb, timestamptz, jsonb, boolean) from public, anon, authenticated;
grant execute on function deal_step_save(uuid, uuid, uuid, jsonb, timestamptz, jsonb, boolean) to service_role;
