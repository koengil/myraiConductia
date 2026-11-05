-- #312: every SECURITY DEFINER function in public pins
-- `search_path = public, pg_temp`.
--
-- All of them already pinned `public`, but without `pg_temp` listed Postgres
-- searches the session's temp schema FIRST for tables, views and types, so a
-- caller's temp table could shadow a public one inside a definer. Writing
-- pg_temp last is the form the Postgres docs give ("Writing SECURITY DEFINER
-- Functions Safely"). No API role can create temp tables today, so this sets
-- the convention rather than closing an exploit.
--
-- ALTER FUNCTION ... SET edits the one proconfig entry: lock_timeout on the
-- discovery corrections, the owner and the ACL (the #233 grant closure) are
-- kept. A path that is neither `public` nor `public, pg_temp` is not
-- overwritten. One exception is known: hosted Supabase adds its own definer
-- rls_auto_enable() to `public` with search_path=pg_catalog. No migration
-- creates it, so it is left alone with a notice. Any other unexpected path,
-- or a definer with no search_path, still stops the migration so it is fixed
-- by hand. supabase/tests/definer_grants.sql stays strict: it runs only on
-- CI's local stack, where that platform function does not exist.
--
-- supabase/tests/definer_grants.sql uses the same predicate and fails CI on
-- any definer without the pinned path, including one a later
-- `create or replace` resets. New definers spell it
-- `set search_path = public, pg_temp`.
--
-- Reverse: the same loop over definers holding 'search_path=public, pg_temp',
-- running `alter function %s set search_path = public` (ai_budget_check
-- shipped with `public, pg_temp` and keeps it).
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proconfig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prosecdef
      and p.prokind = 'f'
      and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
      and not coalesce(p.proconfig, '{}'::text[]) @> array['search_path=public, pg_temp']
  loop
    if coalesce(f.proconfig, '{}'::text[]) @> array['search_path=public'] then
      execute format('alter function %s set search_path = public, pg_temp', f.sig);
    elsif f.sig::text = 'rls_auto_enable()'
      and coalesce(f.proconfig, '{}'::text[]) @> array['search_path=pg_catalog'] then
      raise notice 'leaving hosted Supabase''s definer % alone (search_path %)', f.sig, f.proconfig;
    else
      raise exception 'definer % has an unexpected search_path %; fix it by hand', f.sig, f.proconfig;
    end if;
  end loop;
end
$$;
