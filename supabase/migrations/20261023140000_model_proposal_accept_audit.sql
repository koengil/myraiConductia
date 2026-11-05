-- supabase/migrations/20261023140000_model_proposal_accept_audit.sql
-- G-02b (#173), slice 1a: the two audit actions of an accepted model proposal.
--
--   discovery.model_proposal_accept_requested   the source owner asked to accept a model-only proposal
--                                               (discovery_accept_model_proposal, 20261023140100)
--   discovery.model_proposal_accept_finished    the source's sync job finished one request, as the discovery worker
--                                               (discovery_finish_model_proposal_accept, slice 1b)
--
-- Both carry ids, step ids and counts only: never the deal key, its slug, a deal name or anything from the mail.
--
-- The CHECK is restated in full, as every widening does: 20261023130600_discovery_milestone_rules.sql's list (the
-- latest on develop: G-07 #753, which carries G-02a's two discovery.model_proposal_dismiss* actions and adds
-- discovery.milestone_detected and discovery.team_mailbox_milestones_detected) plus the two names above, nothing
-- dropped. A migration that merges ahead of this one and widens the CHECK again must be carried into this list before
-- merge (tests/audit-action-check-history.test.ts and tests/check-migration-check-lists.test.ts fail a drop).
-- NOT VALID, like the restatement before it: the list only grows, so every existing row already passes.
--
-- Reverse: restate 20261023130600's list (no audit row of either action may exist then).

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
  'mailbox.connected', 'mailbox.connect_refused', 'mailbox.disconnected', 'mailbox.approval_ended',
  'discovery.team_mailbox_connected', 'discovery.team_mailbox_checked', 'discovery.team_mailbox_member_added',
  'discovery.team_mailbox_member_removed', 'discovery.team_mailbox_disconnected',
  'discovery.tenant_approval_changed',
  'discovery.team_mailbox_proposal_started', 'discovery.team_mailbox_proposal_finished',
  'discovery.model_proposal_dismissed', 'discovery.model_proposal_dismissal_restored',
  'discovery.milestone_detected', 'discovery.team_mailbox_milestones_detected',
  'discovery.model_proposal_accept_requested', 'discovery.model_proposal_accept_finished'
])) not valid;
