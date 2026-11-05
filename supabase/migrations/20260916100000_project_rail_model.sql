-- The project-owned rail in one migration: the structure permission, the
-- project-owned columns, the structural write functions, and deal creation
-- seeding the new columns.

-- Adding and removing steps is a different authority from working one. The
-- existing company:deals:steps:{complete,assign,update_unassigned} all mean
-- "work this step"; none of them mean "change which steps this project has".

alter table company_permissions drop constraint company_permissions_key_check;

alter table company_permissions add constraint company_permissions_key_check check (key in (
  'company:directory:view_all',
  'company:invites:send',
  'company:roles:manage',
  'company:access:assign',
  'company:leads:view',
  'company:leads:create',
  'company:deals:create',
  'company:deals:add_members',
  'company:deals:steps:complete',
  'company:deals:steps:assign',
  'company:deals:steps:update_unassigned',
  'company:deals:steps:structure',
  'company:compliance:notify'
));

insert into company_permissions (key, label, description, category, sort_order) values
  ('company:deals:steps:structure', 'Add and remove deal steps',
    'Add a step to a deal''s rail, and remove or restore one.',
    'Deals', 75)
on conflict (key) do update set
  label = excluded.label,
  description = excluded.description,
  category = excluded.category,
  sort_order = excluded.sort_order;

-- The project-owned rail. deal_steps stops being a mirror of the static
-- catalogue and becomes the project's own structure: which steps it has, in
-- what phase, in what order, and which have left the active rail.
--
-- Structure is project-owned; presentation is not. A catalogue step's title,
-- description, layer, io and compliance still resolve from MVP_DEAL_RAIL by
-- (step_id, census_version). Only custom steps carry `definition`.
--
-- seq becomes nullable: a custom step has no canonical sequence. Catalogue
-- steps keep theirs as the legacy identifier that ?step=<seq> deep links and
-- DATAROOM_STEP_DEFS resolve against. It is no longer an ordering key.

alter table deal_steps
  add column if not exists phase_index      int,
  add column if not exists display_order    int,
  add column if not exists anchor_step_id   uuid references deal_steps (id),
  add column if not exists origin           text not null default 'catalog',
  add column if not exists definition       jsonb,
  add column if not exists removed_at       timestamptz,
  add column if not exists removed_by       uuid references users (id),
  add column if not exists skipped_at       timestamptz,
  add column if not exists skipped_by       uuid references users (id),
  add column if not exists skip_approver_id uuid references users (id),
  add column if not exists skip_reason      text;

alter table deal_steps alter column seq drop not null;

alter table deal_steps drop constraint if exists deal_steps_origin_check;
alter table deal_steps add constraint deal_steps_origin_check
  check (origin in ('catalog', 'custom'));

create index if not exists deal_steps_deal_active_order_idx
  on deal_steps (deal_id, display_order) where removed_at is null;

alter table deals
  add column if not exists current_deal_step_id uuid references deal_steps (id);

-- The structural rail writes. Each opens with a `for update` lock on the
-- deals row, which serialises structural writes per deal without any cross-deal
-- contention.

create or replace function rail_reselect_current(
  p_deal_id  uuid,
  p_actor_id uuid,
  p_from     deal_steps
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next uuid;
begin
  select id into v_next from deal_steps
    where deal_id = p_deal_id
      and removed_at is null
      and status in ('pending', 'current')
      and display_order > p_from.display_order
    order by display_order asc limit 1;

  if v_next is null then
    select id into v_next from deal_steps
      where deal_id = p_deal_id
        and removed_at is null
        and status in ('pending', 'current')
      order by display_order asc limit 1;
  end if;

  if v_next is not null then
    update deal_steps set status = 'current' where id = v_next;
  end if;

  update deals
     set current_deal_step_id = v_next,
         current_step_seq = coalesce(
           (select seq from deal_steps where id = v_next), current_step_seq)
   where id = p_deal_id;

  insert into audit_log (actor_id, action, deal_id, detail)
    select p_actor_id, 'advance', p_deal_id,
           jsonb_build_object('from', p_from.seq, 'to', next_step.seq,
                              'fromStepKey', p_from.step_id, 'toStepKey', next_step.step_id,
                              'fromTitle', p_from.definition->>'title',
                              'toTitle', next_step.definition->>'title')
      from (select 1) as one_row
      left join deal_steps as next_step on next_step.id = v_next;

  return v_next;
end;
$$;

revoke all on function rail_reselect_current(uuid, uuid, deal_steps) from public, anon, authenticated;
grant execute on function rail_reselect_current(uuid, uuid, deal_steps) to service_role;

create or replace function rail_remove_step(
  p_deal_id       uuid,
  p_actor_id      uuid,
  p_step_id       uuid,
  p_protected_ids text[] default array[]::text[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_step    deal_steps;
  v_current uuid;
  v_anchor  uuid;
begin
  perform 1 from deals where id = p_deal_id for update;
  if not found then
    raise exception 'deal % not found', p_deal_id using errcode = 'P0001';
  end if;

  select * into v_step from deal_steps where id = p_step_id and deal_id = p_deal_id;
  if v_step.id is null then
    raise exception 'step % not found on deal %', p_step_id, p_deal_id using errcode = 'P0001';
  end if;

  select current_deal_step_id into v_current from deals where id = p_deal_id;

  if v_step.removed_at is not null then
    return jsonb_build_object('currentStepId', v_current, 'removed', false);
  end if;

  if v_step.status = 'complete' then
    raise exception 'step_complete' using errcode = 'P0003';
  end if;

  if v_step.step_id = any (p_protected_ids) then
    raise exception 'step_protected' using errcode = 'P0004';
  end if;

  select id into v_anchor from deal_steps
    where deal_id = p_deal_id
      and removed_at is null
      and phase_index = v_step.phase_index
      and display_order < v_step.display_order
    order by display_order desc limit 1;

  update deal_steps
     set removed_at = now(), removed_by = p_actor_id, anchor_step_id = v_anchor
   where id = p_step_id;

  if v_current = p_step_id then
    v_current := rail_reselect_current(p_deal_id, p_actor_id, v_step);
  end if;

  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'update', p_deal_id,
            jsonb_build_object('rail', 'remove', 'stepId', p_step_id,
                               'stepKey', v_step.step_id, 'title', v_step.definition->>'title'));

  return jsonb_build_object('currentStepId', v_current, 'removed', true);
end;
$$;

revoke all on function rail_remove_step(uuid, uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function rail_remove_step(uuid, uuid, uuid, text[]) to service_role;

-- Restoration creates no second current position.
--
-- rail_remove_step preserves the removed row's own status, so a step removed
-- while it was current keeps status 'current' while reselection moves the
-- deal's position to another row. Restoring it must not bring that status
-- back as a second current step. If the deal still has a current position,
-- the restored row returns as 'pending'; if reselection left the deal with no
-- current position, the restored row takes it back.

create or replace function rail_restore_step(
  p_deal_id  uuid,
  p_actor_id uuid,
  p_step_id  uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_step    deal_steps;
  v_after   int;
  v_old     int;
  v_current uuid;
begin
  perform 1 from deals where id = p_deal_id for update;
  if not found then
    raise exception 'deal % not found', p_deal_id using errcode = 'P0001';
  end if;

  select * into v_step from deal_steps where id = p_step_id and deal_id = p_deal_id;
  if v_step.id is null then
    raise exception 'step % not found on deal %', p_step_id, p_deal_id using errcode = 'P0001';
  end if;

  select current_deal_step_id into v_current from deals where id = p_deal_id;
  if v_step.removed_at is null then
    return jsonb_build_object('restored', false);
  end if;

  v_old := v_step.display_order;

  update deal_steps set display_order = display_order - 1
    where deal_id = p_deal_id and display_order > v_old;

  select display_order into v_after from deal_steps
    where id = v_step.anchor_step_id and deal_id = p_deal_id and removed_at is null;

  if v_after is null then
    select coalesce(max(display_order), 0) into v_after from deal_steps
      where deal_id = p_deal_id and removed_at is null and phase_index <= v_step.phase_index;
  end if;

  update deal_steps set display_order = display_order + 1
    where deal_id = p_deal_id and display_order > v_after;

  update deal_steps
     set removed_at = null, removed_by = null, display_order = v_after + 1
   where id = p_step_id;

  if v_step.status = 'current' then
    if v_current is null then
      update deals
         set current_deal_step_id = p_step_id,
             current_step_seq = coalesce(v_step.seq, current_step_seq)
       where id = p_deal_id;

      insert into audit_log (actor_id, action, deal_id, detail)
        values (p_actor_id, 'advance', p_deal_id,
                jsonb_build_object('from', null::int, 'to', v_step.seq,
                                   'fromStepKey', null::text, 'toStepKey', v_step.step_id,
                                   'fromTitle', null::text, 'toTitle', v_step.definition->>'title'));
    elsif v_current <> p_step_id then
      update deal_steps set status = 'pending' where id = p_step_id;
    end if;
  end if;

  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'update', p_deal_id,
            jsonb_build_object('rail', 'restore', 'stepId', p_step_id,
                               'stepKey', v_step.step_id, 'title', v_step.definition->>'title'));

  return jsonb_build_object('restored', true);
end;
$$;

revoke all on function rail_restore_step(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function rail_restore_step(uuid, uuid, uuid) to service_role;

create or replace function rail_skip_step(
  p_deal_id     uuid,
  p_actor_id    uuid,
  p_step_id     uuid,
  p_approver_id uuid,
  p_reason      text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_step     deal_steps;
  v_current  uuid;
  v_approver text;
  v_role     text;
begin
  perform 1 from deals where id = p_deal_id for update;
  if not found then
    raise exception 'deal % not found', p_deal_id using errcode = 'P0001';
  end if;

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a skip reason is required' using errcode = 'P0001';
  end if;

  select * into v_step from deal_steps where id = p_step_id and deal_id = p_deal_id;
  if v_step.id is null or v_step.removed_at is not null then
    raise exception 'step % not available on deal %', p_step_id, p_deal_id using errcode = 'P0001';
  end if;
  if v_step.status = 'complete' then
    raise exception 'step_complete' using errcode = 'P0003';
  end if;

  -- The approver's name and deal role, not only the id: `work.skip` carries the
  -- text the readers render (skipOf in /api/v1/deals/{dealId}/step-records),
  -- in the shape develop's PATCH /steps { skip } writes.
  select coalesce(nullif(btrim(u.display_name), ''), nullif(btrim(u.full_name), ''), u.email),
         m.deal_role
    into v_approver, v_role
    from users u
    left join deal_memberships m on m.user_id = u.id and m.deal_id = p_deal_id
   where u.id = p_approver_id;

  update deal_steps
     set status = 'skipped', skipped_at = now(), skipped_by = p_actor_id,
         skip_approver_id = p_approver_id, skip_reason = btrim(p_reason),
         completed_by = p_actor_id, completed_at = now(), completion_note = btrim(p_reason),
         work = coalesce(work, '{}'::jsonb) || jsonb_build_object('skip', jsonb_build_object(
           'approver', coalesce(v_approver, ''), 'approverRole', coalesce(v_role, ''),
           'reason', btrim(p_reason),
           'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
   where id = p_step_id;

  select current_deal_step_id into v_current from deals where id = p_deal_id;
  if v_current = p_step_id then
    v_current := rail_reselect_current(p_deal_id, p_actor_id, v_step);
  end if;

  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'update', p_deal_id,
            jsonb_build_object('rail', 'skip', 'stepId', p_step_id,
                               'stepKey', v_step.step_id, 'title', v_step.definition->>'title',
                               'approver', p_approver_id, 'reason', btrim(p_reason)));

  return jsonb_build_object('currentStepId', v_current);
end;
$$;

revoke all on function rail_skip_step(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function rail_skip_step(uuid, uuid, uuid, uuid, text) to service_role;

-- create_deal_gate0 must seed the project-owned rail columns above on every
-- new deal, or new deals arrive with
-- phase_index, display_order and current_deal_step_id unset and the rail read
-- has nothing to order by. Re-declares the function from 20260907120000 with
-- the same signature (no drop needed): the step-seeding loop now writes
-- phase_index, display_order and origin, and the function sets
-- deals.current_deal_step_id to the row it marks 'current'. Everything else
-- is unchanged.

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

  if not exists (select 1 from gate0_notify_recipients(p_tenant_id, p_bank_id)) then
    raise exception 'no gate0 notify recipient' using errcode = 'P0001';
  end if;

  -- Bug bash Finding 14 (Sep 4): the actor must hold company:deals:create on
  -- the bank. Gated on the company_access_management flag like every sibling
  -- permission check in src/lib/api/v1/access.ts, and firm admins / the CCO
  -- short-circuit the same way they do there. Directors are access roots and
  -- resolve every key; members need a direct grant or a role.
  --
  -- Caller contract: app_company_effective_permissions binds its root source to
  -- auth.uid() / auth.role(); those are session GUCs, unchanged by SECURITY
  -- DEFINER. POST /api/v1/deals invokes this RPC through the service-role
  -- client, which is what makes directors resolve. A caller under a user JWT
  -- whose sub is not p_actor_id would be refused.
  if exists (select 1 from feature_flags where key = 'company_access_management' and enabled)
     and not exists (
       select 1 from users u
       where u.id = p_actor_id and u.firm_role in ('admin', 'cco')
     )
     and not exists (
       select 1
       from app_company_effective_permissions(p_actor_id, p_bank_id) ep
       where ep.permission_key = 'company:deals:create'
     )
  then
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
        tenant_id, code, codename, bank_id, mandate_owner_id, status,
        entry_step_seq, current_step_seq, gate0_completed_at, codename_theme,
        conflicts_approved_by, conflicts_approved_on
      )
      values (
        p_tenant_id, v_code, btrim(p_codename), p_bank_id, p_actor_id, 'intake',
        p_entry_step_seq, p_entry_step_seq, now(), p_codename_theme,
        v_approved_by, v_approved_on
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
    values (v_deal, p_actor_id, v_md_role, 'md', p_entry_phase, p_actor_id)
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
      values (v_deal, v_uid, v_role_id, v_role_slug, p_entry_phase, p_actor_id)
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

  -- COMPLIANCE: payload NEVER carries the target name.
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

-- The RPC takes p_actor_id from its caller, so it must never be reachable with
-- a user JWT through PostgREST. POST /api/v1/deals (service role) is the only
-- caller; the same lock-down gate0_notify_recipients already has.
revoke execute on function create_deal_gate0(uuid, uuid, uuid, text, text, uuid, text, int, int, jsonb, jsonb, jsonb, text, jsonb)
  from public, anon, authenticated;
