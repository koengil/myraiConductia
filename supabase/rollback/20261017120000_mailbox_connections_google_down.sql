-- Rollback for 20261017120000_mailbox_connections_google.sql (#490).
--
-- DESTRUCTIVE. It deletes every Google connection and every revoked
-- connection: they are stored credentials (or the record of one Google ended),
-- the pre-#490 table cannot hold them, and deletion applies to credentials.
-- Those bankers send from the platform address afterwards; a Google banker
-- connects again once the forward migration is back. Microsoft connections are
-- kept unchanged.
--
-- The audit action list goes back to the one in
-- 20261014160000_tenant_retention_policy.sql. It is restored NOT VALID, like
-- every definition of it, so mailbox.* rows already in the append-only
-- audit_log stay; only new writes of those actions are refused. Roll the
-- application back before applying this.

begin;

set local search_path = public;

-- Rows the pre-#490 table cannot hold. After this every remaining row is a
-- connected Microsoft row, so it holds tokens and passes the old CHECK.
delete from mailbox_connections where provider = 'google' or status = 'revoked';

-- 5. The state change functions.
drop function mailbox_sending_disconnect(uuid);
drop function mailbox_sending_mark_revoked(uuid, text);
drop function mailbox_sending_connect_google(uuid, text, text, text, text);

-- 3. The row checks, then the columns (the status CHECK goes with its column).
alter table mailbox_connections drop constraint mailbox_connections_google_sub_check;
alter table mailbox_connections drop constraint mailbox_connections_status_tokens_check;
alter table mailbox_connections drop constraint mailbox_connections_status_check;
alter table mailbox_connections
  drop column revoked_at,
  drop column status,
  drop column account_sub;

-- 2. Tokens are required again.
alter table mailbox_connections alter column tokens_encrypted set not null;

-- 1. Provider: microsoft only, under the same default name.
alter table mailbox_connections drop constraint mailbox_connections_provider_check;
alter table mailbox_connections add constraint mailbox_connections_provider_check
  check (provider in ('microsoft'));

-- 4. The previous audit action list, verbatim from 20261014160000_tenant_retention_policy.sql.
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
  'discovery.mailbox_retained'
])) not valid;

commit;
