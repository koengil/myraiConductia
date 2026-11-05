-- #200 (review of #292, follow-up from #249): rail_skip_step closes a step the
-- same way deal_step_save does, so the two cannot overwrite each other.
--
-- 1. A skip refuses any closed step (complete, skipped, skipped_entry), not only
--    a completed one. deal_step_save refuses a completion or skip of a closed
--    step for the same reason; both take the per-deal lock first, so whichever
--    commits second is refused instead of flipping the first one's outcome.
-- 2. The skip bumps updated_at. It rewrites `work` (work.skip), and the work
--    compare-and-set in deal_step_save keys on updated_at: without the bump a
--    stale work save merged onto the pre-skip row and erased work.skip.
--
-- Re-declares the function from 20260916100000_project_rail_model.sql with
-- only those two changes.

create or replace function rail_skip_step(
  p_deal_id     uuid,
  p_actor_id    uuid,
  p_step_id     uuid,
  p_approver_id uuid,
  p_reason      text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_step     deal_steps;
  v_current  uuid;
  v_approver text;
  v_role     text;
begin
  perform 1 from deals where id = p_deal_id for update;
  if not found then
    raise exception 'deal % not found', p_deal_id using errcode = 'P0001';
  end if;

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a skip reason is required' using errcode = 'P0001';
  end if;

  select * into v_step from deal_steps where id = p_step_id and deal_id = p_deal_id;
  if v_step.id is null or v_step.removed_at is not null then
    raise exception 'step % not available on deal %', p_step_id, p_deal_id using errcode = 'P0001';
  end if;
  -- A step that is already closed stays closed: a completion that won the
  -- deal lock first is not overwritten into a skip, and a second skip does
  -- not stack a second record.
  if v_step.status in ('complete', 'skipped', 'skipped_entry') then
    raise exception 'step_closed' using errcode = 'P0003';
  end if;

  -- The approver's name and deal role, not only the id: `work.skip` carries the
  -- text the readers render (skipOf in /api/v1/deals/{dealId}/step-records),
  -- in the shape develop's PATCH /steps { skip } writes.
  select coalesce(nullif(btrim(u.display_name), ''), nullif(btrim(u.full_name), ''), u.email),
         m.deal_role
    into v_approver, v_role
    from users u
    left join deal_memberships m on m.user_id = u.id and m.deal_id = p_deal_id
   where u.id = p_approver_id;

  update deal_steps
     set status = 'skipped', skipped_at = now(), skipped_by = p_actor_id,
         skip_approver_id = p_approver_id, skip_reason = btrim(p_reason),
         completed_by = p_actor_id, completed_at = now(), completion_note = btrim(p_reason),
         updated_at = now(),
         work = coalesce(work, '{}'::jsonb) || jsonb_build_object('skip', jsonb_build_object(
           'approver', coalesce(v_approver, ''), 'approverRole', coalesce(v_role, ''),
           'reason', btrim(p_reason),
           'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
   where id = p_step_id;

  select current_deal_step_id into v_current from deals where id = p_deal_id;
  if v_current = p_step_id then
    v_current := rail_reselect_current(p_deal_id, p_actor_id, v_step);
  end if;

  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'update', p_deal_id,
            jsonb_build_object('rail', 'skip', 'stepId', p_step_id,
                               'stepKey', v_step.step_id, 'title', v_step.definition->>'title',
                               'approver', p_approver_id, 'reason', btrim(p_reason)));

  return jsonb_build_object('currentStepId', v_current);
end;
$$;

revoke all on function rail_skip_step(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function rail_skip_step(uuid, uuid, uuid, uuid, text) to service_role;
