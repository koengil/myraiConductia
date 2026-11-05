-- supabase/migrations/20260714170000_create_deal_gate0_rpc.sql
-- G5 (Issue #71, Epic: Gate 0 fixture → real): the single transactional Gate 0
-- create. One Postgres function performs, atomically (all-or-nothing):
--   1. target company dedupe on (tenant_id, lower(name))  — fixes the current
--      duplicate-target-on-every-POST bug;
--   2. deal insert with code-collision retry (minting moved into the function);
--   3. deal_parties(target);
--   4. creator MD seat + one seat per requested member;
--   5. notifications fan-out to every tenant CCO (payload carries the deal CODE
--      + code name + actor, NEVER the target company name — the mask holds);
--   6. audit_log rows: 'create' (deal), 'grant' (per seat), 'notify' (per recipient).
-- Plus the deal_memberships wall-breach trigger (v3 §5): research/trading users
-- cannot be granted a seat — enforced now that the wizard grants seats.
--
-- Idempotent: create-or-replace function + drop-and-re-add trigger.
--
-- Screening: screenMessage() is the TS rule pack (src/lib/compliance/screen.ts).
-- The route (G6) runs it over the generated notice text and passes the verdict
-- in as p_screening; the RPC stays pure-SQL and just records it in the payload.

-- ─────────────────────────────────────────────────────────────────────────────
-- WALL-BREACH TRIGGER (v3 §5): a research/trading user may never join a deal team.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function block_wall_breach_membership()
returns trigger language plpgsql as $$
declare
  v_dept text;
begin
  select department into v_dept from users where id = new.user_id;
  if v_dept in ('research','trading') then
    raise exception
      'wall breach: user % is in department "%" and cannot be granted a deal seat (v3 §5)',
      new.user_id, v_dept
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists deal_memberships_no_wall_breach on deal_memberships;
create trigger deal_memberships_no_wall_breach
  before insert or update on deal_memberships
  for each row execute function block_wall_breach_membership();

-- ─────────────────────────────────────────────────────────────────────────────
-- create_deal_gate0 — the transactional Gate 0 create.
-- ─────────────────────────────────────────────────────────────────────────────
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
  p_screening        jsonb  default '{}'::jsonb
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
  v_prefix       text;
  v_year         int := extract(year from now())::int;
  v_code         text;
  v_attempts     int := 0;
  v_constraint   text;
  v_cco          record;
  v_memberships  jsonb;
  v_notified     jsonb;
begin
  if coalesce(btrim(p_codename), '') = '' then
    raise exception 'codename is required' using errcode = 'P0001';
  end if;

  -- 1. Target dedupe: reuse an existing target in this tenant (case-insensitive),
  --    else create it. An explicit company id short-circuits the lookup.
  if p_target_company_id is not null then
    v_target := p_target_company_id;
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

  -- 2. Deal insert with code-collision retry. Codename collisions (the partial
  --    unique index) are NOT retried — they surface so the route can 409.
  v_prefix := rpad(upper(left(regexp_replace(p_codename, '[^a-zA-Z0-9]', '', 'g'), 5)), 5, 'X');
  loop
    v_attempts := v_attempts + 1;
    v_code := v_prefix || '-' || v_year || '-' || lpad((floor(random() * 900) + 100)::int::text, 3, '0');
    begin
      insert into deals (
        tenant_id, code, codename, bank_id, mandate_owner_id, status,
        entry_step_seq, current_step_seq, gate0_completed_at, codename_theme
      )
      values (
        p_tenant_id, v_code, btrim(p_codename), p_bank_id, p_actor_id, 'intake',
        p_entry_step_seq, p_entry_step_seq, now(), p_codename_theme
      )
      returning id into v_deal;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'deals_code_key' and v_attempts < 20 then
        continue; -- code collision: mint a new suffix and retry
      end if;
      raise;      -- codename collision (or exhausted retries): surface it
    end;
  end loop;

  -- 3. Target party.
  insert into deal_parties (deal_id, company_id, party_role)
    values (v_deal, v_target, 'target')
    on conflict (deal_id, company_id, party_role) do nothing;

  -- 4a. Creator MD seat.
  select id into v_md_role from roles where slug = 'md';
  if v_md_role is null then
    raise exception 'md role missing' using errcode = 'P0001';
  end if;
  insert into deal_memberships (deal_id, user_id, role_id, deal_role, phase, added_by)
    values (v_deal, p_actor_id, v_md_role, 'md', p_entry_phase, p_actor_id)
    on conflict (deal_id, user_id) do nothing;
  -- Only audit a 'grant' when a seat was actually created: FOUND is false when
  -- the insert hit the (deal_id, user_id) conflict and did nothing. audit_log is
  -- append-only/immutable (S0.3), so a false 'grant' here would be permanent.
  if found then
    insert into audit_log (actor_id, action, deal_id, detail)
      values (p_actor_id, 'grant', v_deal,
              jsonb_build_object('user', p_actor_id, 'deal_role', 'md'));
  end if;

  -- 4b. Requested member seats (the wall-breach trigger guards each insert).
  for v_member in select * from jsonb_array_elements(p_members)
  loop
    v_uid := (v_member->>'userId')::uuid;
    v_role_slug := coalesce(v_member->>'dealRole', 'deal_team');
    if v_uid is null or v_uid = p_actor_id then
      continue; -- skip empties and the creator (already the MD)
    end if;
    select id into v_role_id from roles where slug = v_role_slug;
    if v_role_id is null then
      raise exception 'invalid deal role "%"', v_role_slug using errcode = 'P0001';
    end if;
    insert into deal_memberships (deal_id, user_id, role_id, deal_role, phase, added_by)
      values (v_deal, v_uid, v_role_id, v_role_slug, p_entry_phase, p_actor_id)
      on conflict (deal_id, user_id) do nothing;
    -- Only audit a 'grant' when a seat was actually created: a duplicate userId
    -- in p_members (or one already seated) hits the conflict and does nothing,
    -- so FOUND is false and we must NOT append a false 'grant' to the immutable
    -- audit_log (S0.3).
    if found then
      insert into audit_log (actor_id, action, deal_id, detail)
        values (p_actor_id, 'grant', v_deal,
                jsonb_build_object('user', v_uid, 'deal_role', v_role_slug));
    end if;
  end loop;

  -- 5. Audit the deal creation itself. COMPLIANCE: code + code name only.
  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'create', v_deal,
            jsonb_build_object('code', v_code, 'codename', btrim(p_codename)));

  -- 6. Notify every tenant CCO. COMPLIANCE: payload NEVER carries the target name.
  select coalesce(display_name, full_name) into v_actor_name
    from users where id = p_actor_id;
  for v_cco in
    select id from users where tenant_id = p_tenant_id and firm_role = 'cco'
  loop
    insert into notifications (tenant_id, deal_id, recipient_id, event_type, payload)
      values (p_tenant_id, v_deal, v_cco.id, 'deal_created',
              jsonb_build_object(
                'code', v_code,
                'codename', btrim(p_codename),
                'actor', v_actor_name,
                'screening', p_screening
              ));
    insert into audit_log (actor_id, action, deal_id, detail)
      values (p_actor_id, 'notify', v_deal,
              jsonb_build_object('recipient', v_cco.id, 'event', 'deal_created'));
  end loop;

  -- Receipts.
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
      'createdAt', v_deal_row.created_at
    ),
    'memberships', coalesce(v_memberships, '[]'::jsonb),
    'notified', v_notified
  );
end;
$$;

grant execute on function create_deal_gate0(
  uuid, uuid, uuid, text, text, uuid, text, int, int, jsonb, jsonb
) to service_role;
