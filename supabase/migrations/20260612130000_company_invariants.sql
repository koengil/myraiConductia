-- Migration: company membership invariants (D33 / S4)
-- Enforces the hard, actor-independent rule at the DB so it holds regardless of
-- caller: a company that still has active members must retain at least one
-- active director.
--
-- A company "has members" iff some active users.company_id points at it, so
-- referenced-only deal parties (no accounts) are unaffected. Removing the last
-- director is allowed only once the company has no other active members.
--
-- NOT here: "no self-removal" (S3) depends on the acting user, which is not
-- reliably available in a trigger when writes come through the service-role
-- admin client (auth.uid() is null). S3 is enforced in the API layer.

create or replace function check_company_has_director(p_company uuid)
returns void
language plpgsql
as $$
begin
  if p_company is null then
    return;
  end if;

  if exists (
    select 1 from users
    where company_id = p_company and status = 'active'
  ) and not exists (
    select 1 from users
    where company_id = p_company and status = 'active' and company_role = 'director'
  ) then
    raise exception 'Company % must retain at least one active director', p_company
      using errcode = 'check_violation';
  end if;
end;
$$;

create or replace function enforce_company_has_director()
returns trigger
language plpgsql
as $$
begin
  -- Check the company losing a director (update/delete) and the one gaining a
  -- member (insert/update), so a move between companies is validated on both ends.
  if tg_op in ('UPDATE', 'DELETE') then
    perform check_company_has_director(old.company_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform check_company_has_director(new.company_id);
  end if;
  return null; -- AFTER trigger: return value ignored; a raised exception rolls back.
end;
$$;

drop trigger if exists company_has_director on users;
create trigger company_has_director
  after insert or update or delete on users
  for each row execute function enforce_company_has_director();
