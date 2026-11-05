
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

create function rcs_bank(p_tenant uuid, p_label text) returns uuid
language plpgsql as $$
declare v_bank uuid := gen_random_uuid();
begin
  insert into companies (id, tenant_id, name, type) values (v_bank, p_tenant, p_label, 'bank');
  return v_bank;
end;
$$;

create function rcs_user(p_tenant uuid, p_bank uuid, p_email text, p_role text) returns uuid
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

create function rcs_deal(p_tenant uuid, p_bank uuid, p_md uuid, p_codename text) returns uuid
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

create function rcs_protected() returns text[] language sql immutable as $$
  select array['p1-s7', 'p1-s6', 'g0-notify'];
$$;

create function rcs_error(p_statement text) returns text
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

create function rcs_template(p_bank uuid, p_actor uuid, p_name text) returns uuid
language sql as $$
  select (create_rail_template(p_bank, p_actor, p_name, null, jsonb_build_array(
    jsonb_build_object('stepId', 'p1-s7', 'seq', 1, 'phaseIndex', 1, 'displayOrder', 1,
                       'origin', 'catalog', 'definition', null),
    jsonb_build_object('stepId', 'p1-s6', 'seq', 2, 'phaseIndex', 1, 'displayOrder', 2,
                       'origin', 'catalog', 'definition', null),
    jsonb_build_object('stepId', 'g0-notify', 'seq', 3, 'phaseIndex', 1, 'displayOrder', 3,
                       'origin', 'catalog', 'definition', null),
    jsonb_build_object('stepId', 'p1-s10', 'seq', 4, 'phaseIndex', 1, 'displayOrder', 4,
                       'origin', 'catalog', 'definition', null),
    jsonb_build_object('stepId', 'p1-s11', 'seq', 5, 'phaseIndex', 2, 'displayOrder', 5,
                       'origin', 'catalog', 'definition', null)
  )) ->> 'id')::uuid;
$$;

create function rcs_skill(p_digest text) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'name', 'Buyer long list',
    'contract', jsonb_build_object(
      'purpose', 'Builds a ranked long list of strategic buyers.',
      'expectedInput', 'The sector and size of the target.',
      'expectedOutput', 'A ranked list of buyers with a reason for each.'),
    'source', jsonb_build_object(
      'kind', 'publication',
      'skillId', '0b6f6d0e-52a1-4b0f-9a2e-7d3c1f5e8a10',
      'versionId', '5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
      'digest', p_digest));
$$;

do $$
declare
  v_tenant   uuid := '00000000-0000-4000-8000-0000000000f1';
  v_bank     uuid;
  v_md       uuid;
  v_catalog  uuid;
  v_legacy   uuid;
  v_house    uuid;
  v_change   uuid;
  v_result   jsonb;
  v_revision rail_template_revisions;
  v_error    text;
  v_routine  text;
begin
  v_bank := rcs_bank(v_tenant, 'Probe Description Bank');
  v_md := rcs_user(v_tenant, v_bank, 'rcs-description-md@example.com', 'director');

  v_legacy := rcs_template(v_bank, v_md, 'Probe Published Before');
  perform publish_rail_template(v_legacy, v_bank, v_md, rcs_protected());
  if rail_catalog_draft_differs(v_legacy) then
    raise exception 'FAIL: a template published with an empty description has nothing left to publish';
  end if;
  if (select r.description from rail_template_revisions r
        join rail_templates t on t.current_revision_id = r.id
        join rail_catalog_templates c on c.rail_template_id = t.id
       where c.id = v_legacy) is distinct from '' then
    raise exception 'FAIL: a template with no description publishes an empty one';
  end if;

  v_catalog := (create_rail_template(v_bank, v_md, 'Probe Described Rail', null,
    jsonb_build_array(
      jsonb_build_object('stepId', 'p1-s7', 'seq', 1, 'phaseIndex', 1, 'displayOrder', 1,
                         'origin', 'catalog', 'definition', null),
      jsonb_build_object('stepId', 'p1-s6', 'seq', 2, 'phaseIndex', 1, 'displayOrder', 2,
                         'origin', 'catalog', 'definition', null),
      jsonb_build_object('stepId', 'g0-notify', 'seq', 3, 'phaseIndex', 1, 'displayOrder', 3,
                         'origin', 'catalog', 'definition', null)),
    'For mid-market carve-outs.') ->> 'id')::uuid;
  if (select description from rail_catalog_templates where id = v_catalog)
     is distinct from 'For mid-market carve-outs.' then
    raise exception 'FAIL: a template is created with its description';
  end if;

  v_error := rcs_error(format('select create_rail_template(%L, %L, %L, null, %L, %L)',
    v_bank, v_md, 'Probe Long Description', '[{"stepId":"p1-s7","phaseIndex":1,"displayOrder":1}]'::jsonb,
    repeat('x', 501)));
  if v_error is distinct from 'template_description' then
    raise exception 'FAIL: a description stops at 500 characters, got %', v_error;
  end if;

  v_result := publish_rail_template(v_catalog, v_bank, v_md, rcs_protected());
  select * into v_revision from rail_template_revisions where id = (v_result ->> 'revisionId')::uuid;
  if v_revision.description is distinct from 'For mid-market carve-outs.' then
    raise exception 'FAIL: publish copies the description onto the revision, got %', v_revision.description;
  end if;
  if rail_catalog_draft_differs(v_catalog) then
    raise exception 'FAIL: a freshly published template has nothing left to publish';
  end if;

  v_result := set_rail_template_description(v_bank, v_md, v_catalog, '  For carve-outs of any size.  ');
  if v_result -> 'changed' is distinct from 'true'::jsonb
     or v_result ->> 'description' is distinct from 'For carve-outs of any size.' then
    raise exception 'FAIL: a description is trimmed and saved, got %', v_result;
  end if;
  if not rail_catalog_draft_differs(v_catalog) then
    raise exception 'FAIL: a changed description is a change to publish';
  end if;
  select id into v_change from rail_catalog_changes
   where template_id = v_catalog and action = 'set_template_description' and undoes_id is null;
  if v_change is null
     or (select before ->> 'description' from rail_catalog_changes where id = v_change)
        is distinct from 'For mid-market carve-outs.'
     or (select after ->> 'description' from rail_catalog_changes where id = v_change)
        is distinct from 'For carve-outs of any size.' then
    raise exception 'FAIL: a description change is logged with the text before and after';
  end if;

  v_result := set_rail_template_description(v_bank, v_md, v_catalog, 'For carve-outs of any size.');
  if v_result -> 'changed' is distinct from 'false'::jsonb
     or (select count(*) from rail_catalog_changes
          where template_id = v_catalog and action = 'set_template_description') is distinct from 1::bigint then
    raise exception 'FAIL: saving the same description writes nothing';
  end if;

  perform undo_rail_template_change(v_bank, v_md, v_catalog, v_change);
  if (select description from rail_catalog_templates where id = v_catalog)
     is distinct from 'For mid-market carve-outs.'
     or rail_catalog_draft_differs(v_catalog) then
    raise exception 'FAIL: undoing a description change restores it and leaves nothing to publish';
  end if;

  v_error := rcs_error(format('select set_rail_template_description(%L, %L, %L, %L)',
    v_bank, v_md, v_catalog, repeat('x', 501)));
  if v_error is distinct from 'template_description' then
    raise exception 'FAIL: an edited description stops at 500 characters, got %', v_error;
  end if;
  v_error := rcs_error(format('select set_rail_template_description(%L, %L, %L, %L)',
    gen_random_uuid(), v_md, v_catalog, 'Nope'));
  if v_error is distinct from 'template_missing' then
    raise exception 'FAIL: another company cannot describe this template, got %', v_error;
  end if;

  select id into v_house from rail_catalog_steps where template_id = v_catalog and step_id = 'p1-s6';
  perform set_rail_template_step_skill(v_bank, v_md, v_catalog, v_house, rcs_skill(repeat('a', 64)));
  if (select definition from rail_catalog_steps where id = v_house)
     is distinct from jsonb_build_object('skill', rcs_skill(repeat('a', 64))) then
    raise exception 'FAIL: a house step can hold a skill';
  end if;
  if not rail_catalog_draft_differs(v_catalog)
     or jsonb_array_length(rail_catalog_manifest(v_catalog) -> 'skills') is distinct from 1 then
    raise exception 'FAIL: a skill set on a step is a change to publish and is in the manifest';
  end if;

  perform set_rail_template_step_skill(v_bank, v_md, v_catalog, v_house, rcs_skill(repeat('b', 64)));
  select id into v_change from rail_catalog_changes
   where template_id = v_catalog and action = 'set_step_skill'
     and after -> 'definition' -> 'skill' -> 'source' ->> 'digest' = repeat('b', 64);
  perform undo_rail_template_change(v_bank, v_md, v_catalog, v_change);
  if (select definition -> 'skill' -> 'source' ->> 'digest' from rail_catalog_steps where id = v_house)
     is distinct from repeat('a', 64) then
    raise exception 'FAIL: undoing a skill change restores the skill it replaced';
  end if;

  perform set_rail_template_step_skill(v_bank, v_md, v_catalog, v_house, null);
  if (select definition from rail_catalog_steps where id = v_house) is not null
     or rail_catalog_draft_differs(v_catalog) then
    raise exception 'FAIL: clearing a house step''s skill leaves the step as it was published';
  end if;

  v_error := rcs_error(format('select set_rail_template_step_skill(%L, %L, %L, %L, %L)',
    v_bank, v_md, v_catalog, v_house, '{"name":"No source"}'::jsonb));
  if v_error is distinct from 'template_step' then
    raise exception 'FAIL: a skill block needs a name, a contract and a source, got %', v_error;
  end if;

  perform add_rail_template_step(v_bank, v_md, v_catalog, 'custom-' || gen_random_uuid()::text,
    null, 2, 'custom', jsonb_build_object(
      'schemaVersion', 1, 'type', 'skill', 'title', 'Buyer long list',
      'description', 'Ranks buyers.', 'inputs', '[]'::jsonb,
      'skill', rcs_skill(repeat('c', 64))), null);
  v_error := rcs_error(format('select set_rail_template_step_skill(%L, %L, %L, %L, null)',
    v_bank, v_md, v_catalog,
    (select id from rail_catalog_steps where template_id = v_catalog and definition ->> 'type' = 'skill')));
  if v_error is distinct from 'template_step' then
    raise exception 'FAIL: a skill step cannot lose its skill, got %', v_error;
  end if;

  foreach v_routine in array array[
    'create_rail_template(uuid, uuid, text, uuid, jsonb, text)',
    'set_rail_template_description(uuid, uuid, uuid, text)',
    'set_rail_template_step_skill(uuid, uuid, uuid, uuid, jsonb)'
  ]
  loop
    if has_function_privilege('anon', v_routine, 'execute')
       or has_function_privilege('authenticated', v_routine, 'execute')
       or not has_function_privilege('service_role', v_routine, 'execute') then
      raise exception 'FAIL: % must be callable by service_role only', v_routine;
    end if;
  end loop;

  raise notice 'OK: templates have a description and steps a logged skill setter';
end $$;

create function rcs_house(p_step text, p_seq int, p_phase int, p_definition jsonb default null) returns jsonb
language sql immutable as $$
  select jsonb_build_object('dealStepId', gen_random_uuid(), 'stepId', p_step, 'origin', 'catalog',
    'seq', p_seq, 'phaseIndex', p_phase, 'definition', p_definition);
$$;

create function rcs_custom(p_step text, p_phase int, p_definition jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('dealStepId', gen_random_uuid(), 'stepId', p_step, 'origin', 'custom',
    'seq', null, 'phaseIndex', p_phase, 'definition', p_definition);
$$;

create function rcs_order(p_template uuid) returns text[] language sql stable as $$
  select array_agg(step_id order by display_order) from rail_catalog_steps where template_id = p_template;
$$;

do $$
declare
  v_tenant    uuid := '00000000-0000-4000-8000-0000000000f2';
  v_bank      uuid;
  v_md        uuid;
  v_worker    uuid;
  v_deal      uuid;
  v_catalog   uuid;
  v_template  uuid;
  v_revision  uuid;
  v_keep      text := 'custom-11111111-1111-4111-8111-111111111111';
  v_drop      text := 'custom-22222222-2222-4222-8222-222222222222';
  v_new       text := 'custom-33333333-3333-4333-8333-333333333333';
  v_steps     jsonb;
  v_result    jsonb;
  v_check     jsonb;
  v_seen      uuid[];
  v_role      uuid;
  v_error     text;
  v_routine   text;
  v_padded    jsonb;
  v_order_before text[];
  v_changes_before bigint;
  v_tenant2   uuid := '00000000-0000-4000-8000-0000000000f3';
  v_bank2     uuid;
  v_other     uuid;
  v_catalog2  uuid;
  v_published2 jsonb;
  v_rev2      uuid := gen_random_uuid();
begin
  v_bank := rcs_bank(v_tenant, 'Probe Apply Bank');
  v_md := rcs_user(v_tenant, v_bank, 'rcs-apply-md@example.com', 'director');
  v_worker := rcs_user(v_tenant, v_bank, 'rcs-apply-worker@example.com', 'member');
  v_deal := rcs_deal(v_tenant, v_bank, v_md, 'Probe Apply One');

  v_catalog := rcs_template(v_bank, v_md, 'Probe Apply Rail');
  perform add_rail_template_step(v_bank, v_md, v_catalog, v_keep, null, 2, 'custom',
    jsonb_build_object('title', 'Fairness opinion', 'description', 'Independent opinion.'), null);
  perform add_rail_template_step(v_bank, v_md, v_catalog, v_drop, null, 2, 'custom',
    jsonb_build_object('title', 'Old memo', 'description', 'No longer used.'), null);
  v_result := publish_rail_template(v_catalog, v_bank, v_md, rcs_protected());
  v_template := (v_result ->> 'templateId')::uuid;
  v_revision := (v_result ->> 'revisionId')::uuid;
  select coalesce(array_agg(id), '{}') into v_seen from rail_catalog_changes where template_id = v_catalog;

  v_steps := jsonb_build_array(
    rcs_house('p1-s7', 1, 1),
    rcs_house('p1-s6', 2, 1, jsonb_build_object('skill', rcs_skill(repeat('a', 64)))),
    rcs_house('g0-notify', 3, 1),
    rcs_custom(v_new, 1, jsonb_build_object('title', 'Team memo', 'description', 'Added by the team.')),
    rcs_house('p1-s10', 4, 1),
    rcs_house('p1-s11', 5, 2),
    rcs_custom(v_keep, 2, jsonb_build_object('title', 'Fairness opinion', 'description', 'Opinion before signing.')));

  v_result := rail_catalog_apply_rail(v_bank, v_md, v_catalog, v_steps);
  if v_result is distinct from jsonb_build_object('removed', 1, 'added', 1, 'updated', 2) then
    raise exception 'FAIL: the apply reports what it changed, got %', v_result;
  end if;
  if rcs_order(v_catalog) is distinct from
     array['p1-s7', 'p1-s6', 'g0-notify', v_new, 'p1-s10', 'p1-s11', v_keep] then
    raise exception 'FAIL: the template takes the rail''s steps in the rail''s order, got %', rcs_order(v_catalog);
  end if;
  if (select definition ->> 'description' from rail_catalog_steps
       where template_id = v_catalog and step_id = v_keep) is distinct from 'Opinion before signing.'
     or (select definition -> 'skill' from rail_catalog_steps
          where template_id = v_catalog and step_id = 'p1-s6') is distinct from rcs_skill(repeat('a', 64)) then
    raise exception 'FAIL: a matched step takes the rail''s description and skill';
  end if;
  if (select array_agg(action order by action) from rail_catalog_changes
       where template_id = v_catalog and id <> all (v_seen))
     is distinct from array['add_step', 'remove_step', 'set_description', 'set_step_skill'] then
    raise exception 'FAIL: every change of an apply is logged under its own action';
  end if;

  v_result := rail_catalog_apply_rail(v_bank, v_md, v_catalog, v_steps);
  if v_result is distinct from jsonb_build_object('removed', 0, 'added', 0, 'updated', 0) then
    raise exception 'FAIL: applying the same rail again changes nothing, got %', v_result;
  end if;

  select jsonb_agg(
           case when e ->> 'stepId' = v_keep
                then jsonb_set(e, '{definition,description}', to_jsonb('Opinion before signing.   '::text))
                else e end order by ord)
    into v_padded
    from jsonb_array_elements(v_steps) with ordinality as t(e, ord);
  v_result := rail_catalog_apply_rail(v_bank, v_md, v_catalog, v_padded);
  if v_result is distinct from jsonb_build_object('removed', 0, 'added', 0, 'updated', 0) then
    raise exception 'FAIL: a description that differs only by trailing space changes nothing, got %', v_result;
  end if;

  v_order_before := rcs_order(v_catalog);
  select count(*) into v_changes_before from rail_catalog_changes where template_id = v_catalog;
  v_error := rcs_error(format('select rail_catalog_apply_rail(%L, %L, %L, %L)', v_bank, v_md, v_catalog,
    jsonb_build_array(
      rcs_house('p1-s7', 1, 1), rcs_house('p1-s6', 2, 1), rcs_house('g0-notify', 3, 1),
      rcs_house('p1-s11', 5, 2), rcs_house('p1-s10', 4, 1))));
  if v_error is distinct from 'order_differs' then
    raise exception 'FAIL: matched steps in another relative order are refused, got %', v_error;
  end if;
  if rcs_order(v_catalog) is distinct from v_order_before
     or (select count(*) from rail_catalog_changes where template_id = v_catalog) is distinct from v_changes_before then
    raise exception 'FAIL: a refused order writes nothing';
  end if;

  v_result := rail_catalog_apply_rail(v_bank, v_md, v_catalog, jsonb_build_array(
    rcs_house('p1-s7', 1, 1), rcs_house('p1-s6', 2, 1), rcs_house('g0-notify', 3, 1),
    rcs_custom('custom-44444444-4444-4444-8444-444444444444', 2,
      jsonb_build_object('title', 'Only step', 'description', 'Everything else was replaced.'))));
  if rcs_order(v_catalog) is distinct from
     array['p1-s7', 'p1-s6', 'g0-notify', 'custom-44444444-4444-4444-8444-444444444444']
     or (select definition from rail_catalog_steps where template_id = v_catalog and step_id = 'p1-s6')
        is not null then
    raise exception 'FAIL: an unrelated rail replaces every other step and clears a skill it does not have';
  end if;

  v_check := rail_catalog_save_check(v_md, v_bank, v_deal,
    jsonb_build_object('kind', 'new', 'name', 'Probe Brand New'), rail_template_source_fingerprint(v_deal));
  if v_check ->> 'tenantId' is distinct from v_tenant::text
     or v_check -> 'target' is distinct from 'null'::jsonb then
    raise exception 'FAIL: a new save is checked and reports the tenant, got %', v_check;
  end if;

  v_error := rcs_error(format('select rail_catalog_save_check(%L, %L, %L, %L, %L)', v_md, v_bank, v_deal,
    jsonb_build_object('kind', 'new', 'name', 'probe apply rail'), rail_template_source_fingerprint(v_deal)));
  if v_error is distinct from 'name_taken' then
    raise exception 'FAIL: a new save cannot reuse a template name, got %', v_error;
  end if;
  v_error := rcs_error(format('select rail_catalog_save_check(%L, %L, %L, %L, %L)', v_md, v_bank, v_deal,
    jsonb_build_object('kind', 'new', 'name', 'Default'), rail_template_source_fingerprint(v_deal)));
  if v_error is distinct from 'invalid_command' then
    raise exception 'FAIL: a new save cannot be named Default, got %', v_error;
  end if;
  v_error := rcs_error(format('select rail_catalog_save_check(%L, %L, %L, %L, %L)', v_md, v_bank, v_deal,
    jsonb_build_object('kind', 'new', 'name', 'Probe Brand New'), repeat('0', 64)));
  if v_error is distinct from 'source_changed' then
    raise exception 'FAIL: a rail that changed since it was read is refused, got %', v_error;
  end if;

  select id into v_role from roles where slug = 'deal_team';
  insert into deal_memberships (deal_id, user_id, role_id, deal_role, phase, added_by)
    values (v_deal, v_worker, v_role, 'deal_team', 0, v_md);
  v_error := rcs_error(format('select rail_catalog_save_check(%L, %L, %L, %L, %L)', v_worker, v_bank, v_deal,
    jsonb_build_object('kind', 'new', 'name', 'Probe Brand New'), rail_template_source_fingerprint(v_deal)));
  if v_error is distinct from 'forbidden' then
    raise exception 'FAIL: a deal member who cannot configure templates cannot save, got %', v_error;
  end if;

  update users set firm_role = 'cco' where id = v_worker;
  v_error := rcs_error(format('select rail_catalog_save_check(%L, %L, %L, %L, %L)', v_worker, v_bank, v_deal,
    jsonb_build_object('kind', 'new', 'name', 'Probe Brand New'), rail_template_source_fingerprint(v_deal)));
  if v_error is distinct from 'forbidden' then
    raise exception 'FAIL: a firm cco without the template permission cannot save, got %', v_error;
  end if;

  update feature_flags set enabled = false where key = 'company_access_management';
  v_error := rcs_error(format('select rail_catalog_save_check(%L, %L, %L, %L, %L)', v_worker, v_bank, v_deal,
    jsonb_build_object('kind', 'new', 'name', 'Probe Brand New'), rail_template_source_fingerprint(v_deal)));
  if v_error is distinct from 'forbidden' then
    raise exception 'FAIL: the template permission is checked with company_access_management off, got %', v_error;
  end if;
  v_error := rcs_error(format('select rail_catalog_save_check(%L, %L, %L, %L, %L)', v_md, v_bank, v_deal,
    jsonb_build_object('kind', 'new', 'name', 'Probe Brand New'), rail_template_source_fingerprint(v_deal)));
  if v_error is not null then
    raise exception 'FAIL: a director can still save with company_access_management off, got %', v_error;
  end if;
  update feature_flags set enabled = true where key = 'company_access_management';
  update users set firm_role = null where id = v_worker;

  v_error := rcs_error(format('select rail_catalog_save_check(%L, %L, %L, %L, %L)', v_md, v_bank, v_deal,
    jsonb_build_object('kind', 'replace', 'templateId', v_template, 'expectedRevisionId', v_revision),
    rail_template_source_fingerprint(v_deal)));
  if v_error is distinct from 'unpublished_changes' then
    raise exception 'FAIL: a template with unpublished changes cannot be replaced, got %', v_error;
  end if;

  v_result := publish_rail_template(v_catalog, v_bank, v_md, rcs_protected());
  v_error := rcs_error(format('select rail_catalog_save_check(%L, %L, %L, %L, %L)', v_md, v_bank, v_deal,
    jsonb_build_object('kind', 'replace', 'templateId', v_template, 'expectedRevisionId', v_revision),
    rail_template_source_fingerprint(v_deal)));
  if v_error is distinct from 'stale_template' then
    raise exception 'FAIL: a template that moved to another version cannot be replaced blindly, got %', v_error;
  end if;

  v_check := rail_catalog_save_check(v_md, v_bank, v_deal,
    jsonb_build_object('kind', 'replace', 'templateId', v_template,
                       'expectedRevisionId', v_result ->> 'revisionId'),
    rail_template_source_fingerprint(v_deal));
  if v_check -> 'target' ->> 'catalogTemplateId' is distinct from v_catalog::text
     or jsonb_array_length(v_check -> 'target' -> 'steps') is distinct from 4
     or v_check -> 'target' -> 'steps' -> 0 is distinct from
        jsonb_build_object('stepId', 'p1-s7', 'skill', null, 'retainedDigest', null) then
    raise exception 'FAIL: a replace is checked and reports the target''s steps, got %', v_check;
  end if;

  v_error := rcs_error(format('select rail_catalog_save_check(%L, %L, %L, %L, %L)', v_md, v_bank, v_deal,
    jsonb_build_object('kind', 'replace', 'templateId', gen_random_uuid(), 'expectedRevisionId', v_revision),
    rail_template_source_fingerprint(v_deal)));
  if v_error is distinct from 'not_found' then
    raise exception 'FAIL: a template that is not in the catalog cannot be replaced, got %', v_error;
  end if;

  v_bank2 := rcs_bank(v_tenant2, 'Probe Other Bank');
  v_other := rcs_user(v_tenant2, v_bank2, 'rcs-other-admin@example.com', 'director');
  update users set firm_role = 'admin' where id = v_other;

  v_error := rcs_error(format('select rail_catalog_save_check(%L, %L, %L, %L, %L)', v_other, v_bank, v_deal,
    jsonb_build_object('kind', 'new', 'name', 'Probe Brand New'), rail_template_source_fingerprint(v_deal)));
  if v_error is distinct from 'forbidden' then
    raise exception 'FAIL: a firm administrator of another tenant cannot check a save on this company''s deal, got %', v_error;
  end if;

  v_catalog2 := rcs_template(v_bank2, v_other, 'Probe Other Rail');
  perform add_rail_template_step(v_bank2, v_other, v_catalog2, 'custom-55555555-5555-4555-8555-555555555555', null, 2, 'custom',
    jsonb_build_object('title', 'Other memo', 'description', 'Another firm.'), null);
  v_published2 := publish_rail_template(v_catalog2, v_bank2, v_other, rcs_protected());
  v_error := rcs_error(format('select rail_catalog_save_check(%L, %L, %L, %L, %L)', v_md, v_bank, v_deal,
    jsonb_build_object('kind', 'replace', 'templateId', v_published2 ->> 'templateId',
                       'expectedRevisionId', v_published2 ->> 'revisionId'),
    rail_template_source_fingerprint(v_deal)));
  if v_error is distinct from 'not_found' then
    raise exception 'FAIL: a template of another company cannot be replaced, got %', v_error;
  end if;

  perform set_rail_template_step_skill(v_bank, v_md, v_catalog,
    (select id from rail_catalog_steps where template_id = v_catalog and step_id = 'p1-s6'),
    rcs_skill(repeat('a', 64)));
  v_result := publish_rail_template(v_catalog, v_bank, v_md, rcs_protected(), v_rev2,
    jsonb_build_object('revisionId', v_rev2, 'assets', jsonb_build_array(
      jsonb_build_object('key', 's0', 'packageDigest', repeat('a', 64)))));
  v_check := rail_catalog_save_check(v_md, v_bank, v_deal,
    jsonb_build_object('kind', 'replace', 'templateId', v_template, 'expectedRevisionId', v_result ->> 'revisionId'),
    rail_template_source_fingerprint(v_deal));
  if (select e from jsonb_array_elements(v_check -> 'target' -> 'steps') e where e ->> 'stepId' = 'p1-s6')
     is distinct from jsonb_build_object('stepId', 'p1-s6', 'skill', rcs_skill(repeat('a', 64)),
                                         'retainedDigest', repeat('a', 64)) then
    raise exception 'FAIL: a target step reports its skill and the digest retained for it, got %', v_check;
  end if;

  foreach v_routine in array array[
    'rail_catalog_apply_rail(uuid, uuid, uuid, jsonb)',
    'rail_template_assert_manage(uuid, uuid)',
    'rail_catalog_save_check(uuid, uuid, uuid, jsonb, text)'
  ]
  loop
    if has_function_privilege('anon', v_routine, 'execute')
       or has_function_privilege('authenticated', v_routine, 'execute')
       or not has_function_privilege('service_role', v_routine, 'execute') then
      raise exception 'FAIL: % must be callable by service_role only', v_routine;
    end if;
  end loop;

  raise notice 'OK: a rail is applied to a template through logged changes, and a save is checked first';
end $$;

create function rcs_steps(p_deal uuid) returns jsonb language sql stable as $$
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
        || jsonb_build_object('skill', rcs_skill(s.definition -> 'skillBinding' ->> 'digest'))
      else jsonb_build_object('title', s.definition ->> 'title',
                              'description', s.definition ->> 'description') end
  ) order by s.display_order, s.id), '[]'::jsonb)
  from deal_steps s where s.deal_id = p_deal and s.removed_at is null;
$$;

do $$
declare
  v_tenant    uuid := '00000000-0000-4000-8000-0000000000f3';
  v_bank      uuid;
  v_md        uuid;
  v_peer      uuid;
  v_deal      uuid;
  v_other     uuid;
  v_request   uuid := gen_random_uuid();
  v_revision  uuid := gen_random_uuid();
  v_digest    text := repeat('a', 64);
  v_receipt   jsonb;
  v_saved     jsonb;
  v_again     jsonb;
  v_replaced  jsonb;
  v_catalog   uuid;
  v_template  uuid;
  v_memo      uuid;
  v_skill     uuid;
  v_steps     jsonb;
  v_error     text;
  v_third     uuid;
  v_third_cat uuid;
  v_third_row uuid;
  v_other_new jsonb;
begin
  v_bank := rcs_bank(v_tenant, 'Probe Save Bank');
  v_md := rcs_user(v_tenant, v_bank, 'rcs-save-md@example.com', 'director');
  v_peer := rcs_user(v_tenant, v_bank, 'rcs-save-peer@example.com', 'director');
  v_deal := rcs_deal(v_tenant, v_bank, v_md, 'Probe Save One');

  v_memo := (rail_insert_step(v_deal, v_md, 2, 'phase_end', null,
    jsonb_build_object('title', 'Team memo', 'description', 'Added by the team.')) ->> 'stepId')::uuid;
  v_skill := (rail_insert_step(v_deal, v_md, 2, 'phase_end', null,
    jsonb_build_object(
      'schemaVersion', 1, 'type', 'skill', 'title', 'Buyer long list',
      'description', 'Ranks strategic buyers.',
      'inputs', jsonb_build_array(jsonb_build_object(
        'key', 'primary', 'kind', 'text', 'label', 'Input',
        'helperText', 'The sector and size of the target.', 'required', true)),
      'skillBinding', jsonb_build_object(
        'skillId', '0b6f6d0e-52a1-4b0f-9a2e-7d3c1f5e8a10',
        'versionId', '5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
        'digest', v_digest))) ->> 'stepId')::uuid;

  if (rail_template_read_source(v_md, v_deal) -> 'steps' -> 0) ? 'templateStepKey' is not true then
    raise exception 'FAIL: the source read reports each step''s template step id';
  end if;

  v_steps := rcs_steps(v_deal);
  v_receipt := jsonb_build_object('revisionId', v_revision,
    'assets', jsonb_build_array(jsonb_build_object('key', 's0', 'packageDigest', v_digest)));

  v_error := rcs_error(format(
    'select save_rail_to_catalog(%L, %L, %L, %L, %L, %L, %L, %L, %L)',
    v_md, v_bank, v_deal, gen_random_uuid(),
    jsonb_build_object('kind', 'new', 'name', 'Probe Saved Rail'), 'From Probe Save One.',
    v_steps, rail_template_source_fingerprint(v_deal), rcs_protected()));
  if v_error is distinct from 'source_changed' then
    raise exception 'FAIL: a rail with a skill cannot be saved without its receipt, got %', v_error;
  end if;

  v_error := rcs_error(format(
    'select save_rail_to_catalog(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L)',
    v_md, v_bank, v_deal, gen_random_uuid(),
    jsonb_build_object('kind', 'new', 'name', 'Probe Saved Rail'), 'From Probe Save One.',
    v_steps - 0, rail_template_source_fingerprint(v_deal), rcs_protected(), v_revision, v_receipt));
  if v_error is distinct from 'invalid_command' then
    raise exception 'FAIL: a step list that is not the deal''s active steps is refused, got %', v_error;
  end if;

  v_saved := save_rail_to_catalog(v_md, v_bank, v_deal, v_request,
    jsonb_build_object('kind', 'new', 'name', 'Probe Saved Rail'), 'From Probe Save One.',
    v_steps, rail_template_source_fingerprint(v_deal), rcs_protected(), v_revision, v_receipt);
  v_template := (v_saved ->> 'id')::uuid;
  if (v_saved ->> 'revisionId')::uuid is distinct from v_revision
     or v_saved ->> 'name' is distinct from 'Probe Saved Rail'
     or v_saved ->> 'description' is distinct from 'From Probe Save One.'
     or v_saved -> 'version' is distinct from '1'::jsonb
     or v_saved -> 'stepCount' is distinct from '7'::jsonb
     or v_saved -> 'skillCount' is distinct from '1'::jsonb then
    raise exception 'FAIL: a new save returns the published template, got %', v_saved;
  end if;

  select id into v_catalog from rail_catalog_templates where rail_template_id = v_template;
  if v_catalog is null
     or (select count(*) from rail_catalog_steps where template_id = v_catalog) is distinct from 7::bigint
     or (select definition -> 'skill' -> 'source' ->> 'digest' from rail_catalog_steps
          where template_id = v_catalog and definition ->> 'type' = 'skill') is distinct from v_digest
     or rail_catalog_draft_differs(v_catalog) then
    raise exception 'FAIL: a new save creates a published catalog template with the rail''s steps and skill';
  end if;

  if exists (select 1 from deal_steps
              where deal_id = v_deal and removed_at is null and template_step_key is null)
     or (select template_step_key from deal_steps where id = v_memo)
        is distinct from 'custom-' || v_memo::text
     or (select rail_template_revision_id from deals where id = v_deal) is distinct from v_revision
     or (select rail_template_name from deals where id = v_deal) is distinct from 'Probe Saved Rail' then
    raise exception 'FAIL: after a save the deal follows the template and its steps carry the template''s ids';
  end if;
  if deal_template_changes(v_deal, rcs_protected()) is not null then
    raise exception 'FAIL: a deal is offered nothing by the template it just saved';
  end if;

  if not exists (
    select 1 from audit_log
     where action = 'rail.template_created' and actor_id = v_md and deal_id = v_deal
       and detail ->> 'requestId' = v_request::text
       and detail ->> 'revisionId' = v_revision::text
       and detail -> 'version' = '1'::jsonb
       and detail -> 'result' = v_saved) then
    raise exception 'FAIL: a new save is audited on the deal with its request id and result';
  end if;

  if rail_catalog_save_replay(v_md, v_request) is distinct from v_saved then
    raise exception 'FAIL: a two-argument replay still finds a completed save';
  end if;
  if rail_catalog_save_replay(v_md, v_request, v_deal) is distinct from v_saved then
    raise exception 'FAIL: a completed save can be read back by its actor, request id and deal';
  end if;
  if rail_catalog_save_replay(v_peer, v_request, v_deal) is not null
     or rail_catalog_save_replay(v_md, gen_random_uuid(), v_deal) is not null
     or rail_catalog_save_replay(v_md, v_request, gen_random_uuid()) is not null then
    raise exception 'FAIL: a replay is found only for the actor who saved, the request id used and the deal saved';
  end if;

  v_again := save_rail_to_catalog(v_md, v_bank, v_deal, v_request,
    jsonb_build_object('kind', 'new', 'name', 'Probe Saved Rail'), 'From Probe Save One.',
    v_steps, rail_template_source_fingerprint(v_deal), rcs_protected(), v_revision, v_receipt);
  if v_again is distinct from v_saved
     or (select count(*) from rail_template_revisions where template_id = v_template) is distinct from 1::bigint then
    raise exception 'FAIL: the same request id returns the first result and writes nothing';
  end if;

  v_error := rcs_error(format(
    'select save_rail_to_catalog(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L)',
    v_md, v_bank, v_deal, gen_random_uuid(),
    jsonb_build_object('kind', 'replace', 'templateId', v_template, 'expectedRevisionId', v_revision),
    'From Probe Save One.', rcs_steps(v_deal), rail_template_source_fingerprint(v_deal), rcs_protected(),
    gen_random_uuid(), v_receipt));
  if v_error is distinct from 'nothing_to_publish' then
    raise exception 'FAIL: replacing a template with the rail it already equals is refused, got %', v_error;
  end if;

  insert into feature_flags (key, enabled) values ('template_change_review', true)
    on conflict (key) do update set enabled = true;

  v_other := rcs_deal(v_tenant, v_bank, v_peer, 'Probe Save Two');
  update deals set rail_template_revision_id = v_revision, rail_template_name = 'Probe Saved Rail'
   where id = v_other;
  update deal_steps set template_step_key = step_id where deal_id = v_other;

  perform rail_insert_step(v_deal, v_md, 2, 'phase_end', null,
    jsonb_build_object('title', 'Sanctions re-screen', 'description', 'Before signing.'));

  insert into deal_memberships (deal_id, user_id, role_id, deal_role, phase, added_by)
    values (v_deal, v_peer, (select id from roles where slug = 'deal_team'), 'deal_team',
            (select phase from deal_memberships where deal_id = v_deal and user_id = v_md), v_md);

  v_replaced := save_rail_to_catalog(v_md, v_bank, v_deal, gen_random_uuid(),
    jsonb_build_object('kind', 'replace', 'templateId', v_template, 'expectedRevisionId', v_revision),
    'Now with a re-screen.', rcs_steps(v_deal), rail_template_source_fingerprint(v_deal), rcs_protected(),
    '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a',
    jsonb_build_object('revisionId', '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a',
      'assets', jsonb_build_array(jsonb_build_object('key', 's0', 'packageDigest', v_digest))));
  if v_replaced -> 'version' is distinct from '2'::jsonb
     or v_replaced -> 'stepCount' is distinct from '8'::jsonb
     or v_replaced ->> 'description' is distinct from 'Now with a re-screen.' then
    raise exception 'FAIL: a replace publishes the next version with the rail''s steps, got %', v_replaced;
  end if;
  if (select count(*) from rail_catalog_changes where template_id = v_catalog and action = 'add_step')
       is distinct from 1::bigint
     or (select count(*) from rail_catalog_changes
          where template_id = v_catalog and action = 'set_template_description') is distinct from 1::bigint
     or (select count(*) from rail_catalog_changes
          where template_id = v_catalog and action = 'set_step_skill') is distinct from 0::bigint then
    raise exception 'FAIL: a replace logs the added step and the description, and leaves an unchanged skill alone';
  end if;
  if (select rail_template_revision_id from deals where id = v_deal)
       is distinct from '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a'::uuid
     or deal_template_changes(v_deal, rcs_protected()) is not null then
    raise exception 'FAIL: after a replace the deal sits at the new version and is offered nothing';
  end if;
  if exists (
    select 1 from notifications n
     where n.event_type = 'rail_template_updated' and n.payload ->> 'code' =
           (select code from deals where id = v_deal)) then
    raise exception 'FAIL: the team of the deal that saved is not notified about its own save';
  end if;
  if jsonb_array_length(deal_template_changes(v_other, rcs_protected()) -> 'changes') < 1
     or not exists (
       select 1 from notifications n
        where n.event_type = 'rail_template_updated' and n.payload ->> 'code' =
              (select code from deals where id = v_other)) then
    raise exception 'FAIL: another deal on the template is offered the changes and notified';
  end if;
  if not exists (
    select 1 from audit_log
     where action = 'rail.template_replaced' and deal_id = v_deal
       and detail ->> 'previousRevisionId' = v_revision::text
       and detail -> 'version' = '2'::jsonb) then
    raise exception 'FAIL: a replace is audited with the revision it replaced';
  end if;

  v_other_new := save_rail_to_catalog(v_peer, v_bank, v_other, gen_random_uuid(),
    jsonb_build_object('kind', 'new', 'name', 'Probe Other Rail'), null,
    rcs_steps(v_other), rail_template_source_fingerprint(v_other), rcs_protected());
  if (select rail_template_revision_id from deals where id = v_other)
       is distinct from (v_other_new ->> 'revisionId')::uuid
     or (select rail_template_name from deals where id = v_other) is distinct from 'Probe Other Rail'
     or exists (select 1 from deal_steps
                 where deal_id = v_other and removed_at is null and template_step_key is null)
     or deal_template_changes(v_other, rcs_protected()) is not null then
    raise exception 'FAIL: a deal that followed another template now follows the one it saved';
  end if;

  v_third := rcs_deal(v_tenant, v_bank, v_md, 'Probe Save Three');
  select id into v_third_row from deal_steps where deal_id = v_third and step_id = 'p1-s11';
  perform rail_remove_step(v_third, v_md, v_third_row, rcs_protected());
  v_again := save_rail_to_catalog(v_md, v_bank, v_third, v_request,
    jsonb_build_object('kind', 'new', 'name', 'Probe Third Rail'), null,
    rcs_steps(v_third), rail_template_source_fingerprint(v_third), rcs_protected());
  if v_again ->> 'name' is distinct from 'Probe Third Rail' then
    raise exception 'FAIL: a request id reused on another deal is a new save, got %', v_again;
  end if;
  select id into v_third_cat from rail_catalog_templates where rail_template_id = (v_again ->> 'id')::uuid;
  perform add_rail_template_step(v_bank, v_md, v_third_cat, 'p1-s11', 5, 2, 'catalog', null, null);
  perform publish_rail_template(v_third_cat, v_bank, v_md, rcs_protected());
  if (select template_step_key from deal_steps where id = v_third_row) is distinct from 'p1-s11'
     or coalesce(jsonb_array_length(deal_template_changes(v_third, rcs_protected()) -> 'changes'), 0) <> 0 then
    raise exception 'FAIL: a house step the team removed before saving is not offered back to it';
  end if;

  update deal_steps
     set definition = jsonb_set(definition, '{description}', to_jsonb(repeat('x', 4001)))
   where id = v_memo;
  v_error := rcs_error(format(
    'select save_rail_to_catalog(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L)',
    v_md, v_bank, v_deal, gen_random_uuid(),
    jsonb_build_object('kind', 'replace', 'templateId', v_template,
                       'expectedRevisionId', '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a'),
    'Too long.', rcs_steps(v_deal), rail_template_source_fingerprint(v_deal), rcs_protected(),
    '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b',
    jsonb_build_object('revisionId', '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b',
      'assets', jsonb_build_array(jsonb_build_object('key', 's0', 'packageDigest', v_digest)))));
  if v_error is distinct from 'invalid_command' then
    raise exception 'FAIL: a replace with a step description the catalog refuses is an unusable command, got %', v_error;
  end if;

  if has_function_privilege('anon',
       'save_rail_to_catalog(uuid, uuid, uuid, uuid, jsonb, text, jsonb, text, text[], uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated',
       'save_rail_to_catalog(uuid, uuid, uuid, uuid, jsonb, text, jsonb, text, text[], uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'rail_catalog_validate_rail_steps(uuid, jsonb, text[])', 'execute')
     or has_function_privilege('authenticated', 'rail_catalog_validate_rail_steps(uuid, jsonb, text[])', 'execute')
     or has_function_privilege('anon', 'rail_catalog_save_replay(uuid, uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'rail_catalog_save_replay(uuid, uuid, uuid)', 'execute')
     or not has_function_privilege('service_role', 'rail_catalog_save_replay(uuid, uuid, uuid)', 'execute')
     or not has_function_privilege('service_role',
       'save_rail_to_catalog(uuid, uuid, uuid, uuid, jsonb, text, jsonb, text, text[], uuid, jsonb)', 'execute')
     or not has_function_privilege('service_role', 'rail_catalog_validate_rail_steps(uuid, jsonb, text[])', 'execute') then
    raise exception 'FAIL: the save functions must be service role only';
  end if;

  raise notice 'OK: a rail is saved to the catalog, published, and its deal follows it';
end $$;

rollback;
