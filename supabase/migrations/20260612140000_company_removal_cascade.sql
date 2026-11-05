-- Migration: company-removal cascade (D33 / S2)
-- Membership = users.company_id. "Remove a member from the company" = clear
-- company_id (set it NULL). When a user's company_id is cleared (or moved to a
-- different company), drop ALL their deal seats so access cannot outlive
-- company membership.
--
-- A user belongs to exactly one company (1 email = 1 account), so deleting all
-- their deal_memberships is company-scoped by construction; a consultant
-- engaged elsewhere holds a SEPARATE account there and is unaffected.
--
-- status (active|suspended) is an ORTHOGONAL, reversible access freeze: it does
-- NOT cascade. A suspended user keeps their seats but is denied access at the
-- auth/RLS layer. Seats are hard-deleted; the compliance trail lives in
-- audit_log (the API writes a 'revoke' row per dropped seat). This is the DB
-- belt; the API adds actor + audit + the self-removal (S3) guard.

-- Remove the earlier suspend-based function (superseded by company-removal).
drop trigger if exists cascade_revoke_membership on users;
drop function if exists cascade_revoke_on_suspend();

create or replace function cascade_revoke_on_company_removal()
returns trigger
language plpgsql
as $$
begin
  if old.company_id is not null
     and new.company_id is distinct from old.company_id then
    delete from deal_memberships where user_id = new.id;
  end if;
  return null; -- AFTER trigger
end;
$$;

create trigger cascade_revoke_membership
  after update of company_id on users
  for each row execute function cascade_revoke_on_company_removal();
