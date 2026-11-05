-- Backfill lead_personas.conductia_tenant_id (see the migration
-- 20260930100000_lead_personas_conductia_tenant.sql for why the column exists).
--
-- Deliberately NOT part of the migration, following the precedent of
-- scripts/split-company-tenant.sql (D54): a migration that moves rows is a
-- migration you cannot review row-by-row before it runs.
--
-- Rows left NULL stay invisible to the application, which fails CLOSED. Nothing
-- is destroyed: `links` and `tenant_id` are untouched, so an unresolved row can
-- be resolved later. Prefer leaving a row NULL over guessing at it.
--
-- RUN STEP 1 FIRST AND READ THE OUTPUT. Do not run step 2 blind.

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1 — census (read-only)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1a. How many personas exist, and how many are already bound?
select
  count(*)                                            as personas_total,
  count(conductia_tenant_id)                          as already_bound,
  count(*) - count(conductia_tenant_id)               as needs_backfill,
  count(distinct tenant_id)                           as distinct_ignatious_handles
from lead_personas;

-- 1b. Which tenant does each persona's links resolve to?
--
-- links[].leadId holds EITHER a company uuid OR a deal code, so both are tried.
-- A persona resolving to more than one tenant, or to none, is reported rather
-- than resolved: that is the case a human must look at.
with linked as (
  select
    p.id as persona_id,
    l->>'leadId' as lead_id
  from lead_personas p
  left join lateral jsonb_array_elements(
    case when jsonb_typeof(p.links) = 'array' then p.links else '[]'::jsonb end
  ) as l on true
  where p.conductia_tenant_id is null
),
resolved as (
  select
    linked.persona_id,
    coalesce(c.tenant_id, d.tenant_id) as tenant_id
  from linked
  left join companies c
    on c.id = case when linked.lead_id ~ '^[0-9a-f-]{36}$' then linked.lead_id::uuid end
  left join deals d
    on d.code = linked.lead_id
)
select
  persona_id,
  count(distinct tenant_id) filter (where tenant_id is not null) as distinct_tenants,
  min(tenant_id::text)                                           as resolved_tenant,
  case
    when count(distinct tenant_id) filter (where tenant_id is not null) = 1 then 'RESOLVABLE'
    when count(distinct tenant_id) filter (where tenant_id is not null) = 0 then 'NO LINKS RESOLVE'
    else 'AMBIGUOUS - MULTIPLE TENANTS'
  end as verdict
from resolved
group by persona_id
order by verdict, persona_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2 — backfill (writes). Pick ONE branch after reading step 1.
-- ─────────────────────────────────────────────────────────────────────────────

-- 2a. THE LIKELY CASE. lead_personas dates from 2026-08-18 and per-firm tenants
-- only began on 2026-09-15 (D54), and that migration did not re-tenant existing
-- companies. So every existing persona most likely belongs to the original
-- bootstrap tenant. If step 1a shows one distinct handle and step 1b shows a
-- single resolved tenant, bind them all to it explicitly. This binds EVERY
-- NULL row, including the "NO LINKS RESOLVE" bucket from step 1b, so it is only
-- safe when that bucket is empty or those rows are known bootstrap-tenant data.
-- Otherwise use 2b and leave them for a human:
--
--   update lead_personas
--      set conductia_tenant_id = '<paste the uuid from step 1b>'::uuid
--    where conductia_tenant_id is null;

-- 2b. IF step 1b shows more than one tenant in play, bind only the rows that
-- resolve unambiguously and leave the rest NULL for a human:
--
--   with linked as (
--     select p.id as persona_id, l->>'leadId' as lead_id
--     from lead_personas p
--     left join lateral jsonb_array_elements(
--       case when jsonb_typeof(p.links) = 'array' then p.links else '[]'::jsonb end
--     ) as l on true
--     where p.conductia_tenant_id is null
--   ),
--   resolved as (
--     select linked.persona_id, coalesce(c.tenant_id, d.tenant_id) as tenant_id
--     from linked
--     left join companies c
--       on c.id = case when linked.lead_id ~ '^[0-9a-f-]{36}$' then linked.lead_id::uuid end
--     left join deals d on d.code = linked.lead_id
--   ),
--   unambiguous as (
--     select persona_id, min(tenant_id) as tenant_id
--     from resolved
--     where tenant_id is not null
--     group by persona_id
--     having count(distinct tenant_id) = 1
--   )
--   update lead_personas p
--      set conductia_tenant_id = u.tenant_id
--     from unambiguous u
--    where p.id = u.persona_id and p.conductia_tenant_id is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3 — verify. Anything still NULL is invisible to the app by design.
-- ─────────────────────────────────────────────────────────────────────────────
--
--   select count(*) filter (where conductia_tenant_id is null) as still_unbound,
--          count(*) as total
--     from lead_personas;
