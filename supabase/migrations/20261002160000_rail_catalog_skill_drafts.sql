-- Drafts for the skill builder opened from a saved rail template.
-- One active draft per author per template. Saving the skill adds a template step.

create table if not exists rail_catalog_skill_drafts (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references rail_catalog_templates(id) on delete cascade,
  company_id uuid not null references companies(id),
  author_id uuid not null references users(id),
  status text not null default 'active' check (status in ('active', 'archived', 'published')),
  name text not null default '' check (char_length(name) <= 100),
  placement jsonb,
  composer_text text not null default '' check (char_length(composer_text) <= 20000),
  edit_revision bigint not null default 0 check (edit_revision >= 0),
  messages jsonb not null default '[]'::jsonb,
  candidate jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists rail_catalog_skill_drafts_one_active
  on rail_catalog_skill_drafts (template_id, author_id)
  where status = 'active';

alter table rail_catalog_skill_drafts enable row level security;
revoke all on rail_catalog_skill_drafts from public, anon, authenticated;
grant select, insert, update, delete on rail_catalog_skill_drafts to service_role;
