-- Box-backed datarooms (one folder per rail step). Extends G16 deal_steps — does
-- NOT recreate that table. See docs/07-decisions/ADR-0012-box-dataroom-steps.md.

-- ─────────────────────────────────────────────────────────────────────────────
-- DATAROOMS (Box folder per rail step_id)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists datarooms (
  id              uuid primary key default gen_random_uuid(),
  deal_id         uuid not null references deals (id) on delete cascade,
  step_id         text not null,
  provider        text not null default 'box' check (provider in ('box')),
  box_folder_id   text,
  box_folder_url  text,
  requires_upload boolean not null default false,
  min_phase       int  not null default 0,
  created_at      timestamptz not null default now(),
  unique (deal_id, step_id)
);

create index if not exists datarooms_deal_id_idx on datarooms (deal_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- DOCUMENTS — link optional Box file + dataroom
-- ─────────────────────────────────────────────────────────────────────────────
alter table documents
  add column if not exists dataroom_id uuid references datarooms (id) on delete set null;

alter table documents
  add column if not exists box_file_id text;

alter table documents
  add column if not exists storage_provider text not null default 'internal'
    check (storage_provider in ('internal', 'box'));

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS (enabled, policy-free — same belt as Phase 1 dataroom slice)
-- ─────────────────────────────────────────────────────────────────────────────
alter table datarooms enable row level security;

grant select, insert, update, delete on datarooms to service_role;
