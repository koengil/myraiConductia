-- Latest Ignatious research memos applied back onto a CRM lead (company).
create table if not exists lead_research (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  company_id uuid not null references companies (id) on delete cascade,
  agent text not null,
  execution_id text not null unique,
  memo_md text,
  people_added integer not null default 0,
  created_by uuid references users (id),
  created_at timestamptz not null default now()
);

create index if not exists lead_research_company_idx
  on lead_research (company_id, created_at desc);

alter table lead_research enable row level security;
grant select, insert, update, delete on lead_research to service_role;
