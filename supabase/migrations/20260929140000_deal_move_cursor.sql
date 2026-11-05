-- #249: a rail move and its audit row commit together. The progress route
-- used to update deals.current_step_seq, insert the audit row, and undo the
-- move by hand when the insert failed; that undo could not tell its own write
-- from a later request that moved to the same step. In one function, a
-- rejected audit insert rolls the move back with it.
create or replace function deal_move_cursor(
  p_deal_id  uuid,
  p_actor_id uuid,
  p_step_id  uuid,
  p_from_seq int,
  p_to_seq   int
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update deals
     set current_step_seq = p_to_seq, current_deal_step_id = p_step_id
   where id = p_deal_id;
  if not found then
    raise exception 'deal % not found', p_deal_id using errcode = 'P0001';
  end if;

  insert into audit_log (actor_id, action, deal_id, detail)
  values (p_actor_id, 'advance', p_deal_id,
          jsonb_build_object('from', p_from_seq, 'to', p_to_seq));
end;
$$;

revoke all on function deal_move_cursor(uuid, uuid, uuid, int, int) from public, anon, authenticated;
grant execute on function deal_move_cursor(uuid, uuid, uuid, int, int) to service_role;
