-- Rollback for 20260930170000_legal_holds_rls.sql.
--
-- Turns row level security off on legal_holds and restores the PUBLIC execute
-- the three functions had from Postgres itself when 20260629120000 created
-- them. The forward migration changes no table grant (those were closed by
-- 20260929170000), so none is touched here. The service_role execute grants
-- are left in place; they are redundant with PUBLIC and harmless.
--
-- This rollback REOPENS /rest/v1/rpc/place_legal_hold, lift_legal_hold and
-- deal_is_under_hold to the publishable key, guarded only by the table
-- privileges, which 20260929170000 keeps closed to anon and authenticated. Apply it only to recover
-- from a broken forward migration, and re-apply the forward migration as soon
-- as possible.

begin;

alter table legal_holds disable row level security;

grant execute on function place_legal_hold(uuid, uuid, text) to public;
grant execute on function lift_legal_hold(uuid, uuid) to public;
grant execute on function deal_is_under_hold(uuid) to public;

commit;
