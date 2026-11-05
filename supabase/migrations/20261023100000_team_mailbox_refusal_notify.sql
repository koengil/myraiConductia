-- supabase/migrations/20261023100000_team_mailbox_refusal_notify.sql
-- #173 G-04: a Directory refusal of a team inbox tells the inbox's own firm.
--
-- Until now a refused team inbox told nobody: discovery_record_team_mailbox_check wrote the
-- discovery.team_mailbox_checked audit row and nothing else, so the CCO and the admin learned of
-- a refusal only by opening the Team inboxes card. Two changes:
--
-- 1. notifications_event_type_check gains team_mailbox_refused. The CHECK is restated whole with
--    the 19 values of 20261021140000_firm_compliance_settings_save.sql, not valid, as every
--    widening does.
-- 2. discovery_record_team_mailbox_check is restated whole from its only definition
--    (20261019130000_team_mailbox_check.sql). The one change is a notification insert inside the
--    existing change test, when the new status is refused. So it is sent once per state change:
--    entering refused (from pending, or from verified, the pin mismatch that becomes
--    identity_changed included) and a refused reason changing. A recheck that finds the same
--    refusal, a recovery to verified, a first verify and a transient directory_error send
--    nothing. The notice is written in the same transaction as the audit row, which stays the
--    record (no extra audit row per recipient).
--
-- Recipients: the active, internal admins and CCOs seated in the inbox's own firm company
-- (team_mailboxes.firm_company_id), never every company firm_company_ids() names, so another
-- bank company of the same tenant is not told. With nobody seated nobody is told, and the audit
-- row is the record (C25, no fallback principal).
--
-- Payload: {teamMailboxId, address, reason, href:'/discovery'}. The address is the one the team
-- connect notice already sends to the same people; the reason is one of the seven fixed check
-- codes, which the bell turns into a short phrase. Never mail, a subject, the Directory id or an
-- error text. The audit row is unchanged and still carries ids and fixed codes only.
--
-- create or replace keeps the owner and the grants (service_role only, 20261019130000), and the
-- signature is unchanged, so this file has no grant or revoke.
--
-- Reverse: restate the function from 20261019130000_team_mailbox_check.sql. The CHECK value
-- stays (rows already delivered hold it).

-- ── 1. Notification type ───────────────────────────────────────────────────
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
    'compliance_settings_changed',
    'team_mailbox_refused'
  ))
  not valid;

-- ── 2. Record the outcome, and tell the firm of a refusal ──────────────────
create or replace function discovery_record_team_mailbox_check(
  p_id                uuid,
  p_status            text,
  p_reason            text default null,
  p_directory_user_id text default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tm         team_mailboxes%rowtype;
  v_status     text := p_status;
  v_reason     text := p_reason;
  v_new_status text;
  v_new_reason text;
  v_changed    boolean;
begin
  if p_id is null or p_status is null or p_status not in ('verified', 'refused', 'error') then
    raise exception 'discovery_record_team_mailbox_check: bad arguments' using errcode = '22023';
  end if;
  if p_status = 'verified' then
    -- A Directory id is an opaque token. It is never an address, so one with an '@' is refused.
    if p_reason is not null or p_directory_user_id is null
       or length(p_directory_user_id) not between 1 and 128 or p_directory_user_id ~ '[@\s]' then
      raise exception 'discovery_record_team_mailbox_check: bad arguments' using errcode = '22023';
    end if;
  elsif p_status = 'refused' then
    if p_reason is null
       or p_reason not in ('group', 'alias', 'suspended', 'no_mailbox', 'not_found', 'identity_changed', 'directory_denied')
       or p_directory_user_id is not null then
      raise exception 'discovery_record_team_mailbox_check: bad arguments' using errcode = '22023';
    end if;
  else
    if p_reason is distinct from 'directory_error' or p_directory_user_id is not null then
      raise exception 'discovery_record_team_mailbox_check: bad arguments' using errcode = '22023';
    end if;
  end if;

  -- The registration's row lock orders this against Remove (which takes the same row after
  -- its advisory lock) and against another worker's record: whichever comes second sees
  -- the first's result.
  select * into v_tm from team_mailboxes where id = p_id for update;
  if not found or v_tm.disconnected_at is not null then
    return jsonb_build_object('recorded', false);
  end if;

  if v_status = 'verified' and v_tm.directory_user_id is not null
     and v_tm.directory_user_id <> p_directory_user_id then
    v_status := 'refused';
    v_reason := 'identity_changed';
  end if;

  if v_status = 'verified' then
    update team_mailboxes
       set check_status = 'verified', check_reason = null, checked_at = now(), verified_at = now(),
           directory_user_id = coalesce(directory_user_id, p_directory_user_id),
           last_check_error = null, last_check_error_at = null
     where id = v_tm.id
    returning check_status, check_reason into v_new_status, v_new_reason;
  elsif v_status = 'refused' then
    update team_mailboxes
       set check_status = 'refused', check_reason = v_reason, checked_at = now(),
           last_check_error = null, last_check_error_at = null
     where id = v_tm.id
    returning check_status, check_reason into v_new_status, v_new_reason;
  else
    update team_mailboxes
       set checked_at = now(), last_check_error = 'directory_error', last_check_error_at = now()
     where id = v_tm.id
    returning check_status, check_reason into v_new_status, v_new_reason;
  end if;

  -- A status or reason change is news; a repeat of the same answer is not. A transient
  -- error never changes either, so it is never audited here (it is on the row).
  v_changed := (v_tm.check_status, v_tm.check_reason) is distinct from (v_new_status, v_new_reason);
  if v_changed then
    insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
    values (v_tm.tenant_id, 'service', 'discovery-worker', 'discovery.team_mailbox_checked',
            jsonb_build_object('teamMailboxId', v_tm.id, 'status', v_new_status)
            || case when v_new_reason is null then '{}'::jsonb else jsonb_build_object('reason', v_new_reason) end);
    -- #173 G-04: entering refused, or a refused reason changing, tells the admins and CCOs of
    -- the inbox's own firm company, never every company firm_company_ids() names. A recovery
    -- to verified tells no one. With nobody seated nobody is told; the row above is the record.
    if v_new_status = 'refused' then
      insert into notifications (tenant_id, recipient_id, event_type, payload)
      select v_tm.tenant_id, u.id, 'team_mailbox_refused',
             jsonb_build_object('teamMailboxId', v_tm.id, 'address', v_tm.address,
                                'reason', v_new_reason, 'href', '/discovery')
      from users u
      where u.tenant_id = v_tm.tenant_id and u.status = 'active' and u.firm_role in ('admin', 'cco')
        and u.is_external = false
        and u.company_id = v_tm.firm_company_id;
    end if;
  end if;

  return jsonb_build_object('recorded', true, 'changed', v_changed, 'status', v_new_status, 'reason', v_new_reason);
end;
$$;
