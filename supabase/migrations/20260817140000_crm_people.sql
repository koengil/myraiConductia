-- CRM people catalog: canonical person nodes for lead relationship/stakeholder maps.
-- Scoped to the customer org that registered the lead (registered_by_company_id),
-- mirroring companies.registered_by_company_id on leads.

create table if not exists crm_people (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null,
  registered_by_company_id  uuid references companies (id) on delete set null,
  name                      text not null,
  email                     text,
  title                     text,
  org                       text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create unique index if not exists crm_people_registrar_dedupe_idx
  on crm_people (
    tenant_id,
    coalesce(registered_by_company_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(trim(name)),
    coalesce(lower(trim(email)), '')
  );

create index if not exists crm_people_registered_by_company_idx
  on crm_people (registered_by_company_id)
  where registered_by_company_id is not null;

alter table crm_people enable row level security;

grant select, insert, update, delete on crm_people to service_role;
grant select on crm_people to authenticated;

alter table lead_stakeholders
  add column if not exists person_id uuid references crm_people (id) on delete set null;

alter table lead_relationships
  add column if not exists person_id uuid references crm_people (id) on delete set null;
