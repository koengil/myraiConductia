
begin;
-- #316: new auth users are contained; promote each fixture the way the seed
-- script does (authorize_provisioned_profile over its metadata) and give it a
-- live session whose id is the user id, so impersonating claims can carry
-- session_id = sub.
create or replace function pg_temp.authorize_fixture() returns trigger language plpgsql as $fx$
begin
  perform public.authorize_provisioned_profile(new.id, new.raw_user_meta_data);
  insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values (new.id, new.id, now(), now(), 'aal1') on conflict (id) do nothing;
  return new;
end
$fx$;
drop trigger if exists zz_authorize_fixture on auth.users;
create trigger zz_authorize_fixture after insert on auth.users
  for each row execute function pg_temp.authorize_fixture();

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into feature_flags (key, enabled) values ('company_access_management', true)
  on conflict (key) do update set enabled = true;

create function rcp_bank(p_tenant uuid, p_label text) returns uuid
language plpgsql as $$
declare v_bank uuid := gen_random_uuid();
begin
  insert into companies (id, tenant_id, name, type) values (v_bank, p_tenant, p_label, 'bank');
  return v_bank;
end;
$$;

create function rcp_user(p_tenant uuid, p_bank uuid, p_email text, p_role text) returns uuid
language plpgsql as $$
declare v_user uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_user, p_email, jsonb_build_object('department', 'ib', 'tenant_id', p_tenant));
  update users set company_id = p_bank, company_role = p_role, is_external = false, status = 'active'
   where id = v_user;
  return v_user;
end;
$$;

create function rcp_deal(p_tenant uuid, p_bank uuid, p_md uuid, p_codename text) returns uuid
language plpgsql as $$
begin
  return (create_deal_gate0(
    p_tenant_id      => p_tenant,
    p_actor_id       => p_md,
    p_bank_id        => p_bank,
    p_codename       => p_codename,
    p_target_name    => 'Probe Target',
    p_entry_step_seq => 4,
    p_steps          => jsonb_build_array(
      jsonb_build_object('stepId', 'p1-s7', 'seq', 1, 'phaseIndex', 1, 'displayOrder', 1),
      jsonb_build_object('stepId', 'p1-s6', 'seq', 2, 'phaseIndex', 1, 'displayOrder', 2),
      jsonb_build_object('stepId', 'g0-notify', 'seq', 3, 'phaseIndex', 1, 'displayOrder', 3),
      jsonb_build_object('stepId', 'p1-s10', 'seq', 4, 'phaseIndex', 1, 'displayOrder', 4),
      jsonb_build_object('stepId', 'p1-s11', 'seq', 5, 'phaseIndex', 2, 'displayOrder', 5)
    ),
    p_census_version => 'probe-rail',
    p_conflicts      => jsonb_build_object('approvedBy', 'Avery Lindqvist', 'approvedOn', '2026-09-01')
  ) -> 'deal' ->> 'id')::uuid;
end;
$$;

create function rcp_steps() returns jsonb language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('stepId', 'p1-s7', 'seq', 1, 'phaseIndex', 1, 'displayOrder', 1,
                       'origin', 'catalog', 'definition', null),
    jsonb_build_object('stepId', 'p1-s6', 'seq', 2, 'phaseIndex', 1, 'displayOrder', 2,
                       'origin', 'catalog', 'definition', null),
    jsonb_build_object('stepId', 'g0-notify', 'seq', 3, 'phaseIndex', 1, 'displayOrder', 3,
                       'origin', 'catalog', 'definition', null),
    jsonb_build_object('stepId', 'p1-s10', 'seq', 4, 'phaseIndex', 1, 'displayOrder', 4,
                       'origin', 'catalog', 'definition', null),
    jsonb_build_object('stepId', 'p1-s11', 'seq', 5, 'phaseIndex', 2, 'displayOrder', 5,
                       'origin', 'catalog', 'definition', null),
    jsonb_build_object('stepId', 'custom-0f7c2b9e-3a41-4c55-9d1e-6b2a7f0c8d13', 'seq', null,
                       'phaseIndex', 2, 'displayOrder', 6, 'origin', 'custom',
                       'definition', jsonb_build_object('title', 'Fairness opinion',
                                                        'description', 'Independent opinion before signing.'))
  );
$$;

create function rcp_protected() returns text[] language sql immutable as $$
  select array['p1-s7', 'p1-s6', 'g0-notify'];
$$;

create function rcp_template(p_bank uuid, p_actor uuid, p_name text) returns uuid
language sql as $$
  select (create_rail_template(p_bank, p_actor, p_name, null, rcp_steps()) ->> 'id')::uuid;
$$;

create function rcp_step_row(p_template uuid, p_step_id text) returns uuid
language sql as $$
  select id from rail_catalog_steps where template_id = p_template and step_id = p_step_id;
$$;

create function rcp_revision(
  p_template uuid, p_actor uuid, p_deal uuid, p_catalog uuid,
  p_fingerprint text, p_state text, p_manifest jsonb
) returns rail_template_revisions language sql as $$
  insert into rail_template_revisions (
    template_id, actor_id, request_id, request_digest, command,
    source_deal_id, source_catalog_template_id, source_fingerprint, manifest, state
  ) values (
    p_template, p_actor, gen_random_uuid(), repeat('a', 64), '{}'::jsonb,
    p_deal, p_catalog, p_fingerprint, p_manifest, p_state
  ) returning *;
$$;

create function rcp_shape_skill(p_digest text) returns jsonb language sql as $$
  select jsonb_build_object(
    'key', 's0',
    'name', 'Shape Skill',
    'source', jsonb_build_object('kind', 'publication', 'skillId', gen_random_uuid(),
                                 'versionId', gen_random_uuid(), 'digest', p_digest),
    'contract', jsonb_build_object('purpose', 'p', 'expectedInput', 'i', 'expectedOutput', 'o'));
$$;

create function rcp_error(p_statement text) returns text
language plpgsql as $$
begin
  execute p_statement;
  return null;
exception when sqlstate 'P0004' then
  return sqlerrm;
when others then
  return sqlerrm;
end;
$$;

create function rcp_input(p_tenant uuid, p_actor uuid, p_bank uuid, p_codename text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'tenantId', p_tenant, 'actorId', p_actor, 'bankId', p_bank,
    'codename', p_codename, 'targetName', 'Probe Target', 'targetCompanyId', null,
    'codenameTheme', null, 'members', '[]'::jsonb,
    'screening', jsonb_build_object('verdict', 'approved', 'reasons', '[]'::jsonb),
    'conflicts', jsonb_build_object('approvedBy', 'Avery Lindqvist', 'approvedOn', '2026-09-02')
  );
$$;

create function rcp_seed(p_manifest jsonb, p_step_ids jsonb) returns jsonb
language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p_step_ids ->> (step ->> 'key'),
    'stepId', coalesce(step ->> 'catalogStepId', 'custom:' || (p_step_ids ->> (step ->> 'key'))),
    'origin', case when step ->> 'catalogStepId' is not null then 'catalog' else 'custom' end,
    'seq', step -> 'seq',
    'phaseIndex', step -> 'phaseIndex',
    'displayOrder', step -> 'displayOrder',
    'definition', case
      when step ->> 'catalogStepId' is not null
        or jsonb_typeof(step -> 'definition') is distinct from 'object' then 'null'::jsonb
      else step -> 'definition' end,
    'binding', 'null'::jsonb
  ) order by (step ->> 'displayOrder')::int), '[]'::jsonb)
  from jsonb_array_elements(p_manifest -> 'steps') step;
$$;

create function rcp_create_deal(
  p_tenant uuid, p_bank uuid, p_actor uuid, p_template uuid, p_revision uuid, p_codename text
) returns uuid language plpgsql as $$
declare
  v_request   uuid := gen_random_uuid();
  v_admission jsonb;
  v_deal      uuid;
begin
  v_admission := rail_template_admit_creation(p_actor, v_request,
    jsonb_build_object('templateId', p_template, 'revisionId', p_revision),
    rcp_input(p_tenant, p_actor, p_bank, p_codename));
  v_deal := (v_admission ->> 'dealId')::uuid;
  perform rail_template_finalize_creation(p_actor, v_request,
    jsonb_build_object('requestId', v_request, 'projectId', v_deal, 'skills', '[]'::jsonb),
    rcp_seed(v_admission -> 'manifest', v_admission -> 'stepIds'));
  return v_deal;
end;
$$;

do $$
declare
  v_tenant   uuid := '00000000-0000-4000-8000-0000000000d1';
  v_bank     uuid;
  v_md       uuid;
  v_deal     uuid;
  v_template uuid;
  v_catalog  uuid;
  v_other    uuid;
  v_first    rail_template_revisions;
  v_second   rail_template_revisions;
  v_third    rail_template_revisions;
  v_error    text;
begin
  v_bank := rcp_bank(v_tenant, 'Probe Revision Bank');
  v_md := rcp_user(v_tenant, v_bank, 'rcp-revision-md@example.com', 'director');
  v_deal := rcp_deal(v_tenant, v_bank, v_md, 'Probe Revision Source');
  v_catalog := rcp_template(v_bank, v_md, 'Probe Revision Catalog');
  v_other := rcp_template(v_bank, v_md, 'Probe Revision Other');

  insert into rail_templates (tenant_id, company_id, name, created_by)
    values (v_tenant, v_bank, 'Probe Revision Rail', v_md)
    returning id into v_template;

  v_first := rcp_revision(v_template, v_md, null, v_catalog, null, 'ready', '{}'::jsonb);
  v_second := rcp_revision(v_template, v_md, null, v_catalog, null, 'ready', '{}'::jsonb);
  v_third := rcp_revision(v_template, v_md, null, v_catalog, null, 'ready', '{}'::jsonb);
  if v_first.version is distinct from 1
     or v_second.version is distinct from 2
     or v_third.version is distinct from 3 then
    raise exception 'FAIL: revisions must number 1, 2, 3 per template, got %, %, %',
      v_first.version, v_second.version, v_third.version;
  end if;

  v_error := rcp_error(format('select rcp_revision(%L, %L, %L, %L, %L, %L, %L::jsonb)',
    v_template, v_md, v_deal, v_catalog, repeat('b', 64), 'ready', '{}'));
  if coalesce(v_error, '') not like '%rail_template_revisions_source_check%' then
    raise exception 'FAIL: a revision with two sources must be refused, got %', v_error;
  end if;

  v_error := rcp_error(format('select rcp_revision(%L, %L, %L, %L, %L, %L, %L::jsonb)',
    v_template, v_md, null, null, null, 'ready', '{}'));
  if v_error is distinct from 'forbidden' then
    raise exception 'FAIL: a revision with no catalog source must be refused, got %', v_error;
  end if;

  v_error := rcp_error(format('select rcp_revision(%L, %L, %L, %L, %L, %L, %L::jsonb)',
    v_template, v_md, v_deal, null, repeat('b', 64), 'ready', '{}'));
  if v_error is distinct from 'forbidden' then
    raise exception 'FAIL: a revision saved from a deal must be refused, got %', v_error;
  end if;

  v_error := rcp_error(format('select rcp_revision(%L, %L, %L, %L, %L, %L, %L::jsonb)',
    v_template, v_md, null, v_catalog, null, 'preparing', '{}'));
  if v_error is distinct from 'forbidden' then
    raise exception 'FAIL: a revision that is not ready must be refused, got %', v_error;
  end if;

  v_error := rcp_error(format(
    'update rail_template_revisions set state = %L, version = 9 where id = %L', 'ready', v_first.id));
  if v_error is distinct from 'revision_immutable' then
    raise exception 'FAIL: a revision must be immutable, got %', v_error;
  end if;

  update rail_catalog_templates set rail_template_id = v_template where id = v_catalog;
  v_error := rcp_error(format(
    'update rail_catalog_templates set rail_template_id = %L where id = %L', v_template, v_other));
  if coalesce(v_error, '') not like '%rail_catalog_templates_rail_template_id_key%' then
    raise exception 'FAIL: one saved rail links to at most one catalog template, got %', v_error;
  end if;

  if (select data_type || ':' || is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'deal_steps'
         and column_name = 'template_step_key') is distinct from 'text:YES' then
    raise exception 'FAIL: deal_steps.template_step_key must be a nullable text column';
  end if;

  raise notice 'OK: revisions carry one source and a version per template';
end $$;

do $$
declare
  v_tenant   uuid := '00000000-0000-4000-8000-0000000000d2';
  v_bank     uuid;
  v_md       uuid;
  v_catalog  uuid;
  v_manifest jsonb;
  v_schema1  jsonb;
  v_custom   jsonb;
  v_house    jsonb;
  v_error    text;
  v_routine  text;
begin
  v_bank := rcp_bank(v_tenant, 'Probe Manifest Bank');
  v_md := rcp_user(v_tenant, v_bank, 'rcp-manifest-md@example.com', 'director');
  v_catalog := rcp_template(v_bank, v_md, 'Probe Manifest Rail');
  perform set_rail_template_step_description(v_bank, v_md, v_catalog,
    rcp_step_row(v_catalog, 'p1-s10'), 'Context for the deal team.');

  v_manifest := rail_catalog_manifest(v_catalog);

  if v_manifest -> 'schemaVersion' is distinct from '2'::jsonb
     or v_manifest ->> 'censusVersion' is distinct from rail_catalog_census_version()
     or v_manifest -> 'skills' is distinct from '[]'::jsonb
     or jsonb_array_length(v_manifest -> 'steps') is distinct from 6 then
    raise exception 'FAIL: a catalog manifest is schema 2 with no skills and every draft step, got %',
      v_manifest;
  end if;

  if (select array_agg(step ->> 'templateStepKey' order by (step ->> 'displayOrder')::int)
        from jsonb_array_elements(v_manifest -> 'steps') step)
     is distinct from
     (select array_agg(step_id order by display_order)
        from rail_catalog_steps where template_id = v_catalog) then
    raise exception 'FAIL: each templateStepKey must be the catalog step_id, in display order';
  end if;

  if (select array_agg(step ->> 'key' order by (step ->> 'displayOrder')::int)
        from jsonb_array_elements(v_manifest -> 'steps') step)
     is distinct from array['t0', 't1', 't2', 't3', 't4', 't5'] then
    raise exception 'FAIL: manifest keys must run t0..tn in display order';
  end if;

  select step into v_custom from jsonb_array_elements(v_manifest -> 'steps') step
   where step ->> 'catalogStepId' is null;
  if v_custom -> 'seq' is distinct from 'null'::jsonb
     or v_custom -> 'definition' is distinct from jsonb_build_object(
          'title', 'Fairness opinion', 'description', 'Independent opinion before signing.')
     or coalesce(v_custom ->> 'templateStepKey', '') not like 'custom-%' then
    raise exception 'FAIL: a custom step publishes its title and description, got %', v_custom;
  end if;

  select step into v_house from jsonb_array_elements(v_manifest -> 'steps') step
   where step ->> 'catalogStepId' = 'p1-s10';
  if v_house -> 'definition' is distinct from 'null'::jsonb
     or v_house -> 'seq' is distinct from '4'::jsonb then
    raise exception 'FAIL: a house step publishes its seq and no definition, got %', v_house;
  end if;

  perform rail_template_validate_manifest_shape(v_manifest);

  v_schema1 := jsonb_build_object(
    'schemaVersion', 1,
    'censusVersion', v_manifest ->> 'censusVersion',
    'skills', '[]'::jsonb,
    'steps', (select jsonb_agg(step - 'templateStepKey' order by (step ->> 'displayOrder')::int)
                from jsonb_array_elements(v_manifest -> 'steps') step));
  perform rail_template_validate_manifest_shape(v_schema1);

  v_error := rcp_error(format('select rail_template_validate_manifest_shape(%L::jsonb)',
    v_manifest #- '{steps,0,templateStepKey}'));
  if v_error is distinct from 'invalid_command' then
    raise exception 'FAIL: a schema 2 step without a templateStepKey must be refused, got %', v_error;
  end if;

  v_error := rcp_error(format('select rail_template_validate_manifest_shape(%L::jsonb)',
    jsonb_set(v_manifest, '{steps,1,templateStepKey}', v_manifest -> 'steps' -> 0 -> 'templateStepKey')));
  if v_error is distinct from 'invalid_command' then
    raise exception 'FAIL: a repeated templateStepKey must be refused, got %', v_error;
  end if;

  v_error := rcp_error(format('select rail_template_validate_manifest_shape(%L::jsonb)',
    jsonb_set(v_manifest, '{schemaVersion}', '3'::jsonb)));
  if v_error is distinct from 'invalid_command' then
    raise exception 'FAIL: an unknown schema version must be refused, got %', v_error;
  end if;

  v_error := rcp_error(format('select rail_template_validate_manifest_shape(%L::jsonb)',
    v_manifest - 'steps'));
  if v_error is distinct from 'invalid_command' then
    raise exception 'FAIL: a manifest without steps must be refused, got %', v_error;
  end if;

  v_error := rcp_error(format('select rail_template_validate_manifest_shape(%L::jsonb)',
    jsonb_set(v_manifest, '{steps}', '[]'::jsonb)));
  if v_error is distinct from 'invalid_command' then
    raise exception 'FAIL: a manifest with no steps must be refused, got %', v_error;
  end if;

  v_error := rcp_error(format('select rail_template_validate_manifest_shape(%L::jsonb)',
    jsonb_set(v_manifest, '{steps,0,phaseIndex}', '"one"'::jsonb)));
  if v_error is distinct from 'invalid_command' then
    raise exception 'FAIL: a step phase that is not a number must be refused, got %', v_error;
  end if;

  v_error := rcp_error(format('select rail_template_validate_manifest_shape(%L::jsonb)',
    jsonb_set(v_manifest, '{steps,0,displayOrder}', '1.5'::jsonb)));
  if v_error is distinct from 'invalid_command' then
    raise exception 'FAIL: a fractional step order must be refused, got %', v_error;
  end if;

  v_error := rcp_error(format('select rail_template_validate_manifest_shape(%L::jsonb)',
    jsonb_set(v_manifest, '{steps,0,displayOrder}',
      to_jsonb(jsonb_array_length(v_manifest -> 'steps') + 1))));
  if v_error is distinct from 'invalid_command' then
    raise exception 'FAIL: a step order that does not run 1 to n must be refused, got %', v_error;
  end if;

  v_error := rcp_error(format('select rail_template_validate_manifest_shape(%L::jsonb)',
    jsonb_set(v_manifest, '{skills}', '{}'::jsonb)));
  if v_error is distinct from 'invalid_command' then
    raise exception 'FAIL: a skill list that is not an array must be refused, got %', v_error;
  end if;

  v_error := rcp_error(format('select rail_template_validate_manifest_shape(%L::jsonb)',
    jsonb_set(v_manifest, '{skills}', jsonb_build_array(rcp_shape_skill(repeat('a', 64))))));
  if v_error is not null then
    raise exception 'FAIL: a well-formed skill must pass the shape check, got %', v_error;
  end if;

  v_error := rcp_error(format('select rail_template_validate_manifest_shape(%L::jsonb)',
    jsonb_set(v_manifest, '{skills}', jsonb_build_array(rcp_shape_skill('nothex')))));
  if v_error is distinct from 'invalid_command' then
    raise exception 'FAIL: a skill digest that is not 64 hex characters must be refused, got %', v_error;
  end if;

  if not rail_catalog_draft_differs(v_catalog) then
    raise exception 'FAIL: a template that was never published has changes to publish';
  end if;

  foreach v_routine in array array[
    'rail_catalog_manifest(uuid)', 'rail_catalog_manifest_steps(uuid)',
    'rail_catalog_draft_differs(uuid)', 'rail_catalog_census_version()',
    'rail_template_validate_manifest_shape(jsonb)'
  ]
  loop
    if has_function_privilege('anon', v_routine, 'execute')
       or has_function_privilege('authenticated', v_routine, 'execute')
       or not has_function_privilege('service_role', v_routine, 'execute') then
      raise exception 'FAIL: % must be callable by service_role only', v_routine;
    end if;
  end loop;

  raise notice 'OK: a catalog draft becomes a schema 2 manifest keyed by its step ids';
end $$;

do $$
declare
  v_tenant      uuid := '00000000-0000-4000-8000-0000000000d3';
  v_bank        uuid;
  v_md          uuid;
  v_name_bank   uuid;
  v_name_md     uuid;
  v_catalog     uuid;
  v_removed     uuid;
  v_named       uuid;
  v_saved       uuid;
  v_custom_row  uuid;
  v_change      uuid;
  v_template    uuid;
  v_first       jsonb;
  v_second      jsonb;
  v_publication jsonb;
  v_audit       jsonb;
  v_revision    rail_template_revisions;
  v_error       text;
  v_routine     text;
begin
  v_bank := rcp_bank(v_tenant, 'Probe Publish Bank');
  v_md := rcp_user(v_tenant, v_bank, 'rcp-publish-md@example.com', 'director');
  v_catalog := rcp_template(v_bank, v_md, 'Probe Publish Rail');

  v_publication := rail_catalog_publication(v_catalog);
  if v_publication -> 'published' is distinct from 'null'::jsonb
     or v_publication -> 'hasUnpublishedChanges' is distinct from 'true'::jsonb then
    raise exception 'FAIL: an unpublished template has no version and changes to publish, got %',
      v_publication;
  end if;

  v_first := publish_rail_template(v_catalog, v_bank, v_md, rcp_protected());
  v_template := (v_first ->> 'templateId')::uuid;
  if v_template is null
     or v_first ->> 'revisionId' is null
     or v_first -> 'version' is distinct from '1'::jsonb
     or v_first -> 'stepCount' is distinct from '6'::jsonb then
    raise exception 'FAIL: the first publish returns version 1 and the step count, got %', v_first;
  end if;

  if (select rail_template_id from rail_catalog_templates where id = v_catalog)
     is distinct from v_template then
    raise exception 'FAIL: the first publish links the catalog template to its saved rail';
  end if;
  if not exists (
    select 1 from rail_templates t
     where t.id = v_template and t.company_id = v_bank and t.tenant_id = v_tenant
       and t.name = 'Probe Publish Rail' and t.created_by = v_md
       and t.current_revision_id = (v_first ->> 'revisionId')::uuid) then
    raise exception 'FAIL: the first publish creates the saved rail and points it at the revision';
  end if;

  select * into v_revision from rail_template_revisions where id = (v_first ->> 'revisionId')::uuid;
  if v_revision.state is distinct from 'ready'
     or v_revision.source_catalog_template_id is distinct from v_catalog
     or v_revision.source_deal_id is not null
     or v_revision.source_fingerprint is not null
     or v_revision.expected_revision_id is not null
     or v_revision.version is distinct from 1
     or v_revision.manifest is distinct from rail_catalog_manifest(v_catalog) then
    raise exception 'FAIL: the published revision is ready, catalog sourced and holds the draft manifest';
  end if;

  select detail into v_audit from audit_log
   where action = 'rail.template_published' and actor_id = v_md
     and detail ->> 'revisionId' = v_revision.id::text;
  if v_audit is distinct from jsonb_build_object(
       'catalogTemplateId', v_catalog, 'templateId', v_template, 'revisionId', v_revision.id,
       'previousRevisionId', null, 'version', 1, 'stepCount', 6, 'skillCount', 0) then
    raise exception 'FAIL: the publish is audited with its ids, version and step count, got %', v_audit;
  end if;

  v_publication := rail_catalog_publication(v_catalog);
  if v_publication -> 'published' ->> 'revisionId' is distinct from v_revision.id::text
     or v_publication -> 'published' -> 'version' is distinct from '1'::jsonb
     or coalesce(v_publication -> 'published' ->> 'publishedAt', '')
        !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     or v_publication -> 'hasUnpublishedChanges' is distinct from 'false'::jsonb then
    raise exception 'FAIL: a published template reports its version and no changes, got %',
      v_publication;
  end if;

  v_error := rcp_error(format('select publish_rail_template(%L, %L, %L, %L)',
    v_catalog, v_bank, v_md, rcp_protected()));
  if v_error is distinct from 'nothing_to_publish' then
    raise exception 'FAIL: publishing an unchanged draft is refused, got %', v_error;
  end if;

  v_removed := rcp_step_row(v_catalog, 'p1-s11');
  perform remove_rail_template_step(v_bank, v_md, v_catalog, v_removed);
  if not rail_catalog_draft_differs(v_catalog) then
    raise exception 'FAIL: a removed step is a change to publish';
  end if;
  select id into v_change from rail_catalog_changes
   where template_id = v_catalog and action = 'remove_step'
     and before ->> 'stepRowId' = v_removed::text;
  perform undo_rail_template_change(v_bank, v_md, v_catalog, v_change);
  if rail_catalog_draft_differs(v_catalog) then
    raise exception 'FAIL: removing a step and undoing it leaves nothing to publish';
  end if;
  v_error := rcp_error(format('select publish_rail_template(%L, %L, %L, %L)',
    v_catalog, v_bank, v_md, rcp_protected()));
  if v_error is distinct from 'nothing_to_publish' then
    raise exception 'FAIL: an edit and its undo publish nothing, got %', v_error;
  end if;

  perform set_rail_template_step_description(v_bank, v_md, v_catalog,
    rcp_step_row(v_catalog, 'p1-s10'), 'Context for the deal team.');
  if rail_catalog_draft_differs(v_catalog) then
    raise exception 'FAIL: a house step description is not part of a published version';
  end if;

  select id into v_custom_row from rail_catalog_steps
   where template_id = v_catalog and origin = 'custom';
  perform set_rail_template_step_description(v_bank, v_md, v_catalog, v_custom_row,
    'Opinion from a qualified adviser.');
  if not rail_catalog_draft_differs(v_catalog) then
    raise exception 'FAIL: a custom step description is part of a published version';
  end if;
  select id into v_change from rail_catalog_changes
   where template_id = v_catalog and action = 'set_description'
     and after ->> 'stepRowId' = v_custom_row::text and undoes_id is null;
  perform undo_rail_template_change(v_bank, v_md, v_catalog, v_change);
  if rail_catalog_draft_differs(v_catalog) then
    raise exception 'FAIL: undoing a custom description leaves nothing to publish';
  end if;

  perform add_rail_template_step(v_bank, v_md, v_catalog, 'custom-' || gen_random_uuid()::text,
    null, 2, 'custom',
    jsonb_build_object('title', 'Sanctions re-screen', 'description', 'Re-run screening before signing.'),
    null);
  v_second := publish_rail_template(v_catalog, v_bank, v_md, rcp_protected());
  if (v_second ->> 'templateId')::uuid is distinct from v_template
     or v_second -> 'version' is distinct from '2'::jsonb
     or v_second -> 'stepCount' is distinct from '7'::jsonb then
    raise exception 'FAIL: a second publish is version 2 of the same saved rail, got %', v_second;
  end if;
  if (select current_revision_id from rail_templates where id = v_template)
       is distinct from (v_second ->> 'revisionId')::uuid
     or (select expected_revision_id from rail_template_revisions
          where id = (v_second ->> 'revisionId')::uuid) is distinct from v_revision.id
     or (select count(*) from rail_templates where company_id = v_bank) is distinct from 1::bigint then
    raise exception 'FAIL: a second publish moves the pointer of the one saved rail';
  end if;
  if (select detail -> 'previousRevisionId' from audit_log
       where action = 'rail.template_published'
         and detail ->> 'revisionId' = v_second ->> 'revisionId')
     is distinct from to_jsonb(v_revision.id::text) then
    raise exception 'FAIL: a second publish audits the revision it replaced';
  end if;

  perform remove_rail_template_step(v_bank, v_md, v_catalog, rcp_step_row(v_catalog, 'g0-notify'));
  v_error := rcp_error(format('select publish_rail_template(%L, %L, %L, %L)',
    v_catalog, v_bank, v_md, rcp_protected()));
  if v_error is distinct from 'missing_protected_step' then
    raise exception 'FAIL: a draft missing a protected step is refused, got %', v_error;
  end if;

  v_error := rcp_error(format('select publish_rail_template(%L, %L, %L, %L)',
    v_catalog, gen_random_uuid(), v_md, rcp_protected()));
  if v_error is distinct from 'template_missing' then
    raise exception 'FAIL: another company cannot publish this template, got %', v_error;
  end if;

  v_removed := rcp_template(v_bank, v_md, 'Probe Removed Rail');
  perform delete_rail_template(v_bank, v_md, v_removed);
  v_error := rcp_error(format('select publish_rail_template(%L, %L, %L, %L)',
    v_removed, v_bank, v_md, rcp_protected()));
  if v_error is distinct from 'template_removed' then
    raise exception 'FAIL: a removed template cannot be published, got %', v_error;
  end if;

  v_name_bank := rcp_bank(v_tenant, 'Probe Name Bank');
  v_name_md := rcp_user(v_tenant, v_name_bank, 'rcp-name-md@example.com', 'director');
  v_saved := rcp_template(v_name_bank, v_name_md, 'Probe  Name Rail');
  perform publish_rail_template(v_saved, v_name_bank, v_name_md, rcp_protected());
  v_named := rcp_template(v_name_bank, v_name_md, 'Probe Name Rail');
  v_error := rcp_error(format('select publish_rail_template(%L, %L, %L, %L)',
    v_named, v_name_bank, v_name_md, rcp_protected()));
  if v_error is distinct from 'name_taken' then
    raise exception 'FAIL: a published template whose name differs only in inner spacing refuses the first publish, got %', v_error;
  end if;
  v_error := rcp_error(format('select rail_catalog_publish_check(%L, %L, %L)',
    v_named, v_name_bank, rcp_protected()));
  if v_error is distinct from 'name_taken' then
    raise exception 'FAIL: the publish check refuses a name that differs only in inner spacing from a published one, got %', v_error;
  end if;

  foreach v_routine in array array[
    'publish_rail_template(uuid, uuid, uuid, text[], uuid, jsonb)', 'rail_catalog_publication(uuid)',
    'rail_catalog_publish_check(uuid, uuid, text[])'
  ]
  loop
    if has_function_privilege('anon', v_routine, 'execute')
       or has_function_privilege('authenticated', v_routine, 'execute')
       or not has_function_privilege('service_role', v_routine, 'execute') then
      raise exception 'FAIL: % must be callable by service_role only', v_routine;
    end if;
  end loop;

  raise notice 'OK: publish turns the catalog draft into a numbered revision';
end $$;

do $$
declare
  v_tenant    uuid := '00000000-0000-4000-8000-0000000000d4';
  v_bank      uuid;
  v_md        uuid;
  v_catalog   uuid;
  v_template  uuid;
  v_revision  uuid;
  v_deal      uuid;
  v_published jsonb;
  v_again     jsonb;
  v_error     text;
begin
  v_bank := rcp_bank(v_tenant, 'Probe Delete Bank');
  v_md := rcp_user(v_tenant, v_bank, 'rcp-delete-md@example.com', 'director');
  v_catalog := rcp_template(v_bank, v_md, 'Probe Delete Rail');
  v_published := publish_rail_template(v_catalog, v_bank, v_md, rcp_protected());
  v_template := (v_published ->> 'templateId')::uuid;
  v_revision := (v_published ->> 'revisionId')::uuid;
  v_deal := rcp_create_deal(v_tenant, v_bank, v_md, v_template, v_revision, 'Project Ember');

  perform delete_rail_template(v_bank, v_md, v_catalog);

  if (select current_revision_id from rail_templates where id = v_template) is not null then
    raise exception 'FAIL: deleting a catalog template takes its saved rail out of Gate 0';
  end if;
  if not exists (select 1 from rail_template_revisions where id = v_revision and state = 'ready') then
    raise exception 'FAIL: deleting a catalog template keeps its published revisions';
  end if;
  if (select rail_template_revision_id from deals where id = v_deal) is distinct from v_revision
     or (select count(*) from deal_steps where deal_id = v_deal) is distinct from 6::bigint then
    raise exception 'FAIL: a deal built from a deleted template keeps its revision and its rail';
  end if;

  v_error := rcp_error(format('select rcp_create_deal(%L, %L, %L, %L, %L, %L)',
    v_tenant, v_bank, v_md, v_template, v_revision, 'Project Cinder'));
  if v_error is distinct from 'stale_template' then
    raise exception 'FAIL: Gate 0 cannot create a deal from a deleted template, got %', v_error;
  end if;

  v_again := publish_rail_template(rcp_template(v_bank, v_md, 'Probe Delete Rail'),
    v_bank, v_md, rcp_protected());
  if (v_again ->> 'templateId')::uuid is not distinct from v_template
     or v_again -> 'version' is distinct from '1'::jsonb then
    raise exception 'FAIL: a new template with the freed name publishes as a new saved rail, got %',
      v_again;
  end if;

  raise notice 'OK: deleting a catalog template takes it out of Gate 0 and leaves its deals alone';
end $$;

do $$
declare
  v_tenant         uuid := '00000000-0000-4000-8000-0000000000d5';
  v_bank           uuid;
  v_md             uuid;
  v_catalog        uuid;
  v_template       uuid;
  v_revision       uuid;
  v_deal           uuid;
  v_published      jsonb;
begin
  v_bank := rcp_bank(v_tenant, 'Probe Keys Bank');
  v_md := rcp_user(v_tenant, v_bank, 'rcp-keys-md@example.com', 'director');
  v_catalog := rcp_template(v_bank, v_md, 'Probe Keys Rail');
  v_published := publish_rail_template(v_catalog, v_bank, v_md, rcp_protected());
  v_template := (v_published ->> 'templateId')::uuid;
  v_revision := (v_published ->> 'revisionId')::uuid;

  if not exists (
    select 1 from rail_templates t
     where t.id = v_template and t.company_id = v_bank and t.current_revision_id = v_revision) then
    raise exception 'FAIL: Gate 0 lists saved rails with a current revision, and a published template is one';
  end if;

  v_deal := rcp_create_deal(v_tenant, v_bank, v_md, v_template, v_revision, 'Project Lantern');

  if exists (
    select 1 from deal_steps d
     where d.deal_id = v_deal and d.origin = 'catalog'
       and d.template_step_key is distinct from d.step_id) then
    raise exception 'FAIL: a house step created from a published template is keyed by its step id';
  end if;
  if (select template_step_key from deal_steps where deal_id = v_deal and origin = 'custom')
     is distinct from
     (select step_id from rail_catalog_steps where template_id = v_catalog and origin = 'custom') then
    raise exception 'FAIL: a custom step created from a published template is keyed by its catalog step id';
  end if;
  if (select count(*) from deal_steps where deal_id = v_deal and template_step_key is not null)
     is distinct from 6::bigint then
    raise exception 'FAIL: every deal step created from a published template carries a key';
  end if;

  raise notice 'OK: deals created from a published template carry template step keys';
end $$;

create function rcp_skill_definition(p_candidate uuid, p_digest text) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'type', 'skill',
    'title', 'Buyer long list',
    'description', 'Builds a ranked long list of strategic buyers.',
    'inputs', jsonb_build_array(jsonb_build_object(
      'key', 'primary', 'kind', 'text', 'label', 'Input',
      'helperText', 'The sector and size of the target.', 'required', true)),
    'skill', jsonb_build_object(
      'name', 'Buyer long list',
      'contract', jsonb_build_object(
        'purpose', 'Builds a ranked long list of strategic buyers.',
        'expectedInput', 'The sector and size of the target.',
        'expectedOutput', 'A ranked list of buyers with a reason for each.'),
      'source', jsonb_build_object('kind', 'candidate', 'candidateId', p_candidate, 'digest', p_digest)));
$$;

create function rcp_skill_key(p_manifest jsonb, p_row uuid) returns text
language sql stable as $$
  select step ->> 'skillKey'
    from jsonb_array_elements(p_manifest -> 'steps') step
   where step ->> 'templateStepKey' = (select step_id from rail_catalog_steps where id = p_row);
$$;

do $$
declare
  v_tenant   uuid := '00000000-0000-4000-8000-0000000000e1';
  v_bank     uuid;
  v_md       uuid;
  v_catalog  uuid;
  v_first    uuid := gen_random_uuid();
  v_second   uuid := gen_random_uuid();
  v_row      uuid;
  v_other    uuid;
  v_twin     uuid;
  v_plain    uuid;
  v_undone   uuid;
  v_legacy   jsonb;
  v_manifest jsonb;
  v_step     jsonb;
  v_change   uuid;
  v_error    text;
  v_routine  text;
begin
  v_bank := rcp_bank(v_tenant, 'Probe Skill Manifest Bank');
  v_md := rcp_user(v_tenant, v_bank, 'rcp-skill-manifest-md@example.com', 'director');
  v_catalog := rcp_template(v_bank, v_md, 'Probe Skill Rail');

  select jsonb_build_object(
           'schemaVersion', 2,
           'censusVersion', rail_catalog_census_version(),
           'steps', coalesce(jsonb_agg(jsonb_build_object(
             'key', 't' || (s.ordinal - 1),
             'templateStepKey', s.step_id,
             'catalogStepId', case when s.origin = 'catalog' then s.step_id end,
             'seq', case when s.origin = 'catalog' then s.seq end,
             'phaseIndex', s.phase_index,
             'displayOrder', s.ordinal,
             'definition', case when s.origin = 'custom' then jsonb_build_object(
               'title', coalesce(s.definition ->> 'title', ''),
               'description', coalesce(s.definition ->> 'description', '')) end,
             'skillKey', null::text) order by s.ordinal), '[]'::jsonb),
           'skills', '[]'::jsonb)
    into v_legacy
    from (
      select step.step_id, step.seq, step.phase_index, step.origin, step.definition,
             row_number() over (order by step.display_order, step.id) as ordinal
        from rail_catalog_steps step
       where step.template_id = v_catalog
    ) s;
  if rail_catalog_manifest(v_catalog) is distinct from v_legacy then
    raise exception 'FAIL: a template with no skill step builds the manifest it built before, got %',
      rail_catalog_manifest(v_catalog);
  end if;

  perform publish_rail_template(v_catalog, v_bank, v_md, rcp_protected());
  if rail_catalog_draft_differs(v_catalog) then
    raise exception 'FAIL: a template published with no skill step has nothing left to publish';
  end if;

  v_undone := (add_rail_template_step(v_bank, v_md, v_catalog, 'custom-' || gen_random_uuid()::text,
    null, 2, 'custom', rcp_skill_definition(v_second, repeat('b', 64)), null) ->> 'id')::uuid;
  select id into v_change from rail_catalog_changes
   where template_id = v_catalog and action = 'add_step'
     and after ->> 'stepRowId' = v_undone::text;
  perform undo_rail_template_change(v_bank, v_md, v_catalog, v_change);
  if rail_catalog_draft_differs(v_catalog) then
    raise exception 'FAIL: a skill step that is added and then undone leaves nothing to publish';
  end if;

  v_row := (add_rail_template_step(v_bank, v_md, v_catalog, 'custom-' || gen_random_uuid()::text,
    null, 2, 'custom', rcp_skill_definition(v_first, repeat('a', 64)), null) ->> 'id')::uuid;
  if not rail_catalog_draft_differs(v_catalog) then
    raise exception 'FAIL: an added skill step is a change to publish';
  end if;

  v_manifest := rail_catalog_manifest(v_catalog);
  if v_manifest -> 'skills' is distinct from jsonb_build_array(jsonb_build_object(
       'key', 's0',
       'name', 'Buyer long list',
       'contract', rcp_skill_definition(v_first, repeat('a', 64)) -> 'skill' -> 'contract',
       'source', jsonb_build_object('kind', 'candidate', 'candidateId', v_first, 'digest', repeat('a', 64)))) then
    raise exception 'FAIL: the manifest lists the skill of a skill step, got %', v_manifest -> 'skills';
  end if;

  select step into v_step
    from jsonb_array_elements(v_manifest -> 'steps') step
   where step ->> 'templateStepKey' = (select step_id from rail_catalog_steps where id = v_row);
  if v_step ->> 'skillKey' is distinct from 's0'
     or v_step -> 'definition' is distinct from rcp_skill_definition(v_first, repeat('a', 64)) - 'skill' then
    raise exception 'FAIL: a skill step carries its key and its definition without the skill block, got %', v_step;
  end if;
  perform rail_template_validate_manifest_shape(v_manifest);

  v_error := rcp_error(format('select rail_template_validate_manifest_shape(%L)',
    jsonb_set(v_manifest, '{skills,0,source,candidateId}', '"not-a-uuid"'::jsonb)));
  if v_error is distinct from 'invalid_command' then
    raise exception 'FAIL: a candidate source needs a UUID candidate id, got %', v_error;
  end if;

  v_other := (add_rail_template_step(v_bank, v_md, v_catalog, 'custom-' || gen_random_uuid()::text,
    null, 2, 'custom', rcp_skill_definition(v_second, repeat('b', 64)), null) ->> 'id')::uuid;
  v_twin := (add_rail_template_step(v_bank, v_md, v_catalog, 'custom-' || gen_random_uuid()::text,
    null, 2, 'custom', rcp_skill_definition(v_first, repeat('a', 64)), null) ->> 'id')::uuid;
  v_manifest := rail_catalog_manifest(v_catalog);
  if jsonb_array_length(v_manifest -> 'skills') is distinct from 2
     or (select array_agg(skill ->> 'key' order by skill ->> 'key')
           from jsonb_array_elements(v_manifest -> 'skills') skill) is distinct from array['s0', 's1']
     or rcp_skill_key(v_manifest, v_twin) is distinct from rcp_skill_key(v_manifest, v_row)
     or rcp_skill_key(v_manifest, v_other) is not distinct from rcp_skill_key(v_manifest, v_row)
     or rcp_skill_key(v_manifest, v_other) is null then
    raise exception 'FAIL: one skill entry per distinct source, shared by the steps that use it, got %',
      v_manifest -> 'skills';
  end if;

  perform remove_rail_template_step(v_bank, v_md, v_catalog, v_other);
  if jsonb_array_length(rail_catalog_manifest(v_catalog) -> 'skills') is distinct from 1 then
    raise exception 'FAIL: removing a skill step removes its skill from the draft manifest';
  end if;
  select id into v_change from rail_catalog_changes
   where template_id = v_catalog and action = 'remove_step'
     and before ->> 'stepRowId' = v_other::text;
  perform undo_rail_template_change(v_bank, v_md, v_catalog, v_change);
  if jsonb_array_length(rail_catalog_manifest(v_catalog) -> 'skills') is distinct from 2 then
    raise exception 'FAIL: undoing the removal of a skill step brings its skill back';
  end if;

  v_error := rcp_error(format('select set_rail_template_step_description(%L, %L, %L, %L, %L)',
    v_bank, v_md, v_catalog, v_row, ''));
  if v_error is distinct from 'skill_step_description' then
    raise exception 'FAIL: a skill step cannot lose its description, got %', v_error;
  end if;
  v_error := rcp_error(format('select set_rail_template_step_description(%L, %L, %L, %L, %L)',
    v_bank, v_md, v_catalog, v_row, repeat('x', 2001)));
  if v_error is distinct from 'skill_step_description' then
    raise exception 'FAIL: a skill step description stops at 2,000 characters, got %', v_error;
  end if;

  perform set_rail_template_step_description(v_bank, v_md, v_catalog, v_row, 'Ranks strategic buyers.');
  if (select definition ->> 'description' from rail_catalog_steps where id = v_row)
       is distinct from 'Ranks strategic buyers.'
     or (select definition -> 'skill' from rail_catalog_steps where id = v_row)
       is distinct from rcp_skill_definition(v_first, repeat('a', 64)) -> 'skill' then
    raise exception 'FAIL: describing a skill step changes the description and keeps the skill';
  end if;

  select id into v_plain from rail_catalog_steps
   where template_id = v_catalog and step_id = 'custom-0f7c2b9e-3a41-4c55-9d1e-6b2a7f0c8d13';
  perform set_rail_template_step_description(v_bank, v_md, v_catalog, v_plain, '');
  if (select definition ->> 'description' from rail_catalog_steps where id = v_plain) is distinct from '' then
    raise exception 'FAIL: a manual step can still have an empty description';
  end if;

  foreach v_routine in array array[
    'rail_catalog_skill_keys(uuid)', 'rail_catalog_manifest_skills(uuid)'
  ]
  loop
    if has_function_privilege('anon', v_routine, 'execute')
       or has_function_privilege('authenticated', v_routine, 'execute')
       or not has_function_privilege('service_role', v_routine, 'execute') then
      raise exception 'FAIL: % must be callable by service_role only', v_routine;
    end if;
  end loop;

  raise notice 'OK: the draft manifest lists the skills of its steps';
end $$;

create function rcp_skill_seed(p_manifest jsonb, p_step_ids jsonb, p_bindings jsonb) returns jsonb
language sql as $$
  select coalesce(jsonb_agg(seed.value order by (seed.key)::int), '[]'::jsonb)
    from jsonb_each(rail_template_expected_seed(p_manifest, p_step_ids, p_bindings)) seed;
$$;

do $$
declare
  v_tenant    uuid := '00000000-0000-4000-8000-0000000000e2';
  v_bank      uuid;
  v_md        uuid;
  v_catalog   uuid;
  v_plain     uuid;
  v_mounted   uuid;
  v_removed   uuid;
  v_pair      uuid;
  v_third     uuid := gen_random_uuid();
  v_swapped   jsonb;
  v_matched   jsonb;
  v_candidate uuid := gen_random_uuid();
  v_digest    text := repeat('a', 64);
  v_revision  uuid := gen_random_uuid();
  v_second    uuid := gen_random_uuid();
  v_receipt   jsonb;
  v_check     jsonb;
  v_result    jsonb;
  v_stored    rail_template_revisions;
  v_request   uuid := gen_random_uuid();
  v_admission jsonb;
  v_target    jsonb;
  v_binding   jsonb;
  v_deal      uuid;
  v_step      deal_steps;
  v_error     text;
begin
  v_bank := rcp_bank(v_tenant, 'Probe Skill Publish Bank');
  v_md := rcp_user(v_tenant, v_bank, 'rcp-skill-publish-md@example.com', 'director');
  v_catalog := rcp_template(v_bank, v_md, 'Probe Skill Publish Rail');
  perform add_rail_template_step(v_bank, v_md, v_catalog, 'custom-' || gen_random_uuid()::text,
    null, 2, 'custom', rcp_skill_definition(v_candidate, v_digest), null);

  v_check := rail_catalog_publish_check(v_catalog, v_bank, rcp_protected());
  if v_check ->> 'tenantId' is distinct from v_tenant::text
     or v_check -> 'manifest' is distinct from rail_catalog_manifest(v_catalog) then
    raise exception 'FAIL: the publish check returns the tenant and the draft manifest, got %', v_check;
  end if;

  v_receipt := jsonb_build_object(
    'revisionId', v_revision,
    'assets', jsonb_build_array(jsonb_build_object('key', 's0', 'packageDigest', v_digest)));

  v_error := rcp_error(format('select publish_rail_template(%L, %L, %L, %L)',
    v_catalog, v_bank, v_md, rcp_protected()));
  if v_error is distinct from 'draft_changed' then
    raise exception 'FAIL: a draft with skills cannot be published without a receipt, got %', v_error;
  end if;

  v_error := rcp_error(format('select publish_rail_template(%L, %L, %L, %L, %L, %L)',
    v_catalog, v_bank, v_md, rcp_protected(), gen_random_uuid(), v_receipt));
  if v_error is distinct from 'draft_changed' then
    raise exception 'FAIL: a receipt for another revision id is refused, got %', v_error;
  end if;

  v_error := rcp_error(format('select publish_rail_template(%L, %L, %L, %L, %L, %L)',
    v_catalog, v_bank, v_md, rcp_protected(), v_revision,
    jsonb_set(v_receipt, '{assets}', '[]'::jsonb)));
  if v_error is distinct from 'draft_changed' then
    raise exception 'FAIL: a receipt missing a skill is refused, got %', v_error;
  end if;

  v_error := rcp_error(format('select publish_rail_template(%L, %L, %L, %L, %L, %L)',
    v_catalog, v_bank, v_md, rcp_protected(), v_revision,
    jsonb_set(v_receipt, '{assets}', (v_receipt -> 'assets')
      || jsonb_build_array(jsonb_build_object('key', 's1', 'packageDigest', v_digest)))));
  if v_error is distinct from 'draft_changed' then
    raise exception 'FAIL: a receipt with a skill the draft does not hold is refused, got %', v_error;
  end if;

  v_error := rcp_error(format('select publish_rail_template(%L, %L, %L, %L, %L, %L)',
    v_catalog, v_bank, v_md, rcp_protected(), v_revision,
    jsonb_set(v_receipt, '{assets,0,packageDigest}', to_jsonb(repeat('b', 64)))));
  if v_error is distinct from 'draft_changed' then
    raise exception 'FAIL: a receipt whose digest is not the skill''s is refused, got %', v_error;
  end if;

  v_result := publish_rail_template(v_catalog, v_bank, v_md, rcp_protected(), v_revision, v_receipt);
  if (v_result ->> 'revisionId')::uuid is distinct from v_revision
     or v_result -> 'version' is distinct from '1'::jsonb
     or v_result -> 'skillCount' is distinct from '1'::jsonb then
    raise exception 'FAIL: the publish uses the given revision id and counts its skills, got %', v_result;
  end if;

  select * into v_stored from rail_template_revisions where id = v_revision;
  if v_stored.state is distinct from 'ready'
     or v_stored.provider_receipt is distinct from v_receipt
     or v_stored.source_catalog_template_id is distinct from v_catalog
     or jsonb_array_length(v_stored.manifest -> 'skills') is distinct from 1 then
    raise exception 'FAIL: the published revision is ready and stores the receipt and the skills';
  end if;
  if (select detail -> 'skillCount' from audit_log
       where action = 'rail.template_published' and detail ->> 'revisionId' = v_revision::text)
     is distinct from '1'::jsonb then
    raise exception 'FAIL: the publish audit row counts the skills';
  end if;

  v_error := rcp_error(format('select rail_catalog_publish_check(%L, %L, %L)',
    v_catalog, v_bank, rcp_protected()));
  if v_error is distinct from 'nothing_to_publish' then
    raise exception 'FAIL: the check refuses an unchanged draft, got %', v_error;
  end if;

  v_error := rcp_error(format('select rail_catalog_publish_check(%L, %L, %L)',
    v_catalog, gen_random_uuid(), rcp_protected()));
  if v_error is distinct from 'template_missing' then
    raise exception 'FAIL: the check refuses another company, got %', v_error;
  end if;

  v_plain := rcp_template(v_bank, v_md, 'Probe Plain Rail');
  v_error := rcp_error(format('select publish_rail_template(%L, %L, %L, %L, %L, %L)',
    v_plain, v_bank, v_md, rcp_protected(), gen_random_uuid(), v_receipt));
  if v_error is distinct from 'draft_changed' then
    raise exception 'FAIL: a receipt sent for a draft with no skills is refused, got %', v_error;
  end if;

  perform remove_rail_template_step(v_bank, v_md, v_plain, rcp_step_row(v_plain, 'g0-notify'));
  v_error := rcp_error(format('select rail_catalog_publish_check(%L, %L, %L)',
    v_plain, v_bank, rcp_protected()));
  if v_error is distinct from 'missing_protected_step' then
    raise exception 'FAIL: the check refuses a draft missing a protected step, got %', v_error;
  end if;

  v_removed := rcp_template(v_bank, v_md, 'Probe Removed Skill Rail');
  perform delete_rail_template(v_bank, v_md, v_removed);
  v_error := rcp_error(format('select rail_catalog_publish_check(%L, %L, %L)',
    v_removed, v_bank, rcp_protected()));
  if v_error is distinct from 'template_removed' then
    raise exception 'FAIL: the check refuses a removed template, got %', v_error;
  end if;

  v_mounted := rcp_template(v_bank, v_md, 'Probe Mount Skill Rail');
  perform add_rail_template_step(v_bank, v_md, v_mounted, 'custom-' || gen_random_uuid()::text,
    null, 2, 'custom',
    jsonb_set(rcp_skill_definition(v_candidate, v_digest), '{skill,source}',
      jsonb_build_object('kind', 'mount', 'name', 'deal-teaser', 'version', 3, 'digest', repeat('c', 64))),
    null);
  perform publish_rail_template(v_mounted, v_bank, v_md, rcp_protected(), v_second,
    jsonb_build_object('revisionId', v_second, 'assets', jsonb_build_array(
      jsonb_build_object('key', 's0', 'packageDigest', repeat('d', 64)))));
  if (select state from rail_template_revisions where id = v_second) is distinct from 'ready' then
    raise exception 'FAIL: a catalog skill is retained under its package digest, which may differ from its reference';
  end if;
  declare
    x_request   uuid := gen_random_uuid();
    x_admission jsonb;
    x_target    jsonb;
    x_deal      uuid;
    x_binding   jsonb;
    x_error     text;
  begin
    x_admission := rail_template_admit_creation(v_md, x_request,
      jsonb_build_object(
        'templateId', (select rail_template_id from rail_catalog_templates where id = v_mounted),
        'revisionId', v_second),
      rcp_input(v_tenant, v_md, v_bank, 'Project Mounted'));
    x_deal := (x_admission ->> 'dealId')::uuid;
    x_target := x_admission -> 'targets' -> 0;
    x_binding := jsonb_build_object(
      'skillId', x_target ->> 'skillId', 'versionId', x_target ->> 'versionId', 'digest', repeat('c', 64));
    x_error := rcp_error(format('select rail_template_finalize_creation(%L, %L, %L::jsonb, %L::jsonb)',
      v_md, x_request,
      jsonb_build_object('requestId', x_request, 'projectId', x_deal,
        'skills', jsonb_build_array(jsonb_build_object('key', 's0', 'binding', x_binding))),
      rcp_skill_seed(x_admission -> 'manifest', x_admission -> 'stepIds', jsonb_build_object('s0', x_binding))));
    if x_error is distinct from 'provider_unavailable' then
      raise exception 'FAIL: a created deal cannot bind the source digest of a skill retained under another digest, got %', x_error;
    end if;

    x_binding := jsonb_set(x_binding, '{digest}', to_jsonb(repeat('d', 64)));
    x_error := rcp_error(format('select rail_template_finalize_creation(%L, %L, %L::jsonb, %L::jsonb)',
      v_md, x_request,
      jsonb_build_object('requestId', x_request, 'projectId', x_deal,
        'skills', jsonb_build_array(jsonb_build_object('key', 's0', 'binding', x_binding))),
      rcp_skill_seed(x_admission -> 'manifest', x_admission -> 'stepIds', jsonb_build_object('s0', x_binding))));
    if x_error is not null
       or not exists (select 1 from deal_step_skill_bindings
                       where deal_id = x_deal and digest = repeat('d', 64)) then
      raise exception 'FAIL: a created deal binds the digest its skill was retained under, got %', x_error;
    end if;
  end;

  v_pair := rcp_template(v_bank, v_md, 'Probe Pair Skill Rail');
  perform add_rail_template_step(v_bank, v_md, v_pair, 'custom-' || gen_random_uuid()::text,
    null, 2, 'custom', rcp_skill_definition(gen_random_uuid(), repeat('a', 64)), null);
  perform add_rail_template_step(v_bank, v_md, v_pair, 'custom-' || gen_random_uuid()::text,
    null, 2, 'custom', rcp_skill_definition(gen_random_uuid(), repeat('b', 64)), null);
  select jsonb_agg(jsonb_build_object(
           'key', skill ->> 'key',
           'packageDigest', case skill -> 'source' ->> 'digest'
                              when repeat('a', 64) then repeat('b', 64)
                              else repeat('a', 64) end)),
         jsonb_agg(jsonb_build_object(
           'key', skill ->> 'key',
           'packageDigest', skill -> 'source' ->> 'digest'))
    into v_swapped, v_matched
    from jsonb_array_elements(rail_catalog_manifest(v_pair) -> 'skills') skill;
  if jsonb_array_length(v_swapped) is distinct from 2 then
    raise exception 'FAIL: a template with two skill steps lists two skills, got %', v_swapped;
  end if;
  v_error := rcp_error(format('select publish_rail_template(%L, %L, %L, %L, %L, %L)',
    v_pair, v_bank, v_md, rcp_protected(), v_third,
    jsonb_build_object('revisionId', v_third, 'assets', v_swapped)));
  if v_error is distinct from 'draft_changed' then
    raise exception 'FAIL: a receipt that gives each skill the other skill''s digest is refused, got %', v_error;
  end if;
  perform publish_rail_template(v_pair, v_bank, v_md, rcp_protected(), v_third,
    jsonb_build_object('revisionId', v_third, 'assets', v_matched));
  if (select state from rail_template_revisions where id = v_third) is distinct from 'ready' then
    raise exception 'FAIL: the same receipt with each skill''s own digest publishes';
  end if;


  v_admission := rail_template_admit_creation(v_md, v_request,
    jsonb_build_object('templateId', v_result ->> 'templateId', 'revisionId', v_revision),
    rcp_input(v_tenant, v_md, v_bank, 'Project Quillon'));
  v_deal := (v_admission ->> 'dealId')::uuid;
  if jsonb_array_length(v_admission -> 'targets') is distinct from 1
     or v_admission -> 'targets' -> 0 ->> 'key' is distinct from 's0' then
    raise exception 'FAIL: creation reserves one import target for the version''s skill, got %',
      v_admission -> 'targets';
  end if;
  v_target := v_admission -> 'targets' -> 0;
  v_binding := jsonb_build_object(
    'skillId', v_target ->> 'skillId', 'versionId', v_target ->> 'versionId', 'digest', v_digest);
  perform rail_template_finalize_creation(v_md, v_request,
    jsonb_build_object('requestId', v_request, 'projectId', v_deal,
      'skills', jsonb_build_array(jsonb_build_object('key', 's0', 'binding', v_binding))),
    rcp_skill_seed(v_admission -> 'manifest', v_admission -> 'stepIds', jsonb_build_object('s0', v_binding)));

  select * into v_step from deal_steps
   where deal_id = v_deal and origin = 'custom' and definition ->> 'type' = 'skill';
  if v_step.id is null
     or v_step.definition -> 'skillBinding' is distinct from v_binding
     or v_step.definition ? 'skill'
     or v_step.template_step_key is null then
    raise exception 'FAIL: a deal created from the version has the skill step with its binding, got %',
      row_to_json(v_step);
  end if;
  if not exists (
    select 1 from deal_step_skill_bindings b
     where b.deal_step_id = v_step.id and b.kind = 'publication' and b.source = 'template'
       and b.skill_id = (v_binding ->> 'skillId')::uuid
       and b.version_id = (v_binding ->> 'versionId')::uuid and b.digest = v_digest) then
    raise exception 'FAIL: the created deal binds the step to its imported skill';
  end if;
  if not exists (
    select 1 from deal_skill_imports i
     where i.deal_id = v_deal and i.skill_id = (v_binding ->> 'skillId')::uuid
       and i.name = 'Buyer long list' and i.template_revision_id = v_revision
       and i.source_asset_key = 's0') then
    raise exception 'FAIL: the created deal records where the skill was imported from';
  end if;

  update rail_catalog_steps
     set definition = jsonb_set(definition, '{skill,source,digest}', to_jsonb(repeat('f', 64)))
   where template_id = v_catalog and definition ? 'skill';
  if rail_catalog_manifest_steps(v_catalog) is distinct from v_stored.manifest -> 'steps' then
    raise exception 'FAIL: changing only a skill source leaves the manifest steps as they were published';
  end if;
  if not rail_catalog_draft_differs(v_catalog) then
    raise exception 'FAIL: a changed skill source is a change to publish';
  end if;

  raise notice 'OK: publish stores the retain receipt and creation imports the skill';
end $$;

rollback;
