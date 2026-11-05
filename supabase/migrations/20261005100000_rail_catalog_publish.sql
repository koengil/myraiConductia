-- Publishing a company catalog template writes a saved rail revision
-- (20260921100000). A revision now comes from a deal or from a catalog
-- template, carries a version number per template, and deal steps created
-- from a published template remember which template step they came from.

alter table rail_catalog_templates
  add column if not exists rail_template_id uuid unique references rail_templates (id);

alter table rail_template_revisions
  alter column source_deal_id drop not null,
  alter column source_fingerprint drop not null,
  add column if not exists source_catalog_template_id uuid references rail_catalog_templates (id),
  add column if not exists version int;

alter table rail_template_revisions drop constraint if exists rail_template_revisions_source_check;
alter table rail_template_revisions add constraint rail_template_revisions_source_check check (
  num_nonnulls(source_deal_id, source_catalog_template_id) = 1
  and (source_deal_id is null or source_fingerprint is not null)
);

alter table rail_template_revisions disable trigger rail_template_revisions_guard;

update rail_template_revisions r
   set version = ranked.version
  from (
    select id, row_number() over (partition by template_id order by created_at, id)::int as version
      from rail_template_revisions
  ) ranked
 where r.id = ranked.id
   and r.version is null;

alter table rail_template_revisions enable trigger rail_template_revisions_guard;

alter table rail_template_revisions alter column version set not null;
alter table rail_template_revisions drop constraint if exists rail_template_revisions_version_key;
alter table rail_template_revisions add constraint rail_template_revisions_version_key
  unique (template_id, version);
alter table rail_template_revisions drop constraint if exists rail_template_revisions_version_check;
alter table rail_template_revisions add constraint rail_template_revisions_version_check
  check (version >= 1);

alter table deal_steps add column if not exists template_step_key text;

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
     or new.source_deal_id is distinct from old.source_deal_id
     or new.source_catalog_template_id is distinct from old.source_catalog_template_id
     or new.source_fingerprint is distinct from old.source_fingerprint
     or new.expected_revision_id is distinct from old.expected_revision_id
     or new.description <> old.description
     or new.manifest <> old.manifest
     or new.version is distinct from old.version
     or new.created_at <> old.created_at then
    raise exception 'revision_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function rail_template_revision_guard() from public, anon, authenticated;

create or replace function rail_template_revision_admit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source_deal_id is not null and exists (
    select 1 from rail_catalog_templates c where c.rail_template_id = new.template_id
  ) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  if new.version is null then
    perform 1 from rail_templates where id = new.template_id for update;
    select coalesce(max(r.version), 0) + 1 into new.version
      from rail_template_revisions r
     where r.template_id = new.template_id;
  end if;
  return new;
end;
$$;

revoke all on function rail_template_revision_admit() from public, anon, authenticated;

drop trigger if exists rail_template_revisions_admit on rail_template_revisions;
create trigger rail_template_revisions_admit before insert on rail_template_revisions
  for each row execute function rail_template_revision_admit();

create or replace function rail_template_validate_manifest_shape(p_manifest jsonb)
returns void language plpgsql immutable set search_path = public as $$
declare
  v_steps  int;
  v_skills int;
begin
  if jsonb_typeof(p_manifest) is distinct from 'object'
     or coalesce(p_manifest -> 'schemaVersion', 'null'::jsonb) not in ('1'::jsonb, '2'::jsonb)
     or coalesce(btrim(p_manifest ->> 'censusVersion'), '') = ''
     or jsonb_typeof(p_manifest -> 'steps') is distinct from 'array'
     or jsonb_typeof(p_manifest -> 'skills') is distinct from 'array' then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  v_steps := jsonb_array_length(p_manifest -> 'steps');
  v_skills := jsonb_array_length(p_manifest -> 'skills');

  if v_steps = 0 then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_manifest -> 'steps') step
     where coalesce(step ->> 'key', '') !~ '^t[0-9]+$'
        or jsonb_typeof(step -> 'phaseIndex') is distinct from 'number'
        or step -> 'phaseIndex' < '1'::jsonb
        or jsonb_typeof(step -> 'displayOrder') is distinct from 'number'
        or (step ->> 'skillKey' is not null and not exists (
             select 1 from jsonb_array_elements(p_manifest -> 'skills') skill
              where skill ->> 'key' = step ->> 'skillKey'))
        or (p_manifest -> 'schemaVersion' = '2'::jsonb
            and coalesce(btrim(step ->> 'templateStepKey'), '') = '')
  ) then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  if (select count(distinct step ->> 'key') from jsonb_array_elements(p_manifest -> 'steps') step) <> v_steps
     or (select array_agg((step ->> 'displayOrder')::numeric order by (step ->> 'displayOrder')::numeric)
           from jsonb_array_elements(p_manifest -> 'steps') step)
        <> (select array_agg(ordinal::numeric) from generate_series(1, v_steps) ordinal)
     or (p_manifest -> 'schemaVersion' = '2'::jsonb
         and (select count(distinct step ->> 'templateStepKey')
                from jsonb_array_elements(p_manifest -> 'steps') step) <> v_steps) then
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
              or jsonb_typeof(skill -> 'source' -> 'version') is distinct from 'number'))
        or coalesce(btrim(skill -> 'contract' ->> 'purpose'), '') = ''
        or coalesce(btrim(skill -> 'contract' ->> 'expectedInput'), '') = ''
        or coalesce(btrim(skill -> 'contract' ->> 'expectedOutput'), '') = ''
  ) or (select count(distinct skill ->> 'key') from jsonb_array_elements(p_manifest -> 'skills') skill)
       <> v_skills then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function rail_template_validate_manifest_shape(jsonb) from public, anon, authenticated;
grant execute on function rail_template_validate_manifest_shape(jsonb) to service_role;

create or replace function rail_template_validate_manifest(p_manifest jsonb, p_deal_id uuid)
returns void language plpgsql stable security definer set search_path = public as $$
declare
  v_active int;
begin
  perform rail_template_validate_manifest_shape(p_manifest);

  if p_manifest ->> 'censusVersion' is distinct from rail_template_census_version(p_deal_id) then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  select count(*) into v_active
    from deal_steps where deal_id = p_deal_id and removed_at is null;
  if jsonb_array_length(p_manifest -> 'steps') <> v_active then
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
end;
$$;

revoke all on function rail_template_validate_manifest(jsonb, uuid) from public, anon, authenticated;
grant execute on function rail_template_validate_manifest(jsonb, uuid) to service_role;

create or replace function rail_catalog_census_version() returns text
language sql immutable as $$
  select 'hv-5x65-2026-07-08'::text;
$$;

revoke all on function rail_catalog_census_version() from public, anon, authenticated;
grant execute on function rail_catalog_census_version() to service_role;

create or replace function rail_catalog_manifest_steps(p_template_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', 't' || (s.ordinal - 1),
    'templateStepKey', s.step_id,
    'catalogStepId', case when s.origin = 'catalog' then s.step_id end,
    'seq', case when s.origin = 'catalog' then s.seq end,
    'phaseIndex', s.phase_index,
    'displayOrder', s.ordinal,
    'definition', case when s.origin = 'custom' then jsonb_build_object(
      'title', coalesce(s.definition ->> 'title', ''),
      'description', coalesce(s.definition ->> 'description', '')) end,
    'skillKey', null::text
  ) order by s.ordinal), '[]'::jsonb)
  from (
    select step.step_id, step.seq, step.phase_index, step.origin, step.definition,
           row_number() over (order by step.display_order, step.id) as ordinal
      from rail_catalog_steps step
     where step.template_id = p_template_id
  ) s;
$$;

revoke all on function rail_catalog_manifest_steps(uuid) from public, anon, authenticated;
grant execute on function rail_catalog_manifest_steps(uuid) to service_role;

create or replace function rail_catalog_manifest(p_template_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'schemaVersion', 2,
    'censusVersion', rail_catalog_census_version(),
    'steps', rail_catalog_manifest_steps(p_template_id),
    'skills', '[]'::jsonb
  );
$$;

revoke all on function rail_catalog_manifest(uuid) from public, anon, authenticated;
grant execute on function rail_catalog_manifest(uuid) to service_role;

create or replace function rail_catalog_draft_differs(p_template_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select rail_catalog_manifest_steps(p_template_id) is distinct from (
    select r.manifest -> 'steps'
      from rail_catalog_templates c
      join rail_templates t on t.id = c.rail_template_id
      join rail_template_revisions r on r.id = t.current_revision_id
     where c.id = p_template_id
  );
$$;

revoke all on function rail_catalog_draft_differs(uuid) from public, anon, authenticated;
grant execute on function rail_catalog_draft_differs(uuid) to service_role;

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
  'rail.step_rebound', 'rail.template_created', 'rail.template_replaced', 'rail.template_applied',
  'discovery.candidate_proposed', 'discovery.candidate_promoted', 'discovery.correction',
  'discovery.milestone_extracted', 'discovery.stage_assessed', 'discovery.mailbox_consented',
  'discovery.mailbox_consent_withdrawn', 'discovery.mailbox_refused', 'discovery.allowlist_drift',
  'discovery.site_registered', 'discovery.site_unregistered', 'discovery.site_refused',
  'discovery.mailbox_source_archived', 'discovery.mailbox_sources_unified', 'profile_provisioned',
  'identity_provider_configured', 'identity_provider_removed', 'work_identity_released', 'work_identity_connected',
  'discovery.mailbox_access_changed', 'discovery.exclusion_policy_changed', 'rail.template_published'
])) not valid;

create or replace function publish_rail_template(
  p_template_id   uuid,
  p_company_id    uuid,
  p_actor_id      uuid,
  p_protected_ids text[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_catalog  rail_catalog_templates;
  v_manifest jsonb;
  v_steps    int;
  v_template uuid;
  v_previous uuid;
  v_tenant   uuid;
  v_request  uuid := gen_random_uuid();
  v_revision rail_template_revisions;
begin
  select * into v_catalog from rail_catalog_templates
   where id = p_template_id and company_id = p_company_id
   for update;
  if not found then
    raise exception 'template_missing' using errcode = 'P0003';
  end if;
  if v_catalog.deleted_at is not null then
    raise exception 'template_removed' using errcode = 'P0003';
  end if;

  v_manifest := rail_catalog_manifest(p_template_id);
  v_steps := jsonb_array_length(v_manifest -> 'steps');

  if v_catalog.rail_template_id is not null then
    select id, current_revision_id into v_template, v_previous
      from rail_templates where id = v_catalog.rail_template_id
      for update;
  end if;

  if not rail_catalog_draft_differs(p_template_id) then
    raise exception 'nothing_to_publish' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from unnest(coalesce(p_protected_ids, array[]::text[])) protected_id
     where not exists (
       select 1 from rail_catalog_steps s
        where s.template_id = p_template_id
          and s.origin = 'catalog'
          and s.step_id = protected_id)
  ) then
    raise exception 'missing_protected_step' using errcode = 'P0004';
  end if;

  perform rail_template_validate_manifest_shape(v_manifest);

  if v_template is null then
    if exists (
      select 1 from rail_templates t
       where t.company_id = p_company_id
         and t.current_revision_id is not null
         and t.normalized_name = rail_template_normalized_name(v_catalog.name)
    ) then
      raise exception 'name_taken' using errcode = 'P0002';
    end if;
    select tenant_id into v_tenant from companies where id = p_company_id;
    insert into rail_templates (tenant_id, company_id, name, created_by)
      values (v_tenant, p_company_id, v_catalog.name, p_actor_id)
      returning id into v_template;
    update rail_catalog_templates set rail_template_id = v_template where id = p_template_id;
  end if;

  insert into rail_template_revisions (
    template_id, actor_id, request_id, request_digest, command,
    source_catalog_template_id, expected_revision_id, manifest, state
  ) values (
    v_template, p_actor_id, v_request,
    encode(sha256(convert_to(v_request::text, 'UTF8')), 'hex'),
    jsonb_build_object('kind', 'publish', 'catalogTemplateId', p_template_id),
    p_template_id, v_previous, v_manifest, 'ready'
  ) returning * into v_revision;

  begin
    update rail_templates
       set current_revision_id = v_revision.id, updated_at = now()
     where id = v_template;
  exception when unique_violation then
    raise exception 'name_taken' using errcode = 'P0002';
  end;

  insert into audit_log (actor_id, action, detail)
  values (p_actor_id, 'rail.template_published', jsonb_build_object(
    'catalogTemplateId', p_template_id,
    'templateId', v_template,
    'revisionId', v_revision.id,
    'previousRevisionId', v_previous,
    'version', v_revision.version,
    'stepCount', v_steps
  ));

  return jsonb_build_object(
    'templateId', v_template,
    'revisionId', v_revision.id,
    'version', v_revision.version,
    'stepCount', v_steps
  );
end;
$$;

revoke all on function publish_rail_template(uuid, uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function publish_rail_template(uuid, uuid, uuid, text[]) to service_role;

create or replace function rail_catalog_publication(p_template_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'published', (
      select jsonb_build_object(
        'version', r.version,
        'revisionId', r.id,
        'publishedAt', to_char(r.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        from rail_catalog_templates c
        join rail_templates t on t.id = c.rail_template_id
        join rail_template_revisions r on r.id = t.current_revision_id
       where c.id = p_template_id),
    'hasUnpublishedChanges', rail_catalog_draft_differs(p_template_id)
  );
$$;

revoke all on function rail_catalog_publication(uuid) from public, anon, authenticated;
grant execute on function rail_catalog_publication(uuid) to service_role;

create or replace function delete_rail_template(
  p_company_id  uuid,
  p_actor_id    uuid,
  p_template_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name     text;
  v_template uuid;
begin
  update rail_catalog_templates
    set deleted_at = now()
    where id = p_template_id
      and company_id = p_company_id
      and deleted_at is null
    returning name, rail_template_id into v_name, v_template;
  if not found then
    raise exception 'template_missing' using errcode = 'P0003';
  end if;

  if v_template is not null then
    update rail_templates
       set current_revision_id = null, updated_at = now()
     where id = v_template;
  end if;

  insert into audit_log (actor_id, action, detail)
    values (
      p_actor_id,
      'update',
      jsonb_build_object('railTemplate', p_template_id, 'name', v_name, 'removed', true)
    );

  return jsonb_build_object('id', p_template_id, 'deleted', true);
end;
$$;

revoke all on function delete_rail_template(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function delete_rail_template(uuid, uuid, uuid) to service_role;

create or replace function rail_template_finalize_creation(
  p_actor_id uuid, p_request_id uuid, p_imports jsonb, p_seed jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_creation  rail_template_creations;
  v_revision  rail_template_revisions;
  v_manifest  jsonb;
  v_assets    jsonb;
  v_bindings  jsonb;
  v_name      text;
  v_input     jsonb;
  v_result    jsonb;
  v_receipt   jsonb;
  v_deal      uuid;
begin
  select * into v_creation from rail_template_creations
   where request_id = p_request_id for update;
  if not found or v_creation.actor_id <> p_actor_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_creation.state = 'ready' then
    return v_creation.receipt;
  end if;

  perform rail_template_assert_create(p_actor_id, v_creation.company_id);

  select * into v_revision from rail_template_revisions where id = v_creation.revision_id;
  if not found or v_revision.state <> 'ready' then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  v_manifest := v_revision.manifest;
  v_assets := coalesce(v_revision.provider_receipt -> 'assets', '[]'::jsonb);
  select name into v_name from rail_templates where id = v_revision.template_id;

  if jsonb_typeof(p_imports) <> 'object'
     or rail_template_uuid(p_imports ->> 'requestId') is distinct from p_request_id
     or rail_template_uuid(p_imports ->> 'projectId') is distinct from v_creation.reserved_deal_id
     or jsonb_typeof(p_imports -> 'skills') <> 'array'
     or jsonb_array_length(p_imports -> 'skills') <> jsonb_array_length(v_creation.targets)
     or (select count(distinct skill ->> 'key')
           from jsonb_array_elements(p_imports -> 'skills') skill)
        <> jsonb_array_length(v_creation.targets)
     or exists (
          select 1 from jsonb_array_elements(p_imports -> 'skills') skill
           where coalesce(skill -> 'binding' ->> 'digest', '') !~ '^[0-9a-f]{64}$'
              or not exists (
                   select 1 from jsonb_array_elements(v_creation.targets) target
                    where target ->> 'key' = skill ->> 'key'
                      and target ->> 'skillId' = skill -> 'binding' ->> 'skillId'
                      and target ->> 'versionId' = skill -> 'binding' ->> 'versionId')
              or not exists (
                   select 1 from jsonb_array_elements(v_assets) asset
                    where asset ->> 'key' = skill ->> 'key'
                      and asset ->> 'packageDigest' = skill -> 'binding' ->> 'digest')) then
    raise exception 'provider_unavailable' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_object_agg(skill ->> 'key', jsonb_build_object(
    'skillId', skill -> 'binding' ->> 'skillId',
    'versionId', skill -> 'binding' ->> 'versionId',
    'digest', skill -> 'binding' ->> 'digest')), '{}'::jsonb) into v_bindings
    from jsonb_array_elements(p_imports -> 'skills') skill;

  perform rail_template_validate_seed(v_manifest, p_seed, v_creation.step_ids, v_bindings);

  v_input := v_creation.input;
  v_deal := v_creation.reserved_deal_id;

  v_result := create_deal_gate0_core(
    p_tenant_id            => v_creation.tenant_id,
    p_actor_id             => p_actor_id,
    p_bank_id              => v_creation.company_id,
    p_codename             => v_input ->> 'codename',
    p_target_name          => v_input ->> 'targetName',
    p_target_company_id    => rail_template_uuid(v_input ->> 'targetCompanyId'),
    p_codename_theme       => v_input ->> 'codenameTheme',
    p_entry_step_seq       => 1,
    p_entry_phase          => 1,
    p_members              => coalesce(v_input -> 'members', '[]'::jsonb),
    p_screening            => coalesce(v_input -> 'screening', '{}'::jsonb),
    p_steps                => '[]'::jsonb,
    p_census_version       => v_manifest ->> 'censusVersion',
    p_conflicts            => coalesce(v_input -> 'conflicts', '{}'::jsonb),
    p_reserved_deal_id     => v_deal,
    p_template_seed        => p_seed,
    p_template_revision_id => v_creation.revision_id,
    p_template_name        => v_name
  );

  update deal_steps s
     set template_step_key = step ->> 'templateStepKey'
    from jsonb_array_elements(v_manifest -> 'steps') step
   where s.deal_id = v_deal
     and s.id = rail_template_uuid(v_creation.step_ids ->> (step ->> 'key'))
     and coalesce(step ->> 'templateStepKey', '') <> '';

  insert into deal_step_skill_bindings (
    deal_step_id, deal_id, kind, skill_id, version_id, digest, bound_by, source
  )
  select (seed_row ->> 'id')::uuid, v_deal, 'publication',
         (seed_row -> 'binding' ->> 'skillId')::uuid, (seed_row -> 'binding' ->> 'versionId')::uuid,
         seed_row -> 'binding' ->> 'digest', p_actor_id, 'template'
    from jsonb_array_elements(p_seed) seed_row
   where jsonb_typeof(seed_row -> 'binding') = 'object';

  insert into deal_skill_imports (
    skill_id, deal_id, version_id, digest, name, capability_contract,
    imported_by, template_revision_id, source_asset_key
  )
  select (v_bindings -> (skill ->> 'key') ->> 'skillId')::uuid, v_deal,
         (v_bindings -> (skill ->> 'key') ->> 'versionId')::uuid,
         v_bindings -> (skill ->> 'key') ->> 'digest',
         skill ->> 'name', skill -> 'contract',
         p_actor_id, v_creation.revision_id, skill ->> 'key'
    from jsonb_array_elements(v_manifest -> 'skills') skill;

  insert into audit_log (actor_id, action, deal_id, detail)
  values (p_actor_id, 'rail.template_applied', v_deal, jsonb_build_object(
    'templateId', v_revision.template_id,
    'revisionId', v_creation.revision_id,
    'companyId', v_creation.company_id,
    'stepCount', jsonb_array_length(v_manifest -> 'steps'),
    'skillCount', jsonb_array_length(v_manifest -> 'skills')
  ));

  v_receipt := v_result || jsonb_build_object(
    'screening', coalesce(v_input -> 'screening', '{}'::jsonb));

  update rail_template_creations
     set state = 'ready', receipt = v_receipt
   where request_id = p_request_id;

  return v_receipt;
end;
$$;

revoke all on function rail_template_finalize_creation(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function rail_template_finalize_creation(uuid, uuid, jsonb, jsonb) to service_role;

