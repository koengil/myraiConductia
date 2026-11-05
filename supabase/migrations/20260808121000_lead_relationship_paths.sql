-- Migration: Lead CRM relationship paths — warm-path links (Seq 8 follow-on)
-- Maps each target stakeholder to a firm-side introducer (or cold). One row per
-- stakeholder per lead company; upserted at path selection time.

create table if not exists lead_relationship_paths (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  company_id       uuid not null references companies (id) on delete cascade,
  stakeholder_id   uuid not null references lead_stakeholders (id) on delete cascade,
  relationship_id  uuid references lead_relationships (id) on delete set null,
  path_type        text not null check (path_type in ('warm', 'cold')),
  approved         boolean not null default false,
  approved_by      text,
  approved_on      date,
  created_at       timestamptz not null default now(),
  unique (tenant_id, company_id, stakeholder_id)
);

create index if not exists lead_relationship_paths_company_idx
  on lead_relationship_paths (tenant_id, company_id);

alter table lead_relationship_paths enable row level security;

grant select, insert, update, delete on lead_relationship_paths to service_role;
grant select on lead_relationship_paths to authenticated;
