-- Gmail send as the banker (#490), slice S1a: mailbox_connections learns about
-- Google, and the audit log learns the three sending mailbox actions.
--
-- One sending mailbox per user is kept (unique user_id); the row's provider
-- decides the send path. A Google connection stores only its refresh token
-- (same AES-256-GCM envelope and MAILBOX_TOKEN_KEY as Graph), the Google
-- account's stable id (account_sub, the id_token sub) and the scopes Google
-- actually granted. When Google ends the approval (any invalid_grant) the row
-- turns status = 'revoked' and its tokens are deleted, so sends refuse until
-- the banker reconnects or disconnects.
--
-- Nothing in src/ writes a Google row in this slice; the Microsoft callback's
-- upsert resets status, revoked_at and account_sub, so a Microsoft connect
-- over a Google row satisfies these checks.
--
-- 1. The provider CHECK, inline on the column since 20260730150000 and so
--    named by Postgres's default, is dropped by that name and redefined.
-- 2. tokens_encrypted may be null (a revoked connection holds no token).
-- 3. account_sub, status and revoked_at, with two row checks: a connected row
--    holds tokens and a revoked one holds none; a Google row names its account.
-- 4. audit_log_action_check restated in full from
--    20261014160000_tenant_retention_policy.sql (develop's latest list), plus
--    mailbox.connected, mailbox.disconnected, mailbox.approval_ended and
--    mailbox.connect_refused. Their detail is {provider} only, plus a fixed
--    refusal code for connect_refused: no address, no free text.
-- 5. One function per connection state change, each writing the change and
--    its audit row in one transaction, so neither lands without the other.
--    Security invoker, executable by service_role only. Connect refuses an
--    external user (a counterparty or adviser), or no user, with not_eligible:
--    sending from Gmail is for the bank's own people (owner decision 2026-10-19).
--
-- Rollback: supabase/rollback/20261017120000_mailbox_connections_google_down.sql.

-- ── 1. Provider: microsoft or google ──────────────────────────────────────
alter table mailbox_connections drop constraint mailbox_connections_provider_check;
alter table mailbox_connections add constraint mailbox_connections_provider_check
  check (provider in ('microsoft', 'google'));

-- ── 2. A revoked connection keeps no token ────────────────────────────────
alter table mailbox_connections alter column tokens_encrypted drop not null;

-- ── 3. Account, status and the row checks ─────────────────────────────────
alter table mailbox_connections
  add column account_sub text,
  add column status text not null default 'connected',
  add column revoked_at timestamptz;

alter table mailbox_connections add constraint mailbox_connections_status_check
  check (status in ('connected', 'revoked'));
alter table mailbox_connections add constraint mailbox_connections_status_tokens_check
  check ((status = 'connected') = (tokens_encrypted is not null));
alter table mailbox_connections add constraint mailbox_connections_google_sub_check
  check (provider <> 'google' or account_sub is not null);

-- ── 4. Four new audit actions ─────────────────────────────────────────────
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
  'discovery.mailbox_access_changed', 'discovery.exclusion_policy_changed', 'rail.template_published',
  'discovery.reader_pass_started', 'discovery.reader_pass_finished', 'discovery.mailbox_purged',
  'discovery.content_collected', 'discovery.group_removal_held', 'discovery.tenant_purged', 'discovery.retention_policy_set',
  'discovery.mailbox_retained',
  'mailbox.connected', 'mailbox.disconnected', 'mailbox.approval_ended', 'mailbox.connect_refused'
])) not valid;

-- ── 5. State changes with their audit rows ────────────────────────────────

-- Connect for sending stores a Google approval. The user's earlier row, of
-- either provider and any status, is deleted and a new one inserted, so the
-- row id names this one approval: the outbox binds a send-as-is token to it,
-- and a reconnect of the same address never replays an older screen.
create function mailbox_sending_connect_google(
  p_user uuid, p_email text, p_tokens_encrypted text, p_scopes text, p_account_sub text
) returns uuid language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  -- Sending from Gmail is for the bank's own people only (owner decision 2026-10-19): an external user
  -- (a counterparty or adviser invited into a deal), or no user at all, is refused before anything changes.
  if not exists (select 1 from users where id = p_user and is_external = false) then
    raise exception 'not_eligible' using errcode = '42501';
  end if;
  delete from mailbox_connections where user_id = p_user;
  insert into mailbox_connections (user_id, provider, email, tokens_encrypted, scopes, account_sub, status)
  values (p_user, 'google', p_email, p_tokens_encrypted, p_scopes, p_account_sub, 'connected')
  returning id into v_id;
  insert into audit_log (actor_id, action, detail)
  values (p_user, 'mailbox.connected', jsonb_build_object('provider', 'google'));
  return v_id;
end;
$$;
revoke all on function mailbox_sending_connect_google(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function mailbox_sending_connect_google(uuid, text, text, text, text) to service_role;

-- Google ended a connection's approval (invalid_grant). Conditional on the
-- token blob the failing send read, so a reconnect that landed meanwhile is
-- never wiped. True when the row was marked (and audited).
create function mailbox_sending_mark_revoked(p_connection uuid, p_read_blob text)
returns boolean language plpgsql set search_path = public, pg_temp as $$
declare
  v_user uuid;
begin
  update mailbox_connections
     set status = 'revoked', tokens_encrypted = null, revoked_at = now(), updated_at = now()
   where id = p_connection and provider = 'google' and tokens_encrypted = p_read_blob
  returning user_id into v_user;
  if v_user is null then
    return false;
  end if;
  insert into audit_log (actor_id, action, detail)
  values (v_user, 'mailbox.approval_ended', jsonb_build_object('provider', 'google'));
  return true;
end;
$$;
revoke all on function mailbox_sending_mark_revoked(uuid, text) from public, anon, authenticated;
grant execute on function mailbox_sending_mark_revoked(uuid, text) to service_role;

-- Disconnect deletes the user's sending connection and its stored approval.
-- A Google disconnect is audited; Graph connect and disconnect are not yet
-- (#490 T5). Returns the deleted row's provider, or null when there was none.
create function mailbox_sending_disconnect(p_user uuid)
returns text language plpgsql set search_path = public, pg_temp as $$
declare
  v_provider text;
begin
  delete from mailbox_connections where user_id = p_user
  returning provider into v_provider;
  if v_provider = 'google' then
    insert into audit_log (actor_id, action, detail)
    values (p_user, 'mailbox.disconnected', jsonb_build_object('provider', 'google'));
  end if;
  return v_provider;
end;
$$;
revoke all on function mailbox_sending_disconnect(uuid) from public, anon, authenticated;
grant execute on function mailbox_sending_disconnect(uuid) to service_role;
