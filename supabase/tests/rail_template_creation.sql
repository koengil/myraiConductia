
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

create function rtc_bank(p_tenant uuid, p_label text) returns uuid
language plpgsql as $$
declare v_bank uuid := gen_random_uuid();
begin
  insert into companies (id, tenant_id, name, type) values (v_bank, p_tenant, p_label, 'bank');
  return v_bank;
end;
$$;

create function rtc_user(p_tenant uuid, p_bank uuid, p_email text, p_role text) returns uuid
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

create function rtc_source_deal(p_tenant uuid, p_bank uuid, p_md uuid, p_codename text) returns uuid
language plpgsql as $$
begin
  return (create_deal_gate0(
    p_tenant_id      => p_tenant,
    p_actor_id       => p_md,
    p_bank_id        => p_bank,
    p_codename       => p_codename,
    p_target_name    => 'Atlassian',
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

create function rtc_skill_definition() returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'type', 'skill',
    'title', 'Weekly memo',
    'description', 'Draft a memo',
    'inputs', jsonb_build_array(jsonb_build_object(
      'key', 'primary', 'kind', 'text', 'label', 'Input',
      'helperText', 'A reporting period.', 'required', true))
  );
$$;

create function rtc_custom_step(p_deal uuid, p_skill uuid, p_version uuid) returns uuid
language plpgsql as $$
declare v_row uuid := gen_random_uuid();
begin
  update deal_steps set display_order = display_order + 1
   where deal_id = p_deal and display_order >= 4;
  insert into deal_steps (
    id, deal_id, step_id, seq, status, phase_index, display_order, origin, definition
  ) values (
    v_row, p_deal, 'custom:' || v_row::text, null, 'complete', 1, 4, 'custom',
    rtc_skill_definition() || jsonb_build_object('skillBinding', jsonb_build_object(
      'skillId', p_skill, 'versionId', p_version, 'digest', repeat('a', 64)))
  );
  update deal_steps set work = jsonb_build_object('note', 'drafted') where id = v_row;
  return v_row;
end;
$$;

create function rtc_protected() returns text[] language sql immutable as $$
  select array['p1-s7', 'p1-s6', 'g0-notify'];
$$;

create function rtc_skill_block(p_binding jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'name', 'Weekly memo',
    'contract', jsonb_build_object('purpose', 'Draft a weekly memo.',
                                   'expectedInput', 'A reporting period.',
                                   'expectedOutput', 'A concise memo.'),
    'source', jsonb_build_object('kind', 'publication',
                                 'skillId', p_binding ->> 'skillId',
                                 'versionId', p_binding ->> 'versionId',
                                 'digest', p_binding ->> 'digest'));
$$;

create function rtc_steps(p_deal uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'dealStepId', s.id,
    'stepId', case when s.origin = 'catalog' then s.step_id
                   else coalesce(s.template_step_key, 'custom-' || s.id::text) end,
    'origin', s.origin,
    'seq', s.seq,
    'phaseIndex', s.phase_index,
    'definition', case
      when s.origin = 'catalog' then null
      when s.definition ? 'type' then (s.definition - 'skillBinding')
        || jsonb_build_object('skill', rtc_skill_block(s.definition -> 'skillBinding'))
      else jsonb_build_object('title', s.definition ->> 'title',
                              'description', s.definition ->> 'description') end
  ) order by s.display_order, s.id), '[]'::jsonb)
  from deal_steps s where s.deal_id = p_deal and s.removed_at is null;
$$;

create function rtc_input(p_tenant uuid, p_actor uuid, p_bank uuid, p_codename text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'tenantId', p_tenant, 'actorId', p_actor, 'bankId', p_bank,
    'codename', p_codename, 'targetName', 'Canva', 'targetCompanyId', null,
    'codenameTheme', null, 'members', '[]'::jsonb,
    'screening', jsonb_build_object('verdict', 'approved', 'reasons', '[]'::jsonb),
    'conflicts', jsonb_build_object('approvedBy', 'Avery Lindqvist', 'approvedOn', '2026-09-02')
  );
$$;

create function rtc_bindings(p_targets jsonb, p_digest text) returns jsonb
language sql as $$
  select coalesce(jsonb_object_agg(t ->> 'key', jsonb_build_object(
    'skillId', t ->> 'skillId', 'versionId', t ->> 'versionId', 'digest', p_digest)), '{}'::jsonb)
  from jsonb_array_elements(p_targets) t;
$$;

create function rtc_imports(p_request uuid, p_deal uuid, p_targets jsonb, p_digest text)
returns jsonb language sql as $$
  select jsonb_build_object(
    'requestId', p_request,
    'projectId', p_deal,
    'skills', coalesce((select jsonb_agg(jsonb_build_object(
      'key', t ->> 'key',
      'binding', jsonb_build_object('skillId', t ->> 'skillId',
                                    'versionId', t ->> 'versionId', 'digest', p_digest)))
      from jsonb_array_elements(p_targets) t), '[]'::jsonb)
  );
$$;

create function rtc_seed(p_manifest jsonb, p_step_ids jsonb, p_bindings jsonb)
returns jsonb language sql as $$
  select coalesce(jsonb_agg(seed_row order by (step ->> 'displayOrder')::int), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', p_step_ids ->> (step ->> 'key'),
      'stepId', coalesce(step ->> 'catalogStepId', 'custom:' || (p_step_ids ->> (step ->> 'key'))),
      'origin', case when step ->> 'catalogStepId' is not null then 'catalog' else 'custom' end,
      'phaseIndex', (step ->> 'phaseIndex')::int,
      'displayOrder', (step ->> 'displayOrder')::int
    ) || jsonb_build_object(
      'seq', step -> 'seq',
      'definition', case
        when step ->> 'catalogStepId' is not null or jsonb_typeof(step -> 'definition') <> 'object'
          then 'null'::jsonb
        when step -> 'definition' ? 'type'
          then (step -> 'definition') || jsonb_build_object(
                 'skillBinding', p_bindings -> (step ->> 'skillKey'))
        else step -> 'definition' end,
      'binding', case when step ->> 'skillKey' is null then 'null'::jsonb
                      else p_bindings -> (step ->> 'skillKey') end
    ) as seed_row, step
    from jsonb_array_elements(p_manifest -> 'steps') step
  ) rows;
$$;

create function rtc_publish(
  p_actor uuid, p_bank uuid, p_deal uuid, p_name text, p_template uuid, p_expected uuid
) returns uuid language plpgsql as $$
declare
  v_revision uuid := gen_random_uuid();
  v_steps    jsonb := rtc_steps(p_deal);
  v_skills   int;
  v_saved    jsonb;
begin
  select count(*) into v_skills
    from jsonb_array_elements(v_steps) step
   where jsonb_typeof(step -> 'definition' -> 'skill') = 'object';
  v_saved := save_rail_to_catalog(
    p_actor, p_bank, p_deal, gen_random_uuid(),
    case when p_template is null
      then jsonb_build_object('kind', 'new', 'name', p_name)
      else jsonb_build_object('kind', 'replace', 'templateId', p_template,
                              'expectedRevisionId', p_expected) end,
    'Shape', v_steps, rail_template_source_fingerprint(p_deal), rtc_protected(),
    case when v_skills > 0 then v_revision end,
    case when v_skills > 0 then jsonb_build_object('revisionId', v_revision, 'assets',
      jsonb_build_array(jsonb_build_object('key', 's0', 'packageDigest', repeat('a', 64)))) end);
  return (v_saved ->> 'revisionId')::uuid;
end;
$$;

do $$
declare
  v_tenant      uuid := '00000000-0000-4000-8000-00000000000c';
  v_bank        uuid;
  v_md          uuid;
  v_creator     uuid;
  v_source      uuid;
  v_custom      uuid;
  v_skill       uuid := gen_random_uuid();
  v_version     uuid := gen_random_uuid();
  v_manifest_a  jsonb;
  v_manifest_b  jsonb;
  v_template    uuid;
  v_revision_a  uuid;
  v_revision_b  uuid;
  v_selection   jsonb;
  v_input       jsonb;
  v_admission   jsonb;
  v_receipt     jsonb;
  v_request_1   uuid := gen_random_uuid();
  v_request_2   uuid := gen_random_uuid();
  v_request_3   uuid := gen_random_uuid();
  v_request_4   uuid := gen_random_uuid();
  v_request_5   uuid := gen_random_uuid();
  v_deal_5      uuid;
  v_targets_5   jsonb;
  v_deal_1      uuid;
  v_deal_2      uuid;
  v_deal_3      uuid;
  v_seed        jsonb;
  v_imports     jsonb;
  v_targets     jsonb;
  v_bindings    jsonb;
  v_snapshot_1  jsonb;
  v_current     uuid;
  v_removed     uuid;
  v_ok          boolean;
begin
  insert into feature_flags (key, enabled) values ('company_access_management', true)
    on conflict (key) do update set enabled = true;

  v_bank := rtc_bank(v_tenant, 'Probe Creation Bank');
  v_md := rtc_user(v_tenant, v_bank, 'rtc-md@example.com', 'director');
  v_creator := rtc_user(v_tenant, v_bank, 'rtc-creator@example.com', 'director');
  v_source := rtc_source_deal(v_tenant, v_bank, v_md, 'Probe Creation Source');
  v_custom := rtc_custom_step(v_source, v_skill, v_version);

  update deal_steps set work = jsonb_build_object('note', 'done'), assigned_to = v_md
   where deal_id = v_source and step_id = 'p1-s10';

  select id into v_removed from deal_steps where deal_id = v_source and step_id = 'p1-s11';
  perform rail_remove_step(v_source, v_md, v_removed, array[]::text[]);

  v_revision_a := rtc_publish(v_md, v_bank, v_source, 'Diligence Rail', null, null);
  select template_id, manifest into v_template, v_manifest_a
    from rail_template_revisions where id = v_revision_a;
  if v_manifest_a -> 'schemaVersion' is distinct from '2'::jsonb
     or (v_manifest_a -> 'steps' -> 3 ->> 'templateStepKey') is distinct from 'custom-' || v_custom::text then
    raise exception 'FAIL: the fixture must be a published catalog version keyed by template step ids, got %',
      v_manifest_a -> 'steps' -> 3;
  end if;

  if (v_manifest_a -> 'steps' -> 3 ->> 'catalogStepId') is not null
     or (v_manifest_a -> 'steps' -> 3 -> 'seq') <> 'null'::jsonb then
    raise exception 'FAIL: the fixture must capture a custom step with a null seq, got %',
      v_manifest_a -> 'steps' -> 3;
  end if;

  v_selection := jsonb_build_object('templateId', v_template, 'revisionId', v_revision_a);
  v_input := rtc_input(v_tenant, v_creator, v_bank, 'Project Lantern');

  v_admission := rail_template_admit_creation(v_creator, v_request_1, v_selection, v_input);
  v_deal_1 := (v_admission ->> 'dealId')::uuid;
  v_targets := v_admission -> 'targets';

  if (v_admission ->> 'state') <> 'preparing' or (v_admission -> 'receipt') <> 'null'::jsonb then
    raise exception 'FAIL: admission must freeze the creation as preparing with no receipt';
  end if;
  if (v_admission ->> 'revisionId')::uuid is distinct from v_revision_a then
    raise exception 'FAIL: admission must freeze the current revision';
  end if;
  if jsonb_array_length(v_targets) <> 1
     or (v_targets -> 0 ->> 'skillId')::uuid = v_skill
     or (v_targets -> 0 ->> 'versionId')::uuid = v_version then
    raise exception 'FAIL: admission must reserve fresh skill identities, got %', v_targets;
  end if;
  if exists (select 1 from deals where id = v_deal_1) then
    raise exception 'FAIL: admission must not create a visible deal';
  end if;

  if rail_template_admit_creation(v_creator, v_request_1, v_selection, v_input) ->> 'dealId'
     is distinct from v_deal_1::text then
    raise exception 'FAIL: readmitting a request must return the same reserved deal';
  end if;
  v_ok := false;
  begin
    perform rail_template_admit_creation(v_creator, v_request_1, v_selection,
      rtc_input(v_tenant, v_creator, v_bank, 'Project Beacon'));
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'idempotency_conflict';
  end;
  if not v_ok then
    raise exception 'FAIL: a changed payload on a live request must conflict';
  end if;

  v_bindings := rtc_bindings(v_targets, repeat('a', 64));
  v_seed := rtc_seed(v_manifest_a, v_admission -> 'stepIds', v_bindings);
  v_imports := rtc_imports(v_request_1, v_deal_1, v_targets, repeat('a', 64));

  v_ok := false;
  begin
    perform rail_template_finalize_creation(v_creator, v_request_1,
      jsonb_build_object('requestId', v_request_1, 'projectId', v_deal_1, 'skills', '[]'::jsonb),
      v_seed);
  exception when sqlstate 'P0001' then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL: a receipt missing an imported asset must abort';
  end if;
  if exists (select 1 from deals where id = v_deal_1)
     or exists (select 1 from deal_steps where deal_id = v_deal_1)
     or exists (select 1 from deal_skill_imports where deal_id = v_deal_1) then
    raise exception 'FAIL: an aborted finalization must leave no deal, steps or imports';
  end if;

  v_receipt := rail_template_finalize_creation(v_creator, v_request_1, v_imports, v_seed);

  if (v_receipt -> 'deal' ->> 'id')::uuid is distinct from v_deal_1
     or coalesce(v_receipt -> 'deal' ->> 'code', '') = ''
     or (v_receipt -> 'screening' ->> 'verdict') <> 'approved'
     or jsonb_array_length(v_receipt -> 'notified') < 1 then
    raise exception 'FAIL: finalization must return the Gate 0 receipt, got %', v_receipt;
  end if;

  if (select count(*) from deal_steps where deal_id = v_deal_1 and status = 'current') <> 1 then
    raise exception 'FAIL: template creation must have one current step';
  end if;
  select current_deal_step_id into v_current from deals where id = v_deal_1;
  if v_current is distinct from (select id from deal_steps where deal_id = v_deal_1 and status = 'current') then
    raise exception 'FAIL: the deal must point at its own current step row';
  end if;
  if (select origin from deal_steps where id = v_current) <> 'custom'
     or (select seq from deal_steps where id = v_current) is not null
     or (select definition ->> 'title' from deal_steps where id = v_current) <> 'Weekly memo' then
    raise exception 'FAIL: the first execution step must be the captured custom step with no seq';
  end if;
  if (select array_agg(step_id order by step_id) from deal_steps
       where deal_id = v_deal_1 and status = 'skipped_entry')
     is distinct from (select array_agg(id order by id) from unnest(rail_template_gate0_step_ids()) id) then
    raise exception 'FAIL: only the Gate 0 receipt steps may be skipped on entry';
  end if;
  if exists (
    select 1 from deal_steps where deal_id = v_deal_1
       and status not in ('current', 'skipped_entry', 'pending')) then
    raise exception 'FAIL: source progress must not be copied';
  end if;
  if exists (select 1 from deal_steps where deal_id = v_deal_1
              and (assigned_to is not null or coalesce(work, '{}'::jsonb) <> '{}'::jsonb)) then
    raise exception 'FAIL: source people or work copied';
  end if;
  if exists (select 1 from deal_steps
              where deal_id = v_deal_1 and step_id = 'custom:' || v_custom::text) then
    raise exception 'FAIL: destination steps must carry fresh identities';
  end if;
  if (select count(*) from deal_steps where deal_id = v_deal_1)
     <> jsonb_array_length(v_manifest_a -> 'steps') then
    raise exception 'FAIL: the destination rail must hold exactly the captured steps';
  end if;
  if exists (select 1 from deal_steps where deal_id = v_deal_1 and removed_at is not null) then
    raise exception 'FAIL: removed source steps must not be copied';
  end if;
  if exists (select 1 from deal_steps where deal_id = v_deal_1 and template_step_key is null) then
    raise exception 'FAIL: every step created from a published version carries its template step id';
  end if;

  if (select rail_template_revision_id from deals where id = v_deal_1) is distinct from v_revision_a
     or (select rail_template_name from deals where id = v_deal_1) <> 'Diligence Rail' then
    raise exception 'FAIL: the deal must record the template revision it was created from';
  end if;

  if (select count(*) from deal_step_skill_bindings where deal_id = v_deal_1) <> 1 then
    raise exception 'FAIL: the destination must bind exactly the captured skill';
  end if;
  if exists (select 1 from deal_step_skill_bindings
              where deal_id = v_deal_1
                and (source <> 'template' or kind <> 'publication'
                     or skill_id = v_skill or version_id = v_version
                     or digest <> repeat('a', 64) or bound_by <> v_creator)) then
    raise exception 'FAIL: bound copies must be template sourced with independent identities';
  end if;
  if (select count(*) from deal_skill_imports where deal_id = v_deal_1) <> 1
     or not exists (
       select 1 from deal_skill_imports
        where deal_id = v_deal_1 and template_revision_id = v_revision_a
          and source_asset_key = 's0' and name = 'Weekly memo'
          and imported_by = v_creator
          and capability_contract ->> 'purpose' = 'Draft a weekly memo.') then
    raise exception 'FAIL: the destination must record its imported skill metadata';
  end if;
  if not exists (
    select 1 from deal_step_skill_bindings b join deal_skill_imports i
      on i.skill_id = b.skill_id and i.version_id = b.version_id
     where b.deal_id = v_deal_1) then
    raise exception 'FAIL: the bound copy must resolve to the imported skill';
  end if;

  if not exists (
    select 1 from audit_log
     where deal_id = v_deal_1 and action = 'rail.template_applied' and actor_id = v_creator
       and (detail ->> 'templateId')::uuid = v_template
       and (detail ->> 'revisionId')::uuid = v_revision_a
       and (detail ->> 'stepCount')::int = jsonb_array_length(v_manifest_a -> 'steps')
       and (detail ->> 'skillCount')::int = 1) then
    raise exception 'FAIL: applying a template must be audited';
  end if;
  if exists (
    select 1 from audit_log where deal_id = v_deal_1 and action = 'rail.template_applied'
       and (detail ? 'manifest' or detail ? 'seed' or detail ? 'imports' or detail ? 'input')) then
    raise exception 'FAIL: template audit detail must carry ids and counts only';
  end if;

  select jsonb_build_object(
    'steps', (select jsonb_agg(to_jsonb(s) order by s.display_order) from deal_steps s where s.deal_id = v_deal_1),
    'bindings', (select jsonb_agg(to_jsonb(b) order by b.deal_step_id) from deal_step_skill_bindings b
                  where b.deal_id = v_deal_1)) into v_snapshot_1;

  if rail_template_finalize_creation(v_creator, v_request_1, v_imports, v_seed) is distinct from v_receipt then
    raise exception 'FAIL: replaying a finished creation must return its stored receipt';
  end if;
  if (select count(*) from deals where rail_template_revision_id = v_revision_a) <> 2 then
    raise exception 'FAIL: replaying a finished creation must not create another deal: the source deal and the first created deal follow this version';
  end if;
  if (select count(*) from notifications where deal_id = v_deal_1 and event_type = 'deal_created')
     <> jsonb_array_length(v_receipt -> 'notified') then
    raise exception 'FAIL: replaying a finished creation must not notify twice';
  end if;
  if (select count(*) from audit_log where deal_id = v_deal_1 and action = 'rail.template_applied') <> 1 then
    raise exception 'FAIL: replaying a finished creation must not audit twice';
  end if;

  v_admission := rail_template_admit_creation(v_creator, v_request_5, v_selection,
    rtc_input(v_tenant, v_creator, v_bank, 'Project Cinder'));
  v_deal_5 := (v_admission ->> 'dealId')::uuid;
  v_targets_5 := v_admission -> 'targets';

  insert into deal_skill_imports (
    skill_id, deal_id, version_id, digest, name, capability_contract,
    imported_by, template_revision_id, source_asset_key
  ) values (
    gen_random_uuid(), v_source, (v_targets_5 -> 0 ->> 'versionId')::uuid, repeat('a', 64),
    'Weekly memo', jsonb_build_object('purpose', 'Draft a weekly memo.',
      'expectedInput', 'A reporting period.', 'expectedOutput', 'A concise memo.'),
    v_md, v_revision_a, 's0'
  );

  v_ok := false;
  begin
    perform rail_template_finalize_creation(v_creator, v_request_5,
      rtc_imports(v_request_5, v_deal_5, v_targets_5, repeat('a', 64)),
      rtc_seed(v_manifest_a, v_admission -> 'stepIds',
               rtc_bindings(v_targets_5, repeat('a', 64))));
  exception when unique_violation then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL: a duplicate imported skill identity must abort finalization';
  end if;
  if exists (select 1 from deals where id = v_deal_5)
     or exists (select 1 from deal_steps where deal_id = v_deal_5)
     or exists (select 1 from deal_step_skill_bindings where deal_id = v_deal_5)
     or exists (select 1 from deal_skill_imports where deal_id = v_deal_5)
     or exists (select 1 from notifications where deal_id = v_deal_5)
     or exists (select 1 from audit_log where deal_id = v_deal_5) then
    raise exception 'FAIL: a failure after step insertion must leave no deal, steps, imports or notices';
  end if;
  if (select state from rail_template_creations where request_id = v_request_5) <> 'preparing' then
    raise exception 'FAIL: a failed finalization must leave the creation resumable';
  end if;

  delete from deal_skill_imports
   where deal_id = v_source and version_id = (v_targets_5 -> 0 ->> 'versionId')::uuid;
  perform rail_template_finalize_creation(v_creator, v_request_5,
    rtc_imports(v_request_5, v_deal_5, v_targets_5, repeat('a', 64)),
    rtc_seed(v_manifest_a, v_admission -> 'stepIds',
             rtc_bindings(v_targets_5, repeat('a', 64))));
  if (select count(*) from deal_steps where deal_id = v_deal_5)
     <> jsonb_array_length(v_manifest_a -> 'steps')
     or (select count(*) from deal_skill_imports where deal_id = v_deal_5) <> 1 then
    raise exception 'FAIL: a retry after a post-insert failure must produce the whole rail';
  end if;

  v_admission := rail_template_admit_creation(v_creator, v_request_3, v_selection,
    rtc_input(v_tenant, v_creator, v_bank, 'Project Harbour'));
  v_deal_3 := (v_admission ->> 'dealId')::uuid;

  select id into v_removed from deal_steps where deal_id = v_source and step_id = 'p1-s10';
  perform rail_remove_step(v_source, v_md, v_removed, array[]::text[]);
  v_revision_b := rtc_publish(v_md, v_bank, v_source, null, v_template, v_revision_a);
  select manifest into v_manifest_b from rail_template_revisions where id = v_revision_b;

  if (select version from rail_template_revisions where id = v_revision_a) is distinct from 1
     or (select version from rail_template_revisions where id = v_revision_b) is distinct from 2 then
    raise exception 'FAIL: a saved rail must number its revisions 1 then 2';
  end if;

  if jsonb_array_length(v_manifest_b -> 'steps') >= jsonb_array_length(v_manifest_a -> 'steps') then
    raise exception 'FAIL: the replacement fixture must differ from the captured revision';
  end if;

  v_receipt := rail_template_finalize_creation(v_creator, v_request_3,
    rtc_imports(v_request_3, v_deal_3, v_admission -> 'targets', repeat('a', 64)),
    rtc_seed(v_manifest_a, v_admission -> 'stepIds',
               rtc_bindings(v_admission -> 'targets', repeat('a', 64))));
  if (select rail_template_revision_id from deals where id = v_deal_3) is distinct from v_revision_a
     or (select count(*) from deal_steps where deal_id = v_deal_3)
        <> jsonb_array_length(v_manifest_a -> 'steps') then
    raise exception 'FAIL: a creation admitted before a replacement must keep its captured revision';
  end if;

  v_ok := false;
  begin
    perform rail_template_admit_creation(v_creator, v_request_4, v_selection,
      rtc_input(v_tenant, v_creator, v_bank, 'Project Meridian'));
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'stale_template';
  end;
  if not v_ok then
    raise exception 'FAIL: a new request against a superseded revision must be stale';
  end if;

  v_admission := rail_template_admit_creation(v_creator, v_request_2,
    jsonb_build_object('templateId', v_template, 'revisionId', v_revision_b),
    rtc_input(v_tenant, v_creator, v_bank, 'Project Meridian'));
  v_deal_2 := (v_admission ->> 'dealId')::uuid;
  perform rail_template_finalize_creation(v_creator, v_request_2,
    rtc_imports(v_request_2, v_deal_2, v_admission -> 'targets', repeat('a', 64)),
    rtc_seed(v_manifest_b, v_admission -> 'stepIds',
               rtc_bindings(v_admission -> 'targets', repeat('a', 64))));

  if (select count(*) from deal_steps where deal_id = v_deal_2)
     <> jsonb_array_length(v_manifest_b -> 'steps') then
    raise exception 'FAIL: a later creation must follow the replaced revision';
  end if;
  if (select jsonb_build_object(
        'steps', (select jsonb_agg(to_jsonb(s) order by s.display_order) from deal_steps s where s.deal_id = v_deal_1),
        'bindings', (select jsonb_agg(to_jsonb(b) order by b.deal_step_id) from deal_step_skill_bindings b
                      where b.deal_id = v_deal_1))) is distinct from v_snapshot_1 then
    raise exception 'FAIL: replacing a template must not touch an earlier deal';
  end if;
  if (select count(distinct skill_id) from deal_step_skill_bindings
       where deal_id in (v_deal_1, v_deal_2)) <> 2 then
    raise exception 'FAIL: each deal must receive its own skill identity';
  end if;

  raise notice 'OK: admission, atomic finalization, fresh identities and replacement isolation';
end $$;

rollback;

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

do $$
declare
  v_relation text;
  v_routine  text;
  v_role     text;
begin
  if not (select relrowsecurity from pg_class where oid = 'rail_template_creations'::regclass) then
    raise exception 'FAIL: rail_template_creations must enable row level security';
  end if;
  foreach v_role in array array['anon', 'authenticated']
  loop
    if has_table_privilege(v_role, 'rail_template_creations', 'select')
       or has_table_privilege(v_role, 'rail_template_creations', 'insert')
       or has_table_privilege(v_role, 'rail_template_creations', 'update')
       or has_table_privilege(v_role, 'rail_template_creations', 'delete') then
      raise exception 'FAIL: rail_template_creations must carry no browser grants, % holds one', v_role;
    end if;
  end loop;
  if not has_table_privilege('service_role', 'rail_template_creations', 'select') then
    raise exception 'FAIL: service_role must read rail_template_creations';
  end if;

  foreach v_routine in array array[
    'create_deal_gate0_core(uuid, uuid, uuid, text, text, uuid, text, int, int, jsonb, jsonb, jsonb, text, jsonb, uuid, jsonb, uuid, text)',
    'rail_template_admit_creation(uuid, uuid, jsonb, jsonb)',
    'rail_template_finalize_creation(uuid, uuid, jsonb, jsonb)'
  ]
  loop
    foreach v_role in array array['anon', 'authenticated']
    loop
      if has_function_privilege(v_role, v_routine, 'execute') then
        raise exception 'FAIL: % must not be executable by %', v_routine, v_role;
      end if;
    end loop;
    if not has_function_privilege('service_role', v_routine, 'execute') then
      raise exception 'FAIL: service_role must execute %', v_routine;
    end if;
  end loop;

  foreach v_role in array array['anon', 'authenticated']
  loop
    if has_function_privilege(v_role,
      'create_deal_gate0(uuid, uuid, uuid, text, text, uuid, text, int, int, jsonb, jsonb, jsonb, text, jsonb)',
      'execute') then
      raise exception 'FAIL: create_deal_gate0 must stay closed to %', v_role;
    end if;
  end loop;

  raise notice 'OK: row level security and execute grants';
end $$;

rollback;

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

create function rtc_bank(p_tenant uuid, p_label text) returns uuid
language plpgsql as $$
declare v_bank uuid := gen_random_uuid();
begin
  insert into companies (id, tenant_id, name, type) values (v_bank, p_tenant, p_label, 'bank');
  return v_bank;
end;
$$;

create function rtc_user(p_tenant uuid, p_bank uuid, p_email text, p_role text) returns uuid
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

do $$
declare
  v_tenant uuid := '00000000-0000-4000-8000-00000000000d';
  v_bank   uuid;
  v_md     uuid;
  v_result jsonb;
  v_deal   uuid;
begin
  v_bank := rtc_bank(v_tenant, 'Probe Standard Bank');
  v_md := rtc_user(v_tenant, v_bank, 'rtc-standard@example.com', 'director');

  v_result := create_deal_gate0(
    p_tenant_id      => v_tenant,
    p_actor_id       => v_md,
    p_bank_id        => v_bank,
    p_codename       => 'Probe Standard One',
    p_target_name    => 'Atlassian',
    p_entry_step_seq => 4,
    p_entry_phase    => 1,
    p_steps          => jsonb_build_array(
      jsonb_build_object('stepId', 'p1-s7', 'seq', 1, 'phaseIndex', 1, 'displayOrder', 1),
      jsonb_build_object('stepId', 'p1-s6', 'seq', 2, 'phaseIndex', 1, 'displayOrder', 2),
      jsonb_build_object('stepId', 'g0-notify', 'seq', 3, 'phaseIndex', 1, 'displayOrder', 3),
      jsonb_build_object('stepId', 'p1-s10', 'seq', 4, 'phaseIndex', 1, 'displayOrder', 4),
      jsonb_build_object('stepId', 'p1-s11', 'seq', 5, 'phaseIndex', 2, 'displayOrder', 5)
    ),
    p_census_version => 'probe-rail',
    p_conflicts      => jsonb_build_object('approvedBy', 'Avery Lindqvist', 'approvedOn', '2026-09-01')
  );

  v_deal := (v_result -> 'deal' ->> 'id')::uuid;
  if v_deal is null or (v_result -> 'deal' ->> 'entryStepSeq')::int <> 4
     or (v_result -> 'deal' ->> 'currentStepSeq')::int <> 4
     or jsonb_array_length(v_result -> 'notified') < 1 then
    raise exception 'FAIL: standard creation must keep its receipt, got %', v_result;
  end if;
  if (select count(*) from deal_steps where deal_id = v_deal) <> 5
     or (select step_id from deal_steps where deal_id = v_deal and status = 'current') <> 'p1-s10'
     or (select count(*) from deal_steps where deal_id = v_deal and status = 'skipped_entry') <> 3
     or (select count(*) from deal_steps where deal_id = v_deal and status = 'pending') <> 1 then
    raise exception 'FAIL: standard creation must still seed status by sequence';
  end if;
  if (select current_deal_step_id from deals where id = v_deal)
     is distinct from (select id from deal_steps where deal_id = v_deal and status = 'current') then
    raise exception 'FAIL: standard creation must still point at its current step';
  end if;
  if (select rail_template_revision_id from deals where id = v_deal) is not null
     or (select rail_template_name from deals where id = v_deal) is not null then
    raise exception 'FAIL: standard creation must leave template provenance empty';
  end if;
  if (select count(*) from deal_steps where deal_id = v_deal and origin <> 'catalog') <> 0 then
    raise exception 'FAIL: standard creation must seed catalog steps';
  end if;

  raise notice 'OK: standard Gate 0 creation is unchanged';
end $$;

rollback;
