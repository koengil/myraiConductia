-- supabase/migrations/20260721120000_conflicts_attestation.sql
-- Conflicts attestation gate (Seq 6 "Are we allowed to continue?"): a mandate
-- cannot be created without a recorded senior-partner conflicts approval. The
-- check itself runs off-platform today (deliberately human-led, per the
-- execution guide); the platform records the attestation — approver + date —
-- as first-class deal fields and as an append-only 'attest' audit row, so a
-- staleness policy (e.g. re-attest at activation) can be layered on later
-- without a data-model change. No expiry for now, but the date is recorded.
--
-- Idempotent: add column if not exists / drop-and-re-add CHECK; the RPC is
-- create-or-replace with the prior signature dropped first (single overload).

-- 1. Attestation record on the deal (who approved, when — never a bare boolean).
alter table deals add column if not exists conflicts_approved_by text;
alter table deals add column if not exists conflicts_approved_on date;

-- 2. Widen the audit action enum with 'attest' (template:
--    20260714160000_audit_action_create_notify.sql — drop-and-re-add CHECK).
--    2026-08-01 replay repair: the original 12-action list is violated by live
--    orchestration-spine rows ('screen','send','release'), so a validated
--    re-add aborts every replay mid-chain and leaves audit_log unconstrained.
--    The list here now matches the 20260731120000 superset; that migration
--    remains the source of truth for the final CHECK.
--    2026-09-14 replay repair: skill authoring/publication and rail work
--    (skill_authoring.*, skill_publication.*, rail.step_rebound) landed on
--    later migrations without ever widening this list, so a lived-in database
--    that already holds those rows fails this validated re-add too. `not
--    valid` here for the same reason as 20260612160000: the later, wider
--    migrations re-add the full, validated constraint.
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check
  check (action in (
    'view','download','upload','export','grant','revoke',
    'hold_placed','hold_lifted','create','notify','advance','attest',
    'screen','send','release',
    'invite_sent','invite_accepted','invite_revoked',
    'invite_domain_override','invite_challenge_issued','invite_challenge_rotated','invite_verification_succeeded','invite_verification_locked','mfa_enrolled','mfa_challenged'
  )) not valid;

-- ─────────────────────────────────────────────────────────────────────────────
-- Re-emit create_deal_gate0 (base = G16 / 20260716180000_deal_steps.sql) adding
-- p_conflicts: { approvedBy, approvedOn } — REQUIRED. The RPC is the atomic
-- gate: no deal row exists without the attestation, and the attestation is
-- audited in the same transaction as the create.
--
-- The new param changes the argument signature, so Postgres would otherwise ADD
-- an overload (leaving the old 13-arg version → ambiguous calls). Drop the
-- prior signature first so this stays the single create_deal_gate0.
-- ─────────────────────────────────────────────────────────────────────────────
drop function if exists create_deal_gate0(
  uuid, uuid, uuid, text, text, uuid, text, int, int, jsonb, jsonb, jsonb, text
);

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
  v_cco          record;
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

  -- 0. Conflicts attestation gate (Seq 6): without a recorded senior-partner
  --    approval, the deal must not exist. Validated again here (not just in
  --    the route) because the RPC is the single writer of deal rows.
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

  -- 1. Target dedupe / tenant-scoped id (G19).
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

  -- 2. Deal insert with code-collision retry; prefix from the distinctive word (G21).
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

  -- 5. Audit the deal creation. COMPLIANCE: code + code name only.
  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'create', v_deal,
            jsonb_build_object('code', v_code, 'codename', btrim(p_codename)));

  -- 5b. Audit the conflicts attestation in the same transaction — the entry
  --     that makes the gate defensible (approver, date, checklist).
  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'attest', v_deal,
            jsonb_build_object(
              'checklist', 'conflicts',
              'approved_by', v_approved_by,
              'approved_on', v_approved_on
            ));

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

  -- 7. Seed per-step state (G16). Pre-entry = skipped_entry (NOT complete), the
  --    entry step is current, the rest pending. Empty p_steps = skip (back-compat).
  for v_step in select * from jsonb_array_elements(p_steps)
  loop
    v_step_seq := (v_step->>'seq')::int;
    insert into deal_steps (deal_id, step_id, seq, status, census_version)
      values (
        v_deal,
        v_step->>'stepId',
        v_step_seq,
        case
          when v_step_seq = p_entry_step_seq then 'current'
          when v_step_seq < p_entry_step_seq then 'skipped_entry'
          else 'pending'
        end,
        p_census_version
      )
      on conflict (deal_id, step_id) do nothing;
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
      'conflictsApprovedBy', v_deal_row.conflicts_approved_by,
      'conflictsApprovedOn', v_deal_row.conflicts_approved_on,
      'createdAt', v_deal_row.created_at
    ),
    'memberships', coalesce(v_memberships, '[]'::jsonb),
    'notified', v_notified
  );
end;
$$;

grant execute on function create_deal_gate0(
  uuid, uuid, uuid, text, text, uuid, text, int, int, jsonb, jsonb, jsonb, text, jsonb
) to service_role;
