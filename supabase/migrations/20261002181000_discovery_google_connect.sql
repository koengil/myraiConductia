-- supabase/migrations/20261002181000_discovery_google_connect.sql
-- Gmail reader (#259), phase 4, folded into #262's one-click opt-in.
-- There is no separate "Connect Gmail" step. mailbox_consent_grant() (#262,
-- 20261001130000) is the opt-in: it requires an MD or deal-team role on a deal of
-- the member's tenant, creates (or adopts, or archives and replaces) the mailbox
-- content_sources row on the provider whose registration admitted the address (a
-- Google-domain member gets a google source), and tells the firm's admins and its
-- CCO with the existing `mailbox_connected` notification. #259 adds only what a
-- Gmail member and the firm's admin still need after that:
--   1. discovery_google_mailbox_status(): the member's own Google source, for the
--      card's join-the-group instruction (group, domain, paused, group refusal).
--   2. discovery_set_mailbox_source_status(): the firm admin pauses and resumes
--      a Google mailbox source (R12, review after the fact), audited.
-- Every Google source reads full content (plan D2).

-- ── 1. One new audit action ────────────────────────────────────────────────
-- Pause and resume audit as discovery.mailbox_access_changed. The CHECK restates
-- develop's latest list (20261002100000_work_identity_onboarding.sql, #320, which
-- ends in the work-identity actions) plus that one value. mailbox_connected already stands in
-- notifications_event_type_check (20261001160000), so that CHECK is not touched.
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
  'rail.step_rebound', 'rail.template_created', 'rail.template_replaced', 'rail.template_applied',
  'discovery.candidate_proposed', 'discovery.candidate_promoted', 'discovery.correction',
  'discovery.milestone_extracted', 'discovery.stage_assessed', 'discovery.mailbox_consented',
  'discovery.mailbox_consent_withdrawn', 'discovery.mailbox_refused', 'discovery.allowlist_drift',
  'discovery.site_registered', 'discovery.site_unregistered', 'discovery.site_refused',
  'discovery.mailbox_source_archived', 'discovery.mailbox_sources_unified', 'profile_provisioned',
  'identity_provider_configured', 'identity_provider_removed', 'work_identity_released', 'work_identity_connected',
  'discovery.mailbox_access_changed'
])) not valid;

-- ── 2. What the profile card shows a Gmail member ──────────────────────────
-- Answers for auth.uid() only: the caller's own Google mailbox source, once they
-- have opted in (an allowed_mailboxes row: current seat and open consent). It
-- returns an address, the firm's ingest group and domain, and two flags, never
-- mail. Eligibility is not asked again: it is mailbox_consent_grant's rule, and a
-- source exists only after that grant.
--   connected         the caller owns a live (not archived) Google source for the
--                     address of their seat
--   paused            a firm admin paused that source
--   waitingForGroup   the guard's own dedup state (mailbox_guard_state, written by
--                     mailbox_guard_check on a provider_read) last refused this
--                     address not_in_provider_group: the member is not yet in the
--                     bank's ingest group. It clears on the first pass that reads.
-- A member who has not opted in, who has no Google mailbox, or whose source is
-- another's or archived gets { connected: false }.
create or replace function discovery_google_mailbox_status()
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_allowed record;
  v_reg google_reader_registrations;
  v_src content_sources;
begin
  if v_uid is null then
    raise exception 'not_available' using errcode = '42501';
  end if;
  select a.tenant_id, a.address into v_allowed from allowed_mailboxes a
   where a.user_id = v_uid and a.provider = 'google' limit 1;
  if not found then
    return jsonb_build_object('connected', false);
  end if;
  select * into v_src from content_sources cs
   where cs.tenant_id = v_allowed.tenant_id and cs.kind = 'mailbox' and cs.provider = 'google'
     and lower(cs.address) = v_allowed.address
     and cs.owner_user_id = v_uid and cs.archived_at is null;
  if not found then
    return jsonb_build_object('connected', false);
  end if;
  select * into v_reg from google_reader_registrations g
   where g.tenant_id = v_allowed.tenant_id and g.status = 'active';
  return jsonb_build_object(
    'connected', true,
    'address', v_allowed.address,
    'group', v_reg.allowlist_group,
    'domain', v_reg.workspace_domain,
    'paused', v_src.status = 'paused',
    'waitingForGroup', coalesce((select g.last_reason = 'not_in_provider_group' from mailbox_guard_state g
                                  where g.tenant_id = v_allowed.tenant_id and g.address = v_allowed.address), false));
end;
$$;

-- ── 3. Pause and resume, by the firm's admin ───────────────────────────────
-- The guard refuses a source that is not active (source_paused) and the worker
-- reads active sources only, so a paused source is never read. It is never
-- deleted: its items and provenance stay, and resuming reads on. Develop has no
-- other pause path, so this is the one, and it is Google-only. An archived
-- source (archived_at set, #262's orphan handling) is closed for good: it answers
-- like an unknown id, and resume can never reopen it.
create or replace function discovery_set_mailbox_source_status(p_source_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_src content_sources;
begin
  if v_uid is null then
    raise exception 'not_available' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('active', 'paused') then
    raise exception 'discovery_set_mailbox_source_status: status must be active or paused' using errcode = '22023';
  end if;
  select * into v_src from content_sources where id = p_source_id for update;
  -- One answer for "no such source", "another tenant's source", "an archived
  -- source", "not a Google mailbox" and "not the firm's admin": the caller learns
  -- nothing about which.
  if not found or v_src.kind <> 'mailbox' or v_src.provider <> 'google' or v_src.archived_at is not null
     or not app_is_firm_admin(v_src.tenant_id, v_uid) then
    raise exception 'not_available' using errcode = '42501';
  end if;

  if v_src.status is distinct from p_status then
    update content_sources set status = p_status where id = v_src.id;
    insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
    values (v_src.tenant_id, v_uid, 'user', 'discovery.mailbox_access_changed',
            jsonb_build_object('change', case when p_status = 'paused' then 'paused' else 'resumed' end,
                               'provider', v_src.provider, 'address', lower(v_src.address),
                               'sourceId', v_src.id));
  end if;
  return jsonb_build_object('id', v_src.id, 'status', p_status, 'changed', v_src.status is distinct from p_status);
end;
$$;

revoke all on function discovery_google_mailbox_status(), discovery_set_mailbox_source_status(uuid, text)
  from public, anon;
grant execute on function discovery_google_mailbox_status(), discovery_set_mailbox_source_status(uuid, text)
  to authenticated, service_role;
