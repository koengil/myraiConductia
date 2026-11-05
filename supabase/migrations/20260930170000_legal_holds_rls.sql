-- Enable RLS on legal_holds and close its functions to every role but the
-- service role (review of #230).
--
-- 20260629120000_legal_hold.sql created legal_holds without row level security
-- and without revoking anything from anon or authenticated; it only granted
-- select, insert and update to service_role. It was the one table in `public`
-- with RLS off. Its three functions, place_legal_hold, lift_legal_hold and
-- deal_is_under_hold, are security invoker and kept the default PUBLIC
-- execute, so /rest/v1/rpc/* would accept a call from the publishable key.
--
-- 20260929170000_close_definer_function_grants.sql already revoked every
-- table privilege on legal_holds from public, anon and authenticated, and
-- supabase/tests/definer_grants.sql asserts it. It did not enable RLS, and it
-- left the three functions alone: they are security invoker, so its
-- prosecdef loop skipped them, and its default-privileges revoke only covers
-- functions created after it. This migration adds the two missing pieces: RLS
-- on the table and execute on the functions for service_role only.
-- public_rls_coverage.sql keeps the next table from landing with RLS off.
--
-- Callers checked: only the three block_* trigger functions from
-- 20260629120000 call deal_is_under_hold or read legal_holds, and no later
-- migration redefines or calls any of them. The triggers run as the role that
-- deletes or truncates a deal or document. authenticated holds no delete on
-- deals or documents and no delete policy exists, so in practice that role is
-- service_role (granted below) or the owner. Were anon or authenticated ever
-- to reach one, the guard now fails with a permission error, which still
-- blocks the delete. The app places and lifts holds only through the service
-- role; nothing in src/ reads the table.
--
-- RLS on with no policy is deny-all for every role without BYPASSRLS; the
-- service role bypasses it, so the existing grants keep working unchanged.
-- Idempotent: safe to re-run.
--
-- Rollback: supabase/rollback/20260930170000_legal_holds_rls_down.sql

alter table legal_holds enable row level security;

revoke all on function place_legal_hold(uuid, uuid, text) from public, anon, authenticated;
revoke all on function lift_legal_hold(uuid, uuid) from public, anon, authenticated;
revoke all on function deal_is_under_hold(uuid) from public, anon, authenticated;

grant execute on function place_legal_hold(uuid, uuid, text) to service_role;
grant execute on function lift_legal_hold(uuid, uuid) to service_role;
grant execute on function deal_is_under_hold(uuid) to service_role;
