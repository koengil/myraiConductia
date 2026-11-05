-- supabase/migrations/20261021150000_reader_helpers_plan_cache.sql
-- The three reader-registration helpers become PL/pgSQL, with their queries unchanged, so a member's
-- deal email at ~2k links stops paying a fresh plan for each of them on every link.
--
-- Why: 20261019160000 made app_owns_item PL/pgSQL because a non-inlined SQL function called from inside
-- another function's executor is parsed and planned afresh on every call (Postgres 17 keeps a SQL
-- function's plan in the calling expression's FmgrInfo, which lives only as long as that executor). The
-- same thing still happens one level down. app_owns_item's cached plan expands allowed_team_mailboxes,
-- whose lateral calls mailbox_reader_providers, which calls reader_mailbox_domains and
-- reader_firm_company_ids once per provider. Every execution of app_owns_item's statement starts a new
-- executor, so those three security definer SQL functions (up to five calls) were planned again on every
-- app_owns_item call. The member's deal email makes about three app_owns_item calls per link (the
-- evidence_links policy, then discovery_item_metadata's `own` and its app_can_see_item), ~6,000 for the
-- 2,000-link test, and CI measured that request at 10.5 to 14.5 s when it passed and 16.7 to 45.6 s when
-- it failed (tests/integration/team-mailbox-visibility.test.ts, budget 15 s). allowed_mailboxes calls
-- mailbox_reader_providers the same way, so every personal-mailbox test of app_owns_item and
-- app_item_has_allowed_source pays it too.
--
-- PL/pgSQL keeps each statement's plan for the session, whoever calls it. Nothing else changes: the same
-- signatures, return types, volatility (stable), security definer, the pinned search_path
-- (20261016100000; create or replace resets the configuration to what it states), and the same queries,
-- so the same answers for every input, NULLs included (each query is an aggregate over no GROUP BY and
-- returns exactly one row, so `return (select ...)` returns what the SQL body returned). create or replace
-- keeps the owner and the grants. Bodies restated from their latest definitions:
--   mailbox_reader_providers   20261001130000_mailbox_allowlist.sql
--   reader_mailbox_domains     20261002180000_discovery_google_sources.sql
--   reader_firm_company_ids    20261002180000_discovery_google_sources.sql
--
-- Reverse: restate the three bodies above as `language sql` from those files, with
-- `set search_path = public, pg_temp`.

create or replace function reader_mailbox_domains(p_tenant_id uuid, p_provider text)
returns text[] language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return (
    select coalesce(array_agg(distinct d), '{}'::text[]) from (
      select lower(x) as d from graph_reader_registrations r, unnest(r.mailbox_domains) as x
       where p_provider = 'microsoft' and r.tenant_id = p_tenant_id and r.status = 'active'
      union all
      select g.workspace_domain from google_reader_registrations g
       where p_provider = 'google' and g.tenant_id = p_tenant_id and g.status = 'active'
    ) domains);
end;
$$;

-- Only a same-tenant company of type 'bank' counts, for either provider.
create or replace function reader_firm_company_ids(p_tenant_id uuid, p_provider text)
returns uuid[] language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return (
    select coalesce(array_agg(distinct c.id), '{}'::uuid[]) from (
      select r.firm_company_id, r.tenant_id from graph_reader_registrations r
       where p_provider = 'microsoft' and r.tenant_id = p_tenant_id and r.status = 'active'
      union all
      select g.firm_company_id, g.tenant_id from google_reader_registrations g
       where p_provider = 'google' and g.tenant_id = p_tenant_id and g.status = 'active'
    ) reg
    join companies c on c.id = reg.firm_company_id and c.tenant_id = reg.tenant_id and c.type = 'bank');
end;
$$;

create or replace function mailbox_reader_providers(p_tenant_id uuid, p_address text, p_company_id uuid)
returns text[] language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return (
    select coalesce(array_agg(p.provider order by p.provider), '{}'::text[])
    from unnest(array['microsoft', 'google']) as p(provider)
    where split_part(lower(coalesce(p_address, '')), '@', 2) = any (reader_mailbox_domains(p_tenant_id, p.provider))
      and p_company_id = any (reader_firm_company_ids(p_tenant_id, p.provider)));
end;
$$;
