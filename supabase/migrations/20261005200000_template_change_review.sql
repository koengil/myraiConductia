-- Template change review (sub-project 2): a deal built from a published
-- template revision is compared with the template's current revision, the
-- deal team decides each added or removed step, and a publish notifies the
-- internal members of every deal it offers changes to.

create table if not exists deal_template_change_decisions (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references deals (id) on delete cascade,
  step_key    text not null,
  kind        text not null check (kind in ('added', 'removed')),
  decision    text not null check (decision in ('accepted', 'discarded', 'reopened')),
  revision_id uuid not null references rail_template_revisions (id),
  actor_id    uuid not null references users (id),
  decided_at  timestamptz not null default clock_timestamp()
);

create index if not exists deal_template_change_decisions_latest_idx
  on deal_template_change_decisions (deal_id, step_key, kind, decided_at desc);

alter table deal_template_change_decisions enable row level security;
revoke all on deal_template_change_decisions from public, anon, authenticated, service_role;
grant select, insert on deal_template_change_decisions to service_role;

create unique index if not exists deal_steps_template_step_key_idx
  on deal_steps (deal_id, template_step_key) where template_step_key is not null;

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
    select distinct on (step_key) step_key, decision, revision_id
      from deal_template_change_decisions
     where deal_id = p_deal_id and kind = 'added'
     order by step_key, decided_at desc
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
    select distinct on (step_key) step_key, decision, revision_id
      from deal_template_change_decisions
     where deal_id = p_deal_id and kind = 'removed'
     order by step_key, decided_at desc
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

drop function if exists deal_template_change_decide(uuid, uuid, text, text, text[]);

create or replace function deal_template_change_decide(
  p_deal_id       uuid,
  p_actor_id      uuid,
  p_change_id     text,
  p_decision      text,
  p_revision_id   uuid,
  p_protected_ids text[]
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
  v_target   uuid;
  v_target_order int;
  v_new_order    int;
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

  if p_decision = 'accepted' and v_kind = 'added' then
    select step into v_step
      from jsonb_array_elements(v_current.manifest -> 'steps') as step
     where step ->> 'templateStepKey' = v_key;

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
    else
      v_catalog := v_step ->> 'catalogStepId';
      v_inserted := (rail_insert_step(
        p_deal_id,
        p_actor_id,
        (v_step ->> 'phaseIndex')::int,
        case when v_anchor is null then 'phase_start' else 'after' end,
        v_anchor,
        case when v_catalog is null then jsonb_build_object(
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
      'revisionId', v_current.id));

  return deal_template_changes(p_deal_id, p_protected_ids);
end;
$$;

revoke all on function deal_template_change_decide(uuid, uuid, text, text, uuid, text[]) from public, anon, authenticated;
grant execute on function deal_template_change_decide(uuid, uuid, text, text, uuid, text[]) to service_role;

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
  v_template uuid;
  v_revision uuid;
begin
  perform 1 from deals where id = p_deal_id for update;
  if not found then
    raise exception 'deal % not found', p_deal_id using errcode = 'P0001';
  end if;

  select * into v_latest from deal_template_change_decisions
   where deal_id = p_deal_id and step_key = v_key and kind = v_kind
   order by decided_at desc
   limit 1;
  if v_latest.id is null or v_latest.decision <> 'discarded' then
    raise exception 'not_reopenable' using errcode = 'P0001';
  end if;

  select t.id, coalesce(t.current_revision_id, v_latest.revision_id) into v_template, v_revision
    from rail_template_revisions r
    join rail_templates t on t.id = r.template_id
   where r.id = v_latest.revision_id;

  insert into deal_template_change_decisions (deal_id, step_key, kind, decision, revision_id, actor_id)
    values (p_deal_id, v_key, v_kind, 'reopened', v_revision, p_actor_id);

  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'update', p_deal_id, jsonb_build_object(
      'rail', 'template_change',
      'decision', 'reopened',
      'kind', v_kind,
      'stepKey', v_key,
      'templateId', v_template,
      'revisionId', v_revision));

  return jsonb_build_object('changeId', p_change_id, 'decision', 'reopened');
end;
$$;

revoke all on function deal_template_change_reopen(uuid, uuid, text) from public, anon, authenticated;
grant execute on function deal_template_change_reopen(uuid, uuid, text) to service_role;

alter table notifications drop constraint if exists notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check
  check (event_type in (
    'deal_created','compliance_hold','nda_pending','nda_signed',
    'phase_promoted','expense_approved','member_added',
    'step_assigned','step_completed',
    'access_requested','access_approved','access_denied',
    'mailbox_allowlist_drift',
    'mailbox_connected',
    'rail_template_updated'
  ))
  not valid;

create or replace function rail_template_notify_deals(
  p_revision_id   uuid,
  p_actor_id      uuid,
  p_protected_ids text[]
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_revision  rail_template_revisions;
  v_template  rail_templates;
  v_actor     text;
  v_deal      deals;
  v_recipient uuid;
  v_count     int := 0;
begin
  if not exists (select 1 from feature_flags where key = 'template_change_review' and enabled) then
    return 0;
  end if;

  select * into v_revision from rail_template_revisions where id = p_revision_id;
  if v_revision.id is null then
    return 0;
  end if;
  select * into v_template from rail_templates where id = v_revision.template_id;
  select coalesce(nullif(btrim(display_name), ''), nullif(btrim(full_name), ''), 'Banker')
    into v_actor from users where id = p_actor_id;

  for v_deal in
    select d.*
      from deals d
      join rail_template_revisions r on r.id = d.rail_template_revision_id
     where r.template_id = v_template.id
       and d.tenant_id = v_template.tenant_id
       and d.status <> 'closed'
     order by d.created_at, d.id
  loop
    if not exists (
      select 1
        from jsonb_array_elements(
               coalesce(deal_template_changes(v_deal.id, p_protected_ids) -> 'changes', '[]'::jsonb)) as change
       where change -> 'decision' = 'null'::jsonb
    ) then
      continue;
    end if;

    for v_recipient in
      select u.id
        from deal_memberships m
        join users u on u.id = m.user_id
       where m.deal_id = v_deal.id
         and u.is_external = false
         and u.tenant_id = v_deal.tenant_id
         and u.id is distinct from p_actor_id
       order by u.id
    loop
      insert into notifications (tenant_id, deal_id, recipient_id, event_type, payload)
        values (v_deal.tenant_id, v_deal.id, v_recipient, 'rail_template_updated',
                jsonb_build_object(
                  'code', v_deal.code,
                  'codename', v_deal.codename,
                  'templateId', v_template.id,
                  'templateName', v_template.name,
                  'version', v_revision.version,
                  'actor', v_actor,
                  'destinationLabel', v_deal.codename || ' · ' || v_template.name || ' v' || v_revision.version,
                  'href', '/projects/' || v_deal.code || '/rail?review=template'));
      insert into audit_log (actor_id, action, deal_id, detail)
        values (p_actor_id, 'notify', v_deal.id,
                jsonb_build_object('recipient', v_recipient, 'event', 'rail_template_updated'));
      v_count := v_count + 1;
    end loop;
  end loop;

  return v_count;
end;
$$;

revoke all on function rail_template_notify_deals(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function rail_template_notify_deals(uuid, uuid, text[]) to service_role;

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

  perform rail_template_notify_deals(v_revision.id, p_actor_id, p_protected_ids);

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
