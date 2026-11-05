// Audit-log action constants. Mirror the audit_log.action CHECK enum, whose
// source of truth is the migration chain:
//   20260604100000_permissions_schema.sql  — base actions
//   20260629120000_legal_hold.sql          — hold_placed / hold_lifted
//   20260714160000_audit_action_create_notify.sql — create / notify (Gate 0)
//   20260715180000_audit_action_advance.sql        — advance (rail progress)
//   20260721120000_conflicts_attestation.sql       — attest (conflicts gate)
//   20260731120000_onboarding_invites.sql          — screen / send / release
//     (legacy orchestration-spine actions found in live audit rows, folded
//     into the CHECK there) + invite_sent / invite_accepted / invite_revoked
//   20260804160000_invite_safeguard_2fa.sql         — invite recipient
//     safeguards + platform MFA completion
//   20260814190000_company_access_management.sql     — update
//   20260921100000_rail_templates.sql                 — rail.template_created /
//     rail.template_replaced
//   20260921110000_create_deal_from_template.sql      — rail.template_applied
//   20260925100000_audit_hash_chain.sql               — discovery.* (below)
//   20261002100000_work_identity_onboarding.sql       — profile_provisioned,
//     identity_provider_configured / _removed, work_identity_released /
//     _connected
//   20261017120000_mailbox_connections_google.sql     — mailbox.connected /
//     .disconnected / .approval_ended / .connect_refused (#490)

export const AUDIT_ACTION = {
  VIEW: 'view',
  DOWNLOAD: 'download',
  UPLOAD: 'upload',
  EXPORT: 'export',
  GRANT: 'grant',
  REVOKE: 'revoke',
  UPDATE: 'update',
  HOLD_PLACED: 'hold_placed',
  HOLD_LIFTED: 'hold_lifted',
  CREATE: 'create',
  NOTIFY: 'notify',
  ADVANCE: 'advance',
  ATTEST: 'attest',
  SCREEN: 'screen',
  SEND: 'send',
  RELEASE: 'release',
  INVITE_SENT: 'invite_sent',
  INVITE_ACCEPTED: 'invite_accepted',
  INVITE_REVOKED: 'invite_revoked',
  INVITE_DOMAIN_OVERRIDE: 'invite_domain_override',
  INVITE_CHALLENGE_ISSUED: 'invite_challenge_issued',
  INVITE_CHALLENGE_ROTATED: 'invite_challenge_rotated',
  INVITE_VERIFICATION_SUCCEEDED: 'invite_verification_succeeded',
  INVITE_VERIFICATION_LOCKED: 'invite_verification_locked',
  MFA_ENROLLED: 'mfa_enrolled',
  MFA_CHALLENGED: 'mfa_challenged',
  /** Supervisor reject of a held outbound message (compliance email channel, PR #122). */
  REJECT: 'reject',
  /** MD assigned a rail step to a deal-team member. */
  ASSIGN_STEP: 'assign_step',
  /** Assignee or MD marked a rail step complete. */
  COMPLETE_STEP: 'complete_step',
  /** Manual step work saved (field keys only in detail). */
  STEP_WORK: 'step_work',
  /** A deal's rail saved as a new firm rail template (written by SQL). */
  RAIL_TEMPLATE_CREATED: 'rail.template_created',
  /** A deal's rail saved over an existing rail template (written by SQL). */
  RAIL_TEMPLATE_REPLACED: 'rail.template_replaced',
  /** A deal created from a saved rail template (written by SQL). */
  RAIL_TEMPLATE_APPLIED: 'rail.template_applied',
  RAIL_TEMPLATE_PUBLISHED: 'rail.template_published',
  /** Trusted server provisioning authorized a contained profile (written by SQL). */
  PROFILE_PROVISIONED: 'profile_provisioned',
  /** A firm's approved work-account provider was set (written by SQL). */
  IDENTITY_PROVIDER_CONFIGURED: 'identity_provider_configured',
  /** A firm's approved work-account provider was removed (written by SQL). */
  IDENTITY_PROVIDER_REMOVED: 'identity_provider_removed',
  /** Unbound work identities released from an account (written by SQL). */
  WORK_IDENTITY_RELEASED: 'work_identity_released',
  /** A work identity connected to an existing account (written by SQL). */
  WORK_IDENTITY_CONNECTED: 'work_identity_connected',
  /** A sending mailbox connected (detail {provider} only, #490). */
  MAILBOX_CONNECTED: 'mailbox.connected',
  /** A sending mailbox disconnected and its stored approval deleted (detail {provider} only, #490). */
  MAILBOX_DISCONNECTED: 'mailbox.disconnected',
  /** The provider ended a sending mailbox's approval, e.g. invalid_grant (detail {provider} only, #490). */
  MAILBOX_APPROVAL_ENDED: 'mailbox.approval_ended',
  /** A Connect for sending refused before anything was stored (detail {provider, reason}, reason a fixed code, #490). */
  MAILBOX_CONNECT_REFUSED: 'mailbox.connect_refused',
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];
export const AUDIT_ACTIONS = Object.values(AUDIT_ACTION) as AuditAction[];

// Discovery actions, added to the audit_log.action CHECK by
// 20260925100000_audit_hash_chain.sql, 20261001130000_mailbox_allowlist.sql and
// 20261002181000_discovery_google_connect.sql,
// 20261003110000_discovery_exclusion_policy.sql,
// 20261006120000_discovery_reader_pass.sql,
// 20261014120500_discovery_purge.sql,
// 20261014130000_discovery_purge_wiring.sql,
// 20261014140000_discovery_purge_tenant.sql and
// 20261014160000_tenant_retention_policy.sql,
// 20261019100000_team_mailboxes.sql,
// 20261023120000_model_proposal_dismissal_audit.sql,
// 20261023130600_discovery_milestone_rules.sql and
// 20261023140000_model_proposal_accept_audit.sql. Kept apart from AUDIT_ACTION, which
// mirrors the base list only. The chain trigger raises when one of these rows
// arrives without a tenant_id.
export const DISCOVERY_AUDIT_ACTION = {
  CANDIDATE_PROPOSED: 'discovery.candidate_proposed',
  CANDIDATE_PROMOTED: 'discovery.candidate_promoted',
  CORRECTION: 'discovery.correction',
  MILESTONE_EXTRACTED: 'discovery.milestone_extracted',
  STAGE_ASSESSED: 'discovery.stage_assessed',
  MAILBOX_CONSENTED: 'discovery.mailbox_consented',
  MAILBOX_CONSENT_WITHDRAWN: 'discovery.mailbox_consent_withdrawn',
  MAILBOX_REFUSED: 'discovery.mailbox_refused',
  ALLOWLIST_DRIFT: 'discovery.allowlist_drift',
  // An orphaned mailbox source archived on the next holder's opt-in, and a firm admin's merge of it (#262 round 3).
  MAILBOX_SOURCE_ARCHIVED: 'discovery.mailbox_source_archived',
  MAILBOX_SOURCES_UNIFIED: 'discovery.mailbox_sources_unified',
  SITE_REGISTERED: 'discovery.site_registered',
  SITE_UNREGISTERED: 'discovery.site_unregistered',
  SITE_REFUSED: 'discovery.site_refused',
  MAILBOX_ACCESS_CHANGED: 'discovery.mailbox_access_changed',
  // A new version of a tenant's exclusion policy (#263; written by SQL on every insert).
  EXCLUSION_POLICY_CHANGED: 'discovery.exclusion_policy_changed',
  // One discovery reader attempt (#370): written by discovery_record_reader_pass(), joined by detail.passId.
  READER_PASS_STARTED: 'discovery.reader_pass_started',
  READER_PASS_FINISHED: 'discovery.reader_pass_finished',
  // A banker's stored mail deleted when their consent ended (#461; written by the
  // mailbox_consents_purge trigger): ids, the reason and counts only.
  MAILBOX_PURGED: 'discovery.mailbox_purged',
  // The worker's backstop deleted stored messages no mailbox holds (#461;
  // discovery_collect_orphans_all): the run id and counts only.
  CONTENT_COLLECTED: 'discovery.content_collected',
  // The group-removal breaker held a tenant: too many consents due at once (#461;
  // discovery_withdraw_group_removed): counts only, once a day.
  GROUP_REMOVAL_HELD: 'discovery.group_removal_held',
  // An operator deleted a tenant's stored mail at pilot end (#461;
  // discovery_purge_tenant, run by scripts/discovery/purge-tenant.ts): the run id and counts only.
  TENANT_PURGED: 'discovery.tenant_purged',
  // A tenant's retention policy written (#461; tenant_retention_policy_set, audited by the table's trigger): the
  // operator, the reason, and the old and new values.
  RETENTION_POLICY_SET: 'discovery.retention_policy_set',
  // A banker's consent ended under content_on_disconnect keep (#461; discovery_purge_mailbox): the source
  // archived, nothing deleted. Ids, the reason and the policy applied only.
  MAILBOX_RETAINED: 'discovery.mailbox_retained',
  // Admin-managed team inboxes (#581; 20261019100000_team_mailboxes.sql). Every row about a team source carries
  // ids and fixed codes only, never the address.
  TEAM_MAILBOX_CONNECTED: 'discovery.team_mailbox_connected',
  TEAM_MAILBOX_CHECKED: 'discovery.team_mailbox_checked',
  TEAM_MAILBOX_MEMBER_ADDED: 'discovery.team_mailbox_member_added',
  TEAM_MAILBOX_MEMBER_REMOVED: 'discovery.team_mailbox_member_removed',
  TEAM_MAILBOX_DISCONNECTED: 'discovery.team_mailbox_disconnected',
  // A per-tenant capability approved or revoked (G-01 #173; 20261023110100_discovery_tenant_approvals.sql). Written
  // by the table's AFTER trigger: {capability, firmCompanyId, on, decisionRef}.
  TENANT_APPROVAL_CHANGED: 'discovery.tenant_approval_changed',
  // One AI pass over a team inbox (G-01 #173; 20261023110200_discovery_team_proposal_pass.sql), written by
  // discovery_begin_proposal_source and discovery_end_proposal_source (or a later begin, for a pass whose lease
  // lapsed): ids, the path, the outcome and integer counts only, never an address or a deal name.
  TEAM_MAILBOX_PROPOSAL_STARTED: 'discovery.team_mailbox_proposal_started',
  TEAM_MAILBOX_PROPOSAL_FINISHED: 'discovery.team_mailbox_proposal_finished',
  // A model proposal dismissed by its source owner, and an operator's restore at the owner's request (G-02a #173;
  // 20261023120000_model_proposal_dismissal_audit.sql, written by 20261023120100's two definers). Ids and counts
  // only, never the deal key, its slug or a name.
  MODEL_PROPOSAL_DISMISSED: 'discovery.model_proposal_dismissed',
  MODEL_PROPOSAL_DISMISSAL_RESTORED: 'discovery.model_proposal_dismissal_restored',
  // The rule detector (#173 G-07 slice 3b; 20261023130600_discovery_milestone_rules.sql): one settled detection of an
  // item {detectionId, sourceItemId, eventCount, rulesVersion}, and one run's pass over a team inbox
  // {teamMailboxId, runId, items, events}. Ids, counts and the version only, never text.
  MILESTONE_DETECTED: 'discovery.milestone_detected',
  TEAM_MAILBOX_MILESTONES_DETECTED: 'discovery.team_mailbox_milestones_detected',
  // A model-only proposal accepted by its source owner, and the source's sync job finishing the request (G-02b #173;
  // 20261023140000_model_proposal_accept_audit.sql, written by discovery_accept_model_proposal in 20261023140100 and,
  // as the discovery worker, by slice 1b's finish definer). Ids, a step id and counts only, never the deal key, its
  // slug or a name.
  MODEL_PROPOSAL_ACCEPT_REQUESTED: 'discovery.model_proposal_accept_requested',
  MODEL_PROPOSAL_ACCEPT_FINISHED: 'discovery.model_proposal_accept_finished',
} as const;

export type DiscoveryAuditAction =
  (typeof DISCOVERY_AUDIT_ACTION)[keyof typeof DISCOVERY_AUDIT_ACTION];
export const DISCOVERY_AUDIT_ACTIONS = Object.values(
  DISCOVERY_AUDIT_ACTION,
) as DiscoveryAuditAction[];

// Mirrors the audit_log.actor_type CHECK (20260925100000_audit_hash_chain.sql).
// The chain trigger fills it when a writer leaves it out: 'user' when actor_id
// is set, else 'service'. A 'model' row must carry the model gateway's
// service_identity.
export const AUDIT_ACTOR_TYPE = {
  USER: 'user',
  SERVICE: 'service',
  MODEL: 'model',
} as const;

export type AuditActorType = (typeof AUDIT_ACTOR_TYPE)[keyof typeof AUDIT_ACTOR_TYPE];
export const AUDIT_ACTOR_TYPES = Object.values(AUDIT_ACTOR_TYPE) as AuditActorType[];

/** The service_identity every actor_type = 'model' row must carry. */
export const MODEL_GATEWAY_SERVICE_IDENTITY = 'model-gateway';

/** Reserved tenant for chained rows whose tenant cannot be resolved. */
export const SYSTEM_AUDIT_TENANT_ID = '00000000-0000-0000-0000-000000000000';
