-- Migration: Lead CRM persistence — relationship-map + stakeholder-map (#114 follow-on)
-- Source: docs/superpowers/specs/2026-07-22-lead-crm-persistence-design.md (Data model)
-- Scope: two child tables tied to a lead (companies.id), tenant-scoped, mirroring
-- the Phase 1 permissions schema style. CHECK enums copy the current /leads UI
-- option sets verbatim (this migration is the source of truth; TS constants in
-- src/lib/constants/leadMaps.ts mirror it — kept in sync by
-- tests/constants-schema-sync.test.ts).
--
-- RLS: enabled on both tables; no policies here (deferred to the app layer per
-- ADR-0008 / permissions-enforcement-gaps, matching the Phase 1 pattern).

-- ─────────────────────────────────────────────────────────────────────────────
-- LEAD RELATIONSHIPS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists lead_relationships (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  company_id        uuid not null references companies (id) on delete cascade,
  person_name       text not null,
  title             text,
  person_company    text,
  contact_info      text,
  relationship_type text not null check (relationship_type in
    ('colleague','co-investor','board member','prior client','prior banker',
     'personal','school','prior deal counterparty')),
  strength          text not null check (strength in ('High','Medium','Low')),
  source            text not null check (source in
    ('HubSpot','M365 email-calendar','PitchBook','CapIQ','banker asserted')),
  confidence        text not null check (confidence in ('High','Medium','Low')),
  last_verified     date,
  owner             text,
  basis             text,
  created_at        timestamptz not null default now()
);
create index if not exists lead_relationships_company_idx
  on lead_relationships (tenant_id, company_id);

alter table lead_relationships enable row level security;

grant select, insert, update, delete on lead_relationships to service_role;
grant select on lead_relationships to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- LEAD STAKEHOLDERS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists lead_stakeholders (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  company_id       uuid not null references companies (id) on delete cascade,
  name             text not null,
  title            text,
  org              text,
  role_in_decision text not null check (role_in_decision in
    ('decision-maker','influencer','gatekeeper','blocker')),
  equity_pct       numeric,
  motivation       text not null check (motivation in
    ('max price','speed','legacy','keep the team','liquidity','return hurdle')),
  stance           text not null check (stance in ('Supporter','Neutral','Detractor')),
  board_seat       boolean not null default false,
  investor         boolean not null default false,
  likely_objections text,
  created_at       timestamptz not null default now()
);
create index if not exists lead_stakeholders_company_idx
  on lead_stakeholders (tenant_id, company_id);

alter table lead_stakeholders enable row level security;

grant select, insert, update, delete on lead_stakeholders to service_role;
grant select on lead_stakeholders to authenticated;
