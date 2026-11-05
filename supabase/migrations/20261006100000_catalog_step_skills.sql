-- Skills on catalog steps (sub-project 3, slice 1; ADR-0024). A catalog step's
-- definition can hold a skill block. The draft manifest lists those skills,
-- publish stores the retain receipt under a revision id the route mints, and
-- accepting an added step inserts a real skill step from one imported skill.

create or replace function rail_catalog_skill_keys(p_template_id uuid)
returns table (skill_key text, source jsonb, skill jsonb)
language sql stable security definer set search_path = public as $$
  select 's' || (row_number() over (order by d.first_order) - 1), d.source, d.skill
    from (
      select step.definition -> 'skill' -> 'source' as source,
             (array_agg(step.definition -> 'skill' order by step.display_order, step.id))[1] as skill,
             min(step.display_order) as first_order
        from rail_catalog_steps step
       where step.template_id = p_template_id
         and jsonb_typeof(step.definition -> 'skill' -> 'source') = 'object'
       group by step.definition -> 'skill' -> 'source'
    ) d;
$$;

revoke all on function rail_catalog_skill_keys(uuid) from public, anon, authenticated;
grant execute on function rail_catalog_skill_keys(uuid) to service_role;

create or replace function rail_catalog_manifest_skills(p_template_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', k.skill_key,
    'name', k.skill ->> 'name',
    'contract', k.skill -> 'contract',
    'source', k.source
  ) order by substr(k.skill_key, 2)::int), '[]'::jsonb)
  from rail_catalog_skill_keys(p_template_id) k;
$$;

revoke all on function rail_catalog_manifest_skills(uuid) from public, anon, authenticated;
grant execute on function rail_catalog_manifest_skills(uuid) to service_role;

create or replace function rail_catalog_manifest_steps(p_template_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', 't' || (s.ordinal - 1),
    'templateStepKey', s.step_id,
    'catalogStepId', case when s.origin = 'catalog' then s.step_id end,
    'seq', case when s.origin = 'catalog' then s.seq end,
    'phaseIndex', s.phase_index,
    'displayOrder', s.ordinal,
    'definition', case
      when s.origin <> 'custom' then null
      when s.skill_key is not null then s.definition - 'skill'
      else jsonb_build_object(
        'title', coalesce(s.definition ->> 'title', ''),
        'description', coalesce(s.definition ->> 'description', '')) end,
    'skillKey', s.skill_key
  ) order by s.ordinal), '[]'::jsonb)
  from (
    select step.step_id, step.seq, step.phase_index, step.origin, step.definition,
           k.skill_key,
           row_number() over (order by step.display_order, step.id) as ordinal
      from rail_catalog_steps step
      left join rail_catalog_skill_keys(p_template_id) k
        on k.source = step.definition -> 'skill' -> 'source'
     where step.template_id = p_template_id
  ) s;
$$;

create or replace function rail_catalog_manifest(p_template_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'schemaVersion', 2,
    'censusVersion', rail_catalog_census_version(),
    'steps', rail_catalog_manifest_steps(p_template_id),
    'skills', rail_catalog_manifest_skills(p_template_id)
  );
$$;

create or replace function rail_catalog_draft_differs(p_template_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           'steps', rail_catalog_manifest_steps(p_template_id),
           'skills', rail_catalog_manifest_skills(p_template_id))
         is distinct from (
    select jsonb_build_object('steps', r.manifest -> 'steps', 'skills', r.manifest -> 'skills')
      from rail_catalog_templates c
      join rail_templates t on t.id = c.rail_template_id
      join rail_template_revisions r on r.id = t.current_revision_id
     where c.id = p_template_id
  );
$$;

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
        or coalesce(skill -> 'source' ->> 'kind', '') not in ('publication', 'mount', 'candidate')
        or (skill -> 'source' ->> 'kind' = 'publication' and (
              rail_template_uuid(skill -> 'source' ->> 'skillId') is null
              or rail_template_uuid(skill -> 'source' ->> 'versionId') is null))
        or (skill -> 'source' ->> 'kind' = 'mount' and (
              coalesce(btrim(skill -> 'source' ->> 'name'), '') = ''
              or jsonb_typeof(skill -> 'source' -> 'version') is distinct from 'number'))
        or (skill -> 'source' ->> 'kind' = 'candidate'
            and rail_template_uuid(skill -> 'source' ->> 'candidateId') is null)
        or coalesce(btrim(skill -> 'contract' ->> 'purpose'), '') = ''
        or coalesce(btrim(skill -> 'contract' ->> 'expectedInput'), '') = ''
        or coalesce(btrim(skill -> 'contract' ->> 'expectedOutput'), '') = ''
  ) or (select count(distinct skill ->> 'key') from jsonb_array_elements(p_manifest -> 'skills') skill)
       <> v_skills then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function set_rail_template_step_description(
  p_company_id  uuid,
  p_actor_id    uuid,
  p_template_id uuid,
  p_step_row_id uuid,
  p_description text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_description text := btrim(coalesce(p_description, ''));
  v_previous    text;
  v_step        rail_catalog_steps;
  v_title       text;
  v_before      jsonb;
begin
  perform 1 from rail_catalog_templates
    where id = p_template_id and company_id = p_company_id
    for update;
  if not found then
    raise exception 'template_missing' using errcode = 'P0003';
  end if;

  if char_length(v_description) > 4000 then
    raise exception 'template_step' using errcode = 'P0001';
  end if;

  select * into v_step from rail_catalog_steps
    where id = p_step_row_id and template_id = p_template_id;
  if v_step.id is null then
    raise exception 'template_step_missing' using errcode = 'P0003';
  end if;

  if v_step.definition ->> 'type' = 'skill'
     and (v_description = '' or char_length(v_description) > 2000) then
    raise exception 'skill_step_description' using errcode = 'P0001';
  end if;

  v_previous := coalesce(v_step.definition->>'description', '');
  v_title := coalesce(nullif(btrim(v_step.definition->>'title'), ''), v_step.step_id);
  v_before := rail_template_step_snapshot(v_step) || jsonb_build_object('description', v_previous);

  update rail_catalog_steps
     set definition = coalesce(definition, '{}'::jsonb) || jsonb_build_object('description', v_description)
   where id = p_step_row_id
   returning * into v_step;

  perform record_rail_template_change(
    p_template_id, p_company_id, p_actor_id, 'set_description',
    format('Updated the description of "%s"', v_title),
    v_before,
    rail_template_step_snapshot(v_step) || jsonb_build_object('description', v_description),
    null
  );

  insert into audit_log (actor_id, action, detail)
    values (
      p_actor_id,
      'update',
      jsonb_build_object(
        'railTemplate', p_template_id,
        'rail', 'describe',
        'stepId', p_step_row_id,
        'stepKey', v_step.step_id
      )
    );

  return jsonb_build_object('id', v_step.id, 'description', v_description);
end;
$$;

create or replace function rail_catalog_publish_check(
  p_template_id   uuid,
  p_company_id    uuid,
  p_protected_ids text[]
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_catalog  rail_catalog_templates;
  v_manifest jsonb;
begin
  select * into v_catalog from rail_catalog_templates
   where id = p_template_id and company_id = p_company_id;
  if not found then
    raise exception 'template_missing' using errcode = 'P0003';
  end if;
  if v_catalog.deleted_at is not null then
    raise exception 'template_removed' using errcode = 'P0003';
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

  v_manifest := rail_catalog_manifest(p_template_id);
  perform rail_template_validate_manifest_shape(v_manifest);

  if v_catalog.rail_template_id is null and exists (
    select 1 from rail_templates t
     where t.company_id = p_company_id
       and t.current_revision_id is not null
       and t.normalized_name = rail_template_normalized_name(v_catalog.name)
  ) then
    raise exception 'name_taken' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'tenantId', (select tenant_id from companies where id = p_company_id),
    'manifest', v_manifest);
end;
$$;

revoke all on function rail_catalog_publish_check(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function rail_catalog_publish_check(uuid, uuid, text[]) to service_role;

drop function if exists publish_rail_template(uuid, uuid, uuid, text[]);

create or replace function publish_rail_template(
  p_template_id   uuid,
  p_company_id    uuid,
  p_actor_id      uuid,
  p_protected_ids text[],
  p_revision_id   uuid default null,
  p_receipt       jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_catalog  rail_catalog_templates;
  v_manifest jsonb;
  v_skills   jsonb;
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

  if v_catalog.rail_template_id is not null then
    select id, current_revision_id into v_template, v_previous
      from rail_templates where id = v_catalog.rail_template_id
      for update;
  end if;

  v_manifest := rail_catalog_publish_check(p_template_id, p_company_id, p_protected_ids) -> 'manifest';
  v_steps := jsonb_array_length(v_manifest -> 'steps');
  v_skills := v_manifest -> 'skills';

  if jsonb_array_length(v_skills) = 0 then
    if p_revision_id is not null or p_receipt is not null then
      raise exception 'draft_changed' using errcode = 'P0002';
    end if;
  elsif p_revision_id is null
     or jsonb_typeof(p_receipt) is distinct from 'object'
     or jsonb_typeof(p_receipt -> 'assets') is distinct from 'array' then
    raise exception 'draft_changed' using errcode = 'P0002';
  elsif rail_template_uuid(p_receipt ->> 'revisionId') is distinct from p_revision_id
     or jsonb_array_length(p_receipt -> 'assets') <> jsonb_array_length(v_skills)
     or exists (
          select 1 from jsonb_array_elements(v_skills) skill
           where not exists (
             select 1 from jsonb_array_elements(p_receipt -> 'assets') asset
              where asset ->> 'key' = skill ->> 'key'
                and coalesce(asset ->> 'packageDigest', '') ~ '^[0-9a-f]{64}$'
                and (skill -> 'source' ->> 'kind' = 'mount'
                     or asset ->> 'packageDigest' = skill -> 'source' ->> 'digest'))) then
    raise exception 'draft_changed' using errcode = 'P0002';
  end if;

  if v_template is null then
    select tenant_id into v_tenant from companies where id = p_company_id;
    insert into rail_templates (tenant_id, company_id, name, created_by)
      values (v_tenant, p_company_id, v_catalog.name, p_actor_id)
      returning id into v_template;
    update rail_catalog_templates set rail_template_id = v_template where id = p_template_id;
  end if;

  insert into rail_template_revisions (
    id, template_id, actor_id, request_id, request_digest, command,
    source_catalog_template_id, expected_revision_id, manifest, state, provider_receipt
  ) values (
    coalesce(p_revision_id, gen_random_uuid()), v_template, p_actor_id, v_request,
    encode(sha256(convert_to(v_request::text, 'UTF8')), 'hex'),
    jsonb_build_object('kind', 'publish', 'catalogTemplateId', p_template_id),
    p_template_id, v_previous, v_manifest, 'ready', p_receipt
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
    'stepCount', v_steps,
    'skillCount', jsonb_array_length(v_skills)
  ));

  perform rail_template_notify_deals(v_revision.id, p_actor_id, p_protected_ids);

  return jsonb_build_object(
    'templateId', v_template,
    'revisionId', v_revision.id,
    'version', v_revision.version,
    'stepCount', v_steps,
    'skillCount', jsonb_array_length(v_skills)
  );
end;
$$;

revoke all on function publish_rail_template(uuid, uuid, uuid, text[], uuid, jsonb)
  from public, anon, authenticated;
grant execute on function publish_rail_template(uuid, uuid, uuid, text[], uuid, jsonb) to service_role;

create or replace function deal_template_change_skill(
  p_deal_id       uuid,
  p_change_id     text,
  p_revision_id   uuid,
  p_protected_ids text[]
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_key  text := substr(p_change_id, strpos(p_change_id, ':') + 1);
  v_set  jsonb;
  v_step jsonb;
begin
  v_set := deal_template_changes(p_deal_id, p_protected_ids);
  if p_revision_id is null
     or p_revision_id is distinct from (v_set -> 'currentRevision' ->> 'id')::uuid then
    raise exception 'stale_change' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from jsonb_array_elements(coalesce(v_set -> 'changes', '[]'::jsonb)) as change
     where change ->> 'id' = p_change_id
       and change ->> 'kind' = 'added'
       and change -> 'decision' = 'null'::jsonb
  ) then
    raise exception 'stale_change' using errcode = 'P0001';
  end if;

  select step into v_step
    from rail_template_revisions r,
         jsonb_array_elements(r.manifest -> 'steps') as step
   where r.id = (v_set -> 'currentRevision' ->> 'id')::uuid
     and step ->> 'templateStepKey' = v_key;

  return jsonb_build_object(
    'tenantId', (select tenant_id from deals where id = p_deal_id),
    'revisionId', v_set -> 'currentRevision' ->> 'id',
    'skillKey', v_step ->> 'skillKey');
end;
$$;

revoke all on function deal_template_change_skill(uuid, text, uuid, text[]) from public, anon, authenticated;
grant execute on function deal_template_change_skill(uuid, text, uuid, text[]) to service_role;

drop function if exists deal_template_change_decide(uuid, uuid, text, text, text[]);
drop function if exists deal_template_change_decide(uuid, uuid, text, text, uuid, text[]);

create or replace function deal_template_change_decide(
  p_deal_id       uuid,
  p_actor_id      uuid,
  p_change_id     text,
  p_decision      text,
  p_revision_id   uuid,
  p_protected_ids text[],
  p_import        jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind     text := split_part(p_change_id, ':', 1);
  v_key      text := substr(p_change_id, strpos(p_change_id, ':') + 1);
  v_set      jsonb;
  v_change   jsonb;
  v_current  rail_template_revisions;
  v_step     jsonb;
  v_catalog  text;
  v_anchor   uuid;
  v_row      uuid;
  v_inserted uuid;
  v_placed   uuid;
  v_target   uuid;
  v_target_order int;
  v_new_order    int;
  v_skill_key text;
  v_digest    text;
  v_binding   jsonb;
begin
  if p_decision is null or p_decision not in ('accepted', 'discarded') then
    raise exception 'invalid_decision' using errcode = '22023';
  end if;

  perform 1 from deals where id = p_deal_id for update;
  if not found then
    raise exception 'deal % not found', p_deal_id using errcode = 'P0001';
  end if;

  v_set := deal_template_changes(p_deal_id, p_protected_ids);
  if p_revision_id is null
     or p_revision_id is distinct from (v_set -> 'currentRevision' ->> 'id')::uuid then
    raise exception 'stale_change' using errcode = 'P0001';
  end if;

  select change into v_change
    from jsonb_array_elements(coalesce(v_set -> 'changes', '[]'::jsonb)) as change
   where change ->> 'id' = p_change_id
     and change -> 'decision' = 'null'::jsonb;
  if v_change is null then
    raise exception 'stale_change' using errcode = 'P0001';
  end if;

  select * into v_current from rail_template_revisions
   where id = (v_set -> 'currentRevision' ->> 'id')::uuid;

  if p_import is not null and not (p_decision = 'accepted' and v_kind = 'added') then
    raise exception 'skill_import_mismatch' using errcode = 'P0001';
  end if;

  if p_decision = 'accepted' and v_kind = 'added' then
    select step into v_step
      from jsonb_array_elements(v_current.manifest -> 'steps') as step
     where step ->> 'templateStepKey' = v_key;

    v_skill_key := v_step ->> 'skillKey';
    if v_skill_key is null then
      if p_import is not null then
        raise exception 'skill_import_mismatch' using errcode = 'P0001';
      end if;
    else
      select asset ->> 'packageDigest' into v_digest
        from jsonb_array_elements(coalesce(v_current.provider_receipt -> 'assets', '[]'::jsonb)) asset
       where asset ->> 'key' = v_skill_key;
      if v_digest is null
         or jsonb_typeof(p_import) is distinct from 'object'
         or p_import ->> 'key' is distinct from v_skill_key
         or rail_template_uuid(p_import ->> 'requestId') is null
         or rail_template_uuid(p_import -> 'binding' ->> 'skillId') is null
         or rail_template_uuid(p_import -> 'binding' ->> 'versionId') is null
         or p_import -> 'binding' ->> 'digest' is distinct from v_digest then
        raise exception 'skill_import_mismatch' using errcode = 'P0001';
      end if;
      v_binding := jsonb_build_object(
        'skillId', p_import -> 'binding' ->> 'skillId',
        'versionId', p_import -> 'binding' ->> 'versionId',
        'digest', v_digest);
    end if;

    select id into v_anchor from deal_steps
     where deal_id = p_deal_id
       and removed_at is null
       and step_id = v_change -> 'anchor' ->> 'stepId';

    select s.id into v_target
      from deal_steps s
      join deal_steps a on a.id = v_anchor
     where s.deal_id = p_deal_id
       and s.removed_at is null
       and s.display_order >= a.display_order
       and not exists (
         select 1 from deal_steps b
          where b.deal_id = p_deal_id
            and b.removed_at is null
            and b.display_order > a.display_order
            and b.display_order <= s.display_order
            and (b.template_step_key is not null or b.anchor_step_id is distinct from v_anchor))
     order by s.display_order desc
     limit 1;

    select id into v_row from deal_steps
     where deal_id = p_deal_id
       and template_step_key = v_key
       and removed_at is not null
       and removed_by is null;

    if v_row is not null then
      update deal_steps set anchor_step_id = v_target where id = v_row;
      perform rail_restore_step(p_deal_id, p_actor_id, v_row);
      update deal_steps set anchor_step_id = null where id = v_row;
      v_placed := v_row;
    else
      v_catalog := v_step ->> 'catalogStepId';
      v_inserted := (rail_insert_step(
        p_deal_id,
        p_actor_id,
        (v_step ->> 'phaseIndex')::int,
        case when v_anchor is null then 'phase_start' else 'after' end,
        v_anchor,
        case
          when v_catalog is not null then null
          when v_binding is not null
            then (v_step -> 'definition') || jsonb_build_object('skillBinding', v_binding)
          else jsonb_build_object(
            'title', coalesce(v_step -> 'definition' ->> 'title', v_key),
            'description', coalesce(v_step -> 'definition' ->> 'description', '')) end,
        v_catalog
      ) ->> 'stepId')::uuid;

      update deal_steps
         set template_step_key = v_key,
             origin = case when v_catalog is null then 'custom' else 'catalog' end,
             seq = case when v_catalog is null then null else (v_step ->> 'seq')::int end,
             anchor_step_id = null,
             census_version = case when v_catalog is null then null
                                   else v_current.manifest ->> 'censusVersion' end
       where id = v_inserted;

      if v_target is not null then
        select display_order into v_target_order from deal_steps where id = v_target;
        select display_order into v_new_order from deal_steps where id = v_inserted;
        if v_new_order > v_target_order + 1 then
          update deal_steps set display_order = display_order + 1
           where deal_id = p_deal_id
             and display_order > v_target_order
             and display_order < v_new_order;
          update deal_steps set display_order = v_target_order + 1 where id = v_inserted;
        end if;
      end if;
      v_placed := v_inserted;
    end if;

    if v_binding is not null then
      insert into deal_step_skill_bindings (
        deal_step_id, deal_id, kind, skill_id, version_id, digest, bound_by, source
      ) values (
        v_placed, p_deal_id, 'publication',
        (v_binding ->> 'skillId')::uuid, (v_binding ->> 'versionId')::uuid,
        v_binding ->> 'digest', p_actor_id, 'template'
      );

      insert into deal_skill_imports (
        skill_id, deal_id, version_id, digest, name, capability_contract,
        imported_by, template_revision_id, source_asset_key
      )
      select (v_binding ->> 'skillId')::uuid, p_deal_id, (v_binding ->> 'versionId')::uuid,
             v_binding ->> 'digest', skill ->> 'name', skill -> 'contract',
             p_actor_id, v_current.id, v_skill_key
        from jsonb_array_elements(v_current.manifest -> 'skills') skill
       where skill ->> 'key' = v_skill_key;
    end if;
  elsif p_decision = 'accepted' then
    select id into v_row from deal_steps
     where deal_id = p_deal_id and template_step_key = v_key and removed_at is null;
    perform rail_remove_step(p_deal_id, p_actor_id, v_row, p_protected_ids);
  end if;

  insert into deal_template_change_decisions (deal_id, step_key, kind, decision, revision_id, actor_id)
    values (p_deal_id, v_key, v_kind, p_decision, v_current.id, p_actor_id);

  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'update', p_deal_id, jsonb_build_object(
      'rail', 'template_change',
      'decision', p_decision,
      'kind', v_kind,
      'stepKey', v_key,
      'templateId', v_set -> 'template' ->> 'id',
      'revisionId', v_current.id)
      || case when v_binding is null then '{}'::jsonb
              else jsonb_build_object(
                'skillId', v_binding ->> 'skillId',
                'versionId', v_binding ->> 'versionId') end);

  return deal_template_changes(p_deal_id, p_protected_ids);
end;
$$;

revoke all on function deal_template_change_decide(uuid, uuid, text, text, uuid, text[], jsonb)
  from public, anon, authenticated;
grant execute on function deal_template_change_decide(uuid, uuid, text, text, uuid, text[], jsonb) to service_role;
