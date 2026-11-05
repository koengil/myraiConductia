// Postgres table-name constants. Mirror the tables created in
// supabase/migrations/ (feature_flags + the Phase 1 permissions schema).

export const TABLE = {
  FEATURE_FLAGS: 'feature_flags',
  COMPANIES: 'companies',
  USERS: 'users',
  ROLES: 'roles',
  DEALS: 'deals',
  DEAL_PARTIES: 'deal_parties',
  DEAL_MEMBERSHIPS: 'deal_memberships',
  DOCUMENTS: 'documents',
  DEAL_STEPS: 'deal_steps',
  RAIL_CATALOG_TEMPLATES: 'rail_catalog_templates',
  RAIL_CATALOG_STEPS: 'rail_catalog_steps',
  RAIL_CATALOG_CHANGES: 'rail_catalog_changes',
  RAIL_CATALOG_SKILL_DRAFTS: 'rail_catalog_skill_drafts',
  DATAROOMS: 'datarooms',
  AUDIT_LOG: 'audit_log',
  NOTIFICATIONS: 'notifications',
  LEAD_RELATIONSHIPS: 'lead_relationships',
  LEAD_STAKEHOLDERS: 'lead_stakeholders',
  LEAD_RELATIONSHIP_PATHS: 'lead_relationship_paths',
  LEAD_RESEARCH: 'lead_research',
  LEAD_DOCUMENTS: 'lead_documents',
  LEAD_INTEL: 'lead_intel',
  LEAD_PERSONAS: 'lead_personas',
  INVITES: 'invites',
  COMPANY_VERIFIED_DOMAINS: 'company_verified_domains',
  INVITE_DOMAIN_CONFIRMATIONS: 'invite_domain_confirmations',
  COMPANY_PERMISSIONS: 'company_permissions',
  COMPANY_ROLES: 'company_roles',
  COMPANY_ROLE_PERMISSIONS: 'company_role_permissions',
  COMPANY_MEMBER_ACCESS: 'company_member_access',
  COMPANY_MEMBER_ROLES: 'company_member_roles',
  COMPANY_MEMBER_PERMISSIONS: 'company_member_permissions',
  ACCESS_REQUESTS: 'access_requests',
  SETUP_WALKTHROUGH_PROGRESS: 'setup_walkthrough_progress',
  OUTBOUND_MESSAGES: 'outbound_messages',
  INBOUND_MESSAGES: 'inbound_messages',
  AI_USAGE: 'ai_usage',
  AI_BUDGETS: 'ai_budgets',
  FIRM_COMPLIANCE_SETTINGS: 'firm_compliance_settings',
  MAIL_WARNING_OUTCOMES: 'mail_warning_outcomes',
  SKILL_PUBLICATION_OPERATIONS: 'skill_publication_operations',
  SKILL_AUTHORING_CANDIDATES: 'skill_authoring_candidates',
  SKILL_AUTHORING_DRAFTS: 'skill_authoring_drafts',
  DEAL_STEP_SKILL_RUNS: 'deal_step_skill_runs',
  SKILL_COMMENT_TEACHINGS: 'skill_comment_teachings',
  DEAL_STEP_SKILL_BINDINGS: 'deal_step_skill_bindings',
  RAIL_TEMPLATES: 'rail_templates',
  RAIL_TEMPLATE_REVISIONS: 'rail_template_revisions',
  RAIL_TEMPLATE_CREATIONS: 'rail_template_creations',
  DEAL_SKILL_IMPORTS: 'deal_skill_imports',
  DEAL_TEMPLATE_CHANGE_DECISIONS: 'deal_template_change_decisions',
  // Deal discovery (20260925120000_discovery_core.sql).
  GRAPH_READER_REGISTRATIONS: 'graph_reader_registrations',
  GOOGLE_READER_REGISTRATIONS: 'google_reader_registrations',
  CONTENT_SOURCES: 'content_sources',
  ROUTING_LEDGER: 'routing_ledger',
  SEND_CENSUS_WEEKLY: 'send_census_weekly',
  SOURCE_ITEMS: 'source_items',
  SOURCE_ITEM_SOURCES: 'source_item_sources',
  SOURCE_ITEM_TEXTS: 'source_item_texts',
  DEAL_CANDIDATES: 'deal_candidates',
  EVIDENCE_LINKS: 'evidence_links',
  CANDIDATE_VISIBILITY: 'candidate_visibility',
  // Mailbox allowlist (20261001130000_mailbox_allowlist.sql). The two views are service-role only.
  MAILBOX_CONSENTS: 'mailbox_consents',
  MAILBOX_GUARD_STATE: 'mailbox_guard_state',
  MAILBOX_SEATED_INVITES: 'mailbox_seated_invites',
  ALLOWED_MAILBOXES: 'allowed_mailboxes',
  MAILBOX_ALLOWLIST_DRIFT: 'mailbox_allowlist_drift',
  // Admin-managed team inboxes (20261019100000_team_mailboxes.sql, #581). The firm-owned registry; service-role only.
  TEAM_MAILBOXES: 'team_mailboxes',
  // The team half of the allowlist (20261019140000_team_mailbox_guard.sql, #581): a view; service-role only.
  ALLOWED_TEAM_MAILBOXES: 'allowed_team_mailboxes',
  // Who may read a team inbox (20261019150000_team_mailbox_members.sql, #581): the admin's member list and the view of
  // those who still may. Written by definers only; the view is service-role only.
  TEAM_MAILBOX_MEMBERS: 'team_mailbox_members',
  TEAM_MAILBOX_READERS: 'team_mailbox_readers',
  // SharePoint site allowlist (20261001180000_site_allowlist.sql). allowed_sites is a service-role-only view.
  REGISTERED_SITES: 'registered_sites',
  ALLOWED_SITES: 'allowed_sites',
  // Milestones and stage assessments (20261002200000_discovery_milestones.sql).
  MILESTONE_EVENTS: 'milestone_events',
  STAGE_ASSESSMENTS: 'stage_assessments',
  MODEL_CALLS: 'model_calls',
  // The rule detector's settle ledger (#173 G-07 slice 3b; 20261023130600_discovery_milestone_rules.sql).
  MILESTONE_DETECTIONS: 'milestone_detections',
  DISCOVERY_RECOMPUTE_REQUESTS: 'discovery_recompute_requests',
  CORRECTIONS: 'corrections',
  // Exclusion policy versions (20261003110000_discovery_exclusion_policy.sql). Service-role only.
  DISCOVERY_EXCLUSION_POLICIES: 'discovery_exclusion_policies',
  // The threads a thread-scoped exclusion rule has excluded (same migration). Per mailbox source; service-role only.
  DISCOVERY_THREAD_TAINTS: 'discovery_thread_taints',
  // One row per message per mailbox processed, no content and a per-tenant keyed digest (#461). Service-role read and delete; a definer writes it.
  DISCOVERY_MESSAGE_INDEX: 'discovery_message_index',
  // The demo-only deal proposal step's answers (20261014120000_discovery_model_proposals.sql, #460). Deleted with #459.
  DISCOVERY_MODEL_PROPOSALS: 'discovery_model_proposals',
  // The owner's per-tenant capability switches (20261023110100, G-01 #173). Written by reviewed migrations only; service-role read.
  DISCOVERY_TENANT_APPROVALS: 'discovery_tenant_approvals',
  // The audited pass a team source holds before any model call (20261023110200, G-01 #173). Written by definers only.
  DISCOVERY_TEAM_PROPOSAL_PASSES: 'discovery_team_proposal_passes',
  // The owner's dismissals of those proposals, archive-not-delete (20261023120100_model_proposal_dismissals.sql,
  // G-02a #173): select under RLS for the source owner; written only by the dismiss and restore definers.
  DISCOVERY_MODEL_PROPOSAL_DISMISSALS: 'discovery_model_proposal_dismissals',
  // The owner's requests to accept a model-only proposal (20261023140100_model_proposal_accepts.sql, G-02b #173):
  // select under RLS for the source owner; written only by the accept RPC and the worker's definers (slice 1b).
  DISCOVERY_MODEL_PROPOSAL_ACCEPTS: 'discovery_model_proposal_accepts',
  // A live extraction run's cohort rows (20261021190000, #261): a call's reservation is set and cleared here. Service-role only.
  DISCOVERY_EXTRACT_BUDGET_ITEMS: 'discovery_extract_budget_items',
} as const;

export type TableName = (typeof TABLE)[keyof typeof TABLE];

/**
 * Core Phase 1 permission tables (excludes feature_flags). The element type is
 * inferred, not annotated TableName[]: that union names the mailbox-derived
 * tables, and the type-based fence (tests/agent-surfaces.test.ts) would flag
 * every .from() over it.
 */
export const PERMISSION_TABLES = [
  TABLE.COMPANIES,
  TABLE.USERS,
  TABLE.ROLES,
  TABLE.DEALS,
  TABLE.DEAL_PARTIES,
  TABLE.DEAL_MEMBERSHIPS,
  TABLE.DOCUMENTS,
  TABLE.DEAL_STEPS,
  TABLE.DATAROOMS,
  TABLE.AUDIT_LOG,
  TABLE.NOTIFICATIONS,
  TABLE.LEAD_RELATIONSHIPS,
  TABLE.LEAD_STAKEHOLDERS,
  TABLE.LEAD_RELATIONSHIP_PATHS,
];
