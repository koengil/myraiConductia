-- Rail templates saved before the catalog (20260921100000) are retired: each
-- loses its current revision, the revision triggers refuse the old kind and
-- every update, and the functions only the old save called are dropped. No row
-- is deleted. Every statement here can run twice.
-- This file also holds the latest definition of rail_template_assert_manage,
-- rail_catalog_save_replay, save_rail_to_catalog, deal_template_changes and
-- deal_template_change_reopen. Change any of them from the copy here.

update rail_templates t
   set current_revision_id = null, updated_at = now()
 where t.current_revision_id is not null
   and not exists (
     select 1 from rail_catalog_templates c where c.rail_template_id = t.id);

alter table rail_template_revisions alter column state set default 'ready';

create or replace function rail_template_revision_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  raise exception 'revision_immutable' using errcode = 'P0001';
end;
$$;

revoke all on function rail_template_revision_guard() from public, anon, authenticated;

create or replace function rail_template_revision_admit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source_catalog_template_id is null or new.state is distinct from 'ready' then
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

drop function if exists rail_template_admit_save(uuid, uuid, jsonb, jsonb, text);
drop function if exists rail_template_finalize_save(uuid, uuid, jsonb);
drop function if exists rail_template_validate_manifest(jsonb, uuid);
drop function if exists rail_template_admission(rail_template_revisions);
drop function if exists rail_template_command_digest(jsonb);
drop function if exists rail_template_summary(rail_template_revisions);
drop function if exists rail_template_assert_structure(uuid, uuid);

create or replace function rail_template_assert_manage(p_actor_id uuid, p_company_id uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not app_has_company_permission(p_actor_id, p_company_id, 'company:rails:templates:manage') then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function rail_template_assert_manage(uuid, uuid) from public, anon, authenticated;
grant execute on function rail_template_assert_manage(uuid, uuid) to service_role;

drop function if exists rail_catalog_save_replay(uuid, uuid);

create or replace function rail_catalog_save_replay(
  p_actor_id   uuid,
  p_request_id uuid,
  p_deal_id    uuid default null
) returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select detail -> 'result'
    from audit_log
   where actor_id = p_actor_id
     and action in ('rail.template_created', 'rail.template_replaced')
     and detail ->> 'requestId' = p_request_id::text
     and (p_deal_id is null or deal_id = p_deal_id)
   order by ts desc
   limit 1;
$$;

revoke all on function rail_catalog_save_replay(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function rail_catalog_save_replay(uuid, uuid, uuid) to service_role;

create or replace function save_rail_to_catalog(
  p_actor_id           uuid,
  p_company_id         uuid,
  p_deal_id            uuid,
  p_request_id         uuid,
  p_target             jsonb,
  p_description        text,
  p_steps              jsonb,
  p_source_fingerprint text,
  p_protected_ids      text[],
  p_revision_id        uuid default null,
  p_receipt            jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind      text := p_target ->> 'kind';
  v_replay    jsonb;
  v_catalog   uuid;
  v_published jsonb;
  v_revision  rail_template_revisions;
  v_name      text;
  v_result    jsonb;
begin
  perform 1 from deals where id = p_deal_id for update;

  v_replay := rail_catalog_save_replay(p_actor_id, p_request_id, p_deal_id);
  if v_replay is not null then
    return v_replay;
  end if;

  if v_kind = 'replace' then
    perform 1 from rail_catalog_templates
     where rail_template_id = rail_template_uuid(p_target ->> 'templateId')
       and company_id = p_company_id and deleted_at is null
     for update;
  end if;

  perform rail_catalog_save_check(p_actor_id, p_company_id, p_deal_id, p_target, p_source_fingerprint);
  perform rail_catalog_validate_rail_steps(p_deal_id, p_steps, p_protected_ids);

  if v_kind = 'new' then
    begin
      v_catalog := (create_rail_template(
        p_company_id, p_actor_id, p_target ->> 'name', null,
        (select jsonb_agg(t.step || jsonb_build_object('displayOrder', t.ord) order by t.ord)
           from jsonb_array_elements(p_steps) with ordinality as t(step, ord)),
        p_description) ->> 'id')::uuid;
    exception
      when sqlstate 'P0002' then
        raise exception 'name_taken' using errcode = 'P0002';
      when sqlstate 'P0001' then
        raise exception 'invalid_command' using errcode = 'P0001';
    end;
  else
    select id into v_catalog from rail_catalog_templates
     where rail_template_id = rail_template_uuid(p_target ->> 'templateId')
       and company_id = p_company_id and deleted_at is null
     for update;
    begin
      perform rail_catalog_apply_rail(p_company_id, p_actor_id, v_catalog, p_steps);
      perform set_rail_template_description(p_company_id, p_actor_id, v_catalog, p_description);
    exception
      when sqlstate 'P0001' then
        raise exception 'invalid_command' using errcode = 'P0001';
    end;
  end if;

  update deal_steps s
     set template_step_key = step ->> 'stepId'
    from jsonb_array_elements(p_steps) step
   where s.deal_id = p_deal_id
     and s.id = rail_template_uuid(step ->> 'dealStepId');

  update deal_steps
     set template_step_key = step_id
   where deal_id = p_deal_id
     and origin = 'catalog'
     and removed_at is not null
     and template_step_key is null;

  begin
    v_published := publish_rail_template(
      v_catalog, p_company_id, p_actor_id, p_protected_ids, p_revision_id, p_receipt);
  exception when sqlstate 'P0002' then
    if sqlerrm = 'draft_changed' then
      raise exception 'source_changed' using errcode = 'P0001';
    end if;
    raise;
  end;

  select * into v_revision from rail_template_revisions
   where id = (v_published ->> 'revisionId')::uuid;
  select name into v_name from rail_templates where id = v_revision.template_id;

  update deals
     set rail_template_revision_id = v_revision.id,
         rail_template_name = v_name
   where id = p_deal_id;

  v_result := jsonb_build_object(
    'id', v_revision.template_id,
    'revisionId', v_revision.id,
    'name', v_name,
    'description', v_revision.description,
    'stepCount', v_published -> 'stepCount',
    'skillCount', v_published -> 'skillCount',
    'version', v_published -> 'version',
    'updatedAt', to_char(v_revision.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));

  insert into audit_log (actor_id, action, deal_id, detail)
  values (
    p_actor_id,
    case when v_kind = 'new' then 'rail.template_created' else 'rail.template_replaced' end,
    p_deal_id,
    jsonb_strip_nulls(jsonb_build_object(
      'requestId', p_request_id,
      'catalogTemplateId', v_catalog,
      'templateId', v_revision.template_id,
      'revisionId', v_revision.id,
      'previousRevisionId', v_revision.expected_revision_id,
      'companyId', p_company_id,
      'stepCount', v_published -> 'stepCount',
      'skillCount', v_published -> 'skillCount',
      'version', v_published -> 'version',
      'result', v_result)));

  return v_result;
end;
$$;

revoke all on function save_rail_to_catalog(uuid, uuid, uuid, uuid, jsonb, text, jsonb, text, text[], uuid, jsonb)
  from public, anon, authenticated;
grant execute on function save_rail_to_catalog(uuid, uuid, uuid, uuid, jsonb, text, jsonb, text, text[], uuid, jsonb)
  to service_role;

create or replace function deal_template_changes(p_deal_id uuid, p_protected_ids text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_deal     deals;
  v_base     rail_template_revisions;
  v_current  rail_template_revisions;
  v_template rail_templates;
  v_keys     text[];
  v_added    jsonb;
  v_removed  jsonb;
begin
  select * into v_deal from deals where id = p_deal_id;
  if v_deal.id is null or v_deal.rail_template_revision_id is null then
    return null;
  end if;

  select * into v_base from rail_template_revisions where id = v_deal.rail_template_revision_id;
  select * into v_template from rail_templates where id = v_base.template_id;
  if v_template.current_revision_id is null or v_template.current_revision_id = v_base.id then
    return null;
  end if;

  select * into v_current from rail_template_revisions where id = v_template.current_revision_id;
  if coalesce((v_current.manifest ->> 'schemaVersion')::int, 1) < 2 then
    return null;
  end if;

  if not exists (
    select 1 from deal_steps where deal_id = p_deal_id and template_step_key is not null
  ) then
    return null;
  end if;

  select coalesce(array_agg(step ->> 'templateStepKey'), array[]::text[]) into v_keys
    from jsonb_array_elements(v_current.manifest -> 'steps') as step
   where step ->> 'templateStepKey' is not null;

  with latest as (
    select step ->> 'templateStepKey' as step_key,
           step,
           (step ->> 'phaseIndex')::int as phase_index,
           (step ->> 'displayOrder')::int as display_order
      from jsonb_array_elements(v_current.manifest -> 'steps') as step
     where step ->> 'templateStepKey' is not null
  ),
  decided as (
    select distinct on (x.step_key) x.step_key, x.decision, x.revision_id
      from deal_template_change_decisions x
      join rail_template_revisions r on r.id = x.revision_id
     where x.deal_id = p_deal_id and x.kind = 'added'
       and r.template_id = v_template.id
     order by x.step_key, x.decided_at desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', 'added:' || l.step_key,
           'kind', 'added',
           'title', l.step -> 'definition' ->> 'title',
           'summary', l.step -> 'definition' ->> 'description',
           'phaseIndex', l.phase_index,
           'anchor', (
             select jsonb_build_object('position', 'after', 'stepId', s.step_id)
               from latest p
               join deal_steps s
                 on s.deal_id = p_deal_id
                and s.template_step_key = p.step_key
                and s.removed_at is null
              where p.phase_index = l.phase_index
                and p.display_order < l.display_order
              order by p.display_order desc
              limit 1),
           'decision', case
             when d.revision_id = v_current.id and d.decision = 'accepted' then 'accepted'
             when d.decision = 'discarded' then 'discarded'
           end
         ) order by l.display_order), '[]'::jsonb)
    into v_added
    from latest l
    left join decided d on d.step_key = l.step_key
   where (d.revision_id = v_current.id and d.decision = 'accepted')
      or not exists (
           select 1 from deal_steps s
            where s.deal_id = p_deal_id
              and s.template_step_key = l.step_key
              and (s.removed_at is null or s.removed_by is not null));

  with decided as (
    select distinct on (x.step_key) x.step_key, x.decision, x.revision_id
      from deal_template_change_decisions x
      join rail_template_revisions r on r.id = x.revision_id
     where x.deal_id = p_deal_id and x.kind = 'removed'
       and r.template_id = v_template.id
     order by x.step_key, x.decided_at desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', 'removed:' || s.template_step_key,
           'kind', 'removed',
           'stepId', s.step_id,
           'title', s.definition ->> 'title',
           'phaseIndex', s.phase_index,
           'decision', case
             when d.revision_id = v_current.id and d.decision = 'accepted' then 'accepted'
             when d.decision = 'discarded' then 'discarded'
           end
         ) order by s.display_order), '[]'::jsonb)
    into v_removed
    from deal_steps s
    left join decided d on d.step_key = s.template_step_key
   where s.deal_id = p_deal_id
     and s.template_step_key is not null
     and not (s.template_step_key = any (v_keys))
     and ((d.revision_id = v_current.id and d.decision = 'accepted')
          or (s.removed_at is null
              and s.status <> 'complete'
              and not (s.step_id = any (coalesce(p_protected_ids, array[]::text[])))));

  return jsonb_build_object(
    'template', jsonb_build_object('id', v_template.id, 'name', v_template.name),
    'baseRevision', jsonb_build_object(
      'id', v_base.id,
      'label', 'v' || v_base.version,
      'savedAt', to_char(v_base.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'currentRevision', jsonb_build_object(
      'id', v_current.id,
      'label', 'v' || v_current.version,
      'savedAt', to_char(v_current.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'savedBy', (
        select jsonb_build_object('id', u.id, 'name', coalesce(
                 nullif(btrim(u.display_name), ''), nullif(btrim(u.full_name), ''), u.email, 'Banker'))
          from users u where u.id = v_current.actor_id)),
    'changes', v_added || v_removed
  );
end;
$$;

revoke all on function deal_template_changes(uuid, text[]) from public, anon, authenticated;
grant execute on function deal_template_changes(uuid, text[]) to service_role;

create or replace function deal_template_change_reopen(
  p_deal_id   uuid,
  p_actor_id  uuid,
  p_change_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind     text := split_part(p_change_id, ':', 1);
  v_key      text := substr(p_change_id, strpos(p_change_id, ':') + 1);
  v_latest   deal_template_change_decisions;
  v_template rail_templates;
  v_revision uuid;
begin
  perform 1 from deals where id = p_deal_id for update;
  if not found then
    raise exception 'deal % not found', p_deal_id using errcode = 'P0001';
  end if;

  select t.* into v_template
    from deals d
    join rail_template_revisions r on r.id = d.rail_template_revision_id
    join rail_templates t on t.id = r.template_id
   where d.id = p_deal_id;

  select x.* into v_latest
    from deal_template_change_decisions x
    join rail_template_revisions r on r.id = x.revision_id
   where x.deal_id = p_deal_id and x.step_key = v_key and x.kind = v_kind
     and r.template_id = v_template.id
   order by x.decided_at desc
   limit 1;
  if v_latest.id is null or v_latest.decision <> 'discarded' then
    raise exception 'not_reopenable' using errcode = 'P0001';
  end if;

  v_revision := coalesce(v_template.current_revision_id, v_latest.revision_id);

  insert into deal_template_change_decisions (deal_id, step_key, kind, decision, revision_id, actor_id)
    values (p_deal_id, v_key, v_kind, 'reopened', v_revision, p_actor_id);

  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'update', p_deal_id, jsonb_build_object(
      'rail', 'template_change',
      'decision', 'reopened',
      'kind', v_kind,
      'stepKey', v_key,
      'templateId', v_template.id,
      'revisionId', v_revision));

  return jsonb_build_object('changeId', p_change_id, 'decision', 'reopened');
end;
$$;

revoke all on function deal_template_change_reopen(uuid, uuid, text) from public, anon, authenticated;
grant execute on function deal_template_change_reopen(uuid, uuid, text) to service_role;
