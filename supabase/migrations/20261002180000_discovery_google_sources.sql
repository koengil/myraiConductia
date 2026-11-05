-- supabase/migrations/20261002180000_discovery_google_sources.sql
-- Gmail reader (#259), phase 2. Admits Google sources next to Graph ones.
--  1. C14 (plan D1): content_sources no longer needs a Graph registration. There
--     is no tenants table, so each provider's rows reference that provider's
--     registration through a stored generated column, on delete restrict: a
--     registration with sources is disabled, never deleted, and deleting one
--     provider's registration never touches the other's sources.
--  2. C5: the google branch of #262's provider-aware registration functions.
--     A mailbox is checked against its own provider's registration only.
--  3. C15: firm_company_ids() is the union over both registration tables, so a
--     Google-only tenant keeps its control room and drift recipients.

-- 1. Foreign keys by provider -----------------------------------------------
alter table content_sources drop constraint if exists content_sources_tenant_id_fkey;
alter table content_sources
  add column if not exists ms_registration_tenant uuid
    generated always as (case when provider = 'microsoft' then tenant_id end) stored,
  add column if not exists g_registration_tenant uuid
    generated always as (case when provider = 'google' then tenant_id end) stored;
alter table content_sources
  drop constraint if exists content_sources_ms_registration_fkey,
  drop constraint if exists content_sources_g_registration_fkey,
  drop constraint if exists content_sources_google_mailbox_check;
alter table content_sources
  add constraint content_sources_ms_registration_fkey
    foreign key (ms_registration_tenant) references graph_reader_registrations (tenant_id) on delete restrict,
  add constraint content_sources_g_registration_fkey
    foreign key (g_registration_tenant) references google_reader_registrations (tenant_id) on delete restrict;
-- A Google source is a mailbox (no Google site reader exists).
alter table content_sources
  add constraint content_sources_google_mailbox_check check (provider <> 'google' or kind = 'mailbox');

-- 2. The google branch (bodies otherwise #262's, verbatim) -------------------
create or replace function reader_registration_active(p_tenant_id uuid, p_provider text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (p_provider = 'microsoft' and exists (select 1 from graph_reader_registrations r
       where r.tenant_id = p_tenant_id and r.status = 'active'))
    or (p_provider = 'google' and exists (select 1 from google_reader_registrations g
       where g.tenant_id = p_tenant_id and g.status = 'active')),
    false);
$$;

-- Empty means none (fail closed).
create or replace function reader_mailbox_domains(p_tenant_id uuid, p_provider text)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct d), '{}'::text[]) from (
    select lower(x) as d from graph_reader_registrations r, unnest(r.mailbox_domains) as x
     where p_provider = 'microsoft' and r.tenant_id = p_tenant_id and r.status = 'active'
    union all
    select g.workspace_domain from google_reader_registrations g
     where p_provider = 'google' and g.tenant_id = p_tenant_id and g.status = 'active'
  ) domains;
$$;

-- Only a same-tenant company of type 'bank' counts, for either provider.
create or replace function reader_firm_company_ids(p_tenant_id uuid, p_provider text)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct c.id), '{}'::uuid[]) from (
    select r.firm_company_id, r.tenant_id from graph_reader_registrations r
     where p_provider = 'microsoft' and r.tenant_id = p_tenant_id and r.status = 'active'
    union all
    select g.firm_company_id, g.tenant_id from google_reader_registrations g
     where p_provider = 'google' and g.tenant_id = p_tenant_id and g.status = 'active'
  ) reg
  join companies c on c.id = reg.firm_company_id and c.tenant_id = reg.tenant_id and c.type = 'bank';
$$;

-- 3. C15: firm_company_ids(tenant) is #262's body (any status), plus the Google registration.
create or replace function firm_company_ids(p_tenant_id uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct c.id), '{}'::uuid[]) from (
    select r.firm_company_id, r.tenant_id from graph_reader_registrations r
     where r.tenant_id = p_tenant_id
    union all
    select g.firm_company_id, g.tenant_id from google_reader_registrations g
     where g.tenant_id = p_tenant_id
  ) reg
  join companies c on c.id = reg.firm_company_id and c.tenant_id = reg.tenant_id and c.type = 'bank';
$$;

-- Grants unchanged from #262: service_role only.
revoke all on function reader_registration_active(uuid, text), reader_mailbox_domains(uuid, text),
  reader_firm_company_ids(uuid, text), firm_company_ids(uuid) from public, anon, authenticated;
grant execute on function reader_registration_active(uuid, text), reader_mailbox_domains(uuid, text),
  reader_firm_company_ids(uuid, text), firm_company_ids(uuid) to service_role;
