-- #233: close SECURITY DEFINER functions to the publishable key.
--
-- Supabase's default privileges grant EXECUTE on every new public function
-- directly to anon and authenticated, not through PUBLIC, so the migrations'
-- `revoke ... from public` left most definer functions callable through
-- /rest/v1/rpc by anyone holding the browser key. Several trust a
-- caller-supplied actor id.
--
-- Every definer function in public is now service_role only, except the ones
-- the calling role genuinely evaluates:
--   * the RLS helpers the `to authenticated` policies call;
--   * accept_invite and verify_invite_challenge, which the invite routes call
--     with the user's session and which derive the user from auth.uid().
-- anon keeps nothing. supabase/tests/definer_grants.sql holds this line in CI;
-- a function joining the allowlist must be added there too.

do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

grant execute on function
  app_is_overseer(uuid),
  app_user_tenant(uuid),
  app_user_company(uuid),
  app_is_deal_member(uuid, uuid),
  app_is_deal_md(uuid, uuid),
  app_user_is_director(uuid),
  app_has_company_permission(uuid, uuid, text),
  app_company_is_access_root(uuid, uuid),
  app_is_control_room(uuid),
  app_owns_item(uuid, uuid),
  app_can_see_candidate(uuid, uuid),
  app_can_see_item(uuid, uuid),
  app_is_deal_overseer(uuid, uuid),
  app_user_is_external(uuid),
  app_actor_in_user_tenant(uuid, uuid),
  accept_invite(uuid, uuid),
  verify_invite_challenge(uuid, uuid, text)
to authenticated;

-- New functions start closed to the browser roles. Two defaults grant them
-- EXECUTE: Supabase's per-schema grant to anon/authenticated, and Postgres's
-- built-in grant to PUBLIC, which both roles inherit. The PUBLIC one is global,
-- so it can only be revoked without IN SCHEMA. A function the browser needs
-- must now be granted explicitly.
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges revoke execute on functions from public;

-- Tables with RLS on and no policy are service_role only by intent, but the
-- default table grants were never revoked, and TRUNCATE ignores RLS.
-- legal_holds has no RLS at all and is read only by the admin client.
do $$
declare
  tbl regclass;
begin
  for tbl in
    select c.oid::regclass
    from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relkind = 'r'
      and c.relrowsecurity
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
  loop
    execute format('revoke all on table %s from public, anon, authenticated', tbl);
  end loop;
end
$$;

revoke all on table legal_holds from public, anon, authenticated;

-- TRUNCATE ignores RLS, so a table with policies is still wiped by any
-- signed-in caller holding the default grant. No client ever truncates.
do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as tbl
    from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
  loop
    execute format('revoke truncate on table %s from public, anon, authenticated', r.tbl);
  end loop;
end
$$;

alter default privileges in schema public revoke truncate on tables from anon, authenticated;
