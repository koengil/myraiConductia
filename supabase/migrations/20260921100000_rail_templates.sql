alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check check (action = any (array[
  'view', 'download', 'upload', 'export', 'grant', 'revoke', 'hold_placed', 'hold_lifted', 'create', 'notify',
  'advance', 'attest', 'screen', 'send', 'release', 'invite_sent', 'invite_accepted', 'invite_revoked', 'reject',
  'invite_domain_override', 'invite_challenge_issued', 'invite_challenge_rotated', 'invite_verification_succeeded',
  'invite_verification_locked', 'mfa_enrolled', 'mfa_challenged', 'assign_step', 'complete_step', 'step_work',
  'update', 'skill_authoring.draft_created', 'skill_authoring.draft_archived', 'skill_authoring.message_admitted',
  'skill_authoring.attempt_transitioned', 'skill_authoring.candidate_selected', 'skill_authoring.access_denied',
  'skill_publication.admitted', 'skill_publication.admission_denied', 'skill_publication.duplicate_confirmed',
  'skill_publication.duplicate_declined', 'skill_publication.placement_replaced', 'skill_publication.transition',
  'rail.step_rebound', 'rail.template_created', 'rail.template_replaced'
])) not valid;

create table if not exists rail_templates (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  company_id          uuid not null references companies (id),
  name                text not null,
  normalized_name     text generated always as (lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))) stored,
  current_revision_id uuid,
  created_by          uuid not null references users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint rail_templates_name_check check (char_length(btrim(name)) between 1 and 120)
);

create table if not exists rail_template_revisions (
  id                   uuid primary key default gen_random_uuid(),
  template_id          uuid not null references rail_templates (id),
  actor_id             uuid not null references users (id),
  request_id           uuid not null unique,
  request_digest       text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  command              jsonb not null,
  source_deal_id       uuid not null references deals (id),
  source_fingerprint   text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  expected_revision_id uuid,
  description          text not null default '' check (char_length(description) <= 500),
  manifest             jsonb not null,
  state                text not null default 'preparing' check (state in ('preparing', 'ready', 'conflict')),
  provider_receipt     jsonb,
  created_at           timestamptz not null default now(),
  constraint rail_template_revisions_template_identity_key unique (id, template_id)
);

alter table rail_templates drop constraint if exists rail_templates_current_revision_fkey;
alter table rail_templates add constraint rail_templates_current_revision_fkey
  foreign key (current_revision_id, id) references rail_template_revisions (id, template_id);

create unique index if not exists rail_templates_visible_name_idx
  on rail_templates (company_id, normalized_name) where current_revision_id is not null;
create index if not exists rail_template_revisions_template_idx
  on rail_template_revisions (template_id);

create table if not exists deal_skill_imports (
  skill_id             uuid primary key,
  deal_id              uuid not null references deals (id) on delete cascade,
  version_id           uuid not null unique,
  digest               text not null check (digest ~ '^[0-9a-f]{64}$'),
  name                 text not null check (char_length(btrim(name)) between 1 and 200),
  capability_contract  jsonb not null check (
    jsonb_typeof(capability_contract) = 'object'
    and coalesce(btrim(capability_contract ->> 'purpose'), '') <> ''
    and coalesce(btrim(capability_contract ->> 'expectedInput'), '') <> ''
    and coalesce(btrim(capability_contract ->> 'expectedOutput'), '') <> ''
  ),
  imported_by          uuid not null references users (id),
  template_revision_id uuid not null references rail_template_revisions (id),
  source_asset_key     text not null check (char_length(btrim(source_asset_key)) > 0),
  created_at           timestamptz not null default now()
);

create index if not exists deal_skill_imports_deal_idx on deal_skill_imports (deal_id);

alter table rail_templates enable row level security;
alter table rail_template_revisions enable row level security;
alter table deal_skill_imports enable row level security;

revoke all on rail_templates from public, anon, authenticated;
revoke all on rail_template_revisions from public, anon, authenticated;
revoke all on deal_skill_imports from public, anon, authenticated;
grant select, insert, update, delete on rail_templates to service_role;
grant select, insert, update, delete on rail_template_revisions to service_role;
grant select, insert on deal_skill_imports to service_role;

create or replace function rail_template_revision_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.state <> 'preparing'
     or new.state not in ('ready', 'conflict')
     or new.id <> old.id
     or new.template_id <> old.template_id
     or new.actor_id <> old.actor_id
     or new.request_id <> old.request_id
     or new.request_digest <> old.request_digest
     or new.command <> old.command
     or new.source_deal_id <> old.source_deal_id
     or new.source_fingerprint <> old.source_fingerprint
     or new.expected_revision_id is distinct from old.expected_revision_id
     or new.description <> old.description
     or new.manifest <> old.manifest
     or new.created_at <> old.created_at then
    raise exception 'revision_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function rail_template_revision_guard() from public, anon, authenticated;

drop trigger if exists rail_template_revisions_guard on rail_template_revisions;
create trigger rail_template_revisions_guard before update on rail_template_revisions
  for each row execute function rail_template_revision_guard();

create or replace function rail_template_pointer_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.current_revision_id is not null and not exists (
    select 1 from rail_template_revisions r
     where r.id = new.current_revision_id and r.state = 'ready'
  ) then
    raise exception 'revision_not_ready' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function rail_template_pointer_guard() from public, anon, authenticated;

drop trigger if exists rail_templates_pointer_guard on rail_templates;
create trigger rail_templates_pointer_guard before insert or update on rail_templates
  for each row execute function rail_template_pointer_guard();

create or replace function deal_skill_import_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_bank    uuid;
  v_company uuid;
begin
  if tg_op <> 'INSERT' then
    raise exception 'import_immutable' using errcode = 'P0001';
  end if;
  select d.bank_id into v_bank from deals d where d.id = new.deal_id;
  select t.company_id into v_company
    from rail_template_revisions r
    join rail_templates t on t.id = r.template_id
   where r.id = new.template_revision_id;
  if v_bank is null or v_company is null or v_bank <> v_company then
    raise exception 'import_company_mismatch' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function deal_skill_import_guard() from public, anon, authenticated;

drop trigger if exists deal_skill_imports_guard on deal_skill_imports;
create trigger deal_skill_imports_guard before insert or update on deal_skill_imports
  for each row execute function deal_skill_import_guard();

create or replace function rail_template_source_fingerprint(p_deal_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'steps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'stepId', s.step_id, 'origin', s.origin, 'seq', s.seq,
        'phaseIndex', s.phase_index, 'displayOrder', s.display_order,
        'definition', s.definition, 'removed', s.removed_at is not null
      ) order by s.id)
      from deal_steps s where s.deal_id = p_deal_id), '[]'::jsonb),
    'bindings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'dealStepId', b.deal_step_id, 'kind', b.kind, 'skillId', b.skill_id,
        'versionId', b.version_id, 'mountName', b.mount_name,
        'mountVersion', b.mount_version, 'digest', b.digest
      ) order by b.deal_step_id)
      from deal_step_skill_bindings b where b.deal_id = p_deal_id), '[]'::jsonb)
  )::text, 'UTF8')), 'hex');
$$;

revoke all on function rail_template_source_fingerprint(uuid) from public, anon, authenticated;
grant execute on function rail_template_source_fingerprint(uuid) to service_role;

create or replace function rail_template_uuid(p_value text) returns uuid
language plpgsql immutable as $$
begin
  return p_value::uuid;
exception when others then
  return null;
end;
$$;

revoke all on function rail_template_uuid(text) from public, anon, authenticated;
grant execute on function rail_template_uuid(text) to service_role;

drop function if exists rail_template_normalize_name(text);

create or replace function rail_template_display_name(p_name text) returns text
language sql immutable as $$
  select btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
$$;

revoke all on function rail_template_display_name(text) from public, anon, authenticated;
grant execute on function rail_template_display_name(text) to service_role;

create or replace function rail_template_normalized_name(p_name text) returns text
language sql immutable as $$
  select lower(rail_template_display_name(p_name));
$$;

revoke all on function rail_template_normalized_name(text) from public, anon, authenticated;
grant execute on function rail_template_normalized_name(text) to service_role;

create or replace function rail_template_census_version(p_deal_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select s.census_version from deal_steps s
   where s.deal_id = p_deal_id and s.removed_at is null and s.census_version is not null
   order by s.display_order limit 1;
$$;

revoke all on function rail_template_census_version(uuid) from public, anon, authenticated;
grant execute on function rail_template_census_version(uuid) to service_role;

create or replace function rail_template_command_digest(p_command jsonb) returns text
language sql immutable as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'requestId', lower(coalesce(p_command ->> 'requestId', '')),
    'sourceDealId', lower(coalesce(p_command ->> 'sourceDealId', '')),
    'description', btrim(coalesce(p_command ->> 'description', '')),
    'kind', coalesce(p_command -> 'target' ->> 'kind', ''),
    'name', rail_template_display_name(p_command -> 'target' ->> 'name'),
    'templateId', lower(coalesce(p_command -> 'target' ->> 'templateId', '')),
    'expectedRevisionId', lower(coalesce(p_command -> 'target' ->> 'expectedRevisionId', ''))
  )::text, 'UTF8')), 'hex');
$$;

revoke all on function rail_template_command_digest(jsonb) from public, anon, authenticated;
grant execute on function rail_template_command_digest(jsonb) to service_role;

create or replace function rail_template_assert_source_actor(p_actor_id uuid, p_deal_id uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (
    select 1 from users u
     where u.id = p_actor_id and u.is_external = false and u.status = 'active'
  ) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  if not (app_is_deal_member(p_deal_id, p_actor_id) or app_is_overseer(p_actor_id)) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function rail_template_assert_source_actor(uuid, uuid) from public, anon, authenticated;
grant execute on function rail_template_assert_source_actor(uuid, uuid) to service_role;

create or replace function rail_template_assert_structure(p_actor_id uuid, p_company_id uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if exists (select 1 from feature_flags where key = 'company_access_management' and enabled)
     and not exists (
       select 1 from users u where u.id = p_actor_id and u.firm_role in ('admin', 'cco')
     )
     and not app_has_company_permission(p_actor_id, p_company_id, 'company:deals:steps:structure')
  then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function rail_template_assert_structure(uuid, uuid) from public, anon, authenticated;
grant execute on function rail_template_assert_structure(uuid, uuid) to service_role;

create or replace function rail_template_validate_manifest(p_manifest jsonb, p_deal_id uuid)
returns void language plpgsql stable security definer set search_path = public as $$
declare
  v_steps  int;
  v_skills int;
  v_active int;
begin
  if jsonb_typeof(p_manifest) <> 'object'
     or p_manifest -> 'schemaVersion' <> '1'::jsonb
     or coalesce(btrim(p_manifest ->> 'censusVersion'), '') = ''
     or p_manifest ->> 'censusVersion' is distinct from rail_template_census_version(p_deal_id)
     or jsonb_typeof(p_manifest -> 'steps') <> 'array'
     or jsonb_typeof(p_manifest -> 'skills') <> 'array' then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  v_steps := jsonb_array_length(p_manifest -> 'steps');
  v_skills := jsonb_array_length(p_manifest -> 'skills');
  select count(*) into v_active
    from deal_steps where deal_id = p_deal_id and removed_at is null;

  if v_steps = 0 or v_steps <> v_active then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_manifest -> 'steps') step
     where coalesce(step ->> 'key', '') !~ '^t[0-9]+$'
        or jsonb_typeof(step -> 'phaseIndex') <> 'number'
        or step -> 'phaseIndex' < '1'::jsonb
        or jsonb_typeof(step -> 'displayOrder') <> 'number'
        or (step ->> 'skillKey' is not null and not exists (
             select 1 from jsonb_array_elements(p_manifest -> 'skills') skill
              where skill ->> 'key' = step ->> 'skillKey'))
  ) then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  if (select coalesce(array_agg(step ->> 'catalogStepId' order by step ->> 'catalogStepId'), array[]::text[])
        from jsonb_array_elements(p_manifest -> 'steps') step
       where step ->> 'catalogStepId' is not null)
     is distinct from
     (select coalesce(array_agg(s.step_id order by s.step_id), array[]::text[])
        from deal_steps s
       where s.deal_id = p_deal_id and s.removed_at is null and s.origin = 'catalog') then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  if (select count(distinct step ->> 'key') from jsonb_array_elements(p_manifest -> 'steps') step) <> v_steps
     or (select array_agg((step ->> 'displayOrder')::numeric order by (step ->> 'displayOrder')::numeric)
           from jsonb_array_elements(p_manifest -> 'steps') step)
        <> (select array_agg(ordinal::numeric) from generate_series(1, v_steps) ordinal) then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_manifest -> 'skills') skill
     where coalesce(skill ->> 'key', '') !~ '^s[0-9]+$'
        or coalesce(btrim(skill ->> 'name'), '') = ''
        or coalesce(skill -> 'source' ->> 'digest', '') !~ '^[0-9a-f]{64}$'
        or coalesce(skill -> 'source' ->> 'kind', '') not in ('publication', 'mount')
        or (skill -> 'source' ->> 'kind' = 'publication' and (
              rail_template_uuid(skill -> 'source' ->> 'skillId') is null
              or rail_template_uuid(skill -> 'source' ->> 'versionId') is null))
        or (skill -> 'source' ->> 'kind' = 'mount' and (
              coalesce(btrim(skill -> 'source' ->> 'name'), '') = ''
              or jsonb_typeof(skill -> 'source' -> 'version') <> 'number'))
        or coalesce(btrim(skill -> 'contract' ->> 'purpose'), '') = ''
        or coalesce(btrim(skill -> 'contract' ->> 'expectedInput'), '') = ''
        or coalesce(btrim(skill -> 'contract' ->> 'expectedOutput'), '') = ''
  ) or (select count(distinct skill ->> 'key') from jsonb_array_elements(p_manifest -> 'skills') skill)
       <> v_skills then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function rail_template_validate_manifest(jsonb, uuid) from public, anon, authenticated;
grant execute on function rail_template_validate_manifest(jsonb, uuid) to service_role;

create or replace function rail_template_summary(p_revision rail_template_revisions) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p_revision.template_id,
    'revisionId', p_revision.id,
    'name', t.name,
    'description', p_revision.description,
    'stepCount', jsonb_array_length(p_revision.manifest -> 'steps'),
    'skillCount', jsonb_array_length(p_revision.manifest -> 'skills'),
    'updatedAt', to_char(p_revision.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  from rail_templates t where t.id = p_revision.template_id;
$$;

revoke all on function rail_template_summary(rail_template_revisions) from public, anon, authenticated;
grant execute on function rail_template_summary(rail_template_revisions) to service_role;

create or replace function rail_template_admission(p_revision rail_template_revisions) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'requestId', p_revision.request_id,
    'revisionId', p_revision.id,
    'companyId', t.company_id,
    'command', p_revision.command,
    'manifest', p_revision.manifest,
    'state', p_revision.state,
    'receipt', case when p_revision.state = 'ready' then rail_template_summary(p_revision) end
  )
  from rail_templates t where t.id = p_revision.template_id;
$$;

revoke all on function rail_template_admission(rail_template_revisions) from public, anon, authenticated;
grant execute on function rail_template_admission(rail_template_revisions) to service_role;

create or replace function rail_template_read_source(p_actor_id uuid, p_deal_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_deal deals;
begin
  select * into v_deal from deals where id = p_deal_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform rail_template_assert_source_actor(p_actor_id, p_deal_id);

  return jsonb_build_object(
    'dealId', v_deal.id,
    'companyId', v_deal.bank_id,
    'tenantId', v_deal.tenant_id,
    'censusVersion', rail_template_census_version(p_deal_id),
    'steps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'stepId', s.step_id, 'origin', s.origin, 'seq', s.seq,
        'status', s.status, 'phaseIndex', s.phase_index, 'displayOrder', s.display_order,
        'definition', s.definition, 'anchorStepId', s.anchor_step_id,
        'censusVersion', s.census_version, 'removedAt', s.removed_at
      ) order by s.display_order, s.id)
      from deal_steps s where s.deal_id = p_deal_id), '[]'::jsonb),
    'bindings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'dealStepId', b.deal_step_id, 'kind', b.kind, 'skillId', b.skill_id,
        'versionId', b.version_id, 'mountName', b.mount_name,
        'mountVersion', b.mount_version, 'digest', b.digest
      ) order by b.deal_step_id)
      from deal_step_skill_bindings b where b.deal_id = p_deal_id), '[]'::jsonb),
    'sourceFingerprint', rail_template_source_fingerprint(p_deal_id)
  );
end;
$$;

revoke all on function rail_template_read_source(uuid, uuid) from public, anon, authenticated;
grant execute on function rail_template_read_source(uuid, uuid) to service_role;

create or replace function rail_template_admit_save(
  p_actor_id           uuid,
  p_company_id         uuid,
  p_command            jsonb,
  p_manifest           jsonb,
  p_source_fingerprint text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_request     uuid;
  v_deal_id     uuid;
  v_deal        deals;
  v_kind        text;
  v_name        text;
  v_description text;
  v_digest      text;
  v_existing    rail_template_revisions;
  v_revision    rail_template_revisions;
  v_template    uuid;
  v_expected    uuid;
begin
  if jsonb_typeof(p_command) <> 'object' then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  v_request := rail_template_uuid(p_command ->> 'requestId');
  v_deal_id := rail_template_uuid(p_command ->> 'sourceDealId');
  v_description := btrim(coalesce(p_command ->> 'description', ''));
  v_kind := p_command -> 'target' ->> 'kind';

  if v_request is null or v_deal_id is null or char_length(v_description) > 500
     or v_kind is null or v_kind not in ('new', 'replace') then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  if v_kind = 'new' then
    v_name := rail_template_display_name(p_command -> 'target' ->> 'name');
    if char_length(v_name) < 1 or char_length(v_name) > 120 then
      raise exception 'invalid_command' using errcode = 'P0001';
    end if;
  else
    v_template := rail_template_uuid(p_command -> 'target' ->> 'templateId');
    v_expected := rail_template_uuid(p_command -> 'target' ->> 'expectedRevisionId');
    if v_template is null or v_expected is null then
      raise exception 'invalid_command' using errcode = 'P0001';
    end if;
  end if;

  v_digest := rail_template_command_digest(p_command);

  select * into v_existing from rail_template_revisions where request_id = v_request for update;
  if found then
    if v_existing.actor_id <> p_actor_id or v_existing.request_digest <> v_digest then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    return rail_template_admission(v_existing);
  end if;

  select * into v_deal from deals where id = v_deal_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_deal.bank_id is distinct from p_company_id then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  perform rail_template_assert_source_actor(p_actor_id, v_deal_id);
  perform rail_template_assert_structure(p_actor_id, p_company_id);

  if rail_template_source_fingerprint(v_deal_id) is distinct from p_source_fingerprint then
    raise exception 'source_changed' using errcode = 'P0001';
  end if;

  perform rail_template_validate_manifest(p_manifest, v_deal_id);

  if v_kind = 'new' then
    if exists (
      select 1 from rail_templates t
       where t.company_id = p_company_id
         and t.current_revision_id is not null
         and t.normalized_name = rail_template_normalized_name(v_name)
    ) then
      raise exception 'name_taken' using errcode = 'P0001';
    end if;
    insert into rail_templates (tenant_id, company_id, name, created_by)
      values (v_deal.tenant_id, p_company_id, v_name, p_actor_id)
      returning id into v_template;
  else
    perform 1 from rail_templates where id = v_template for update;
    if not found then
      raise exception 'not_found' using errcode = 'P0001';
    end if;
    if (select company_id from rail_templates where id = v_template) is distinct from p_company_id then
      raise exception 'forbidden' using errcode = 'P0001';
    end if;
    if (select current_revision_id from rail_templates where id = v_template) is distinct from v_expected then
      raise exception 'stale_template' using errcode = 'P0001';
    end if;
  end if;

  begin
    insert into rail_template_revisions (
      template_id, actor_id, request_id, request_digest, command, source_deal_id,
      source_fingerprint, expected_revision_id, description, manifest
    ) values (
      v_template, p_actor_id, v_request, v_digest, p_command, v_deal_id,
      p_source_fingerprint, v_expected, v_description, p_manifest
    ) returning * into v_revision;
  exception when unique_violation then
    select * into v_existing from rail_template_revisions where request_id = v_request;
    if not found or v_existing.actor_id <> p_actor_id or v_existing.request_digest <> v_digest then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    return rail_template_admission(v_existing);
  end;

  return rail_template_admission(v_revision);
end;
$$;

revoke all on function rail_template_admit_save(uuid, uuid, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function rail_template_admit_save(uuid, uuid, jsonb, jsonb, text) to service_role;

create or replace function rail_template_finalize_save(
  p_actor_id uuid, p_request_id uuid, p_receipt jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_revision rail_template_revisions;
  v_deal     deals;
  v_company  uuid;
  v_skills   int;
begin
  select * into v_revision from rail_template_revisions
   where request_id = p_request_id for update;
  if not found or v_revision.actor_id <> p_actor_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_revision.state = 'ready' then
    return rail_template_summary(v_revision);
  end if;
  if v_revision.state <> 'preparing' then
    raise exception 'stale_template' using errcode = 'P0001';
  end if;

  v_skills := jsonb_array_length(v_revision.manifest -> 'skills');
  if jsonb_typeof(p_receipt) <> 'object'
     or rail_template_uuid(p_receipt ->> 'revisionId') is distinct from v_revision.id
     or jsonb_typeof(p_receipt -> 'assets') <> 'array'
     or jsonb_array_length(p_receipt -> 'assets') <> v_skills
     or (select count(distinct asset ->> 'key')
           from jsonb_array_elements(p_receipt -> 'assets') asset) <> v_skills
     or exists (
          select 1 from jsonb_array_elements(p_receipt -> 'assets') asset
           where coalesce(asset ->> 'packageDigest', '') !~ '^[0-9a-f]{64}$'
              or not exists (
                   select 1 from jsonb_array_elements(v_revision.manifest -> 'skills') skill
                    where skill ->> 'key' = asset ->> 'key')) then
    raise exception 'provider_unavailable' using errcode = 'P0001';
  end if;

  select * into v_deal from deals where id = v_revision.source_deal_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  select company_id into v_company from rail_templates where id = v_revision.template_id;
  if v_deal.bank_id is distinct from v_company then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  perform rail_template_assert_source_actor(p_actor_id, v_revision.source_deal_id);
  perform rail_template_assert_structure(p_actor_id, v_company);

  update rail_template_revisions
     set state = 'ready', provider_receipt = p_receipt
   where id = v_revision.id;

  begin
    update rail_templates
    set current_revision_id = v_revision.id, updated_at = now()
    where id = v_revision.template_id
      and current_revision_id is not distinct from v_revision.expected_revision_id;
    if not found then
      raise exception 'stale_template' using errcode = 'P0001';
    end if;
  exception when unique_violation then
    raise exception 'name_taken' using errcode = 'P0001';
  end;

  insert into audit_log (actor_id, action, deal_id, detail)
  values (
    p_actor_id,
    case when v_revision.expected_revision_id is null
      then 'rail.template_created' else 'rail.template_replaced' end,
    v_revision.source_deal_id,
    jsonb_strip_nulls(jsonb_build_object(
      'templateId', v_revision.template_id,
      'revisionId', v_revision.id,
      'previousRevisionId', v_revision.expected_revision_id,
      'companyId', v_company,
      'stepCount', jsonb_array_length(v_revision.manifest -> 'steps'),
      'skillCount', v_skills
    ))
  );

  select * into v_revision from rail_template_revisions where id = v_revision.id;
  return rail_template_summary(v_revision);
end;
$$;

revoke all on function rail_template_finalize_save(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function rail_template_finalize_save(uuid, uuid, jsonb) to service_role;
