
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

create function probe_bank(p_tenant uuid, p_label text) returns uuid
language plpgsql as $$
declare v_bank uuid := gen_random_uuid();
begin
  insert into companies (id, tenant_id, name, type) values (v_bank, p_tenant, p_label, 'bank');
  return v_bank;
end;
$$;

create function probe_user(p_tenant uuid, p_bank uuid, p_email text, p_role text) returns uuid
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

create function probe_deal(p_tenant uuid, p_bank uuid, p_md uuid, p_codename text) returns uuid
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
      jsonb_build_object('stepId', 'p1-s11', 'seq', 5, 'phaseIndex', 1, 'displayOrder', 5)
    ),
    p_census_version => 'probe-rail',
    p_conflicts      => jsonb_build_object('approvedBy', 'Avery Lindqvist', 'approvedOn', '2026-09-01')
  ) -> 'deal' ->> 'id')::uuid;
end;
$$;

create function probe_protected() returns text[] language sql immutable as $$
  select array['p1-s7', 'p1-s6', 'g0-notify'];
$$;

create function probe_template(p_bank uuid, p_actor uuid, p_name text) returns uuid
language sql as $$
  select (create_rail_template(p_bank, p_actor, p_name, null, jsonb_build_array(
    jsonb_build_object('stepId', 'p1-s7', 'seq', 1, 'phaseIndex', 1, 'displayOrder', 1,
                       'origin', 'catalog', 'definition', null),
    jsonb_build_object('stepId', 'p1-s6', 'seq', 2, 'phaseIndex', 1, 'displayOrder', 2,
                       'origin', 'catalog', 'definition', null),
    jsonb_build_object('stepId', 'g0-notify', 'seq', 3, 'phaseIndex', 1, 'displayOrder', 3,
                       'origin', 'catalog', 'definition', null),
    jsonb_build_object('stepId', 'p1-s10', 'seq', 4, 'phaseIndex', 1, 'displayOrder', 4,
                       'origin', 'catalog', 'definition', null)
  )) ->> 'id')::uuid;
$$;

create function probe_error(p_statement text) returns text
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

create function probe_import(p_deal uuid, p_actor uuid, p_revision uuid) returns void
language sql as $$
  insert into deal_skill_imports (
    skill_id, deal_id, version_id, digest, name, capability_contract,
    imported_by, template_revision_id, source_asset_key
  ) values (
    gen_random_uuid(), p_deal, gen_random_uuid(), repeat('a', 64), 'Imported Memo',
    jsonb_build_object('purpose', 'p', 'expectedInput', 'i', 'expectedOutput', 'o'),
    p_actor, p_revision, 's0');
$$;

do $$
declare
  v_tenant uuid := '00000000-0000-4000-8000-00000000000b';
  v_bank   uuid;
  v_md     uuid;
  v_peer   uuid;
  v_deal   uuid;
  v_second uuid;
  v_source jsonb;
  v_before text;
  v_step   uuid;
  v_error  text;
begin
  v_bank := probe_bank(v_tenant, 'Probe Templates Bank');
  v_md := probe_user(v_tenant, v_bank, 'rt-md@example.com', 'director');
  v_peer := probe_user(v_tenant, v_bank, 'rt-peer@example.com', 'director');
  v_deal := probe_deal(v_tenant, v_bank, v_md, 'Probe Templates One');

  select id into v_step from deal_steps where deal_id = v_deal and step_id = 'p1-s11';
  perform rail_remove_step(v_deal, v_md, v_step, array[]::text[]);

  select id into v_step from deal_steps where deal_id = v_deal and step_id = 'p1-s10';
  insert into deal_step_skill_bindings (
    deal_step_id, deal_id, kind, skill_id, version_id, digest, bound_by, source
  ) values (v_step, v_deal, 'publication', gen_random_uuid(), gen_random_uuid(),
            repeat('a', 64), v_md, 'selection');

  v_source := rail_template_read_source(v_md, v_deal);
  if (v_source->>'companyId')::uuid is distinct from v_bank then
    raise exception 'FAIL: the source read must derive the bank company from the deal';
  end if;
  if jsonb_array_length(v_source->'steps') is distinct from 5 then
    raise exception 'FAIL: the source read must return removed rows alongside active ones, got %',
      jsonb_array_length(v_source->'steps');
  end if;
  if jsonb_array_length(v_source->'bindings') is distinct from 1 then
    raise exception 'FAIL: the source read must return the selected bindings';
  end if;
  if coalesce(v_source->>'sourceFingerprint', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'FAIL: the source fingerprint must be a sha256 hex digest, got %',
      v_source->>'sourceFingerprint';
  end if;
  if v_source::text like '%' || v_md::text || '%' then
    raise exception 'FAIL: the source read must not carry named people';
  end if;

  update deal_steps set status = 'complete', work = jsonb_build_object('note', 'done')
   where deal_id = v_deal and step_id = 'p1-s7';
  if rail_template_read_source(v_md, v_deal)->>'sourceFingerprint'
     is distinct from v_source->>'sourceFingerprint' then
    raise exception 'FAIL: runtime work and status must stay out of the source fingerprint';
  end if;

  v_error := probe_error(format('select rail_template_read_source(%L, %L)', v_peer, v_deal));
  if v_error is distinct from 'forbidden' then
    raise exception 'FAIL: reading a source deal must require access to it, got %', v_error;
  end if;

  v_second := probe_deal(v_tenant, v_bank, v_md, 'Probe Templates Two');
  v_before := rail_template_source_fingerprint(v_second);
  select id into v_step from deal_steps where deal_id = v_second and step_id = 'p1-s11';
  perform rail_remove_step(v_second, v_md, v_step, array[]::text[]);
  if rail_template_source_fingerprint(v_second) is not distinct from v_before then
    raise exception 'FAIL: removing a step must change the source fingerprint';
  end if;

  raise notice 'OK: the source read, its access check and the fingerprint';
end $$;

do $$
declare
  v_tenant    uuid := '00000000-0000-4000-8000-00000000000b';
  v_bank      uuid;
  v_other     uuid;
  v_md        uuid;
  v_outsider  uuid;
  v_deal      uuid;
  v_catalog   uuid;
  v_published jsonb;
  v_template  uuid;
  v_revision  uuid;
  v_unlinked  uuid;
  v_error     text;
  v_ok        boolean;
begin
  v_bank := probe_bank(v_tenant, 'Probe Access Bank');
  v_other := probe_bank(v_tenant, 'Probe Rival Bank');
  v_md := probe_user(v_tenant, v_bank, 'rt-access-md@example.com', 'director');
  v_outsider := probe_user(v_tenant, v_other, 'rt-access-rival@example.com', 'director');
  v_deal := probe_deal(v_tenant, v_bank, v_md, 'Probe Access One');

  v_catalog := probe_template(v_bank, v_md, 'Probe Access Rail');
  v_published := publish_rail_template(v_catalog, v_bank, v_md, probe_protected());
  v_template := (v_published ->> 'templateId')::uuid;
  v_revision := (v_published ->> 'revisionId')::uuid;

  if (select state from rail_template_revisions where id = v_revision) is distinct from 'ready'
     or (select current_revision_id from rail_templates where id = v_template) is distinct from v_revision then
    raise exception 'FAIL: a published version is ready and current';
  end if;

  v_error := probe_error(format(
    'update rail_template_revisions set description = %L where id = %L', 'Edited', v_revision));
  if v_error is distinct from 'revision_immutable' then
    raise exception 'FAIL: a published version never changes, got %', v_error;
  end if;

  insert into rail_templates (tenant_id, company_id, name, created_by)
    values (v_tenant, v_bank, 'Probe Unlinked Rail', v_md)
    returning id into v_unlinked;
  if (select normalized_name from rail_templates where id = v_unlinked)
     is distinct from 'probe unlinked rail' then
    raise exception 'FAIL: the template name must normalize whitespace and case, got %',
      (select normalized_name from rail_templates where id = v_unlinked);
  end if;
  if (select normalized_name from rail_templates where id = v_unlinked)
     is distinct from rail_template_normalized_name('  PROBE   unlinked RAIL ') then
    raise exception 'FAIL: the name normalizer must agree with the stored normalized name';
  end if;
  v_error := probe_error(format(
    'insert into rail_template_revisions (template_id, actor_id, request_id, request_digest, command, '
    || 'source_deal_id, source_fingerprint, manifest, state) '
    || 'values (%L, %L, gen_random_uuid(), repeat(''a'', 64), ''{}''::jsonb, %L, repeat(''b'', 64), '
    || '''{}''::jsonb, ''ready'')',
    v_unlinked, v_md, v_deal));
  if v_error is distinct from 'forbidden' then
    raise exception 'FAIL: a version saved from a deal can no longer be written, got %', v_error;
  end if;

  v_error := probe_error(format(
    'insert into rail_template_revisions (template_id, actor_id, request_id, request_digest, command, '
    || 'source_catalog_template_id, manifest, state) '
    || 'values (%L, %L, gen_random_uuid(), repeat(''a'', 64), ''{}''::jsonb, %L, ''{}''::jsonb, ''preparing'')',
    v_template, v_md, v_catalog));
  if v_error is distinct from 'forbidden' then
    raise exception 'FAIL: a version is written ready or not at all, got %', v_error;
  end if;

  v_error := probe_error(format(
    'insert into rail_template_revisions (template_id, actor_id, request_id, request_digest, command, '
    || 'source_catalog_template_id, manifest) '
    || 'values (%L, %L, gen_random_uuid(), repeat(''a'', 64), ''{}''::jsonb, %L, ''{}''::jsonb)',
    v_template, v_md, v_catalog));
  if v_error is not null then
    raise exception 'FAIL: a version written without a state is ready, got %', v_error;
  end if;

  perform probe_import(v_deal, v_md, v_revision);

  v_ok := false;
  begin
    update deal_skill_imports set name = 'Renamed' where deal_id = v_deal;
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'import_immutable';
  end;
  if not v_ok then
    raise exception 'FAIL: an imported skill record must be immutable';
  end if;

  v_ok := false;
  begin
    perform probe_import(probe_deal(v_tenant, v_other, v_outsider, 'Probe Rival One'), v_md, v_revision);
  exception when sqlstate 'P0001' then v_ok := sqlerrm = 'import_company_mismatch';
  end;
  if not v_ok then
    raise exception 'FAIL: an import must name a version from the destination deal bank';
  end if;

  v_ok := false;
  begin
    insert into deal_skill_imports (
      skill_id, deal_id, version_id, digest, name, capability_contract,
      imported_by, template_revision_id, source_asset_key
    ) values (
      gen_random_uuid(), v_deal, gen_random_uuid(), 'nothex', 'Imported Memo',
      jsonb_build_object('purpose', 'p'), v_md, v_revision, 's0'
    );
  exception when sqlstate '23514' then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL: an import must carry a real digest and a complete capability contract';
  end if;

  raise notice 'OK: versions are catalog-sourced, ready and immutable, and imports are guarded';
end $$;

do $$
declare
  v_tenant    uuid := '00000000-0000-4000-8000-00000000000b';
  v_bank      uuid;
  v_md        uuid;
  v_kept      uuid;
  v_published jsonb;
begin
  v_bank := probe_bank(v_tenant, 'Probe Retire Bank');
  v_md := probe_user(v_tenant, v_bank, 'rt-retire-md@example.com', 'director');
  v_kept := probe_template(v_bank, v_md, 'Probe Kept Rail');
  v_published := publish_rail_template(v_kept, v_bank, v_md, probe_protected());

  perform set_config('test.bank', v_bank::text, true);
  perform set_config('test.md', v_md::text, true);
  perform set_config('test.kept_template', v_published ->> 'templateId', true);
  perform set_config('test.kept_revision', v_published ->> 'revisionId', true);
  perform set_config('test.source',
    probe_deal(v_tenant, v_bank, v_md, 'Probe Retire Source')::text, true);
  perform set_config('test.built',
    probe_deal(v_tenant, v_bank, v_md, 'Probe Retire Built')::text, true);
end $$;

alter table rail_template_revisions disable trigger rail_template_revisions_admit;

do $$
declare
  v_tenant    uuid := '00000000-0000-4000-8000-00000000000b';
  v_bank      uuid := current_setting('test.bank')::uuid;
  v_md        uuid := current_setting('test.md')::uuid;
  v_source    uuid := current_setting('test.source')::uuid;
  v_built     uuid := current_setting('test.built')::uuid;
  v_old       uuid;
  v_ready     uuid := gen_random_uuid();
  v_abandoned uuid := gen_random_uuid();
begin
  insert into rail_templates (tenant_id, company_id, name, created_by)
    values (v_tenant, v_bank, 'Probe Old Rail', v_md)
    returning id into v_old;
  insert into rail_template_revisions (
    id, template_id, actor_id, request_id, request_digest, command,
    source_deal_id, source_fingerprint, manifest, state, version, provider_receipt
  ) values
    (v_ready, v_old, v_md, gen_random_uuid(), repeat('a', 64), '{}'::jsonb, v_source, repeat('b', 64),
     jsonb_build_object('schemaVersion', 1, 'censusVersion', 'probe-rail',
                        'steps', '[]'::jsonb, 'skills', '[]'::jsonb),
     'ready', 1, jsonb_build_object('revisionId', v_ready, 'assets', '[]'::jsonb)),
    (v_abandoned, v_old, v_md, gen_random_uuid(), repeat('a', 64), '{}'::jsonb, v_source, repeat('b', 64),
     '{}'::jsonb, 'preparing', 2, null);
  update rail_templates set current_revision_id = v_ready where id = v_old;
  update deals set rail_template_revision_id = v_ready, rail_template_name = 'Probe Old Rail'
   where id = v_built;
  perform probe_import(v_built, v_md, v_ready);

  perform set_config('test.old', v_old::text, true);
  perform set_config('test.ready', v_ready::text, true);
  perform set_config('test.abandoned', v_abandoned::text, true);
end $$;

alter table rail_template_revisions enable trigger rail_template_revisions_admit;

do $$
declare
  v_bank  uuid := current_setting('test.bank')::uuid;
  v_md    uuid := current_setting('test.md')::uuid;
  v_named uuid;
  v_error text;
begin
  v_named := probe_template(v_bank, v_md, 'Probe Old Rail');
  v_error := probe_error(format('select rail_catalog_publish_check(%L, %L, %L)',
    v_named, v_bank, probe_protected()));
  if v_error is distinct from 'name_taken' then
    raise exception 'FAIL: before it is retired an old template holds its name, got %', v_error;
  end if;
  v_error := probe_error(format(
    'update rail_template_revisions set state = %L where id = %L',
    'ready', current_setting('test.abandoned')::uuid));
  if v_error is distinct from 'revision_immutable' then
    raise exception 'FAIL: an abandoned version can no longer be made ready, got %', v_error;
  end if;
  perform set_config('test.named', v_named::text, true);
end $$;

set client_min_messages = warning;
\o /dev/null
\ir ../migrations/20261008100000_retire_old_saved_rails.sql
\o
reset client_min_messages;

do $$
declare
  v_old       uuid := current_setting('test.old')::uuid;
  v_ready     uuid := current_setting('test.ready')::uuid;
  v_abandoned uuid := current_setting('test.abandoned')::uuid;
  v_built     uuid := current_setting('test.built')::uuid;
  v_error     text;
begin
  if (select current_revision_id from rail_templates where id = v_old) is not null then
    raise exception 'FAIL: a template saved before the catalog is retired';
  end if;
  if (select count(*) from rail_template_revisions where template_id = v_old) is distinct from 2::bigint
     or (select state from rail_template_revisions where id = v_ready) is distinct from 'ready'
     or (select state from rail_template_revisions where id = v_abandoned) is distinct from 'preparing'
     or (select source_deal_id from rail_template_revisions where id = v_ready)
        is distinct from current_setting('test.source')::uuid
     or (select manifest ->> 'schemaVersion' from rail_template_revisions where id = v_ready)
        is distinct from '1' then
    raise exception 'FAIL: retiring a template leaves its versions as they were';
  end if;
  if (select rail_template_revision_id from deals where id = v_built) is distinct from v_ready
     or (select rail_template_name from deals where id = v_built) is distinct from 'Probe Old Rail'
     or (select count(*) from deal_skill_imports
          where deal_id = v_built and template_revision_id = v_ready) is distinct from 1::bigint then
    raise exception 'FAIL: a deal created from a retired template keeps its link and its imported skill';
  end if;
  if deal_template_changes(v_built, probe_protected()) is not null then
    raise exception 'FAIL: a deal on a retired template is offered nothing';
  end if;
  if (select current_revision_id from rail_templates
       where id = current_setting('test.kept_template')::uuid)
     is distinct from current_setting('test.kept_revision')::uuid then
    raise exception 'FAIL: a published catalog template keeps its current version';
  end if;

  v_error := probe_error(format(
    'update rail_templates set current_revision_id = %L where id = %L', v_abandoned, v_old));
  if v_error is distinct from 'revision_not_ready' then
    raise exception 'FAIL: a template never points at a version that is not ready, got %', v_error;
  end if;

  update rail_templates t
     set current_revision_id = (
       select r.id from rail_template_revisions r
        where r.template_id = t.id and r.state = 'ready'
        order by r.version desc limit 1)
   where t.id = v_old;
  if (select current_revision_id from rail_templates where id = v_old) is distinct from v_ready then
    raise exception 'FAIL: the retire is undone by pointing a template back at its highest ready version';
  end if;
end $$;

set client_min_messages = warning;
\o /dev/null
\ir ../migrations/20261008100000_retire_old_saved_rails.sql
\o
reset client_min_messages;

do $$
declare
  v_bank  uuid := current_setting('test.bank')::uuid;
  v_md    uuid := current_setting('test.md')::uuid;
  v_old       uuid := current_setting('test.old')::uuid;
  v_ready     uuid := current_setting('test.ready')::uuid;
  v_abandoned uuid := current_setting('test.abandoned')::uuid;
  v_built     uuid := current_setting('test.built')::uuid;
  v_error     text;
begin
  if (select current_revision_id from rail_templates where id = v_old) is not null then
    raise exception 'FAIL: applying the migration again retires a template that was pointed back';
  end if;
  if (select count(*) from rail_template_revisions where template_id = v_old) is distinct from 2::bigint
     or (select current_revision_id from rail_templates
          where id = current_setting('test.kept_template')::uuid)
        is distinct from current_setting('test.kept_revision')::uuid
     or (select state from rail_template_revisions where id = v_ready) is distinct from 'ready'
     or (select state from rail_template_revisions where id = v_abandoned) is distinct from 'preparing'
     or (select source_deal_id from rail_template_revisions where id = v_ready)
        is distinct from current_setting('test.source')::uuid
     or (select rail_template_revision_id from deals where id = v_built) is distinct from v_ready
     or (select rail_template_name from deals where id = v_built) is distinct from 'Probe Old Rail'
     or (select count(*) from deal_skill_imports
          where deal_id = v_built and template_revision_id = v_ready) is distinct from 1::bigint then
    raise exception 'FAIL: applying the migration again changes nothing else';
  end if;

  v_error := probe_error(format('select publish_rail_template(%L, %L, %L, %L)',
    current_setting('test.named')::uuid, v_bank, v_md, probe_protected()));
  if v_error is not null then
    raise exception 'FAIL: a retired template frees its name for a catalog template, got %', v_error;
  end if;

  raise notice 'OK: old templates are retired, their history stays, and the migration can run twice';
end $$;

rollback;

begin;

do $$
declare
  v_relation text;
  v_role     text;
begin
  foreach v_relation in array array['rail_templates', 'rail_template_revisions', 'deal_skill_imports']
  loop
    if not (select relrowsecurity from pg_class where oid = v_relation::regclass) then
      raise exception 'FAIL: % must enable row level security', v_relation;
    end if;
    foreach v_role in array array['anon', 'authenticated']
    loop
      if has_table_privilege(v_role, v_relation, 'select')
         or has_table_privilege(v_role, v_relation, 'insert')
         or has_table_privilege(v_role, v_relation, 'update')
         or has_table_privilege(v_role, v_relation, 'delete') then
        raise exception 'FAIL: % must carry no browser grants, % holds one', v_relation, v_role;
      end if;
    end loop;
    if not has_table_privilege('service_role', v_relation, 'select') then
      raise exception 'FAIL: service_role must read %', v_relation;
    end if;
  end loop;

  foreach v_role in array array['anon', 'authenticated']
  loop
    if has_function_privilege(v_role, 'rail_template_read_source(uuid, uuid)', 'execute') then
      raise exception 'FAIL: rail_template_read_source must not be executable by %', v_role;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'rail_template_read_source(uuid, uuid)', 'execute') then
    raise exception 'FAIL: service_role must execute rail_template_read_source';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'rail_template_admit_save', 'rail_template_finalize_save', 'rail_template_validate_manifest',
         'rail_template_admission', 'rail_template_command_digest', 'rail_template_summary',
         'rail_template_assert_structure')) then
    raise exception 'FAIL: the functions only the old save called must be gone';
  end if;

  raise notice 'OK: row level security, execute grants and the dropped functions';
end $$;

rollback;
