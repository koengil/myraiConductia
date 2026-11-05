-- Conductia callback persistence for source-intelligence and digital twins.
-- Documents and maps are lead-scoped; personas are tenant-scoped.

create table if not exists lead_documents (
  id text primary key,
  tenant_id text not null,
  lead_id text not null,
  company_id uuid references companies (id) on delete cascade,
  title text not null,
  document_type text not null,
  folder text not null,
  kind text not null default 'other',
  text_content text,
  original_filename text,
  mime_type text,
  version integer not null default 1,
  created_at timestamptz not null default now()
);

create index if not exists lead_documents_lead_idx
  on lead_documents (lead_id, created_at desc);

create table if not exists lead_intel (
  lead_id text primary key,
  tenant_id text not null,
  company_id uuid references companies (id) on delete cascade,
  version integer not null default 0,
  relationship_version integer not null default 0,
  stakeholder_version integer not null default 0,
  fields jsonb not null default '{}'::jsonb,
  relationship_map jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  stakeholder_map jsonb not null default '{"stakeholders":[]}'::jsonb,
  tasks jsonb not null default '[]'::jsonb,
  notes jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists lead_personas (
  id text primary key,
  tenant_id text not null,
  name text not null,
  title text not null,
  organization text not null,
  type text,
  subtype text,
  tags jsonb not null default '[]'::jsonb,
  body text not null default '',
  version integer not null default 1,
  authored_by text not null default 'agent',
  links jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lead_personas_tenant_idx
  on lead_personas (tenant_id, name);

alter table lead_documents enable row level security;
alter table lead_intel enable row level security;
alter table lead_personas enable row level security;

grant select, insert, update, delete on lead_documents to service_role;
grant select, insert, update, delete on lead_intel to service_role;
grant select, insert, update, delete on lead_personas to service_role;
