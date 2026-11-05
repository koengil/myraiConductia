-- supabase/migrations/20260916130000_deal_step_skill_runs.sql
-- The ledger of skill runs against a deal step. A row is written only when a
-- run ENDS: there is no queued or in-flight state here, so every row is a
-- finished fact and the table is append-only (triggers block UPDATE and
-- DELETE, so deal_id carries no cascade). The outcome CHECK pairs the verdict
-- with its payload in both directions: succeeded carries result_text, failed
-- never does.
--
-- The table is not on the browser's REST surface. Every read goes through the
-- API routes on the service role, so `authenticated` gets no grant and the
-- table carries no select policy: RLS stays enabled and denies by default.
-- That avoids app_is_overseer, which compares no tenant (#78).
--
-- documents.step_skill_run_id deliberately has NO foreign key. A document is
-- filed mid-run, before the run record exists, and sometimes instead of it ever
-- existing (a run that dies after filing writes no row at all). The column is a
-- provenance hint, not a relationship the database can enforce.

create table if not exists deal_step_skill_runs (
  id              uuid primary key,
  deal_id         uuid not null references deals (id),
  deal_step_id    uuid not null references deal_steps (id),
  actor_id        uuid not null references users (id),
  skill_id        uuid not null,
  version_id      uuid not null,
  digest          text not null check (digest ~ '^[0-9a-f]{64}$'),
  input           text not null,
  outcome         text not null check (outcome in ('succeeded','failed')),
  result_text     text,
  error_message   text,
  provider_run_id text,
  cost_usd        numeric,
  started_at      timestamptz,
  created_at      timestamptz not null default now(),
  check ((outcome = 'succeeded') = (result_text is not null))
);

create index if not exists deal_step_skill_runs_step_idx
  on deal_step_skill_runs (deal_step_id, created_at desc);

alter table deal_step_skill_runs enable row level security;

grant select, insert on deal_step_skill_runs to service_role;

drop policy if exists deal_step_skill_runs_select on deal_step_skill_runs;
revoke select on deal_step_skill_runs from authenticated;

create or replace function deal_step_skill_runs_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'deal_step_skill_runs rows are immutable';
end $$;

drop trigger if exists deal_step_skill_runs_no_update on deal_step_skill_runs;
create trigger deal_step_skill_runs_no_update
  before update on deal_step_skill_runs
  for each row execute function deal_step_skill_runs_immutable();

drop trigger if exists deal_step_skill_runs_no_delete on deal_step_skill_runs;
create trigger deal_step_skill_runs_no_delete
  before delete on deal_step_skill_runs
  for each row execute function deal_step_skill_runs_immutable();

alter table documents
  add column if not exists step_skill_run_id uuid;

create index if not exists documents_step_skill_run_idx
  on documents (step_skill_run_id) where step_skill_run_id is not null;
