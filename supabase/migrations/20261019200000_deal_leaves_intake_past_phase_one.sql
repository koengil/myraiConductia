create or replace function deal_leaves_intake_past_phase_one()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (
    select 1 from deal_steps s
     where s.id = new.current_deal_step_id and s.phase_index > 1
  ) then
    new.status := 'active';
  end if;
  return new;
end;
$$;

revoke all on function deal_leaves_intake_past_phase_one() from public, anon, authenticated;

drop trigger if exists deals_leave_intake_past_phase_one on deals;
create trigger deals_leave_intake_past_phase_one
  before update of current_deal_step_id on deals
  for each row
  when (old.status = 'intake' and new.status = 'intake' and new.current_deal_step_id is not null)
  execute function deal_leaves_intake_past_phase_one();

update deals d
   set status = case d.lifecycle_category
                  when 'closed' then 'closed'
                  when 'terminated' then 'closed'
                  when 'lost' then 'closed'
                  when 'mandate_hold' then 'paused'
                  else 'active'
                end
  from deal_steps s
 where s.id = d.current_deal_step_id
   and s.phase_index > 1
   and d.status = 'intake';
