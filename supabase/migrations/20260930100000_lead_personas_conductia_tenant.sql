-- Partition digital twins by the Conductia tenant, not the Ignatious handle.
--
-- The leak: lead_personas.tenant_id is `text` and holds the Ignatious
-- control-plane tenant handle, which is a single per-deployment constant
-- (IGNATIOUS_TENANT_ID, default 'tn_demo'). Every firm's personas therefore
-- share one partition, and `.eq('tenant_id', 'tn_demo')` isolates nothing.
-- Personas are tenant-scoped rather than lead-scoped, so unlike the rest of the
-- callback seam they cannot be bound by resolving the lead in the path — the
-- verified tenant claim is their only control.
--
-- The fix is a SECOND column carrying the Conductia per-firm tenant (the uuid
-- on companies/users/deals), which the application filters on. The existing
-- tenant_id is deliberately left alone: it is still the handle, it is still
-- what lead_documents and lead_intel hold, and overwriting it would give one
-- column two meanings across the three tables of the same family.
--
-- Additive and reversible. No default and no NOT NULL, so this is a
-- catalog-only change: no table rewrite and no meaningful lock on a live table.
-- Rows left NULL are excluded by the read filter, i.e. they fail CLOSED while
-- remaining fully recoverable — `links` and `tenant_id` are untouched, so a
-- later backfill can still resolve them.
--
-- No data is moved here. Following the precedent set by the tenant-per-firm
-- work (D54), whose risky row movement lived in scripts/split-company-tenant.sql
-- rather than in a migration, the backfill is a separate reviewed script:
-- scripts/backfill-persona-tenant.sql. Run its census first.

alter table lead_personas
  add column if not exists conductia_tenant_id uuid;

-- Mirrors the existing lead_personas_tenant_idx shape. Plain, not CONCURRENTLY:
-- that cannot run inside a transaction and buys nothing on a table this size.
create index if not exists lead_personas_conductia_tenant_idx
  on lead_personas (conductia_tenant_id, name);

comment on column lead_personas.conductia_tenant_id is
  'Conductia per-firm tenant (uuid). The isolation boundary for personas. Distinct from tenant_id, which is the Ignatious control-plane handle.';
