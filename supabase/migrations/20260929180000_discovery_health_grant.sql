-- The admin and control room's ingestion health view
-- (20260925150000_discovery_health) is called with the user's session, so
-- authenticated must execute it. 20260929170000_close_definer_function_grants
-- sorts after that migration and revoked the grant with every other definer
-- function outside its allowlist; a fresh replay left the admin with 42501.
--
-- The function derives the caller from auth.uid() and refuses anyone but a
-- firm admin or the control room of their own tenant, so the grant exposes
-- nothing to other signed-in users. anon keeps nothing.
-- supabase/tests/definer_grants.sql allowlists it.

revoke all on function discovery_ingestion_health() from public, anon;
grant execute on function discovery_ingestion_health() to authenticated, service_role;
