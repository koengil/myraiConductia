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
  'rail.step_rebound', 'rail.template_created', 'rail.template_replaced', 'rail.template_applied'
])) not valid;

alter table deal_step_skill_bindings drop constraint if exists deal_step_skill_bindings_source_check;
alter table deal_step_skill_bindings add constraint deal_step_skill_bindings_source_check
  check (source in ('publication', 'selection', 'template'));

alter table deals
  add column if not exists rail_template_revision_id uuid references rail_template_revisions (id),
  add column if not exists rail_template_name        text;

create table if not exists rail_template_creations (
  request_id       uuid primary key,
  actor_id         uuid not null references users (id),
  tenant_id        uuid not null,
  company_id       uuid not null references companies (id),
  revision_id      uuid not null references rail_template_revisions (id),
  reserved_deal_id uuid not null unique,
  request_digest   text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  input            jsonb not null,
  step_ids         jsonb not null,
  targets          jsonb not null,
  state            text not null default 'preparing' check (state in ('preparing', 'ready')),
  receipt          jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists rail_template_creations_revision_idx
  on rail_template_creations (revision_id);

alter table rail_template_creations enable row level security;

revoke all on rail_template_creations from public, anon, authenticated;
grant select, insert, update on rail_template_creations to service_role;

create or replace function rail_template_gate0_step_ids() returns text[]
language sql immutable as $$
  select array['p1-s7', 'p1-s6', 'g0-notify'];
$$;

revoke all on function rail_template_gate0_step_ids() from public, anon, authenticated;
grant execute on function rail_template_gate0_step_ids() to service_role;

create or replace function app_can_create_deals(p_actor_id uuid, p_company_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from feature_flags where key = 'company_access_management' and enabled)
      or exists (select 1 from users u where u.id = p_actor_id and u.firm_role in ('admin', 'cco'))
      or exists (
           select 1 from app_company_effective_permissions(p_actor_id, p_company_id) ep
            where ep.permission_key = 'company:deals:create');
$$;

revoke all on function app_can_create_deals(uuid, uuid) from public, anon, authenticated;
grant execute on function app_can_create_deals(uuid, uuid) to service_role;

create or replace function rail_template_assert_create(p_actor_id uuid, p_company_id uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (
    select 1 from users u
     where u.id = p_actor_id and u.is_external = false and u.status = 'active'
  ) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  if not app_can_create_deals(p_actor_id, p_company_id) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function rail_template_assert_create(uuid, uuid) from public, anon, authenticated;
grant execute on function rail_template_assert_create(uuid, uuid) to service_role;

create or replace function rail_template_creation_digest(p_selection jsonb, p_input jsonb)
returns text language sql immutable as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'templateId', lower(coalesce(p_selection ->> 'templateId', '')),
    'revisionId', lower(coalesce(p_selection ->> 'revisionId', '')),
    'tenantId', lower(coalesce(p_input ->> 'tenantId', '')),
    'actorId', lower(coalesce(p_input ->> 'actorId', '')),
    'bankId', lower(coalesce(p_input ->> 'bankId', '')),
    'codename', btrim(coalesce(p_input ->> 'codename', '')),
    'targetName', btrim(coalesce(p_input ->> 'targetName', '')),
    'targetCompanyId', lower(coalesce(p_input ->> 'targetCompanyId', '')),
    'codenameTheme', btrim(coalesce(p_input ->> 'codenameTheme', '')),
    'members', coalesce((
      select jsonb_agg(jsonb_build_array(lower(coalesce(m ->> 'userId', '')),
                                         coalesce(m ->> 'dealRole', ''))
                       order by lower(coalesce(m ->> 'userId', '')))
        from jsonb_array_elements(coalesce(p_input -> 'members', '[]'::jsonb)) m), '[]'::jsonb),
    'approvedBy', btrim(coalesce(p_input -> 'conflicts' ->> 'approvedBy', '')),
    'approvedOn', coalesce(p_input -> 'conflicts' ->> 'approvedOn', '')
  )::text, 'UTF8')), 'hex');
$$;

revoke all on function rail_template_creation_digest(jsonb, jsonb) from public, anon, authenticated;
grant execute on function rail_template_creation_digest(jsonb, jsonb) to service_role;

create or replace function rail_template_creation_admission(p_creation rail_template_creations)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'requestId', p_creation.request_id,
    'actorId', p_creation.actor_id,
    'companyId', p_creation.company_id,
    'dealId', p_creation.reserved_deal_id,
    'revisionId', p_creation.revision_id,
    'manifest', r.manifest,
    'input', p_creation.input,
    'stepIds', p_creation.step_ids,
    'targets', p_creation.targets,
    'state', p_creation.state,
    'receipt', p_creation.receipt
  )
  from rail_template_revisions r where r.id = p_creation.revision_id;
$$;

revoke all on function rail_template_creation_admission(rail_template_creations)
  from public, anon, authenticated;
grant execute on function rail_template_creation_admission(rail_template_creations) to service_role;

create or replace function rail_template_expected_seed(
  p_manifest jsonb, p_step_ids jsonb, p_bindings jsonb
) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(step ->> 'displayOrder', jsonb_build_object(
    'id', p_step_ids ->> (step ->> 'key'),
    'stepId', coalesce(step ->> 'catalogStepId',
                       'custom:' || coalesce(p_step_ids ->> (step ->> 'key'), '')),
    'origin', case when step ->> 'catalogStepId' is not null then 'catalog' else 'custom' end,
    'seq', coalesce(step -> 'seq', 'null'::jsonb),
    'phaseIndex', step -> 'phaseIndex',
    'displayOrder', step -> 'displayOrder',
    'definition', case
      when step ->> 'catalogStepId' is not null then 'null'::jsonb
      when jsonb_typeof(step -> 'definition') <> 'object' then 'null'::jsonb
      when step -> 'definition' ? 'type' then (step -> 'definition')
        || jsonb_build_object('skillBinding', p_bindings -> (step ->> 'skillKey'))
      else jsonb_build_object('title', step -> 'definition' -> 'title',
                              'description', step -> 'definition' -> 'description') end,
    'binding', case when step ->> 'skillKey' is null then 'null'::jsonb
                    else p_bindings -> (step ->> 'skillKey') end
  )), '{}'::jsonb)
  from jsonb_array_elements(p_manifest -> 'steps') step;
$$;

revoke all on function rail_template_expected_seed(jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function rail_template_expected_seed(jsonb, jsonb, jsonb) to service_role;

create or replace function rail_template_validate_seed(
  p_manifest jsonb, p_seed jsonb, p_step_ids jsonb, p_bindings jsonb
) returns void
language plpgsql immutable as $$
declare v_expected jsonb;
begin
  if jsonb_typeof(p_seed) <> 'array'
     or jsonb_array_length(p_seed) <> jsonb_array_length(p_manifest -> 'steps')
     or exists (
          select 1 from jsonb_array_elements(p_seed) seed_row
           where jsonb_typeof(seed_row) <> 'object'
              or jsonb_typeof(seed_row -> 'displayOrder') <> 'number') then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  v_expected := rail_template_expected_seed(p_manifest, p_step_ids, p_bindings);

  if (select count(distinct seed_row ->> 'displayOrder') from jsonb_array_elements(p_seed) seed_row)
     <> jsonb_array_length(p_seed)
     or exists (
          select 1 from jsonb_array_elements(p_seed) seed_row
           where v_expected -> (seed_row ->> 'displayOrder') is distinct from seed_row) then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function rail_template_validate_seed(jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function rail_template_validate_seed(jsonb, jsonb, jsonb, jsonb) to service_role;

create or replace function create_deal_gate0_core(
  p_tenant_id        uuid,
  p_actor_id         uuid,
  p_bank_id          uuid,
  p_codename         text,
  p_target_name      text,
  p_target_company_id uuid,
  p_codename_theme   text,
  p_entry_step_seq   int,
  p_entry_phase      int,
  p_members          jsonb,
  p_screening        jsonb,
  p_steps            jsonb,
  p_census_version   text,
  p_conflicts        jsonb,
  p_reserved_deal_id uuid,
  p_template_seed    jsonb,
  p_template_revision_id uuid,
  p_template_name    text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target       uuid;
  v_deal         uuid;
  v_deal_row     deals;
  v_md_role      uuid;
  v_member       jsonb;
  v_uid          uuid;
  v_role_slug    text;
  v_role_id      uuid;
  v_actor_name   text;
  v_distinctive  text;
  v_prefix       text;
  v_year         int := extract(year from now())::int;
  v_code         text;
  v_attempts     int := 0;
  v_constraint   text;
  v_recipient    record;
  v_step         jsonb;
  v_step_seq     int;
  v_memberships  jsonb;
  v_notified     jsonb;
  v_approved_by  text;
  v_approved_on  date;
  v_gate0_step_ids text[] := array['p1-s7', 'p1-s6', 'g0-notify'];
  v_entry_step_id  text;
  v_entry_row      jsonb;
  v_entry_seq      int := p_entry_step_seq;
  v_entry_phase    int := p_entry_phase;
  v_current_step   uuid;
begin
  if coalesce(btrim(p_codename), '') = '' then
    raise exception 'codename is required' using errcode = 'P0001';
  end if;

  v_approved_by := btrim(coalesce(p_conflicts->>'approvedBy', ''));
  if v_approved_by = '' then
    raise exception 'conflicts approval is required' using errcode = 'P0001';
  end if;
  begin
    v_approved_on := (p_conflicts->>'approvedOn')::date;
  exception when others then
    v_approved_on := null;
  end;
  if v_approved_on is null then
    raise exception 'conflicts approval date is required' using errcode = 'P0001';
  end if;

  if p_template_seed is not null then
    if jsonb_typeof(p_template_seed) <> 'array' or jsonb_array_length(p_template_seed) = 0 then
      raise exception 'template_seed_invalid' using errcode = 'P0001';
    end if;

    select value->>'stepId' into v_entry_step_id
    from jsonb_array_elements(p_template_seed)
    where not (value->>'stepId' = any(v_gate0_step_ids))
    order by (value->>'displayOrder')::int
    limit 1;
    if v_entry_step_id is null then
      raise exception 'template_has_no_execution_step' using errcode='P0001';
    end if;

    select value into v_entry_row from jsonb_array_elements(p_template_seed)
     where value->>'stepId' = v_entry_step_id limit 1;
    v_entry_phase := coalesce((v_entry_row->>'phaseIndex')::int, p_entry_phase);
    v_entry_seq := coalesce((v_entry_row->>'seq')::int, (
      select (value->>'seq')::int from jsonb_array_elements(p_template_seed)
       where not (value->>'stepId' = any(v_gate0_step_ids)) and value->>'seq' is not null
       order by (value->>'displayOrder')::int limit 1), p_entry_step_seq);
  end if;

  if not exists (select 1 from gate0_notify_recipients(p_tenant_id, p_bank_id)) then
    raise exception 'no gate0 notify recipient' using errcode = 'P0001';
  end if;

  if not app_can_create_deals(p_actor_id, p_bank_id) then
    raise exception 'not permitted to create deals' using errcode = 'P0001';
  end if;

  if p_target_company_id is not null then
    select id into v_target
      from companies
      where id = p_target_company_id
        and tenant_id = p_tenant_id;
    if v_target is null then
      raise exception 'target company % is not in tenant %', p_target_company_id, p_tenant_id
        using errcode = 'P0001';
    end if;
  else
    if coalesce(btrim(p_target_name), '') = '' then
      raise exception 'targetName or targetCompanyId is required' using errcode = 'P0001';
    end if;
    select id into v_target
      from companies
      where tenant_id = p_tenant_id
        and type = 'target'
        and lower(name) = lower(btrim(p_target_name))
      limit 1;
    if v_target is null then
      insert into companies (tenant_id, name, type)
        values (p_tenant_id, btrim(p_target_name), 'target')
        returning id into v_target;
    end if;
  end if;

  v_distinctive := regexp_replace(btrim(p_codename), '^\s*project\s+', '', 'i');
  if coalesce(btrim(v_distinctive), '') = '' then
    v_distinctive := btrim(p_codename);
  end if;
  v_prefix := rpad(upper(left(regexp_replace(v_distinctive, '[^a-zA-Z0-9]', '', 'g'), 5)), 5, 'X');
  loop
    v_attempts := v_attempts + 1;
    v_code := v_prefix || '-' || v_year || '-' || lpad((floor(random() * 900) + 100)::int::text, 3, '0');
    begin
      insert into deals (
        id, tenant_id, code, codename, bank_id, mandate_owner_id, status,
        entry_step_seq, current_step_seq, gate0_completed_at, codename_theme,
        conflicts_approved_by, conflicts_approved_on,
        rail_template_revision_id, rail_template_name
      )
      values (
        coalesce(p_reserved_deal_id, gen_random_uuid()),
        p_tenant_id, v_code, btrim(p_codename), p_bank_id, p_actor_id, 'intake',
        v_entry_seq, v_entry_seq, now(), p_codename_theme,
        v_approved_by, v_approved_on,
        p_template_revision_id, p_template_name
      )
      returning id into v_deal;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'deals_code_key' and v_attempts < 20 then
        continue;
      end if;
      raise;
    end;
  end loop;

  insert into deal_parties (deal_id, company_id, party_role)
    values (v_deal, v_target, 'target')
    on conflict (deal_id, company_id, party_role) do nothing;

  select id into v_md_role from roles where slug = 'md';
  if v_md_role is null then
    raise exception 'md role missing' using errcode = 'P0001';
  end if;
  insert into deal_memberships (deal_id, user_id, role_id, deal_role, phase, added_by)
    values (v_deal, p_actor_id, v_md_role, 'md', v_entry_phase, p_actor_id)
    on conflict (deal_id, user_id) do nothing;
  if found then
    insert into audit_log (actor_id, action, deal_id, detail)
      values (p_actor_id, 'grant', v_deal,
              jsonb_build_object('user', p_actor_id, 'deal_role', 'md'));
  end if;

  for v_member in select * from jsonb_array_elements(p_members)
  loop
    v_uid := (v_member->>'userId')::uuid;
    v_role_slug := coalesce(v_member->>'dealRole', 'deal_team');
    if v_uid is null or v_uid = p_actor_id then
      continue;
    end if;
    select id into v_role_id from roles where slug = v_role_slug;
    if v_role_id is null then
      raise exception 'invalid deal role "%"', v_role_slug using errcode = 'P0001';
    end if;
    insert into deal_memberships (deal_id, user_id, role_id, deal_role, phase, added_by)
      values (v_deal, v_uid, v_role_id, v_role_slug, v_entry_phase, p_actor_id)
      on conflict (deal_id, user_id) do nothing;
    if found then
      insert into audit_log (actor_id, action, deal_id, detail)
        values (p_actor_id, 'grant', v_deal,
                jsonb_build_object('user', v_uid, 'deal_role', v_role_slug));
    end if;
  end loop;

  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'create', v_deal,
            jsonb_build_object('code', v_code, 'codename', btrim(p_codename)));

  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'attest', v_deal,
            jsonb_build_object(
              'checklist', 'conflicts',
              'approved_by', v_approved_by,
              'approved_on', v_approved_on
            ));

  select coalesce(display_name, full_name) into v_actor_name
    from users where id = p_actor_id;
  for v_recipient in
    select user_id as id from gate0_notify_recipients(p_tenant_id, p_bank_id)
  loop
    insert into notifications (tenant_id, deal_id, recipient_id, event_type, payload)
      values (p_tenant_id, v_deal, v_recipient.id, 'deal_created',
              jsonb_build_object(
                'code', v_code,
                'codename', btrim(p_codename),
                'actor', v_actor_name,
                'screening', p_screening
              ));
    insert into audit_log (actor_id, action, deal_id, detail)
      values (p_actor_id, 'notify', v_deal,
              jsonb_build_object('recipient', v_recipient.id, 'event', 'deal_created'));
  end loop;

  if p_template_seed is null then
    for v_step in select * from jsonb_array_elements(p_steps)
    loop
      v_step_seq := (v_step->>'seq')::int;
      insert into deal_steps (
        deal_id, step_id, seq, status, census_version, phase_index, display_order, origin
      )
        values (
          v_deal,
          v_step->>'stepId',
          v_step_seq,
          case
            when v_step_seq = p_entry_step_seq then 'current'
            when v_step_seq < p_entry_step_seq then 'skipped_entry'
            else 'pending'
          end,
          p_census_version,
          (v_step->>'phaseIndex')::int,
          coalesce((v_step->>'displayOrder')::int, v_step_seq),
          'catalog'
        )
        on conflict (deal_id, step_id) do nothing;
    end loop;

    update deals set current_deal_step_id = (
      select id from deal_steps
      where deal_id = v_deal and status = 'current'
      order by display_order limit 1
    ) where id = v_deal;
  else
    for v_step in select * from jsonb_array_elements(p_template_seed)
    loop
      insert into deal_steps (
        id, deal_id, step_id, seq, status, census_version,
        phase_index, display_order, origin, definition
      )
        values (
          (v_step->>'id')::uuid,
          v_deal,
          v_step->>'stepId',
          (v_step->>'seq')::int,
          case
            when v_step->>'stepId' = v_entry_step_id then 'current'
            when v_step->>'stepId' = any(v_gate0_step_ids) then 'skipped_entry'
            else 'pending'
          end,
          case when v_step->>'origin' = 'custom' then null else p_census_version end,
          (v_step->>'phaseIndex')::int,
          (v_step->>'displayOrder')::int,
          coalesce(v_step->>'origin', 'catalog'),
          case when jsonb_typeof(v_step->'definition') = 'object' then v_step->'definition' end
        );
    end loop;

    select (value->>'id')::uuid into v_current_step from jsonb_array_elements(p_template_seed)
     where value->>'stepId' = v_entry_step_id limit 1;
    update deals set current_deal_step_id = v_current_step where id = v_deal;
  end if;

  select * into v_deal_row from deals where id = v_deal;
  select jsonb_agg(jsonb_build_object('userId', user_id, 'dealRole', deal_role) order by access_granted_at)
    into v_memberships from deal_memberships where deal_id = v_deal;
  select coalesce(jsonb_agg(jsonb_build_object('userId', recipient_id, 'at', created_at)), '[]'::jsonb)
    into v_notified from notifications where deal_id = v_deal and event_type = 'deal_created';

  return jsonb_build_object(
    'deal', jsonb_build_object(
      'id', v_deal_row.id,
      'code', v_deal_row.code,
      'codename', v_deal_row.codename,
      'status', v_deal_row.status,
      'entryStepSeq', v_deal_row.entry_step_seq,
      'currentStepSeq', v_deal_row.current_step_seq,
      'conflictsApprovedBy', v_deal_row.conflicts_approved_by,
      'conflictsApprovedOn', v_deal_row.conflicts_approved_on,
      'createdAt', v_deal_row.created_at
    ),
    'memberships', coalesce(v_memberships, '[]'::jsonb),
    'notified', v_notified
  );
end;
$$;

revoke execute on function create_deal_gate0_core(
  uuid, uuid, uuid, text, text, uuid, text, int, int, jsonb, jsonb, jsonb, text, jsonb,
  uuid, jsonb, uuid, text
) from public, anon, authenticated;
grant execute on function create_deal_gate0_core(
  uuid, uuid, uuid, text, text, uuid, text, int, int, jsonb, jsonb, jsonb, text, jsonb,
  uuid, jsonb, uuid, text
) to service_role;

create or replace function create_deal_gate0(
  p_tenant_id        uuid,
  p_actor_id         uuid,
  p_bank_id          uuid,
  p_codename         text,
  p_target_name      text,
  p_target_company_id uuid  default null,
  p_codename_theme   text   default null,
  p_entry_step_seq   int    default 1,
  p_entry_phase      int    default 0,
  p_members          jsonb  default '[]'::jsonb,
  p_screening        jsonb  default '{}'::jsonb,
  p_steps            jsonb  default '[]'::jsonb,
  p_census_version   text   default null,
  p_conflicts        jsonb  default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return create_deal_gate0_core(
    p_tenant_id, p_actor_id, p_bank_id, p_codename, p_target_name, p_target_company_id,
    p_codename_theme, p_entry_step_seq, p_entry_phase, p_members, p_screening, p_steps,
    p_census_version, p_conflicts, null, null, null, null
  );
end;
$$;

revoke execute on function create_deal_gate0(uuid, uuid, uuid, text, text, uuid, text, int, int, jsonb, jsonb, jsonb, text, jsonb)
  from public, anon, authenticated;

create or replace function rail_template_admit_creation(
  p_actor_id uuid, p_request_id uuid, p_selection jsonb, p_input jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_existing  rail_template_creations;
  v_creation  rail_template_creations;
  v_template  uuid;
  v_revision  uuid;
  v_current   uuid;
  v_company   uuid;
  v_tenant    uuid;
  v_bank      uuid;
  v_manifest  jsonb;
  v_digest    text;
  v_step_ids  jsonb;
  v_targets   jsonb;
begin
  v_template := rail_template_uuid(p_selection ->> 'templateId');
  v_revision := rail_template_uuid(p_selection ->> 'revisionId');
  v_tenant := rail_template_uuid(p_input ->> 'tenantId');
  v_bank := rail_template_uuid(p_input ->> 'bankId');

  if v_template is null or v_revision is null or v_tenant is null or v_bank is null
     or jsonb_typeof(p_input) <> 'object'
     or rail_template_uuid(p_input ->> 'actorId') is distinct from p_actor_id
     or coalesce(btrim(p_input ->> 'codename'), '') = ''
     or coalesce(btrim(p_input -> 'conflicts' ->> 'approvedBy'), '') = ''
     or coalesce(p_input -> 'conflicts' ->> 'approvedOn', '') = ''
     or jsonb_typeof(coalesce(p_input -> 'members', '[]'::jsonb)) <> 'array' then
    raise exception 'invalid_command' using errcode = 'P0001';
  end if;

  v_digest := rail_template_creation_digest(p_selection, p_input);

  select * into v_existing from rail_template_creations
   where request_id = p_request_id for update;
  if found then
    if v_existing.actor_id <> p_actor_id or v_existing.request_digest <> v_digest then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    return rail_template_creation_admission(v_existing);
  end if;

  select company_id, current_revision_id into v_company, v_current
    from rail_templates where id = v_template for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_company is distinct from v_bank then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  perform rail_template_assert_create(p_actor_id, v_company);
  if v_current is distinct from v_revision then
    raise exception 'stale_template' using errcode = 'P0001';
  end if;

  select manifest into v_manifest from rail_template_revisions
   where id = v_revision and template_id = v_template and state = 'ready';
  if v_manifest is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  select jsonb_object_agg(step ->> 'key', gen_random_uuid()) into v_step_ids
    from jsonb_array_elements(v_manifest -> 'steps') step;
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', skill ->> 'key',
    'operationId', gen_random_uuid(),
    'skillId', gen_random_uuid(),
    'versionId', gen_random_uuid())), '[]'::jsonb) into v_targets
    from jsonb_array_elements(v_manifest -> 'skills') skill;

  begin
    insert into rail_template_creations (
      request_id, actor_id, tenant_id, company_id, revision_id, reserved_deal_id,
      request_digest, input, step_ids, targets
    ) values (
      p_request_id, p_actor_id, v_tenant, v_company, v_revision, gen_random_uuid(),
      v_digest, p_input, coalesce(v_step_ids, '{}'::jsonb), v_targets
    ) returning * into v_creation;
  exception when unique_violation then
    select * into v_existing from rail_template_creations where request_id = p_request_id;
    if not found or v_existing.actor_id <> p_actor_id or v_existing.request_digest <> v_digest then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    return rail_template_creation_admission(v_existing);
  end;

  return rail_template_creation_admission(v_creation);
end;
$$;

revoke all on function rail_template_admit_creation(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function rail_template_admit_creation(uuid, uuid, jsonb, jsonb) to service_role;

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
