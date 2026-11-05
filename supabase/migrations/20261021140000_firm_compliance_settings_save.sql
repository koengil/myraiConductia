-- Firm compliance settings, hardened (Martín's review of PR #640 and PR #650; D105).
--
-- 20261020110000 is already applied to db-dev, so it stays as it was and this
-- file carries the changes:
--
-- 1. Ceilings: queued_from at most 90, sampled_from at most 80. Heat is
--    clamped to 0-100, so a threshold at 100 switched off sampling or queueing
--    of compliant mail. 90 matches the "90 to 100" example in Issue #94.
-- 2. firm_compliance_settings_save(): the one writer. It locks the firm's
--    settings, reads the previous values, upserts, and writes the audit row in
--    one transaction, so a change can never save without its audit row, and
--    two concurrent saves can never record a wrong "from".
-- 3. notifications_event_type_check gains compliance_settings_changed: the
--    firm's other CCOs and admins are told when the bar moves.
--
-- The defaults and this range are PROVISIONAL until counsel signs them off
-- (Issue #225, PL-13), which gates mail_channel in production.

-- ── 1. Ceilings ────────────────────────────────────────────────────────────
alter table firm_compliance_settings drop constraint if exists firm_compliance_settings_queued_from_ceiling;
alter table firm_compliance_settings add constraint firm_compliance_settings_queued_from_ceiling
  check (queued_from <= 90);
alter table firm_compliance_settings drop constraint if exists firm_compliance_settings_sampled_from_ceiling;
alter table firm_compliance_settings add constraint firm_compliance_settings_sampled_from_ceiling
  check (sampled_from <= 80);

-- ── 2. The one writer ──────────────────────────────────────────────────────
-- Returns the previous settings; a firm that never saved any was on the
-- shipped defaults, read from the table's own column defaults (a row inserted
-- with nothing but its keys), so the audit's "from" can never drift from them
-- (isDefault: true). The caller has already checked that p_actor is the firm's
-- CCO; only the service role can call this.
create or replace function firm_compliance_settings_save(
  p_tenant uuid,
  p_actor uuid,
  p_queued_from smallint,
  p_sampled_from smallint,
  p_unchecked_floor text,
  p_send_friction text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_before firm_compliance_settings%rowtype;
  v_was_default boolean;
  v_from jsonb;
  v_to jsonb;
begin
  -- Serialises saves per firm, including the first one, when there is no row to lock yet.
  perform pg_advisory_xact_lock(hashtextextended('firm_compliance_settings:' || p_tenant::text, 0));

  -- A firm on the shipped defaults gets a row of column defaults first, so "from" reads them.
  insert into firm_compliance_settings (tenant_id, updated_by) values (p_tenant, p_actor)
    on conflict (tenant_id) do nothing;
  v_was_default := found;
  select * into v_before from firm_compliance_settings where tenant_id = p_tenant;
  v_from := jsonb_build_object(
      'queuedFrom', v_before.queued_from,
      'sampledFrom', v_before.sampled_from,
      'uncheckedFloor', v_before.unchecked_floor,
      'sendFriction', v_before.send_friction)
    || case when v_was_default then jsonb_build_object('isDefault', true) else '{}'::jsonb end;
  v_to := jsonb_build_object(
    'queuedFrom', p_queued_from,
    'sampledFrom', p_sampled_from,
    'uncheckedFloor', p_unchecked_floor,
    'sendFriction', p_send_friction);

  insert into firm_compliance_settings
    (tenant_id, queued_from, sampled_from, unchecked_floor, send_friction, updated_by, updated_at)
  values (p_tenant, p_queued_from, p_sampled_from, p_unchecked_floor, p_send_friction, p_actor, now())
  on conflict (tenant_id) do update set
    queued_from = excluded.queued_from,
    sampled_from = excluded.sampled_from,
    unchecked_floor = excluded.unchecked_floor,
    send_friction = excluded.send_friction,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
  values (p_tenant, p_actor, 'user', 'update',
          jsonb_build_object('kind', 'compliance_settings', 'from', v_from, 'to', v_to));

  return v_from;
end;
$$;
revoke all on function firm_compliance_settings_save(uuid, uuid, smallint, smallint, text, text)
  from public, anon, authenticated;
grant execute on function firm_compliance_settings_save(uuid, uuid, smallint, smallint, text, text)
  to service_role;

-- ── 3. Notification type ───────────────────────────────────────────────────
-- The CHECK is restated whole; the newest restatement is the one in force.
alter table notifications drop constraint if exists notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check
  check (event_type in (
    'deal_created','compliance_hold','nda_pending','nda_signed',
    'phase_promoted','expense_approved','member_added',
    'step_assigned','step_completed',
    'access_requested','access_approved','access_denied',
    'mailbox_allowlist_drift',
    'mailbox_connected',
    'rail_template_updated',
    'ai_budget_threshold',
    'work_identity_replaced',
    'mail_queued_for_review',
    'compliance_settings_changed'
  ))
  not valid;
