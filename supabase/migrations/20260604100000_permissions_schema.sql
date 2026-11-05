-- Migration: Phase 1 permissions schema (minimal slice)
-- Source: docs/03-engineering/permissions_schema_v3-full.md
-- Scope: companies, users, roles, deals, deal_parties, deal_memberships,
--         documents, audit_log — no ndas, deal_expenses, notifications,
--         compliance_events (Phase 2+).
-- users.id = auth.users.id (Option A).

-- ─────────────────────────────────────────────────────────────────────────────
-- DEV TENANT CONSTANT
-- ─────────────────────────────────────────────────────────────────────────────
-- Single-tenant for Conductia-dev until a tenants table is warranted.
-- Referenced by seed scripts and auth trigger.

-- ─────────────────────────────────────────────────────────────────────────────
-- COMPANIES
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists companies (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  name        text not null,
  type        text not null check (type in ('bank','target','acquirer','client','counterparty')),
  created_at  timestamptz not null default now()
);

create index if not exists companies_tenant_id_idx on companies (tenant_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- USERS  (Option A: id mirrors auth.users.id)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists users (
  id           uuid primary key references auth.users (id) on delete cascade,
  tenant_id    uuid not null,
  email        text not null unique,
  full_name    text not null,
  display_name text,
  is_external  boolean not null default false,
  firm_role    text check (firm_role in ('cco','admin')),
  department   text check (department in ('ib','research','trading','compliance','legal','admin')),
  status       text not null default 'active' check (status in ('active','suspended'))
);

create index if not exists users_tenant_id_idx on users (tenant_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLES
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists roles (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug in
                ('md','deal_team','legal','cco','seller','buyer','read_only','admin')),
  label       text not null,
  permissions jsonb not null default '[]'
);

insert into roles (slug, label, permissions) values
  ('md',        'Managing Director',        '["deal:full","acquirer:full","scoring:edit","team:manage","compliance:verdicts"]'),
  ('deal_team', 'Deal Team',                '["deal:read","acquirer:scores","document:read:class1-3","thread:own"]'),
  ('legal',     'Legal Counsel',            '["nda:manage","engagement_letter:manage","document:read:class1-3","thread:own"]'),
  ('cco',       'Chief Compliance Officer', '["deal:read:all","compliance:full","audit:full","nda:read"]'),
  ('seller',    'Seller',                   '["document:upload:class1-3"]'),
  ('buyer',     'Buyer',                    '["document:read:phase_gated"]'),
  ('read_only', 'Observer',                 '["deal:read","document:read:class1-2"]'),
  ('admin',     'Administrator',            '["user:manage","tenant:manage"]')
on conflict (slug) do update set
  label = excluded.label,
  permissions = excluded.permissions;

-- ─────────────────────────────────────────────────────────────────────────────
-- DEALS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists deals (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  code              text not null unique,
  codename          text not null,
  bank_id           uuid not null references companies (id),
  mandate_owner_id  uuid references users (id),
  status            text not null default 'intake'
                    check (status in ('intake','active','paused','closed')),
  created_at        timestamptz not null default now()
);

create index if not exists deals_tenant_id_idx on deals (tenant_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- DEAL PARTIES
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists deal_parties (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references deals (id) on delete cascade,
  company_id  uuid not null references companies (id),
  party_role  text not null check (party_role in
                ('target','co_seller','acquirer_shortlist','counterparty')),
  added_at    timestamptz not null default now(),
  unique (deal_id, company_id, party_role)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- DEAL MEMBERSHIPS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists deal_memberships (
  id                 uuid primary key default gen_random_uuid(),
  deal_id            uuid not null references deals (id) on delete cascade,
  user_id            uuid not null references users (id) on delete cascade,
  role_id            uuid not null references roles (id),
  deal_role          text not null check (deal_role in
                       ('md','deal_team','legal','seller','buyer','read_only')),
  phase              int  not null default 0,
  access_scope       jsonb,
  added_by           uuid references users (id),
  access_granted_at  timestamptz not null default now(),
  unique (deal_id, user_id)
);

create index if not exists deal_memberships_user_id_idx on deal_memberships (user_id);
create index if not exists deal_memberships_deal_id_idx on deal_memberships (deal_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- DOCUMENTS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists documents (
  id              uuid primary key default gen_random_uuid(),
  deal_id         uuid not null references deals (id) on delete cascade,
  name            text not null,
  classification  int  not null check (classification between 1 and 4),
  min_phase       int  not null default 0,
  uploaded_by     uuid references users (id),
  created_at      timestamptz not null default now()
);

create index if not exists documents_deal_id_idx on documents (deal_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- AUDIT LOG
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists audit_log (
  id           uuid primary key default gen_random_uuid(),
  ts           timestamptz not null default now(),
  actor_id     uuid not null references users (id),
  action       text not null check (action in
                 ('view','download','upload','export','grant','revoke')),
  deal_id      uuid references deals (id),
  document_id  uuid references documents (id),
  detail       jsonb
);

create index if not exists audit_log_deal_id_ts_idx on audit_log (deal_id, ts desc);
create index if not exists audit_log_actor_id_ts_idx on audit_log (actor_id, ts desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- AUTH → public.users sync (Option A)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := '00000000-0000-4000-8000-000000000001';
begin
  insert into public.users (
    id,
    tenant_id,
    email,
    full_name,
    display_name,
    is_external,
    firm_role,
    department
  )
  values (
    new.id,
    coalesce((new.raw_user_meta_data->>'tenant_id')::uuid, v_tenant_id),
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'display_name',
    coalesce((new.raw_user_meta_data->>'is_external')::boolean, false),
    new.raw_user_meta_data->>'firm_role',
    new.raw_user_meta_data->>'department'
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = excluded.full_name,
    display_name = excluded.display_name,
    is_external = excluded.is_external,
    firm_role = excluded.firm_role,
    department = excluded.department;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ─────────────────────────────────────────────────────────────────────────────
-- feature_flags.updated_by → users(id)
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'feature_flags_updated_by_fkey'
  ) then
    alter table feature_flags
      add constraint feature_flags_updated_by_fkey
      foreign key (updated_by) references users (id);
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — enabled; policies ship in a follow-up migration (ticket #3).
-- service_role bypasses RLS for seeds and server-side admin paths.
-- ─────────────────────────────────────────────────────────────────────────────
alter table companies enable row level security;
alter table users enable row level security;
alter table roles enable row level security;
alter table deals enable row level security;
alter table deal_parties enable row level security;
alter table deal_memberships enable row level security;
alter table documents enable row level security;
alter table audit_log enable row level security;

grant select, insert, update, delete on companies to service_role;
grant select, insert, update, delete on users to service_role;
grant select, insert, update, delete on roles to service_role;
grant select, insert, update, delete on deals to service_role;
grant select, insert, update, delete on deal_parties to service_role;
grant select, insert, update, delete on deal_memberships to service_role;
grant select, insert, update, delete on documents to service_role;
grant select, insert, update, delete on audit_log to service_role;
