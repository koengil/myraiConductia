-- supabase/tests/public_rls_coverage.sql
-- Every table in schema `public` has row level security on (review of #230,
-- where legal_holds was found without it). Run via psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/public_rls_coverage.sql
-- A table with RLS on and no policy is deny-all for anon and authenticated,
-- which is the right default for a service-role-only table. A table with RLS
-- off is readable through /rest/v1/* by any role holding a grant on it, so a
-- default ACL change is all it takes to expose it.
-- Tables an extension owns (pg_depend deptype 'e') are left out, as in
-- scripts/lib/schemaCatalog.ts: they belong to however the platform installed
-- the extension, not to a migration.
-- Wrapped in a transaction that always ROLLBACKs. Raises (and, with
-- ON_ERROR_STOP, exits non-zero) listing every table without RLS.

begin;

do $$
declare
  v_missing text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into v_missing
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and not c.relrowsecurity
     and not exists (
       select 1 from pg_depend d
        where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e');

  if v_missing is not null then
    raise exception 'FAIL: public tables without row level security: %', v_missing;
  end if;

  raise notice 'PASS: every public table has row level security on';
end $$;

rollback;
