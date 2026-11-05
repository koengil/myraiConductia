alter table deal_step_skill_runs
  add column if not exists parent_run_id uuid references deal_step_skill_runs (id),
  add column if not exists root_run_id   uuid references deal_step_skill_runs (id);

alter table deal_step_skill_runs drop constraint if exists deal_step_skill_runs_source_check;
alter table deal_step_skill_runs add constraint deal_step_skill_runs_source_check
  check (source in ('execution', 'imported', 'revision'));

alter table deal_step_skill_runs drop constraint if exists deal_step_skill_runs_reference_check;
alter table deal_step_skill_runs add constraint deal_step_skill_runs_reference_check
  check (
    (source = 'execution'
      and parent_run_id is null and root_run_id is null
      and digest is not null and actor_id is not null
      and ((skill_id is not null and version_id is not null
            and mount_name is null and mount_version is null)
        or (mount_name is not null and mount_version is not null
            and skill_id is null and version_id is null)))
    or
    (source = 'imported'
      and parent_run_id is null and root_run_id is null
      and digest is null and actor_id is null and skill_id is null and version_id is null
      and mount_name is null and mount_version is null)
    or
    (source = 'revision'
      and parent_run_id is not null and root_run_id is not null and actor_id is not null
      and ((digest is not null and skill_id is not null and version_id is not null
            and mount_name is null and mount_version is null)
        or (digest is not null and mount_name is not null and mount_version is not null
            and skill_id is null and version_id is null)
        or (digest is null and skill_id is null and version_id is null
            and mount_name is null and mount_version is null)))
  );

create unique index if not exists deal_step_skill_runs_one_revision_per_parent_idx
  on deal_step_skill_runs (parent_run_id)
  where outcome = 'succeeded';

create index if not exists deal_step_skill_runs_root_idx
  on deal_step_skill_runs (root_run_id, created_at)
  where root_run_id is not null;

create or replace function deal_step_skill_runs_revision_lineage() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.source <> 'revision' then
    return new;
  end if;
  if not exists (
    select 1 from deal_step_skill_runs root
    where root.id = new.root_run_id
      and root.source <> 'revision'
      and root.deal_id = new.deal_id
      and root.deal_step_id = new.deal_step_id
  ) or not exists (
    select 1 from deal_step_skill_runs parent
    where parent.id = new.parent_run_id
      and coalesce(parent.root_run_id, parent.id) = new.root_run_id
      and parent.deal_id = new.deal_id
      and parent.deal_step_id = new.deal_step_id
  ) then
    raise exception 'a revision must extend a run of its own step'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists deal_step_skill_runs_revision_lineage on deal_step_skill_runs;
create trigger deal_step_skill_runs_revision_lineage
  before insert on deal_step_skill_runs
  for each row execute function deal_step_skill_runs_revision_lineage();

create or replace function record_skill_run_revision(p_run jsonb, p_audit jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into deal_step_skill_runs (
    id, deal_id, deal_step_id, actor_id, source, parent_run_id, root_run_id,
    skill_id, version_id, mount_name, mount_version, digest, inputs, outcome,
    result_text, error_message, model, cost_usd, provider_run_id, started_at)
  select
    id, deal_id, deal_step_id, actor_id, source, parent_run_id, root_run_id,
    skill_id, version_id, mount_name, mount_version, digest, inputs, outcome,
    result_text, error_message, model, cost_usd, provider_run_id, started_at
  from jsonb_populate_record(null::deal_step_skill_runs, p_run);

  insert into audit_log (actor_id, action, deal_id, detail)
  values ((p_run ->> 'actor_id')::uuid, 'create', (p_run ->> 'deal_id')::uuid, p_audit);
end;
$$;

revoke all on function record_skill_run_revision(jsonb, jsonb) from public, anon, authenticated;
grant execute on function record_skill_run_revision(jsonb, jsonb) to service_role;

alter table ai_usage drop constraint if exists ai_usage_source_check;
alter table ai_usage add constraint ai_usage_source_check
  check (source in ('screen','agent_run','bench_chat','twin_chat','discovery_extract','skill_run','skill_authoring','skill_revision'));
