begin;
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

create function tcr_bank(p_tenant uuid, p_label text) returns uuid
language plpgsql as $$
declare v_bank uuid := gen_random_uuid();
begin
  insert into companies (id, tenant_id, name, type) values (v_bank, p_tenant, p_label, 'bank');
  return v_bank;
end;
$$;

create function tcr_user(p_tenant uuid, p_bank uuid, p_email text, p_role text, p_external boolean)
returns uuid language plpgsql as $$
declare v_user uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_user, p_email, jsonb_build_object('department', 'ib', 'tenant_id', p_tenant));
  update users
     set company_id = p_bank, company_role = p_role, is_external = p_external, status = 'active'
   where id = v_user;
  return v_user;
end;
$$;

create function tcr_template(p_tenant uuid, p_bank uuid, p_actor uuid, p_name text) returns uuid
language plpgsql as $$
declare v_template uuid;
begin
  insert into rail_templates (tenant_id, company_id, name, created_by)
    values (p_tenant, p_bank, p_name, p_actor)
    returning id into v_template;
  insert into rail_catalog_templates (company_id, name, created_by, rail_template_id)
    values (p_bank, p_name, p_actor, v_template);
  return v_template;
end;
$$;

create function tcr_step(p_key text, p_phase int, p_order int, p_definition jsonb default null)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'key', 't' || p_order,
    'templateStepKey', p_key,
    'catalogStepId', case when p_key like 'custom-%' then null else p_key end,
    'seq', case when p_key like 'custom-%' then null else p_order end,
    'phaseIndex', p_phase,
    'displayOrder', p_order,
    'definition', p_definition,
    'skillKey', null
  );
$$;

create function tcr_skill_definition() returns jsonb language sql immutable as $$
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

create function tcr_revision(p_template uuid, p_actor uuid, p_version int, p_steps jsonb, p_schema int default 2)
returns uuid language plpgsql as $$
declare v_revision uuid;
begin
  insert into rail_template_revisions (
    template_id, actor_id, request_id, request_digest, command,
    source_catalog_template_id, manifest, state, version
  ) values (
    p_template, p_actor, gen_random_uuid(), repeat('c', 64), '{}'::jsonb,
    (select id from rail_catalog_templates where rail_template_id = p_template),
    jsonb_build_object('schemaVersion', p_schema, 'censusVersion', 'probe-rail',
                       'steps', p_steps, 'skills', '[]'::jsonb),
    'ready', p_version
  ) returning id into v_revision;
  update rail_templates set current_revision_id = v_revision where id = p_template;
  return v_revision;
end;
$$;

create function tcr_deal(p_tenant uuid, p_bank uuid, p_revision uuid, p_codename text) returns uuid
language plpgsql as $$
declare v_deal uuid := gen_random_uuid();
begin
  insert into deals (
    id, tenant_id, code, codename, bank_id, status, rail_template_revision_id, rail_template_name
  ) values (
    v_deal, p_tenant, 'TCR-' || upper(left(replace(v_deal::text, '-', ''), 10)), p_codename,
    p_bank, 'active', p_revision,
    (select t.name from rail_template_revisions r join rail_templates t on t.id = r.template_id
      where r.id = p_revision)
  );
  return v_deal;
end;
$$;

create function tcr_deal_step(p_deal uuid, p_step text, p_phase int, p_order int, p_status text, p_key text)
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into deal_steps (
    id, deal_id, step_id, seq, status, phase_index, display_order, origin, definition, template_step_key
  ) values (
    v_id, p_deal, p_step,
    case when p_step like 'custom:%' then null else p_order end,
    p_status, p_phase, p_order,
    case when p_step like 'custom:%' then 'custom' else 'catalog' end,
    case when p_step like 'custom:%'
      then jsonb_build_object('title', 'Team memo', 'description', 'Added by the deal team.') end,
    p_key
  );
  return v_id;
end;
$$;

create function tcr_member(p_deal uuid, p_user uuid, p_role text) returns void
language sql as $$
  insert into deal_memberships (deal_id, user_id, role_id, deal_role)
  values (p_deal, p_user, (select id from roles where slug = p_role), p_role);
$$;

create function tcr_ids(p_set jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(c.value ->> 'id' order by c.ord), '[]'::jsonb)
    from jsonb_array_elements(p_set -> 'changes') with ordinality as c(value, ord);
$$;

create function tcr_change(p_set jsonb, p_id text) returns jsonb language sql immutable as $$
  select c.value from jsonb_array_elements(p_set -> 'changes') as c(value)
   where c.value ->> 'id' = p_id;
$$;

create function tcr_row(p_deal uuid, p_step text) returns deal_steps language sql stable as $$
  select * from deal_steps where deal_id = p_deal and step_id = p_step;
$$;

create function tcr_current(p_deal uuid) returns uuid language sql stable as $$
  select t.current_revision_id
    from deals d
    join rail_template_revisions r on r.id = d.rail_template_revision_id
    join rail_templates t on t.id = r.template_id
   where d.id = p_deal;
$$;

create function tcr_decide(p_deal uuid, p_actor uuid, p_change text, p_decision text, p_protected text[])
returns jsonb language sql as $$
  select deal_template_change_decide(p_deal, p_actor, p_change, p_decision, tcr_current(p_deal), p_protected);
$$;

do $$
declare
  v_tenant    uuid := '00000000-0000-4000-8000-0000000000d1';
  v_protected text[] := array['p1-s7'];
  v_bank      uuid;
  v_director  uuid;
  v_template  uuid;
  v_legacy    uuid;
  v_v1        uuid;
  v_legacy_v1 uuid;
  v_deal      uuid;
  v_plain     uuid;
  v_old       uuid;
  v_s11       uuid;
  v_team      uuid;
  v_s21       uuid;
  v_s22       uuid;
  v_s23       uuid;
  v_set       jsonb;
begin
  v_bank := tcr_bank(v_tenant, 'Probe Review Bank');
  v_director := tcr_user(v_tenant, v_bank, 'tcr-director@example.com', 'director', false);
  update users set display_name = 'Avery Lindqvist' where id = v_director;
  v_template := tcr_template(v_tenant, v_bank, v_director, 'Standard sell-side');
  v_v1 := tcr_revision(v_template, v_director, 1, jsonb_build_array(
    tcr_step('p1-s7', 1, 1), tcr_step('p1-s10', 1, 2),
    tcr_step('p2-s11', 2, 3), tcr_step('p2-s12', 2, 4), tcr_step('p2-s13', 2, 5),
    tcr_step('p3-s20', 3, 6), tcr_step('p3-s21', 3, 7), tcr_step('p3-s23', 3, 8)));

  v_deal := tcr_deal(v_tenant, v_bank, v_v1, 'Project Lantern');
  perform tcr_deal_step(v_deal, 'p1-s7', 1, 1, 'skipped_entry', 'p1-s7');
  perform tcr_deal_step(v_deal, 'p1-s10', 1, 2, 'current', 'p1-s10');
  v_s11 := tcr_deal_step(v_deal, 'p2-s11', 2, 3, 'pending', 'p2-s11');
  v_team := tcr_deal_step(v_deal, 'custom:team', 2, 4, 'pending', null);
  update deal_steps set anchor_step_id = v_s11 where id = v_team;
  perform tcr_deal_step(v_deal, 'p2-s12', 2, 5, 'complete', 'p2-s12');
  perform tcr_deal_step(v_deal, 'p2-s13', 2, 6, 'pending', 'p2-s13');
  perform tcr_deal_step(v_deal, 'p3-s20', 3, 7, 'pending', 'p3-s20');
  v_s21 := tcr_deal_step(v_deal, 'p3-s21', 3, 8, 'pending', 'p3-s21');
  v_s22 := tcr_deal_step(v_deal, 'p3-s22', 3, 9, 'pending', 'p3-s22');
  update deal_steps set removed_at = now(), anchor_step_id = v_s21 where id = v_s22;
  v_s23 := tcr_deal_step(v_deal, 'p3-s23', 3, 10, 'pending', 'p3-s23');
  update deal_steps set removed_at = now(), removed_by = v_director where id = v_s23;
  update deals set current_deal_step_id = (tcr_row(v_deal, 'p1-s10')).id where id = v_deal;

  if deal_template_changes(v_deal, v_protected) is not null then
    raise exception 'FAIL: a deal on the current revision must be offered nothing';
  end if;

  perform tcr_revision(v_template, v_director, 2, jsonb_build_array(
    tcr_step('p1-s10', 1, 1),
    tcr_step('custom-start', 2, 2, jsonb_build_object('title', 'Kick-off memo', 'description', 'Open the phase.')),
    tcr_step('p2-s11', 2, 3),
    tcr_step('custom-fairness', 2, 4,
      jsonb_build_object('title', 'Fairness opinion', 'description', 'Independent fairness opinion.')),
    tcr_step('p3-s20', 3, 5),
    tcr_step('custom-skill', 3, 6, tcr_skill_definition()),
    tcr_step('p3-s21', 3, 7),
    tcr_step('p3-s22', 3, 8),
    tcr_step('p3-s23', 3, 9),
    tcr_step('custom-late', 4, 10,
      jsonb_build_object('title', 'Board pack', 'description', 'Assemble the board pack.'))));

  v_set := deal_template_changes(v_deal, v_protected);
  if tcr_ids(v_set) is distinct from jsonb_build_array(
       'added:custom-start', 'added:custom-fairness', 'added:custom-skill', 'added:p3-s22',
       'added:custom-late', 'removed:p2-s13') then
    raise exception 'FAIL: offered changes (a team-removed step, a team-added step, a complete step and a protected step are never offered), got %',
      tcr_ids(v_set);
  end if;

  if v_set -> 'template' is distinct from jsonb_build_object('id', v_template, 'name', 'Standard sell-side')
     or v_set -> 'baseRevision' ->> 'label' is distinct from 'v1'
     or v_set -> 'currentRevision' ->> 'label' is distinct from 'v2'
     or v_set -> 'currentRevision' -> 'savedBy'
        is distinct from jsonb_build_object('id', v_director, 'name', 'Avery Lindqvist')
     or (v_set -> 'currentRevision' ->> 'savedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' then
    raise exception 'FAIL: template, labels and publisher, got %', v_set - 'changes';
  end if;

  if tcr_change(v_set, 'added:custom-start') -> 'anchor' is distinct from 'null'::jsonb
     or tcr_change(v_set, 'added:custom-late') -> 'anchor' is distinct from 'null'::jsonb
     or tcr_change(v_set, 'added:custom-skill') -> 'anchor'
        is distinct from jsonb_build_object('position', 'after', 'stepId', 'p3-s20')
     or tcr_change(v_set, 'added:p3-s22') -> 'anchor'
        is distinct from jsonb_build_object('position', 'after', 'stepId', 'p3-s21') then
    raise exception 'FAIL: anchors, got %', v_set -> 'changes';
  end if;

  if tcr_change(v_set, 'added:custom-fairness') is distinct from jsonb_build_object(
       'id', 'added:custom-fairness', 'kind', 'added', 'title', 'Fairness opinion',
       'summary', 'Independent fairness opinion.', 'phaseIndex', 2,
       'anchor', jsonb_build_object('position', 'after', 'stepId', 'p2-s11'), 'decision', null)
     or tcr_change(v_set, 'added:p3-s22') ->> 'title' is not null
     or tcr_change(v_set, 'removed:p2-s13') is distinct from jsonb_build_object(
       'id', 'removed:p2-s13', 'kind', 'removed', 'stepId', 'p2-s13', 'title', null,
       'phaseIndex', 2, 'decision', null) then
    raise exception 'FAIL: change shape, got %', v_set -> 'changes';
  end if;

  v_plain := tcr_deal(v_tenant, v_bank, v_v1, 'Project Ember');
  perform tcr_deal_step(v_plain, 'p1-s10', 1, 1, 'current', null);
  if deal_template_changes(v_plain, v_protected) is not null then
    raise exception 'FAIL: a deal with no template step keys must be offered nothing';
  end if;

  v_legacy := tcr_template(v_tenant, v_bank, v_director, 'Legacy rail');
  v_legacy_v1 := tcr_revision(v_legacy, v_director, 1, jsonb_build_array(tcr_step('p1-s10', 1, 1)));
  v_old := tcr_deal(v_tenant, v_bank, v_legacy_v1, 'Project Cinder');
  perform tcr_deal_step(v_old, 'p1-s10', 1, 1, 'current', 'p1-s10');
  perform tcr_revision(v_legacy, v_director, 2, jsonb_build_array(jsonb_build_object(
    'key', 't0', 'catalogStepId', 'p1-s11', 'seq', 5, 'phaseIndex', 1, 'displayOrder', 1,
    'definition', null, 'skillKey', null)), 1);
  if deal_template_changes(v_old, v_protected) is not null then
    raise exception 'FAIL: a schema 1 current revision must offer nothing';
  end if;

  if has_function_privilege('anon', 'deal_template_changes(uuid, text[])', 'execute')
     or has_function_privilege('authenticated', 'deal_template_changes(uuid, text[])', 'execute')
     or not has_function_privilege('service_role', 'deal_template_changes(uuid, text[])', 'execute') then
    raise exception 'FAIL: deal_template_changes must be service role only';
  end if;
  if has_table_privilege('anon', 'deal_template_change_decisions', 'select')
     or has_table_privilege('authenticated', 'deal_template_change_decisions', 'select')
     or has_table_privilege('service_role', 'deal_template_change_decisions', 'update')
     or has_table_privilege('service_role', 'deal_template_change_decisions', 'delete')
     or not has_table_privilege('service_role', 'deal_template_change_decisions', 'insert') then
    raise exception 'FAIL: decisions are append-only and service role only';
  end if;
end;
$$;

create function tcr_key_row(p_deal uuid, p_key text) returns deal_steps language sql stable as $$
  select * from deal_steps where deal_id = p_deal and template_step_key = p_key;
$$;

do $$
declare
  v_tenant    uuid := '00000000-0000-4000-8000-0000000000d1';
  v_protected text[] := array['p1-s7'];
  v_director  uuid;
  v_template  uuid;
  v_v2        uuid;
  v_v3        uuid;
  v_deal      uuid;
  v_set       jsonb;
  v_row       deal_steps;
  v_ok        boolean;
  v_reviewed  uuid;
  v_decision  text;
  v_decisions bigint;
  v_audits    bigint;
begin
  select id into v_deal from deals where tenant_id = v_tenant and codename = 'Project Lantern';
  select id into v_director from users where email = 'tcr-director@example.com';
  select id into v_template from rail_templates where tenant_id = v_tenant and name = 'Standard sell-side';
  select id into v_v2 from rail_template_revisions where template_id = v_template and version = 2;

  v_set := tcr_decide(v_deal, v_director, 'added:custom-fairness', 'accepted', v_protected);
  v_row := tcr_key_row(v_deal, 'custom-fairness');
  if v_row.id is null or v_row.origin is distinct from 'custom' or v_row.status is distinct from 'pending'
     or v_row.phase_index is distinct from 2 or v_row.removed_at is not null
     or v_row.definition is distinct from
        jsonb_build_object('title', 'Fairness opinion', 'description', 'Independent fairness opinion.')
     or v_row.display_order is distinct from (tcr_row(v_deal, 'custom:team')).display_order + 1 then
    raise exception 'FAIL: an accepted addition lands after the team step that follows its anchor, got %',
      row_to_json(v_row);
  end if;
  if tcr_change(v_set, 'added:custom-fairness') ->> 'decision' is distinct from 'accepted' then
    raise exception 'FAIL: the returned change set shows the accepted decision';
  end if;
  if (select count(*) from audit_log where deal_id = v_deal and action = 'update'
        and detail ->> 'rail' = 'insert' and detail ->> 'title' = 'Fairness opinion') <> 1
     or not exists (select 1 from audit_log where deal_id = v_deal and action = 'update'
        and detail = jsonb_build_object(
          'rail', 'template_change', 'decision', 'accepted', 'kind', 'added',
          'stepKey', 'custom-fairness', 'templateId', v_template, 'revisionId', v_v2)) then
    raise exception 'FAIL: an accepted addition audits the insert and the decision';
  end if;

  perform tcr_decide(v_deal, v_director, 'added:custom-start', 'accepted', v_protected);
  v_row := tcr_key_row(v_deal, 'custom-start');
  if v_row.phase_index is distinct from 2
     or v_row.display_order >= (tcr_row(v_deal, 'p2-s11')).display_order
     or v_row.display_order >= (tcr_row(v_deal, 'custom:team')).display_order
     or v_row.display_order <= (tcr_row(v_deal, 'p1-s10')).display_order then
    raise exception 'FAIL: an addition with no anchor lands at the start of its phase, before the team step';
  end if;

  perform tcr_decide(v_deal, v_director, 'added:p3-s22', 'accepted', v_protected);
  v_row := tcr_row(v_deal, 'p3-s22');
  if v_row.removed_at is not null
     or v_row.display_order is distinct from (tcr_row(v_deal, 'p3-s21')).display_order + 1
     or (select count(*) from deal_steps where deal_id = v_deal and step_id = 'p3-s22') <> 1
     or not exists (select 1 from audit_log where deal_id = v_deal
                      and detail ->> 'rail' = 'restore' and detail ->> 'stepKey' = 'p3-s22') then
    raise exception 'FAIL: a house step left out at creation is restored after its anchor, got %',
      row_to_json(v_row);
  end if;

  perform tcr_decide(v_deal, v_director, 'added:custom-skill', 'accepted', v_protected);
  v_row := tcr_key_row(v_deal, 'custom-skill');
  if v_row.definition is distinct from jsonb_build_object('title', 'Weekly memo', 'description', 'Draft a memo')
     or v_row.display_order is distinct from (tcr_row(v_deal, 'p3-s20')).display_order + 1 then
    raise exception 'FAIL: a skill-step definition is added as a manual step, got %', v_row.definition;
  end if;

  v_set := tcr_decide(v_deal, v_director, 'added:custom-late', 'discarded', v_protected);
  if exists (select 1 from deal_steps where deal_id = v_deal and template_step_key = 'custom-late')
     or tcr_change(v_set, 'added:custom-late') ->> 'decision' is distinct from 'discarded' then
    raise exception 'FAIL: a discarded addition adds nothing and shows as discarded';
  end if;

  v_set := tcr_decide(v_deal, v_director, 'removed:p2-s13', 'discarded', v_protected);
  if (tcr_row(v_deal, 'p2-s13')).removed_at is not null
     or tcr_change(v_set, 'removed:p2-s13') ->> 'decision' is distinct from 'discarded' then
    raise exception 'FAIL: a kept removal leaves the step and shows as kept';
  end if;

  v_ok := false;
  begin
    perform tcr_decide(v_deal, v_director, 'added:custom-fairness', 'accepted', v_protected);
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'stale_change';
  end;
  if not v_ok then
    raise exception 'FAIL: deciding a decided change raises stale_change';
  end if;

  v_ok := false;
  begin
    perform tcr_decide(v_deal, v_director, 'added:custom-late', 'maybe', v_protected);
  exception when sqlstate '22023' then v_ok := sqlerrm = 'invalid_decision';
  end;
  if not v_ok then
    raise exception 'FAIL: a decision other than accepted or discarded raises invalid_decision';
  end if;

  if deal_template_change_reopen(v_deal, v_director, 'added:custom-late')
     is distinct from jsonb_build_object('changeId', 'added:custom-late', 'decision', 'reopened') then
    raise exception 'FAIL: reopen answers the change and its new state';
  end if;
  v_set := deal_template_changes(v_deal, v_protected);
  if tcr_change(v_set, 'added:custom-late') is null
     or tcr_change(v_set, 'added:custom-late') -> 'decision' is distinct from 'null'::jsonb then
    raise exception 'FAIL: a reopened change is offered again';
  end if;

  v_ok := false;
  begin
    perform deal_template_change_reopen(v_deal, v_director, 'added:custom-fairness');
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'not_reopenable';
  end;
  if not v_ok then
    raise exception 'FAIL: an accepted change cannot be reopened';
  end if;

  perform tcr_decide(v_deal, v_director, 'added:custom-late', 'discarded', v_protected);

  update deal_steps set status = 'complete' where id = (tcr_row(v_deal, 'p1-s10')).id;
  update deal_steps set status = 'current' where id = (tcr_row(v_deal, 'p2-s11')).id;
  update deals set current_deal_step_id = (tcr_row(v_deal, 'p2-s11')).id where id = v_deal;

  perform tcr_revision(v_template, v_director, 3, jsonb_build_array(
    tcr_step('p1-s10', 1, 1),
    tcr_step('custom-after-done', 1, 2,
      jsonb_build_object('title', 'Closing memo', 'description', 'Record the phase outcome.')),
    tcr_step('custom-start', 2, 3, jsonb_build_object('title', 'Kick-off memo', 'description', 'Open the phase.')),
    tcr_step('p2-s11', 2, 4),
    tcr_step('p3-s20', 3, 5),
    tcr_step('custom-skill', 3, 6, tcr_skill_definition()),
    tcr_step('p3-s21', 3, 7),
    tcr_step('p3-s22', 3, 8),
    tcr_step('p3-s23', 3, 9),
    tcr_step('custom-late', 4, 10,
      jsonb_build_object('title', 'Board pack', 'description', 'Assemble the board pack.'))));

  select id into v_v3 from rail_template_revisions where template_id = v_template and version = 3;

  v_set := deal_template_changes(v_deal, v_protected);
  if tcr_ids(v_set) is distinct from jsonb_build_array(
       'added:custom-after-done', 'added:custom-late', 'removed:custom-fairness', 'removed:p2-s13') then
    raise exception 'FAIL: at v3 the new changes are offered and the earlier discards stay in the set, got %',
      tcr_ids(v_set);
  end if;
  if tcr_change(v_set, 'added:custom-after-done') -> 'decision' is distinct from 'null'::jsonb
     or tcr_change(v_set, 'removed:custom-fairness') -> 'decision' is distinct from 'null'::jsonb
     or tcr_change(v_set, 'added:custom-late') ->> 'decision' is distinct from 'discarded'
     or tcr_change(v_set, 'removed:p2-s13') ->> 'decision' is distinct from 'discarded' then
    raise exception 'FAIL: at v3 only the new changes are pending; a discard from v2 that still applies reads as discarded, got %',
      v_set -> 'changes';
  end if;

  select count(*) into v_decisions from deal_template_change_decisions where deal_id = v_deal;
  select count(*) into v_audits from audit_log where deal_id = v_deal;
  foreach v_reviewed in array array[v_v2, null]::uuid[] loop
    foreach v_decision in array array['accepted', 'discarded'] loop
      v_ok := false;
      begin
        perform deal_template_change_decide(
          v_deal, v_director, 'added:custom-after-done', v_decision, v_reviewed, v_protected);
      exception when sqlstate 'P0001' then v_ok := sqlerrm = 'stale_change';
      end;
      if not v_ok then
        raise exception 'FAIL: a decision (%) that names % as the reviewed revision raises stale_change',
          v_decision, coalesce(v_reviewed::text, 'no revision');
      end if;
    end loop;
  end loop;
  if (select count(*) from deal_template_change_decisions where deal_id = v_deal) <> v_decisions
     or (select count(*) from audit_log where deal_id = v_deal) <> v_audits
     or exists (select 1 from deal_steps where deal_id = v_deal and template_step_key = 'custom-after-done') then
    raise exception 'FAIL: a decision refused for its revision records nothing and changes no step';
  end if;

  v_set := deal_template_change_decide(
    v_deal, v_director, 'added:custom-after-done', 'accepted', v_v3, v_protected);
  if (tcr_key_row(v_deal, 'custom-after-done')).definition is distinct from
       jsonb_build_object('title', 'Closing memo', 'description', 'Record the phase outcome.')
     or not exists (select 1 from deal_template_change_decisions
                     where deal_id = v_deal and step_key = 'custom-after-done'
                       and decision = 'accepted' and revision_id = v_v3) then
    raise exception 'FAIL: a decision that names the current revision applies that revision and records it';
  end if;
  v_row := tcr_key_row(v_deal, 'custom-after-done');
  if v_row.display_order is distinct from (tcr_row(v_deal, 'p1-s10')).display_order + 1
     or v_row.status is distinct from 'pending'
     or (select current_deal_step_id from deals where id = v_deal)
        is distinct from (tcr_row(v_deal, 'p2-s11')).id then
    raise exception 'FAIL: an addition anchored on a completed step lands after it, pending, and the current step stays';
  end if;

  perform tcr_decide(v_deal, v_director, 'removed:custom-fairness', 'accepted', v_protected);
  v_row := tcr_key_row(v_deal, 'custom-fairness');
  if v_row.removed_at is null or v_row.removed_by is distinct from v_director then
    raise exception 'FAIL: an accepted removal takes the step off the rail as the deciding person';
  end if;

  if (select count(*) from deal_template_change_decisions where deal_id = v_deal) <> 10
     or (select count(*) from audit_log where deal_id = v_deal and action = 'update'
           and detail ->> 'rail' = 'template_change') <> 10 then
    raise exception 'FAIL: every decision and reopening is recorded and audited once';
  end if;

  if deal_template_change_reopen(v_deal, v_director, 'removed:p2-s13')
     is distinct from jsonb_build_object('changeId', 'removed:p2-s13', 'decision', 'reopened') then
    raise exception 'FAIL: a removal kept at an earlier version can be reopened';
  end if;
  v_set := deal_template_changes(v_deal, v_protected);
  if tcr_change(v_set, 'removed:p2-s13') -> 'decision' is distinct from 'null'::jsonb then
    raise exception 'FAIL: a removal kept at an earlier version is pending again once reopened, got %',
      tcr_change(v_set, 'removed:p2-s13');
  end if;
  v_set := tcr_decide(v_deal, v_director, 'removed:p2-s13', 'discarded', v_protected);
  if tcr_change(v_set, 'removed:p2-s13') ->> 'decision' is distinct from 'discarded' then
    raise exception 'FAIL: a removal kept again at the current version reads as kept';
  end if;

  update deal_steps set status = 'complete' where id = (tcr_row(v_deal, 'p2-s13')).id;
  perform tcr_deal_step(v_deal, 'custom:late', 4, 90, 'pending', 'custom-late');
  v_set := deal_template_changes(v_deal, v_protected);
  if tcr_change(v_set, 'removed:p2-s13') is not null or tcr_change(v_set, 'added:custom-late') is not null then
    raise exception 'FAIL: a discard leaves the set once its change no longer applies (a kept step since completed, a discarded addition since on the rail), got %',
      tcr_ids(v_set);
  end if;

  if to_regprocedure('deal_template_change_decide(uuid, uuid, text, text, text[])') is not null then
    raise exception 'FAIL: the decide function without a reviewed revision must not exist';
  end if;
  if to_regprocedure('deal_template_change_decide(uuid, uuid, text, text, uuid, text[])') is not null then
    raise exception 'FAIL: the decide function without room for a skill import must not exist';
  end if;
  if has_function_privilege('anon', 'deal_template_change_decide(uuid, uuid, text, text, uuid, text[], jsonb)', 'execute')
     or has_function_privilege('authenticated', 'deal_template_change_decide(uuid, uuid, text, text, uuid, text[], jsonb)', 'execute')
     or has_function_privilege('anon', 'deal_template_change_reopen(uuid, uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'deal_template_change_reopen(uuid, uuid, text)', 'execute') then
    raise exception 'FAIL: decide and reopen must be service role only';
  end if;
end;
$$;

create function tcr_order(p_deal uuid, p_phase int) returns text[] language sql stable as $$
  select coalesce(array_agg(coalesce(template_step_key, 'team') order by display_order), array[]::text[])
    from deal_steps where deal_id = p_deal and phase_index = p_phase and removed_at is null;
$$;

do $$
declare
  v_tenant   uuid := '00000000-0000-4000-8000-0000000000d2';
  v_bank     uuid;
  v_director uuid;
  v_tpl_a    uuid;
  v_tpl_b    uuid;
  v_tpl_c    uuid;
  v_rev_a    uuid;
  v_rev_b    uuid;
  v_rev_c    uuid;
  v_deal     uuid;
  v_anchor   uuid;
  v_order    text[];
begin
  v_bank := tcr_bank(v_tenant, 'Probe Order Bank');
  v_director := tcr_user(v_tenant, v_bank, 'tcr-order-director@example.com', 'director', false);

  v_tpl_a := tcr_template(v_tenant, v_bank, v_director, 'Order insert');
  v_rev_a := tcr_revision(v_tpl_a, v_director, 1, jsonb_build_array(tcr_step('p2-s11', 2, 1)));
  v_tpl_b := tcr_template(v_tenant, v_bank, v_director, 'Order restore ahead');
  v_rev_b := tcr_revision(v_tpl_b, v_director, 1, jsonb_build_array(tcr_step('p2-s11', 2, 1)));
  v_tpl_c := tcr_template(v_tenant, v_bank, v_director, 'Order restore behind');
  v_rev_c := tcr_revision(v_tpl_c, v_director, 1, jsonb_build_array(tcr_step('p2-s11', 2, 1)));

  perform tcr_revision(v_tpl_a, v_director, 2, jsonb_build_array(
    tcr_step('p2-s11', 2, 1),
    tcr_step('custom-x', 2, 2, jsonb_build_object('title', 'Memo X', 'description', 'X.')),
    tcr_step('custom-y', 2, 3, jsonb_build_object('title', 'Memo Y', 'description', 'Y.'))));
  perform tcr_revision(v_tpl_b, v_director, 2, jsonb_build_array(
    tcr_step('p2-s11', 2, 1),
    tcr_step('p2-s12', 2, 2),
    tcr_step('custom-x', 2, 3, jsonb_build_object('title', 'Memo X', 'description', 'X.'))));
  perform tcr_revision(v_tpl_c, v_director, 2, jsonb_build_array(
    tcr_step('p2-s11', 2, 1),
    tcr_step('custom-x', 2, 2, jsonb_build_object('title', 'Memo X', 'description', 'X.')),
    tcr_step('p2-s12', 2, 3)));

  v_deal := tcr_deal(v_tenant, v_bank, v_rev_a, 'Order Y then X');
  v_anchor := tcr_deal_step(v_deal, 'p2-s11', 2, 1, 'pending', 'p2-s11');
  perform rail_insert_step(v_deal, v_director, 2, 'after', v_anchor,
    jsonb_build_object('title', 'Team memo', 'description', 'Added by the deal team.'));
  perform tcr_decide(v_deal, v_director, 'added:custom-y', 'accepted', array[]::text[]);
  perform tcr_decide(v_deal, v_director, 'added:custom-x', 'accepted', array[]::text[]);
  v_order := tcr_order(v_deal, 2);
  if v_order is distinct from array['p2-s11', 'team', 'custom-x', 'custom-y'] then
    raise exception 'FAIL: additions sharing an anchor accepted in reverse keep template order behind a team step, got %', v_order;
  end if;

  v_deal := tcr_deal(v_tenant, v_bank, v_rev_a, 'Order X then Y');
  v_anchor := tcr_deal_step(v_deal, 'p2-s11', 2, 1, 'pending', 'p2-s11');
  perform rail_insert_step(v_deal, v_director, 2, 'after', v_anchor,
    jsonb_build_object('title', 'Team memo', 'description', 'Added by the deal team.'));
  perform tcr_decide(v_deal, v_director, 'added:custom-x', 'accepted', array[]::text[]);
  perform tcr_decide(v_deal, v_director, 'added:custom-y', 'accepted', array[]::text[]);
  v_order := tcr_order(v_deal, 2);
  if v_order is distinct from array['p2-s11', 'team', 'custom-x', 'custom-y'] then
    raise exception 'FAIL: additions sharing an anchor accepted in order keep template order behind a team step, got %', v_order;
  end if;

  v_deal := tcr_deal(v_tenant, v_bank, v_rev_b, 'Restore then insert');
  perform tcr_deal_step(v_deal, 'p2-s11', 2, 1, 'pending', 'p2-s11');
  perform tcr_deal_step(v_deal, 'p2-s12', 2, 2, 'pending', 'p2-s12');
  update deal_steps set removed_at = now() where deal_id = v_deal and step_id = 'p2-s12';
  perform tcr_decide(v_deal, v_director, 'added:p2-s12', 'accepted', array[]::text[]);
  perform tcr_decide(v_deal, v_director, 'added:custom-x', 'accepted', array[]::text[]);
  v_order := tcr_order(v_deal, 2);
  if v_order is distinct from array['p2-s11', 'p2-s12', 'custom-x'] then
    raise exception 'FAIL: a restored house step then an addition after it keep template order, got %', v_order;
  end if;

  v_deal := tcr_deal(v_tenant, v_bank, v_rev_b, 'Insert then restore');
  perform tcr_deal_step(v_deal, 'p2-s11', 2, 1, 'pending', 'p2-s11');
  perform tcr_deal_step(v_deal, 'p2-s12', 2, 2, 'pending', 'p2-s12');
  update deal_steps set removed_at = now() where deal_id = v_deal and step_id = 'p2-s12';
  perform tcr_decide(v_deal, v_director, 'added:custom-x', 'accepted', array[]::text[]);
  perform tcr_decide(v_deal, v_director, 'added:p2-s12', 'accepted', array[]::text[]);
  v_order := tcr_order(v_deal, 2);
  if v_order is distinct from array['p2-s11', 'p2-s12', 'custom-x'] then
    raise exception 'FAIL: an addition then a restored house step before it keep template order, got %', v_order;
  end if;

  v_deal := tcr_deal(v_tenant, v_bank, v_rev_c, 'Restore behind insert');
  perform tcr_deal_step(v_deal, 'p2-s11', 2, 1, 'pending', 'p2-s11');
  perform tcr_deal_step(v_deal, 'p2-s12', 2, 2, 'pending', 'p2-s12');
  update deal_steps set removed_at = now() where deal_id = v_deal and step_id = 'p2-s12';
  perform tcr_decide(v_deal, v_director, 'added:p2-s12', 'accepted', array[]::text[]);
  perform tcr_decide(v_deal, v_director, 'added:custom-x', 'accepted', array[]::text[]);
  v_order := tcr_order(v_deal, 2);
  if v_order is distinct from array['p2-s11', 'custom-x', 'p2-s12'] then
    raise exception 'FAIL: a house step restored before an addition that precedes it keeps template order, got %', v_order;
  end if;

  v_deal := tcr_deal(v_tenant, v_bank, v_rev_c, 'Insert ahead of restore');
  perform tcr_deal_step(v_deal, 'p2-s11', 2, 1, 'pending', 'p2-s11');
  perform tcr_deal_step(v_deal, 'p2-s12', 2, 2, 'pending', 'p2-s12');
  update deal_steps set removed_at = now() where deal_id = v_deal and step_id = 'p2-s12';
  perform tcr_decide(v_deal, v_director, 'added:custom-x', 'accepted', array[]::text[]);
  perform tcr_decide(v_deal, v_director, 'added:p2-s12', 'accepted', array[]::text[]);
  v_order := tcr_order(v_deal, 2);
  if v_order is distinct from array['p2-s11', 'custom-x', 'p2-s12'] then
    raise exception 'FAIL: an addition then the house step that follows it keep template order, got %', v_order;
  end if;
end;
$$;

create function tcr_order_deal(p_tenant uuid, p_bank uuid, p_revision uuid, p_codename text, p_left_out text)
returns uuid language plpgsql as $$
declare
  v_deal uuid := tcr_deal(p_tenant, p_bank, p_revision, p_codename);
begin
  perform tcr_deal_step(v_deal, 'p2-s11', 2, 1, 'pending', 'p2-s11');
  perform tcr_deal_step(v_deal, p_left_out, 2, 9, 'pending', p_left_out);
  update deal_steps set removed_at = now() where deal_id = v_deal and step_id = p_left_out;
  return v_deal;
end;
$$;

create function tcr_team_after(p_deal uuid, p_actor uuid, p_step text) returns void language plpgsql as $$
begin
  perform rail_insert_step(p_deal, p_actor, 2, 'after',
    (select id from deal_steps where deal_id = p_deal and removed_at is null and template_step_key = p_step),
    jsonb_build_object('title', 'Team memo', 'description', 'Added by the deal team.'));
end;
$$;

do $$
declare
  v_tenant   uuid := '00000000-0000-4000-8000-0000000000d3';
  v_none     text[] := array[]::text[];
  v_bank     uuid;
  v_director uuid;
  v_tpl_a    uuid;
  v_tpl_b    uuid;
  v_tpl_c    uuid;
  v_rev_a    uuid;
  v_rev_b    uuid;
  v_rev_c    uuid;
  v_deal     uuid;
  v_order    text[];
begin
  v_bank := tcr_bank(v_tenant, 'Probe Group Bank');
  v_director := tcr_user(v_tenant, v_bank, 'tcr-group-director@example.com', 'director', false);

  v_tpl_a := tcr_template(v_tenant, v_bank, v_director, 'Group A X H');
  v_rev_a := tcr_revision(v_tpl_a, v_director, 1, jsonb_build_array(tcr_step('p2-s11', 2, 1)));
  v_tpl_b := tcr_template(v_tenant, v_bank, v_director, 'Group chained');
  v_rev_b := tcr_revision(v_tpl_b, v_director, 1, jsonb_build_array(tcr_step('p2-s11', 2, 1)));
  v_tpl_c := tcr_template(v_tenant, v_bank, v_director, 'Group A H X');
  v_rev_c := tcr_revision(v_tpl_c, v_director, 1, jsonb_build_array(tcr_step('p2-s11', 2, 1)));

  perform tcr_revision(v_tpl_a, v_director, 2, jsonb_build_array(
    tcr_step('p2-s11', 2, 1),
    tcr_step('custom-x', 2, 2, jsonb_build_object('title', 'Memo X', 'description', 'X.')),
    tcr_step('p2-s12', 2, 3)));
  perform tcr_revision(v_tpl_b, v_director, 2, jsonb_build_array(
    tcr_step('p2-s11', 2, 1),
    tcr_step('custom-x0', 2, 2, jsonb_build_object('title', 'Memo X0', 'description', 'X0.')),
    tcr_step('custom-x1', 2, 3, jsonb_build_object('title', 'Memo X1', 'description', 'X1.')),
    tcr_step('p2-s12', 2, 4)));
  perform tcr_revision(v_tpl_c, v_director, 2, jsonb_build_array(
    tcr_step('p2-s11', 2, 1),
    tcr_step('p2-s12', 2, 2),
    tcr_step('custom-x', 2, 3, jsonb_build_object('title', 'Memo X', 'description', 'X.'))));

  v_deal := tcr_order_deal(v_tenant, v_bank, v_rev_a, 'Group restore then insert', 'p2-s12');
  perform tcr_team_after(v_deal, v_director, 'p2-s11');
  perform tcr_decide(v_deal, v_director, 'added:p2-s12', 'accepted', v_none);
  perform tcr_decide(v_deal, v_director, 'added:custom-x', 'accepted', v_none);
  v_order := tcr_order(v_deal, 2);
  if v_order is distinct from array['p2-s11', 'team', 'custom-x', 'p2-s12'] then
    raise exception 'FAIL: restore then insert with a team step keeps template order, got %', v_order;
  end if;

  v_deal := tcr_order_deal(v_tenant, v_bank, v_rev_a, 'Group insert then restore', 'p2-s12');
  perform tcr_team_after(v_deal, v_director, 'p2-s11');
  perform tcr_decide(v_deal, v_director, 'added:custom-x', 'accepted', v_none);
  perform tcr_decide(v_deal, v_director, 'added:p2-s12', 'accepted', v_none);
  v_order := tcr_order(v_deal, 2);
  if v_order is distinct from array['p2-s11', 'team', 'custom-x', 'p2-s12'] then
    raise exception 'FAIL: insert then restore with a team step keeps template order, got %', v_order;
  end if;

  v_deal := tcr_order_deal(v_tenant, v_bank, v_rev_b, 'Group chained', 'p2-s12');
  perform tcr_decide(v_deal, v_director, 'added:custom-x0', 'accepted', v_none);
  perform tcr_team_after(v_deal, v_director, 'custom-x0');
  perform tcr_decide(v_deal, v_director, 'added:p2-s12', 'accepted', v_none);
  perform tcr_decide(v_deal, v_director, 'added:custom-x1', 'accepted', v_none);
  v_order := tcr_order(v_deal, 2);
  if v_order is distinct from array['p2-s11', 'custom-x0', 'team', 'custom-x1', 'p2-s12'] then
    raise exception 'FAIL: a step accepted after an earlier accepted step with a team step keeps template order, got %', v_order;
  end if;

  v_deal := tcr_order_deal(v_tenant, v_bank, v_rev_c, 'Group restore ahead', 'p2-s12');
  perform tcr_team_after(v_deal, v_director, 'p2-s11');
  perform tcr_decide(v_deal, v_director, 'added:p2-s12', 'accepted', v_none);
  perform tcr_decide(v_deal, v_director, 'added:custom-x', 'accepted', v_none);
  v_order := tcr_order(v_deal, 2);
  if v_order is distinct from array['p2-s11', 'team', 'p2-s12', 'custom-x'] then
    raise exception 'FAIL: restore then insert behind it with a team step keeps template order, got %', v_order;
  end if;

  v_deal := tcr_order_deal(v_tenant, v_bank, v_rev_c, 'Group insert ahead', 'p2-s12');
  perform tcr_team_after(v_deal, v_director, 'p2-s11');
  perform tcr_decide(v_deal, v_director, 'added:custom-x', 'accepted', v_none);
  perform tcr_decide(v_deal, v_director, 'added:p2-s12', 'accepted', v_none);
  v_order := tcr_order(v_deal, 2);
  if v_order is distinct from array['p2-s11', 'team', 'p2-s12', 'custom-x'] then
    raise exception 'FAIL: insert then restore ahead of it with a team step keeps template order, got %', v_order;
  end if;
end;
$$;

do $$
declare
  v_tenant   uuid := '00000000-0000-4000-8000-0000000000d4';
  v_none     text[] := array[]::text[];
  v_bank     uuid;
  v_director uuid;
  v_tpl_h    uuid;
  v_tpl_x    uuid;
  v_rev_h    uuid;
  v_rev_x    uuid;
  v_deal     uuid;
  v_b        uuid;
  v_order    text[];
begin
  v_bank := tcr_bank(v_tenant, 'Probe Run Bank');
  v_director := tcr_user(v_tenant, v_bank, 'tcr-run-director@example.com', 'director', false);

  v_tpl_h := tcr_template(v_tenant, v_bank, v_director, 'Run house');
  v_rev_h := tcr_revision(v_tpl_h, v_director, 1, jsonb_build_array(tcr_step('p2-s11', 2, 1), tcr_step('p2-s13', 2, 2)));
  v_tpl_x := tcr_template(v_tenant, v_bank, v_director, 'Run custom');
  v_rev_x := tcr_revision(v_tpl_x, v_director, 1, jsonb_build_array(tcr_step('p2-s11', 2, 1), tcr_step('p2-s13', 2, 2)));

  perform tcr_revision(v_tpl_h, v_director, 2, jsonb_build_array(
    tcr_step('p2-s11', 2, 1), tcr_step('p2-s12', 2, 2), tcr_step('p2-s13', 2, 3)));
  perform tcr_revision(v_tpl_x, v_director, 2, jsonb_build_array(
    tcr_step('p2-s11', 2, 1),
    tcr_step('custom-x', 2, 2, jsonb_build_object('title', 'Memo X', 'description', 'X.')),
    tcr_step('p2-s13', 2, 3)));

  v_deal := tcr_deal(v_tenant, v_bank, v_rev_h, 'Run restore stale anchor');
  perform tcr_deal_step(v_deal, 'p2-s11', 2, 1, 'pending', 'p2-s11');
  v_b := tcr_deal_step(v_deal, 'p2-s13', 2, 2, 'pending', 'p2-s13');
  perform tcr_deal_step(v_deal, 'p2-s12', 2, 9, 'pending', 'p2-s12');
  update deal_steps set removed_at = now() where deal_id = v_deal and step_id = 'p2-s12';
  perform rail_remove_step(v_deal, v_director, v_b, v_none);
  perform rail_restore_step(v_deal, v_director, v_b);
  perform tcr_decide(v_deal, v_director, 'added:p2-s12', 'accepted', v_none);
  v_order := tcr_order(v_deal, 2);
  if v_order is distinct from array['p2-s11', 'p2-s12', 'p2-s13'] then
    raise exception 'FAIL: restoring a house step before a team-restored template step, got %', v_order;
  end if;

  v_deal := tcr_deal(v_tenant, v_bank, v_rev_x, 'Run insert stale anchor');
  perform tcr_deal_step(v_deal, 'p2-s11', 2, 1, 'pending', 'p2-s11');
  v_b := tcr_deal_step(v_deal, 'p2-s13', 2, 2, 'pending', 'p2-s13');
  perform rail_remove_step(v_deal, v_director, v_b, v_none);
  perform rail_restore_step(v_deal, v_director, v_b);
  perform tcr_decide(v_deal, v_director, 'added:custom-x', 'accepted', v_none);
  v_order := tcr_order(v_deal, 2);
  if v_order is distinct from array['p2-s11', 'custom-x', 'p2-s13'] then
    raise exception 'FAIL: inserting an addition before a team-restored template step, got %', v_order;
  end if;

  v_deal := tcr_deal(v_tenant, v_bank, v_rev_h, 'Run restore behind team step');
  perform tcr_deal_step(v_deal, 'p2-s11', 2, 1, 'pending', 'p2-s11');
  v_b := tcr_deal_step(v_deal, 'p2-s13', 2, 2, 'pending', 'p2-s13');
  perform tcr_deal_step(v_deal, 'p2-s12', 2, 9, 'pending', 'p2-s12');
  update deal_steps set removed_at = now() where deal_id = v_deal and step_id = 'p2-s12';
  perform rail_remove_step(v_deal, v_director, v_b, v_none);
  perform tcr_team_after(v_deal, v_director, 'p2-s11');
  perform rail_restore_step(v_deal, v_director, v_b);
  v_order := tcr_order(v_deal, 2);
  if v_order is distinct from array['p2-s11', 'p2-s13', 'team'] then
    raise exception 'FAIL: the fixture reads A, B, T, got %', v_order;
  end if;
  perform tcr_decide(v_deal, v_director, 'added:p2-s12', 'accepted', v_none);
  v_order := tcr_order(v_deal, 2);
  if v_order is distinct from array['p2-s11', 'p2-s12', 'p2-s13', 'team'] then
    raise exception 'FAIL: restoring a house step ahead of a restored template step and a team step, got %', v_order;
  end if;

  v_deal := tcr_deal(v_tenant, v_bank, v_rev_x, 'Run insert behind team step');
  perform tcr_deal_step(v_deal, 'p2-s11', 2, 1, 'pending', 'p2-s11');
  v_b := tcr_deal_step(v_deal, 'p2-s13', 2, 2, 'pending', 'p2-s13');
  perform rail_remove_step(v_deal, v_director, v_b, v_none);
  perform tcr_team_after(v_deal, v_director, 'p2-s11');
  perform rail_restore_step(v_deal, v_director, v_b);
  v_order := tcr_order(v_deal, 2);
  if v_order is distinct from array['p2-s11', 'p2-s13', 'team'] then
    raise exception 'FAIL: the fixture reads A, B, T, got %', v_order;
  end if;
  perform tcr_decide(v_deal, v_director, 'added:custom-x', 'accepted', v_none);
  v_order := tcr_order(v_deal, 2);
  if v_order is distinct from array['p2-s11', 'custom-x', 'p2-s13', 'team'] then
    raise exception 'FAIL: inserting an addition ahead of a restored template step and a team step, got %', v_order;
  end if;
end;
$$;

insert into feature_flags (key, enabled) values ('template_change_review', true)
  on conflict (key) do update set enabled = true;

do $$
declare
  v_tenant           uuid := '00000000-0000-4000-8000-0000000000d2';
  v_foreign_tenant   uuid := '00000000-0000-4000-8000-0000000000d3';
  v_bank             uuid;
  v_foreign_bank     uuid;
  v_publisher        uuid;
  v_member           uuid;
  v_external         uuid;
  v_foreign_director uuid;
  v_template         uuid;
  v_other_template   uuid;
  v_v1               uuid;
  v_v2               uuid;
  v_open             uuid;
  v_closed           uuid;
  v_quiet            uuid;
  v_other            uuid;
  v_foreign          uuid;
  v_kept             uuid;
  v_target           uuid := gen_random_uuid();
  v_note             notifications;
  v_published        jsonb;
begin
  v_bank := tcr_bank(v_tenant, 'Probe Notice Bank');
  v_publisher := tcr_user(v_tenant, v_bank, 'tcr-publisher@example.com', 'director', false);
  update users set display_name = 'Dana Whitlock' where id = v_publisher;
  v_member := tcr_user(v_tenant, v_bank, 'tcr-member@example.com', 'member', false);
  v_external := tcr_user(v_tenant, null, 'tcr-seller@example.com', null, true);

  v_template := tcr_template(v_tenant, v_bank, v_publisher, 'Diligence rail');
  v_v1 := tcr_revision(v_template, v_publisher, 1,
    jsonb_build_array(tcr_step('p1-s10', 1, 1), tcr_step('p2-s11', 2, 2)));

  v_open := tcr_deal(v_tenant, v_bank, v_v1, 'Project Harbor');
  v_closed := tcr_deal(v_tenant, v_bank, v_v1, 'Project Quarry');
  update deals set status = 'closed' where id = v_closed;
  v_quiet := tcr_deal(v_tenant, v_bank, v_v1, 'Project Meadow');
  perform tcr_deal_step(d, 'p1-s10', 1, 1, 'current', 'p1-s10'),
          tcr_deal_step(d, 'p2-s11', 2, 2, 'pending', 'p2-s11')
     from unnest(array[v_open, v_closed, v_quiet]) as d;
  perform tcr_deal_step(v_quiet, 'custom:accepted', 2, 3, 'pending', 'custom-new');

  insert into companies (id, tenant_id, name, type) values (v_target, v_tenant, 'Probe Target', 'target');
  insert into deal_parties (deal_id, company_id, party_role) values (v_open, v_target, 'target');
  perform tcr_member(v_open, v_publisher, 'md');
  perform tcr_member(v_open, v_member, 'deal_team');
  perform tcr_member(v_open, v_external, 'seller');
  perform tcr_member(v_closed, v_member, 'deal_team');
  perform tcr_member(v_quiet, v_member, 'deal_team');

  v_other_template := tcr_template(v_tenant, v_bank, v_publisher, 'Buy-side rail');
  v_other := tcr_deal(v_tenant, v_bank,
    tcr_revision(v_other_template, v_publisher, 1, jsonb_build_array(tcr_step('p1-s10', 1, 1))),
    'Project Willow');
  perform tcr_deal_step(v_other, 'p1-s10', 1, 1, 'current', 'p1-s10');
  perform tcr_member(v_other, v_member, 'deal_team');
  perform tcr_revision(v_other_template, v_publisher, 2, jsonb_build_array(
    tcr_step('p1-s10', 1, 1),
    tcr_step('custom-other', 1, 2, jsonb_build_object('title', 'Other memo', 'description', ''))));

  v_foreign_bank := tcr_bank(v_foreign_tenant, 'Probe Foreign Bank');
  v_foreign_director := tcr_user(v_foreign_tenant, v_foreign_bank, 'tcr-foreign@example.com', 'director', false);
  v_foreign := tcr_deal(v_foreign_tenant, v_foreign_bank, v_v1, 'Project Fjord');
  perform tcr_deal_step(v_foreign, 'p1-s10', 1, 1, 'current', 'p1-s10');
  perform tcr_deal_step(v_foreign, 'p2-s11', 2, 2, 'pending', 'p2-s11');
  perform tcr_member(v_foreign, v_foreign_director, 'md');

  v_v2 := tcr_revision(v_template, v_publisher, 2, jsonb_build_array(
    tcr_step('p1-s10', 1, 1), tcr_step('p2-s11', 2, 2),
    tcr_step('custom-new', 2, 3,
      jsonb_build_object('title', 'Fairness opinion', 'description', 'Independent fairness opinion.'))));

  if rail_template_notify_deals(v_v2, v_publisher, array[]::text[]) is distinct from 1 then
    raise exception 'FAIL: one notice: the internal member of the open deal with something to review';
  end if;
  if (select count(*) from notifications
       where event_type = 'rail_template_updated' and tenant_id in (v_tenant, v_foreign_tenant)) <> 1 then
    raise exception 'FAIL: no notice for the publisher, an external member, a closed deal, a quiet deal or another template';
  end if;

  select * into v_note from notifications where event_type = 'rail_template_updated' and tenant_id = v_tenant;
  if v_note.recipient_id is distinct from v_member
     or v_note.deal_id is distinct from v_open
     or v_note.payload is distinct from jsonb_build_object(
          'code', (select code from deals where id = v_open),
          'codename', 'Project Harbor',
          'templateId', v_template,
          'templateName', 'Diligence rail',
          'version', 2,
          'actor', 'Dana Whitlock',
          'destinationLabel', 'Project Harbor · Diligence rail v2',
          'href', '/projects/' || (select code from deals where id = v_open) || '/rail?review=template')
     or v_note.payload::text like '%Probe Target%' then
    raise exception 'FAIL: notice row and payload, got %', row_to_json(v_note);
  end if;

  if exists (select 1 from notifications
              where event_type = 'rail_template_updated'
                and (tenant_id = v_foreign_tenant or deal_id = v_foreign))
     or exists (select 1 from audit_log where action = 'notify' and deal_id = v_foreign) then
    raise exception 'FAIL: a deal in another tenant is never notified';
  end if;

  if not exists (select 1 from audit_log
                  where actor_id = v_publisher and action = 'notify' and deal_id = v_open
                    and detail = jsonb_build_object('recipient', v_member, 'event', 'rail_template_updated')) then
    raise exception 'FAIL: each notice is audited as notify';
  end if;

  update feature_flags set enabled = false where key = 'template_change_review';
  if rail_template_notify_deals(v_v2, v_publisher, array[]::text[]) is distinct from 0 then
    raise exception 'FAIL: no notice while template_change_review is off';
  end if;
  update feature_flags set enabled = true where key = 'template_change_review';

  v_kept := tcr_deal(v_tenant, v_bank, v_v1, 'Project Thicket');
  perform tcr_deal_step(v_kept, 'p1-s10', 1, 1, 'current', 'p1-s10');
  perform tcr_deal_step(v_kept, 'p2-s11', 2, 2, 'pending', 'p2-s11');
  perform tcr_deal_step(v_kept, 'custom:extra', 2, 3, 'pending', 'custom-extra');
  perform tcr_member(v_kept, v_member, 'deal_team');
  perform tcr_decide(v_kept, v_publisher, 'added:custom-new', 'discarded', array[]::text[]);

  insert into rail_catalog_steps (template_id, step_id, seq, phase_index, display_order, origin, definition)
  select c.id, s.step_id, s.seq, s.phase_index, s.display_order, s.origin, s.definition
    from rail_catalog_templates c,
         (values ('p1-s10', 1, 1, 1, 'catalog', null::jsonb),
                 ('p2-s11', 2, 2, 2, 'catalog', null::jsonb),
                 ('custom-new', null, 2, 3, 'custom',
                   jsonb_build_object('title', 'Fairness opinion', 'description', 'Independent fairness opinion.')),
                 ('custom-extra', null, 2, 4, 'custom',
                   jsonb_build_object('title', 'Sanctions re-screen', 'description', 'Re-run sanctions screening.')))
           as s(step_id, seq, phase_index, display_order, origin, definition)
   where c.rail_template_id = v_template;

  v_published := publish_rail_template(
    (select id from rail_catalog_templates where rail_template_id = v_template),
    v_bank, v_publisher, array[]::text[]);
  if (v_published ->> 'version')::int is distinct from 3
     or (select count(*) from notifications
          where event_type = 'rail_template_updated' and deal_id = v_open and recipient_id = v_member) <> 2
     or not exists (select 1 from notifications
                     where event_type = 'rail_template_updated' and deal_id = v_open
                       and (payload ->> 'version')::int = 3) then
    raise exception 'FAIL: publishing notifies the deals it offers changes to, got %', v_published;
  end if;

  if tcr_change(deal_template_changes(v_kept, array[]::text[]), 'added:custom-new') ->> 'decision'
       is distinct from 'discarded'
     or jsonb_array_length(deal_template_changes(v_kept, array[]::text[]) -> 'changes') <> 1
     or exists (select 1 from notifications
                 where event_type = 'rail_template_updated' and deal_id = v_kept) then
    raise exception 'FAIL: a version that leaves a deal only its earlier discard keeps it reviewable and sends no notice';
  end if;

  if has_function_privilege('anon', 'rail_template_notify_deals(uuid, uuid, text[])', 'execute')
     or has_function_privilege('authenticated', 'rail_template_notify_deals(uuid, uuid, text[])', 'execute') then
    raise exception 'FAIL: rail_template_notify_deals must be service role only';
  end if;
end;
$$;

do $$
declare
  v_tenant   uuid := '00000000-0000-4000-8000-0000000000d4';
  v_bank     uuid;
  v_director uuid;
  v_template uuid;
  v_v1       uuid;
  v_v2       uuid;
  v_v3       uuid;
  v_deal     uuid;
  v_shown    jsonb;
  v_ok       boolean := false;
begin
  v_bank := tcr_bank(v_tenant, 'Probe Reviewed Bank');
  v_director := tcr_user(v_tenant, v_bank, 'tcr-reviewed@example.com', 'director', false);
  v_template := tcr_template(v_tenant, v_bank, v_director, 'Reviewed rail');
  v_v1 := tcr_revision(v_template, v_director, 1, jsonb_build_array(tcr_step('p1-s10', 1, 1)));
  v_deal := tcr_deal(v_tenant, v_bank, v_v1, 'Project Cedar');
  perform tcr_deal_step(v_deal, 'p1-s10', 1, 1, 'current', 'p1-s10');

  v_v2 := tcr_revision(v_template, v_director, 2, jsonb_build_array(
    tcr_step('p1-s10', 1, 1),
    tcr_step('custom-memo', 1, 2, jsonb_build_object('title', 'Memo', 'description', 'As first published.'))));
  v_shown := deal_template_changes(v_deal, array[]::text[]);
  if v_shown -> 'currentRevision' ->> 'id' is distinct from v_v2::text
     or tcr_change(v_shown, 'added:custom-memo') ->> 'summary' is distinct from 'As first published.' then
    raise exception 'FAIL: the fixture shows the step as v2 words it, got %', v_shown;
  end if;

  v_v3 := tcr_revision(v_template, v_director, 3, jsonb_build_array(
    tcr_step('p1-s10', 1, 1),
    tcr_step('custom-memo', 1, 2, jsonb_build_object('title', 'Memo', 'description', 'Reworded after review.'))));

  begin
    perform deal_template_change_decide(
      v_deal, v_director, 'added:custom-memo', 'accepted',
      (v_shown -> 'currentRevision' ->> 'id')::uuid, array[]::text[]);
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'stale_change';
  end;
  if not v_ok or exists (select 1 from deal_steps where deal_id = v_deal and template_step_key = 'custom-memo') then
    raise exception 'FAIL: accepting a step as v2 showed it, after v3 reworded it, is refused and adds nothing';
  end if;

  perform deal_template_change_decide(v_deal, v_director, 'added:custom-memo', 'accepted', v_v3, array[]::text[]);
  if (tcr_key_row(v_deal, 'custom-memo')).definition ->> 'description' is distinct from 'Reworded after review.' then
    raise exception 'FAIL: accepting at v3 adds the step as v3 words it';
  end if;
end;
$$;

create function tcr_skill_revision(
  p_template uuid, p_actor uuid, p_version int, p_steps jsonb, p_candidate uuid, p_digest text
) returns uuid language plpgsql as $$
declare v_revision uuid := gen_random_uuid();
begin
  insert into rail_template_revisions (
    id, template_id, actor_id, request_id, request_digest, command,
    source_catalog_template_id, manifest, state, version, provider_receipt
  ) values (
    v_revision, p_template, p_actor, gen_random_uuid(), repeat('c', 64), '{}'::jsonb,
    (select id from rail_catalog_templates where rail_template_id = p_template),
    jsonb_build_object(
      'schemaVersion', 2, 'censusVersion', 'probe-rail', 'steps', p_steps,
      'skills', jsonb_build_array(jsonb_build_object(
        'key', 's0',
        'name', 'Weekly memo',
        'contract', jsonb_build_object(
          'purpose', 'Draft a memo', 'expectedInput', 'A reporting period.',
          'expectedOutput', 'A one page memo.'),
        'source', jsonb_build_object('kind', 'candidate', 'candidateId', p_candidate, 'digest', p_digest)))),
    'ready', p_version,
    jsonb_build_object('revisionId', v_revision, 'assets', jsonb_build_array(
      jsonb_build_object('key', 's0', 'packageDigest', p_digest)))
  );
  update rail_templates set current_revision_id = v_revision where id = p_template;
  return v_revision;
end;
$$;

do $$
declare
  v_tenant    uuid := '00000000-0000-4000-8000-0000000000e3';
  v_protected text[] := array['p1-s7'];
  v_bank      uuid;
  v_director  uuid;
  v_template  uuid;
  v_v1        uuid;
  v_v2        uuid;
  v_v3        uuid;
  v_deal      uuid;
  v_candidate uuid := gen_random_uuid();
  v_digest    text := repeat('d', 64);
  v_skill     uuid := gen_random_uuid();
  v_version   uuid := gen_random_uuid();
  v_import    jsonb;
  v_plan      jsonb;
  v_set       jsonb;
  v_row       deal_steps;
  v_ok        boolean;
begin
  v_bank := tcr_bank(v_tenant, 'Probe Skill Accept Bank');
  v_director := tcr_user(v_tenant, v_bank, 'tcr-skill-director@example.com', 'director', false);
  v_template := tcr_template(v_tenant, v_bank, v_director, 'Skill accept rail');
  v_v1 := tcr_revision(v_template, v_director, 1, jsonb_build_array(
    tcr_step('p1-s7', 1, 1), tcr_step('p1-s10', 1, 2)));
  v_deal := tcr_deal(v_tenant, v_bank, v_v1, 'Project Quill');
  perform tcr_deal_step(v_deal, 'p1-s7', 1, 1, 'complete', 'p1-s7');
  perform tcr_deal_step(v_deal, 'p1-s10', 1, 2, 'current', 'p1-s10');
  v_v2 := tcr_skill_revision(v_template, v_director, 2, jsonb_build_array(
    tcr_step('p1-s7', 1, 1),
    tcr_step('p1-s10', 1, 2),
    tcr_step('custom-memo', 1, 3, tcr_skill_definition()) || jsonb_build_object('skillKey', 's0'),
    tcr_step('custom-plain', 1, 4, jsonb_build_object('title', 'Checklist', 'description', 'A manual step.'))),
    v_candidate, v_digest);

  v_plan := deal_template_change_skill(v_deal, 'added:custom-memo', tcr_current(v_deal), v_protected);
  if v_plan is distinct from jsonb_build_object('tenantId', v_tenant, 'revisionId', v_v2, 'skillKey', 's0') then
    raise exception 'FAIL: an added skill step reports its tenant, revision and skill key, got %', v_plan;
  end if;
  v_plan := deal_template_change_skill(v_deal, 'added:custom-plain', tcr_current(v_deal), v_protected);
  if v_plan -> 'skillKey' is distinct from 'null'::jsonb then
    raise exception 'FAIL: an added manual step reports no skill, got %', v_plan;
  end if;

  v_import := jsonb_build_object(
    'requestId', gen_random_uuid(), 'key', 's0',
    'binding', jsonb_build_object('skillId', v_skill, 'versionId', v_version, 'digest', v_digest));

  v_ok := false;
  begin
    perform deal_template_change_skill(v_deal, 'added:custom-memo', null, v_protected);
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'stale_change';
  end;
  if not v_ok then
    raise exception 'FAIL: a skill lookup that names no reviewed version is stale';
  end if;

  v_ok := false;
  begin
    perform deal_template_change_skill(v_deal, 'added:custom-memo', v_v1, v_protected);
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'stale_change';
  end;
  if not v_ok then
    raise exception 'FAIL: a skill lookup for an older version is stale';
  end if;

  v_ok := false;
  begin
    perform deal_template_change_decide(v_deal, v_director, 'added:custom-memo', 'accepted', v_v1, v_protected,
      jsonb_set(v_import, '{key}', '"s1"'::jsonb));
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'stale_change';
  end;
  if not v_ok then
    raise exception 'FAIL: an import decided against an older version is stale, not a mismatch';
  end if;

  v_ok := false;
  begin
    perform deal_template_change_skill(v_deal, 'added:custom-missing', tcr_current(v_deal), v_protected);
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'stale_change';
  end;
  if not v_ok then
    raise exception 'FAIL: a change that is not offered has no skill to import';
  end if;

  v_ok := false;
  begin
    perform tcr_decide(v_deal, v_director, 'added:custom-memo', 'accepted', v_protected);
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'skill_import_mismatch';
  end;
  if not v_ok then
    raise exception 'FAIL: an added skill step cannot be accepted without its import';
  end if;

  v_ok := false;
  begin
    perform deal_template_change_decide(v_deal, v_director, 'added:custom-memo', 'accepted', tcr_current(v_deal), v_protected,
      jsonb_set(v_import, '{key}', '"s1"'::jsonb));
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'skill_import_mismatch';
  end;
  if not v_ok then
    raise exception 'FAIL: an import for another skill key is refused';
  end if;

  v_ok := false;
  begin
    perform deal_template_change_decide(v_deal, v_director, 'added:custom-memo', 'accepted', tcr_current(v_deal), v_protected,
      jsonb_set(v_import, '{binding,digest}', to_jsonb(repeat('e', 64))));
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'skill_import_mismatch';
  end;
  if not v_ok then
    raise exception 'FAIL: an import whose digest is not the retained one is refused';
  end if;

  v_ok := false;
  begin
    perform deal_template_change_decide(v_deal, v_director, 'added:custom-plain', 'accepted', tcr_current(v_deal), v_protected,
      v_import);
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'skill_import_mismatch';
  end;
  if not v_ok then
    raise exception 'FAIL: an import sent for a step with no skill is refused';
  end if;

  v_ok := false;
  begin
    perform deal_template_change_decide(v_deal, v_director, 'added:custom-memo', 'discarded', tcr_current(v_deal), v_protected,
      v_import);
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'skill_import_mismatch';
  end;
  if not v_ok then
    raise exception 'FAIL: an import sent with a discard is refused';
  end if;

  v_set := deal_template_change_decide(v_deal, v_director, 'added:custom-memo', 'accepted', tcr_current(v_deal), v_protected,
    v_import);
  v_row := tcr_key_row(v_deal, 'custom-memo');
  if v_row.id is null or v_row.origin is distinct from 'custom' or v_row.removed_at is not null
     or v_row.definition is distinct from tcr_skill_definition() || jsonb_build_object(
          'skillBinding', jsonb_build_object('skillId', v_skill, 'versionId', v_version, 'digest', v_digest)) then
    raise exception 'FAIL: an accepted skill step is a skill step bound to the imported skill, got %',
      row_to_json(v_row);
  end if;
  if not exists (
    select 1 from deal_step_skill_bindings b
     where b.deal_step_id = v_row.id and b.deal_id = v_deal and b.kind = 'publication'
       and b.skill_id = v_skill and b.version_id = v_version and b.digest = v_digest
       and b.bound_by = v_director and b.source = 'template') then
    raise exception 'FAIL: the accepted step has its skill binding row';
  end if;
  if not exists (
    select 1 from deal_skill_imports i
     where i.skill_id = v_skill and i.deal_id = v_deal and i.version_id = v_version
       and i.digest = v_digest and i.name = 'Weekly memo'
       and i.capability_contract ->> 'purpose' = 'Draft a memo'
       and i.imported_by = v_director and i.template_revision_id = v_v2
       and i.source_asset_key = 's0') then
    raise exception 'FAIL: the accepted step records where its skill was imported from';
  end if;
  if not exists (
    select 1 from audit_log
     where deal_id = v_deal and action = 'update'
       and detail ->> 'rail' = 'template_change' and detail ->> 'stepKey' = 'custom-memo'
       and detail ->> 'skillId' = v_skill::text and detail ->> 'versionId' = v_version::text) then
    raise exception 'FAIL: the decision audit row names the imported skill';
  end if;
  if tcr_change(v_set, 'added:custom-memo') ->> 'decision' is distinct from 'accepted' then
    raise exception 'FAIL: the returned change set shows the accepted skill step';
  end if;

  v_ok := false;
  begin
    perform deal_template_change_skill(v_deal, 'added:custom-memo', tcr_current(v_deal), v_protected);
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'stale_change';
  end;
  if not v_ok then
    raise exception 'FAIL: an accepted change has no skill left to import';
  end if;

  perform tcr_decide(v_deal, v_director, 'added:custom-plain', 'accepted', v_protected);
  if (tcr_key_row(v_deal, 'custom-plain')).definition
     is distinct from jsonb_build_object('title', 'Checklist', 'description', 'A manual step.') then
    raise exception 'FAIL: a manual step is still accepted with no import';
  end if;

  v_v3 := tcr_skill_revision(v_template, v_director, 3, jsonb_build_array(
    tcr_step('p1-s7', 1, 1),
    tcr_step('p1-s10', 1, 2),
    tcr_step('custom-memo', 1, 3, tcr_skill_definition()) || jsonb_build_object('skillKey', 's0'),
    tcr_step('custom-late', 1, 4, jsonb_build_object('title', 'Late check', 'description', 'Added later.'))),
    v_candidate, v_digest);

  if tcr_change(deal_template_changes(v_deal, v_protected), 'removed:custom-plain') -> 'decision'
       is distinct from 'null'::jsonb then
    raise exception 'FAIL: a step the template dropped is offered as a removed change';
  end if;
  v_ok := false;
  begin
    perform deal_template_change_skill(v_deal, 'removed:custom-plain', tcr_current(v_deal), v_protected);
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'stale_change';
  end;
  if not v_ok then
    raise exception 'FAIL: a removed change has no skill to import';
  end if;

  v_plan := deal_template_change_skill(v_deal, 'added:custom-late', tcr_current(v_deal), v_protected);
  if v_plan ->> 'revisionId' is distinct from v_v3::text
     or v_plan -> 'skillKey' is distinct from 'null'::jsonb then
    raise exception 'FAIL: an offered added step reports the current revision and no skill, got %', v_plan;
  end if;
  perform tcr_decide(v_deal, v_director, 'added:custom-late', 'discarded', v_protected);
  v_ok := false;
  begin
    perform deal_template_change_skill(v_deal, 'added:custom-late', tcr_current(v_deal), v_protected);
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'stale_change';
  end;
  if not v_ok then
    raise exception 'FAIL: a discarded change has no skill left to import';
  end if;

  if has_function_privilege('anon', 'deal_template_change_skill(uuid, text, uuid, text[])', 'execute')
     or has_function_privilege('authenticated', 'deal_template_change_skill(uuid, text, uuid, text[])', 'execute')
     or not has_function_privilege('service_role', 'deal_template_change_skill(uuid, text, uuid, text[])', 'execute') then
    raise exception 'FAIL: deal_template_change_skill must be service role only';
  end if;

  raise notice 'OK: an accepted skill step is bound to the one skill imported for it';
end;
$$;

do $$
declare
  v_tenant   uuid := '00000000-0000-4000-8000-0000000000e7';
  v_bank     uuid;
  v_director uuid;
  v_first    uuid;
  v_second   uuid;
  v_third    uuid;
  v_fourth   uuid;
  v_a1       uuid;
  v_b1       uuid;
  v_c1       uuid;
  v_d1       uuid;
  v_deal     uuid;
  v_kept     uuid;
  v_set      jsonb;
  v_ok       boolean := false;
begin
  v_bank := tcr_bank(v_tenant, 'Probe Scoped Bank');
  v_director := tcr_user(v_tenant, v_bank, 'tcr-scoped@example.com', 'director', false);
  v_first := tcr_template(v_tenant, v_bank, v_director, 'Scoped rail one');
  v_second := tcr_template(v_tenant, v_bank, v_director, 'Scoped rail two');

  v_a1 := tcr_revision(v_first, v_director, 1, jsonb_build_array(tcr_step('p1-s10', 1, 1)));
  v_deal := tcr_deal(v_tenant, v_bank, v_a1, 'Project Juniper');
  perform tcr_deal_step(v_deal, 'p1-s10', 1, 1, 'current', 'p1-s10');
  perform tcr_revision(v_first, v_director, 2, jsonb_build_array(
    tcr_step('p1-s10', 1, 1), tcr_step('p1-s11', 1, 2)));

  perform tcr_decide(v_deal, v_director, 'added:p1-s11', 'discarded', array[]::text[]);
  perform tcr_revision(v_first, v_director, 3, jsonb_build_array(
    tcr_step('p1-s10', 1, 1), tcr_step('p1-s11', 1, 2), tcr_step('p1-s12', 1, 3)));
  v_set := deal_template_changes(v_deal, array[]::text[]);
  if tcr_change(v_set, 'added:p1-s11') ->> 'decision' is distinct from 'discarded'
     or tcr_change(v_set, 'added:p1-s12') -> 'decision' is distinct from 'null'::jsonb then
    raise exception 'FAIL: a discard still counts at the next version of the same template, got %', v_set;
  end if;

  v_b1 := tcr_revision(v_second, v_director, 1, jsonb_build_array(tcr_step('p1-s10', 1, 1)));
  update deals set rail_template_revision_id = v_b1, rail_template_name = 'Scoped rail two'
   where id = v_deal;
  perform tcr_revision(v_second, v_director, 2, jsonb_build_array(
    tcr_step('p1-s10', 1, 1), tcr_step('p1-s11', 1, 2)));
  v_set := deal_template_changes(v_deal, array[]::text[]);
  if tcr_change(v_set, 'added:p1-s11') is null
     or tcr_change(v_set, 'added:p1-s11') -> 'decision' is distinct from 'null'::jsonb then
    raise exception 'FAIL: a discard made under another template decides nothing here, got %', v_set;
  end if;

  begin
    perform deal_template_change_reopen(v_deal, v_director, 'added:p1-s11');
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'not_reopenable';
  end;
  if not v_ok then
    raise exception 'FAIL: a discard made under another template cannot be reopened here';
  end if;

  update deals set rail_template_revision_id = v_a1, rail_template_name = 'Scoped rail one'
   where id = v_deal;
  v_set := deal_template_changes(v_deal, array[]::text[]);
  if tcr_change(v_set, 'added:p1-s11') ->> 'decision' is distinct from 'discarded' then
    raise exception 'FAIL: a deal back on a template finds its earlier decisions for it, got %', v_set;
  end if;

  update deals set rail_template_revision_id = null, rail_template_name = null where id = v_deal;
  v_ok := false;
  begin
    perform deal_template_change_reopen(v_deal, v_director, 'added:p1-s11');
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'not_reopenable';
  end;
  if not v_ok then
    raise exception 'FAIL: a deal that follows no template has nothing to reopen';
  end if;

  update deals set rail_template_revision_id = v_a1, rail_template_name = 'Scoped rail one'
   where id = v_deal;
  if deal_template_change_reopen(v_deal, v_director, 'added:p1-s11') ->> 'decision'
     is distinct from 'reopened' then
    raise exception 'FAIL: a discard is reopened under the template it was made for';
  end if;

  v_third := tcr_template(v_tenant, v_bank, v_director, 'Scoped rail three');
  v_fourth := tcr_template(v_tenant, v_bank, v_director, 'Scoped rail four');
  v_c1 := tcr_revision(v_third, v_director, 1, jsonb_build_array(
    tcr_step('p1-s10', 1, 1), tcr_step('p1-s11', 1, 2)));
  v_kept := tcr_deal(v_tenant, v_bank, v_c1, 'Project Hazel');
  perform tcr_deal_step(v_kept, 'p1-s10', 1, 1, 'current', 'p1-s10');
  perform tcr_deal_step(v_kept, 'p1-s11', 1, 2, 'pending', 'p1-s11');
  perform tcr_revision(v_third, v_director, 2, jsonb_build_array(tcr_step('p1-s10', 1, 1)));

  perform tcr_decide(v_kept, v_director, 'removed:p1-s11', 'discarded', array[]::text[]);
  perform tcr_revision(v_third, v_director, 3, jsonb_build_array(
    tcr_step('p1-s10', 1, 1), tcr_step('p1-s12', 1, 2)));
  v_set := deal_template_changes(v_kept, array[]::text[]);
  if tcr_change(v_set, 'removed:p1-s11') ->> 'decision' is distinct from 'discarded' then
    raise exception 'FAIL: a removal discarded under a template stays discarded at its next version, got %', v_set;
  end if;

  v_d1 := tcr_revision(v_fourth, v_director, 1, jsonb_build_array(
    tcr_step('p1-s10', 1, 1), tcr_step('p1-s11', 1, 2)));
  update deals set rail_template_revision_id = v_d1, rail_template_name = 'Scoped rail four'
   where id = v_kept;
  perform tcr_revision(v_fourth, v_director, 2, jsonb_build_array(tcr_step('p1-s10', 1, 1)));
  v_set := deal_template_changes(v_kept, array[]::text[]);
  if tcr_change(v_set, 'removed:p1-s11') is null
     or tcr_change(v_set, 'removed:p1-s11') -> 'decision' is distinct from 'null'::jsonb then
    raise exception 'FAIL: a removal discarded under another template decides nothing here, got %', v_set;
  end if;

  if has_function_privilege('anon', 'deal_template_changes(uuid, text[])', 'execute')
     or has_function_privilege('authenticated', 'deal_template_changes(uuid, text[])', 'execute')
     or not has_function_privilege('service_role', 'deal_template_changes(uuid, text[])', 'execute')
     or has_function_privilege('anon', 'deal_template_change_reopen(uuid, uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'deal_template_change_reopen(uuid, uuid, text)', 'execute')
     or not has_function_privilege('service_role', 'deal_template_change_reopen(uuid, uuid, text)', 'execute') then
    raise exception 'FAIL: the change set and the reopen are executable by service_role only';
  end if;

  raise notice 'OK: change decisions belong to the template the deal follows';
end;
$$;

rollback;
