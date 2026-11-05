alter table deal_steps alter column id set default gen_random_uuid();

alter table deal_steps
  add column if not exists step_id text not null,
  add column if not exists seq int not null,
  add column if not exists status text not null
    check (status in ('pending', 'current', 'complete', 'skipped_entry', 'skipped')),
  add column if not exists census_version text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table deal_steps add constraint deal_steps_deal_step_key unique (deal_id, step_id);

alter table deals add column if not exists current_step_seq int;
