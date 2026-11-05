import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { AI_USAGE_SOURCES } from '@/lib/ai/usage';
import {
  COMPANY_ROLES,
  INTERNAL_ASSIGNABLE_DEAL_ROLES,
  ROLE_SLUGS,
  resolvePreferredDealRole,
} from '@/lib/constants/roles';
import { DEAL_STATUSES } from '@/lib/constants/deals';
import {
  AUDIT_ACTION,
  AUDIT_ACTIONS,
  AUDIT_ACTOR_TYPES,
  DISCOVERY_AUDIT_ACTION,
  DISCOVERY_AUDIT_ACTIONS,
  MODEL_GATEWAY_SERVICE_IDENTITY,
  SYSTEM_AUDIT_TENANT_ID,
} from '@/lib/constants/audit';
import { COMPANY_TYPE, PARTY_ROLE } from '@/lib/constants/companies';
import { GMAIL_READER_SCOPE, GOOGLE_READER_TABLE } from '@/lib/constants/googleReader';
import { USER_STATUS } from '@/lib/constants/users';
import { INVITE_STATUS, INVITE_DELIVERY_STATUS } from '@/lib/constants/invites';
import { DOCUMENT_ROOM } from '@/lib/constants/documents';
import { AI_BUDGET_THRESHOLDS } from '@/lib/ai/budget';
import { NOTIFICATION_EVENT, NOTIFICATION_EVENTS } from '@/lib/constants/notifications';
import {
  BENCH_RUN_STATUSES,
  RAIL_CENSUS_VERSION,
  SKILL_BINDING_KINDS,
  SKILL_BINDING_SOURCES,
  SKILL_RUN_SOURCES,
  STEP_STATUSES,
} from '@/lib/constants/dealSteps';
import { OUTBOX_STATUSES, RECIPIENT_BOUNDARIES } from '@/lib/constants/outbox';
import { MAIL_WARNING_KINDS, MAIL_WARNING_OUTCOMES } from '@/lib/constants/mailWarningOutcomes';
import {
  COMPANY_PERMISSIONS,
  isCompanyPermission,
  resolveCompanyPermission,
} from '@/lib/constants/companyPermissions';
import { ACCESS_DESTINATIONS } from '@/lib/constants/accessRequests';
import { TABLE } from '@/lib/constants/tables';
import { SEND_RECIPIENTS } from '@/lib/constants/sendCensus';
import {
  DEAL_SIDES,
  DELEGATION_STATUSES,
  DISCOVERY_STATES,
  DRIFT_STATUSES,
  GOOGLE_REGISTRATION_STATUSES,
  ITEM_SENSITIVITIES,
  LINK_STATES,
  REGISTRATION_STATUSES,
  ROUTE_METHOD,
  ROUTE_METHODS,
  ROUTE_TIERS,
  ROUTING_DECISIONS,
  SKIP_REASONS,
  CHECKPOINT_STATES,
  SOURCE_ITEM_KINDS,
  MAILBOX_GUARD_PURPOSES,
  MAILBOX_PROVIDERS,
  MAILBOX_READING_REASON,
  MAILBOX_READING_REASONS,
  MAILBOX_REFUSAL_REASON,
  MAILBOX_REFUSAL_REASONS,
  POLICY_SKIP_REASONS,
  SITE_REFUSAL_REASON,
  SITE_REFUSAL_REASONS,
  SOURCE_KINDS,
  SOURCE_REFUSAL_REASONS,
  SOURCE_STATUSES,
  ASSESSMENT_FLAGS,
  CORRECTION_ACTION,
  CORRECTION_ACTIONS,
  LIFECYCLE_SUGGESTIONS,
  MODEL_CALL_OUTCOMES,
  MODEL_CALL_TRANSPORTS,
  PROPOSAL_OUTCOMES,
  TENANT_CAPABILITIES,
  TENANT_CAPABILITY,
  TEAM_PROPOSAL_PASS_OUTCOMES,
  STAGE_TRIGGERS,
  HISTORY_WINDOW_EXCEEDED,
  SOURCE_RESTART_COOLDOWN_SECONDS,
  READER_LIVENESS_SECONDS,
  BACKFILL_WINDOW_DEFAULT_DAYS,
  TEAM_MAILBOX_ATTESTATION_VERSION,
  TEAM_MAILBOX_CHECK_ERRORS,
  TEAM_MAILBOX_CHECK_REASONS,
  TEAM_MAILBOX_CHECK_STATUSES,
  TEAM_MAILBOX_DISCONNECT_REASONS,
  TEAM_MAILBOX_MEMBER_REMOVED_REASONS,
  TEAM_MAILBOX_READ_WINDOW_MINUTES,
  TEAM_MAILBOX_RENEW_MINUTES,
  TEAM_MAILBOX_WINDOW_MAX_DAYS,
  BACKFILL_WINDOW_MAX_DAYS,
} from '@/lib/constants/discovery';
import { MILESTONE_TYPES } from '@/lib/discovery/milestones';
import { FLAG_REGISTRY } from '@/lib/flags/keys';
import { resolveFlags } from '@/lib/flags/resolveFlags';
import { actionCheckHistory } from './helpers/auditActionCheck';
import {
  RELATIONSHIP_TYPES,
  STRENGTH_LEVELS,
  RELATIONSHIP_SOURCES,
  DECISION_ROLES,
  MOTIVATIONS,
  STANCES,
  PATH_TYPES,
} from '@/lib/constants/leadMaps';

/**
 * The TypeScript constants are the typed mirror of the permissions migration's
 * CHECK enums (ADR-0008). The migration is the source of truth; this test fails
 * loudly if a constant drifts from the SQL it claims to mirror.
 */
const MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260604100000_permissions_schema.sql',
);

const COMPANY_MEMBERSHIP_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260612120000_company_membership.sql',
);

const LEGAL_HOLD_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260629120000_legal_hold.sql',
);

const AUDIT_CREATE_NOTIFY_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260714160000_audit_action_create_notify.sql',
);

const AUDIT_ADVANCE_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260715180000_audit_action_advance.sql',
);

const CONFLICTS_ATTESTATION_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260721120000_conflicts_attestation.sql',
);

const NOTIFICATIONS_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260714161000_notifications.sql',
);

const DEAL_STEPS_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260716180000_deal_steps.sql',
);

const BENCH_SESSION_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260903130000_deal_step_bench_session.sql',
);

const SKILL_VERSION_SELECTION_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql',
);

const CREATE_DEAL_FROM_TEMPLATE_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260921110000_create_deal_from_template.sql',
);

const SKILL_OUTPUT_REVISIONS_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20261013100000_skill_output_revisions.sql',
);

const LEAD_CRM_MAPS_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260722120000_lead_crm_maps.sql',
);

const LEAD_RELATIONSHIP_PATHS_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260808121000_lead_relationship_paths.sql',
);

const DEAL_STEP_ASSIGNMENT_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260808150000_deal_step_assignment.sql',
);

const ONBOARDING_INVITES_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260731120000_onboarding_invites.sql',
);

const INVITE_SAFEGUARD_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260804160000_invite_safeguard_2fa.sql',
);

const OUTBOUND_MESSAGES_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260729130000_outbound_messages.sql',
);

const MAIL_INBOUND_REVIEW_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260730150000_mail_inbound_review_mailbox.sql',
);

const OUTBOX_PENDING_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260803120000_outbox_pending_status.sql',
);

const PREFERRED_DEAL_ROLE_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260814120000_preferred_deal_role.sql',
);

const COMPANY_ACCESS_MANAGEMENT_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260814190000_company_access_management.sql',
);

const COMPANY_PLATFORM_PERMISSIONS_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260816150000_company_platform_permissions.sql',
);

const COMPANY_DEAL_STEP_LEAD_PERMISSIONS_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260816170000_deal_step_and_lead_permissions.sql',
);

const ACCESS_REQUESTS_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260831120000_access_requests.sql',
);

const ACCESS_REQUESTS_LEADS_CREATE_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260901120000_access_request_leads_create.sql',
);

const ACCESS_REQUESTS_ORG_DESTINATIONS_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260903120000_access_request_org_destinations.sql',
);

const GATE0_NOTIFY_PERMISSION_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260902120000_gate0_notify_permission.sql',
);

const STEPS_STRUCTURE_PERMISSION_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260916100000_project_rail_model.sql',
);

const RAIL_TEMPLATES_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20261002110000_rail_catalog_templates.sql',
);

function quotedValues(fragment: string): string[] {
  return [...fragment.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe('constants mirror the permissions migration', () => {
  let sql: string;
  let legalHoldSql: string;
  let auditCreateNotifySql: string;
  let auditAdvanceSql: string;
  let conflictsAttestationSql: string;
  let notificationsSql: string;
  let dealStepsSql: string;
  let leadCrmMapsSql: string;
  let leadRelationshipPathsSql: string;
  let dealStepAssignmentSql: string;
  let onboardingInvitesSql: string;
  let inviteSafeguardSql: string;
  let outboundMessagesSql: string;
  let mailInboundReviewSql: string;
  let outboxPendingSql: string;
  let companyAccessManagementSql: string;
  let companyPlatformPermissionsSql: string;
  let companyDealStepLeadPermissionsSql: string;
  let accessRequestsSql: string;
  let accessRequestsLeadsCreateSql: string;
  let accessRequestsOrgDestinationsSql: string;
  let gate0NotifyPermissionSql: string;
  let stepsStructurePermissionSql: string;
  let railTemplatesSql: string;
  let mailboxAllowlistDriftSql: string;
  let googleConnectSql: string;

  beforeAll(() => {
    sql = readFileSync(MIGRATION, 'utf8');
    legalHoldSql = readFileSync(LEGAL_HOLD_MIGRATION, 'utf8');
    auditCreateNotifySql = readFileSync(AUDIT_CREATE_NOTIFY_MIGRATION, 'utf8');
    auditAdvanceSql = readFileSync(AUDIT_ADVANCE_MIGRATION, 'utf8');
    conflictsAttestationSql = readFileSync(CONFLICTS_ATTESTATION_MIGRATION, 'utf8');
    notificationsSql = readFileSync(NOTIFICATIONS_MIGRATION, 'utf8');
    dealStepsSql = readFileSync(DEAL_STEPS_MIGRATION, 'utf8');
    leadCrmMapsSql = readFileSync(LEAD_CRM_MAPS_MIGRATION, 'utf8');
    leadRelationshipPathsSql = readFileSync(LEAD_RELATIONSHIP_PATHS_MIGRATION, 'utf8');
    dealStepAssignmentSql = readFileSync(DEAL_STEP_ASSIGNMENT_MIGRATION, 'utf8');
    onboardingInvitesSql = readFileSync(ONBOARDING_INVITES_MIGRATION, 'utf8');
    inviteSafeguardSql = readFileSync(INVITE_SAFEGUARD_MIGRATION, 'utf8');
    outboundMessagesSql = readFileSync(OUTBOUND_MESSAGES_MIGRATION, 'utf8');
    mailInboundReviewSql = readFileSync(MAIL_INBOUND_REVIEW_MIGRATION, 'utf8');
    outboxPendingSql = readFileSync(OUTBOX_PENDING_MIGRATION, 'utf8');
    companyAccessManagementSql = readFileSync(
      COMPANY_ACCESS_MANAGEMENT_MIGRATION,
      'utf8',
    );
    companyPlatformPermissionsSql = readFileSync(
      COMPANY_PLATFORM_PERMISSIONS_MIGRATION,
      'utf8',
    );
    companyDealStepLeadPermissionsSql = readFileSync(
      COMPANY_DEAL_STEP_LEAD_PERMISSIONS_MIGRATION,
      'utf8',
    );
    accessRequestsSql = readFileSync(ACCESS_REQUESTS_MIGRATION, 'utf8');
    accessRequestsLeadsCreateSql = readFileSync(ACCESS_REQUESTS_LEADS_CREATE_MIGRATION, 'utf8');
    accessRequestsOrgDestinationsSql = readFileSync(
      ACCESS_REQUESTS_ORG_DESTINATIONS_MIGRATION,
      'utf8',
    );
    gate0NotifyPermissionSql = readFileSync(GATE0_NOTIFY_PERMISSION_MIGRATION, 'utf8');
    stepsStructurePermissionSql = readFileSync(STEPS_STRUCTURE_PERMISSION_MIGRATION, 'utf8');
    railTemplatesSql = readFileSync(RAIL_TEMPLATES_MIGRATION, 'utf8');
    mailboxAllowlistDriftSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261001160000_mailbox_allowlist_drift.sql'),
      'utf8',
    );
    googleConnectSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261002181000_discovery_google_connect.sql'),
      'utf8',
    );
  });

  it('seeds every role slug', () => {
    for (const slug of ROLE_SLUGS) {
      expect(sql).toContain(`'${slug}'`);
    }
  });

  it('covers every deal status in the status CHECK', () => {
    for (const status of DEAL_STATUSES) {
      expect(sql).toContain(`'${status}'`);
    }
  });

  it('covers every audit action in the action CHECK', () => {
    const latestCheck = actionCheckHistory().at(-1)?.actions ?? [];
    for (const action of AUDIT_ACTIONS) {
      const inBase = sql.includes(`'${action}'`);
      const inLegalHold = legalHoldSql.includes(`'${action}'`);
      const inCreateNotify = auditCreateNotifySql.includes(`'${action}'`);
      const inAdvance = auditAdvanceSql.includes(`'${action}'`);
      const inAttest = conflictsAttestationSql.includes(`'${action}'`);
      const inOnboarding = onboardingInvitesSql.includes(`'${action}'`);
      const inInviteSafeguard = inviteSafeguardSql.includes(`'${action}'`);
      const inOutbound = outboundMessagesSql.includes(`'${action}'`);
      const inMailReview = mailInboundReviewSql.includes(`'${action}'`);
      const inStepAssignment = dealStepAssignmentSql.includes(`'${action}'`);
      const inCompanyAccessManagement = companyAccessManagementSql.includes(
        `'${action}'`,
      );
      // Later additions (rail.template_*) are read from the latest CHECK.
      const inLatestCheck = latestCheck.includes(action);
      expect(
        inBase || inLegalHold || inCreateNotify || inAdvance || inAttest || inOnboarding || inInviteSafeguard || inOutbound || inMailReview || inStepAssignment || inCompanyAccessManagement || inLatestCheck,
      ).toBe(true);
    }
  });

  it('covers every recipient boundary in the outbound_messages recipient_boundary CHECK', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20260921160000_outbound_recipient_boundary.sql'), 'utf8');
    for (const boundary of RECIPIENT_BOUNDARIES) expect(sql.includes(`'${boundary}'`)).toBe(true);
    const listed = [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((v) => v !== 'outbound_messages');
    for (const value of listed) expect(RECIPIENT_BOUNDARIES).toContain(value);
  });

  it('mirrors the mail_warning_outcomes kind and outcome CHECKs exactly', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261001200000_mail_warning_outcomes.sql'), 'utf8');
    const check = (column: string) =>
      [...(sql.match(new RegExp(`${column}\\s+text not null check \\(${column} in \\(([^)]*)\\)`))?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(check('kind').sort()).toEqual([...MAIL_WARNING_KINDS].sort());
    // D80 narrowed the outcome CHECK in a later migration: the latest one is the source of truth.
    const narrowed = readFileSync(join(process.cwd(), 'supabase/migrations/20261008200000_mail_warning_outcomes_sent_only.sql'), 'utf8');
    const outcomes = [...(narrowed.match(/check \(outcome in \(([^)]*)\)\)/)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(outcomes.sort()).toEqual([...MAIL_WARNING_OUTCOMES].sort());
  });

  it('mirrors the routing ledger sent recipient CHECK', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261021180000_send_census.sql'), 'utf8');
    const values = [...(sql.match(/routing_ledger_sent_recipient_check check \(sent_recipient in \(([^)]*)\)\)/)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    expect(values.sort()).toEqual([...SEND_RECIPIENTS].sort());
  });

  it('covers every outbox status in the outbound_messages status CHECK', () => {
    for (const status of OUTBOX_STATUSES) {
      const inBase = outboundMessagesSql.includes(`'${status}'`);
      const inReview = mailInboundReviewSql.includes(`'${status}'`);
      const inPending = outboxPendingSql.includes(`'${status}'`);
      expect(inBase || inReview || inPending).toBe(true);
    }
  });

  it('covers every notification event type in the event_type CHECK', () => {
    const templateChangeReviewSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261005200000_template_change_review.sql'),
      'utf8',
    );
    const workIdentityOneBindingSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261010100000_work_identity_one_binding.sql'),
      'utf8',
    );
    const firmComplianceSettingsSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261020110000_firm_compliance_settings.sql'),
      'utf8',
    );
    const firmComplianceSettingsSaveSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261021140000_firm_compliance_settings_save.sql'),
      'utf8',
    );
    const teamMailboxRefusalNotifySql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261023100000_team_mailbox_refusal_notify.sql'),
      'utf8',
    );
    for (const event of NOTIFICATION_EVENTS) {
      const inBase = notificationsSql.includes(`'${event}'`);
      const inAssignment = dealStepAssignmentSql.includes(`'${event}'`);
      const inAccess = accessRequestsSql.includes(`'${event}'`);
      const inDrift = mailboxAllowlistDriftSql.includes(`'${event}'`);
      const inTemplateChange = templateChangeReviewSql.includes(`'${event}'`);
      const inAiBudget = aiBudgetAlertsSql().includes(`'${event}'`);
      const inWorkIdentity = workIdentityOneBindingSql.includes(`'${event}'`);
      const inFirmCompliance = firmComplianceSettingsSql.includes(`'${event}'`);
      const inFirmComplianceSave = firmComplianceSettingsSaveSql.includes(`'${event}'`);
      const inTeamMailboxRefusal = teamMailboxRefusalNotifySql.includes(`'${event}'`);
      expect(inBase || inAssignment || inAccess || inDrift || inTemplateChange || inAiBudget || inWorkIdentity || inFirmCompliance || inFirmComplianceSave || inTeamMailboxRefusal).toBe(true);
    }
  });

  it('covers step lifecycle audit actions in the assignment migration', () => {
    for (const action of [
      AUDIT_ACTION.ASSIGN_STEP,
      AUDIT_ACTION.COMPLETE_STEP,
      AUDIT_ACTION.STEP_WORK,
    ]) {
      expect(dealStepAssignmentSql).toContain(`'${action}'`);
    }
  });

  it('covers every deal-step status in the status CHECK', () => {
    for (const status of STEP_STATUSES) {
      expect(dealStepsSql).toContain(`'${status}'`);
    }
  });

  it('covers every bench run status in the bench_run_status CHECK', () => {
    const benchSql = readFileSync(BENCH_SESSION_MIGRATION, 'utf8');
    for (const status of BENCH_RUN_STATUSES) {
      expect(benchSql).toContain(`'${status}'`);
    }
  });

  it('covers every skill binding kind, binding source and run source CHECK', () => {
    const skillSql = readFileSync(SKILL_VERSION_SELECTION_MIGRATION, 'utf8');
    expect(skillSql).toContain(
      `check (kind in (${SKILL_BINDING_KINDS.map((kind) => `'${kind}'`).join(', ')}))`,
    );
    const templateSql = readFileSync(CREATE_DEAL_FROM_TEMPLATE_MIGRATION, 'utf8');
    expect(templateSql).toContain(
      `check (source in (${SKILL_BINDING_SOURCES.map((source) => `'${source}'`).join(', ')}))`,
    );
    const revisionsSql = readFileSync(SKILL_OUTPUT_REVISIONS_MIGRATION, 'utf8');
    expect(revisionsSql).toContain(
      `check (source in (${SKILL_RUN_SOURCES.map((source) => `'${source}'`).join(', ')}))`,
    );
  });

  it('covers every company type and party role', () => {
    for (const type of Object.values(COMPANY_TYPE)) {
      expect(sql).toContain(`'${type}'`);
    }
    for (const role of Object.values(PARTY_ROLE)) {
      expect(sql).toContain(`'${role}'`);
    }
  });

  it('covers every company role in the company-membership migration', () => {
    const companySql = readFileSync(COMPANY_MEMBERSHIP_MIGRATION, 'utf8');
    for (const role of COMPANY_ROLES) {
      expect(companySql).toContain(`'${role}'`);
    }
  });

  it('keeps the preferred deal role CHECK aligned with the internal allowlist', () => {
    const preferredSql = readFileSync(PREFERRED_DEAL_ROLE_MIGRATION, 'utf8');
    const inList = /preferred_deal_role in \(([^)]+)\)/i.exec(preferredSql)?.[1] ?? '';
    const slugs = [...inList.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();
    expect(slugs).toEqual([...INTERNAL_ASSIGNABLE_DEAL_ROLES].sort());
  });

  it('narrows preferred roles to the internal allowlist', () => {
    expect(resolvePreferredDealRole('legal')).toBe('legal');
    expect(resolvePreferredDealRole('md')).toBeNull();
    expect(resolvePreferredDealRole('seller')).toBeNull();
    expect(resolvePreferredDealRole('admin')).toBeNull();
    expect(resolvePreferredDealRole(null)).toBeNull();
    expect(resolvePreferredDealRole(undefined)).toBeNull();
  });

  it('keeps company permission constants aligned with the CHECK and seed', () => {
    const check = /company_permissions_key_check[\s\S]*?key\s+in\s*\(([^)]+)\)/i.exec(
      railTemplatesSql,
    )?.[1];
    const baseSeed = /insert\s+into\s+(?:public\.)?company_permissions[\s\S]*?values([\s\S]*?);/i.exec(
      companyAccessManagementSql,
    )?.[1];
    const platformSeed = /insert\s+into\s+(?:public\.)?company_permissions[\s\S]*?values([\s\S]*?);/i.exec(
      companyPlatformPermissionsSql,
    )?.[1];
    const dealStepLeadSeed = /insert\s+into\s+(?:public\.)?company_permissions[\s\S]*?values([\s\S]*?);/i.exec(
      companyDealStepLeadPermissionsSql,
    )?.[1];
    const notifySeed = /insert\s+into\s+(?:public\.)?company_permissions[\s\S]*?values([\s\S]*?);/i.exec(
      gate0NotifyPermissionSql,
    )?.[1];
    const structureSeed = /insert\s+into\s+(?:public\.)?company_permissions[\s\S]*?values([\s\S]*?);/i.exec(
      stepsStructurePermissionSql,
    )?.[1];
    const railTemplatesSeed = /insert\s+into\s+(?:public\.)?company_permissions[\s\S]*?values([\s\S]*?);/i.exec(
      railTemplatesSql,
    )?.[1];

    expect(check, 'company_permissions key CHECK').toBeDefined();
    expect(baseSeed, 'company_permissions base seed').toBeDefined();
    expect(platformSeed, 'company_permissions platform seed').toBeDefined();
    expect(dealStepLeadSeed, 'company_permissions deal-step/lead seed').toBeDefined();
    expect(notifySeed, 'company_permissions gate0 notify seed').toBeDefined();
    expect(structureSeed, 'company_permissions structure seed').toBeDefined();
    expect(railTemplatesSeed, 'company_permissions rail template seed').toBeDefined();
    expect([...new Set(quotedValues(check ?? ''))].sort()).toEqual(
      [...COMPANY_PERMISSIONS].sort(),
    );
    expect(
      [
        ...new Set([
          ...quotedValues(baseSeed ?? '').filter((value) => value.startsWith('company:')),
          ...quotedValues(platformSeed ?? '').filter((value) => value.startsWith('company:')),
          ...quotedValues(dealStepLeadSeed ?? '').filter((value) => value.startsWith('company:')),
          ...quotedValues(notifySeed ?? '').filter((value) => value.startsWith('company:')),
          ...quotedValues(structureSeed ?? '').filter((value) => value.startsWith('company:')),
          ...quotedValues(railTemplatesSeed ?? '').filter((value) => value.startsWith('company:')),
        ]),
      ].sort(),
    ).toEqual([...COMPANY_PERMISSIONS].sort());
  });

  it('narrows and resolves untrusted company permission keys', () => {
    expect(isCompanyPermission('company:roles:manage')).toBe(true);
    expect(isCompanyPermission('company:roles:delete')).toBe(false);
    expect(isCompanyPermission(null)).toBe(false);
    expect(resolveCompanyPermission('company:access:assign')).toBe(
      'company:access:assign',
    );
    expect(resolveCompanyPermission('company:access:delete')).toBeNull();
    expect(resolveCompanyPermission(undefined)).toBeNull();
  });

  it('keeps Phase B table constants aligned with the migration', () => {
    for (const table of [
      TABLE.COMPANY_PERMISSIONS,
      TABLE.COMPANY_ROLES,
      TABLE.COMPANY_ROLE_PERMISSIONS,
      TABLE.COMPANY_MEMBER_ACCESS,
      TABLE.COMPANY_MEMBER_ROLES,
      TABLE.COMPANY_MEMBER_PERMISSIONS,
    ]) {
      expect(companyAccessManagementSql).toMatch(
        new RegExp(`create\\s+table(?:\\s+if\\s+not\\s+exists)?\\s+(?:public\\.)?${table}\\b`, 'i'),
      );
    }
  });

  it('keeps audit actions aligned with the latest CHECK', () => {
    // The latest definition in migration order, not a pinned file: pinning
    // one let the list fall behind (tests/audit-action-check-history.test.ts).
    const latest = actionCheckHistory().at(-1)?.actions ?? [];
    for (const action of AUDIT_ACTIONS) expect(latest, action).toContain(action);
    // Undotted actions, the rail template ones and the sending mailbox ones
    // (#490) are mirrored in full. The other namespaced ones (skill_*,
    // rail.step_rebound, discovery.*) are written by SQL or mirrored elsewhere.
    const mirrored = (action: string) =>
      !action.includes('.') || action.startsWith('rail.template_') || action.startsWith('mailbox.');
    expect([...new Set(latest.filter(mirrored))].sort()).toEqual([...AUDIT_ACTIONS].sort());
  });

  it('keeps the audit hash chain enums aligned with their migration', () => {
    const chainSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260925100000_audit_hash_chain.sql'),
      'utf8',
    );
    // The action list is the latest CHECK in migration order (the mailbox
    // allowlist migration widened the chain migration's list), not a pinned file.
    const listed = actionCheckHistory().at(-1)?.actions ?? [];
    expect(listed.length, 'audit_log action CHECK').toBeGreaterThan(0);
    // The widened list keeps every base action and adds exactly the discovery ones.
    for (const action of AUDIT_ACTIONS) expect(listed).toContain(action);
    expect(listed.filter((a) => a.startsWith('discovery.')).sort()).toEqual(
      [...DISCOVERY_AUDIT_ACTIONS].sort(),
    );

    const actorTypes = /check \(actor_type in \(([^)]+)\)\)/.exec(chainSql)?.[1];
    expect(quotedValues(actorTypes ?? '')).toEqual(AUDIT_ACTOR_TYPES);
    expect(chainSql).toContain(`service_identity = '${MODEL_GATEWAY_SERVICE_IDENTITY}'`);
    expect(chainSql).toContain(`'${SYSTEM_AUDIT_TENANT_ID}'::uuid`);
  });

  it('keeps the discovery enums and tables aligned with the discovery migration', () => {
    const discoverySql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260925120000_discovery_core.sql'),
      'utf8',
    );
    const checkValues = (table: string, column: string): string[] => {
      const body = new RegExp(`create table if not exists ${table} \\(([\\s\\S]*?)\\n\\);`).exec(
        discoverySql,
      )?.[1];
      expect(body, `${table} definition`).toBeDefined();
      const list = new RegExp(`check \\(${column} in \\(([^)]+)\\)\\)`).exec(body ?? '')?.[1];
      expect(list, `${table}.${column} CHECK`).toBeDefined();
      return quotedValues(list ?? '');
    };

    expect(checkValues('deal_candidates', 'discovery_state')).toEqual(DISCOVERY_STATES);
    expect(checkValues('deal_candidates', 'deal_side')).toEqual(DEAL_SIDES);
    expect(checkValues('evidence_links', 'route_tier')).toEqual(ROUTE_TIERS);
    expect(checkValues('evidence_links', 'state')).toEqual(LINK_STATES);
    // Widened by G-02b's checks migration (model_proposal), pinned in its own test below; the firm rules' three stay first.
    expect(ROUTE_METHODS.slice(0, 3)).toEqual(checkValues('evidence_links', 'method'));
    expect(ROUTE_METHODS.slice(0, 3)).toEqual(checkValues('routing_ledger', 'method'));
    // Widened by the phase 4 migration below; the phase 3 values stay first.
    expect(ROUTING_DECISIONS.slice(0, 2)).toEqual(checkValues('routing_ledger', 'decision'));
    expect(checkValues('content_sources', 'kind')).toEqual(SOURCE_KINDS);
    expect(checkValues('content_sources', 'status')).toEqual(SOURCE_STATUSES);
    expect(checkValues('graph_reader_registrations', 'status')).toEqual(REGISTRATION_STATUSES);
    expect(checkValues('source_items', 'kind')).toEqual(SOURCE_ITEM_KINDS);
    expect(checkValues('source_items', 'sensitivity')).toEqual(ITEM_SENSITIVITIES);

    for (const table of [
      TABLE.GRAPH_READER_REGISTRATIONS,
      TABLE.CONTENT_SOURCES,
      TABLE.ROUTING_LEDGER,
      TABLE.SOURCE_ITEMS,
      TABLE.SOURCE_ITEM_SOURCES,
      TABLE.SOURCE_ITEM_TEXTS,
      TABLE.DEAL_CANDIDATES,
      TABLE.EVIDENCE_LINKS,
      TABLE.CANDIDATE_VISIBILITY,
    ]) {
      expect(discoverySql).toContain(`create table if not exists ${table} (`);
      expect(discoverySql).toMatch(new RegExp(`alter table ${table}\\s+enable row level security`));
    }
    expect(FLAG_REGISTRY).toHaveProperty('deal_discovery');
  });

  it('keeps the phase 4 ingestion enums aligned with the discovery health migration', () => {
    const healthSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260925150000_discovery_health.sql'),
      'utf8',
    );
    const constraint = (name: string, column: string): string[] => {
      const list = new RegExp(`add constraint ${name}\\s+check \\(${column} in \\(([^)]+)\\)\\)`).exec(healthSql)?.[1];
      expect(list, `${name}`).toBeDefined();
      return quotedValues(list ?? '');
    };
    expect(constraint('routing_ledger_decision_check', 'decision')).toEqual(ROUTING_DECISIONS);
    // The skip reasons were widened by the exclusion policy migration (#263): its CHECK is the latest.
    const exclusionSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261003110000_discovery_exclusion_policy.sql'),
      'utf8',
    );
    const widened = new RegExp(`add constraint routing_ledger_skip_reason_check\\s+check \\(skip_reason in \\(([^)]+)\\)\\)`).exec(exclusionSql)?.[1];
    expect(widened, 'routing_ledger_skip_reason_check').toBeDefined();
    expect(quotedValues(widened ?? '')).toEqual(SKIP_REASONS);
    // The earlier six stay first, in order: the original CHECK is a prefix of the widened one.
    expect(SKIP_REASONS.slice(0, 6)).toEqual(constraint('routing_ledger_skip_reason_check', 'skip_reason'));
    // The health RPC reports each checkpoint state the TS mirror names.
    for (const state of CHECKPOINT_STATES) expect(healthSql).toContain(`'${state}'`);
    expect(healthSql).toContain('add column if not exists drive_item_key text');
    expect(FLAG_REGISTRY).toHaveProperty('discovery_worker_enabled');
  });

  it('keeps the mailbox allowlist enums, tables and guard aligned with their migration', () => {
    const mailboxSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261001130000_mailbox_allowlist.sql'),
      'utf8',
    );
    const listAfter = (marker: RegExp): string[] => {
      const match = marker.exec(mailboxSql.replace(/--.*$/gm, ''));
      expect(match, String(marker)).not.toBeNull();
      return quotedValues(match?.[1] ?? '');
    };
    // The mailbox reasons plus the site reasons (site_guard_check produces those). The three team reasons (#581) came
    // later: 20261019140000 restates this CHECK whole, and its own test below pins the full list.
    const TEAM_REASONS: string[] = [
      MAILBOX_REFUSAL_REASON.TEAM_MAILBOX_UNVERIFIED,
      MAILBOX_REFUSAL_REASON.TEAM_MAILBOX_DISCONNECTED,
      MAILBOX_REFUSAL_REASON.TEAM_MAILBOX_PERSON,
    ];
    expect(listAfter(/check \(last_reason in \(([^)]*)\)/)).toEqual(SOURCE_REFUSAL_REASONS.filter((reason) => !TEAM_REASONS.includes(reason)));
    expect(listAfter(/p_purpose not in \(([^)]*)\)/)).toEqual(MAILBOX_GUARD_PURPOSES);
    expect(listAfter(/p_provider_reason not in \(([^)]*)\)/)).toEqual([
      MAILBOX_REFUSAL_REASON.NOT_IN_PROVIDER_GROUP,
      MAILBOX_REFUSAL_REASON.MIRROR_UNAVAILABLE,
    ]);
    for (const key of ['MAILBOX_CONSENTS', 'MAILBOX_GUARD_STATE', 'MAILBOX_SEATED_INVITES', 'ALLOWED_MAILBOXES'] as const) {
      expect(mailboxSql, key).toMatch(new RegExp(`(table|view)(?: if not exists)? ${TABLE[key]}\\b`));
    }
    // C2: content_sources.provider mirrors MAILBOX_PROVIDER, and the provider list the
    // per-address join walks is the same list.
    expect(listAfter(/add column if not exists provider text not null default 'microsoft'\s+check \(provider in \(([^)]*)\)/)).toEqual(
      MAILBOX_PROVIDERS,
    );
    expect(listAfter(/from unnest\(array\[([^\]]*)\]\) as p\(provider\)/)).toEqual(MAILBOX_PROVIDERS);
    // C5: the registration functions take the provider, and there is no one-argument
    // form left for a guard to call by mistake (it would be the union of the providers).
    const code = mailboxSql.replace(/--.*$/gm, '');
    for (const fn of ['reader_mailbox_domains', 'reader_firm_company_ids', 'reader_registration_active']) {
      expect(code, fn).toContain(`function ${fn}(p_tenant_id uuid, p_provider text)`);
      expect(code, fn).not.toMatch(new RegExp(`${fn}\\((?:p_tenant_id uuid|[a-z_.]*tenant_id)\\)`));
    }
    // The guard judges a mailbox against its own source's provider, through the one decision (audit round 3, A3):
    // mailbox_guard_verdict, which mailbox_guard_check and the member's mailbox_reading_reason both call.
    const guard = /create or replace function mailbox_guard_check\([\s\S]*?\n\$\$;/.exec(code)?.[0] ?? '';
    const verdict = /create or replace function mailbox_guard_verdict\([\s\S]*?\n\$\$;/.exec(code)?.[0] ?? '';
    expect(verdict).not.toBe('');
    expect(guard).toContain('mailbox_guard_verdict(p_tenant_id, v_address, p_provider, coalesce(p_check_owner, false), p_owner_user_id)');
    // The worker's provider-group reason is the caller's input: it applies only when the database allows the read.
    expect(guard).toMatch(/v_reason := coalesce\(\s*mailbox_guard_verdict\(p_tenant_id, v_address, p_provider, coalesce\(p_check_owner, false\), p_owner_user_id\),\s*p_provider_reason\)/);
    // The decision is in the verdict only: none of its tests is repeated in the guard.
    for (const test of ['allowed_mailboxes', 'content_sources', 'reader_registration_active', "'seat_inactive'", "'no_consent'"]) {
      expect(guard, test).not.toContain(test);
    }
    // Round 2, item 6: the caller names its provider, from the same list, and a
    // difference from the source's is a refusal the SQL writes.
    expect(guard).toContain('p_provider         text default null');
    expect(listAfter(/p_provider not in \(([^)]*)\)/)).toEqual(MAILBOX_PROVIDERS);
    // Round 3, item 6: no source row, no read, for every purpose, before the provider comparison.
    expect(verdict).toContain(`return '${MAILBOX_REFUSAL_REASON.NO_SOURCE}'`);
    expect(`${verdict}${guard}`).not.toContain("coalesce(v_provider, 'microsoft')");
    expect(verdict.indexOf(`'${MAILBOX_REFUSAL_REASON.NO_SOURCE}'`)).toBeLessThan(verdict.indexOf('p_provider <> v_source.provider'));
    expect(verdict).toContain('if p_provider is not null and p_provider <> v_source.provider then');
    expect(verdict).toContain(`return '${MAILBOX_REFUSAL_REASON.PROVIDER_MISMATCH}'`);
    expect(verdict).toContain('select * into v_source from content_sources cs');
    // C11: the source's current owner is bound for every purpose, before the caller's own owner check.
    expect(verdict).toContain('if v_source.owner_user_id is distinct from v_allowed.user_id then');
    expect(verdict.indexOf('v_source.owner_user_id is distinct from v_allowed.user_id')).toBeLessThan(verdict.indexOf('elsif p_check_owner'));
    // M6: a paused source is refused after the owner tests, in the same decision the status reports.
    expect(verdict).toContain("elsif v_source.status <> 'active' then");
    expect(verdict).toContain(`return '${MAILBOX_REFUSAL_REASON.SOURCE_PAUSED}'`);
    expect(verdict.indexOf('elsif p_check_owner')).toBeLessThan(verdict.indexOf("v_source.status <> 'active'"));
    expect(verdict).toContain('reader_registration_active(p_tenant_id, v_source.provider)');
    expect(verdict).toContain('reader_firm_company_ids(p_tenant_id, v_source.provider)');
    expect(verdict).toContain('reader_mailbox_domains(p_tenant_id, v_source.provider)');
    expect(verdict).toMatch(/from allowed_mailboxes\s+where tenant_id = p_tenant_id and address = v_address and provider = v_source\.provider/);
    // The verdict writes nothing and only service_role runs it.
    expect(verdict).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(code).toContain('grant execute on function mailbox_guard_verdict(uuid, text, text, boolean, uuid) to service_role;');
    // Every mailbox reason the guard can return is a value the SQL writes (the team ones are written by 20261019140000).
    for (const reason of MAILBOX_REFUSAL_REASONS.filter((r) => !TEAM_REASONS.includes(r))) expect(mailboxSql).toContain(`'${reason}'`);
    // R21: the grant locks the caller's users row before it decides on the seat.
    const grant = /create or replace function mailbox_consent_grant\(\)[\s\S]*?\n\$\$;/.exec(mailboxSql)?.[0] ?? '';
    expect(grant).toContain('perform 1 from users where id = v_user for share;');
    expect(grant.indexOf('for share')).toBeLessThan(grant.indexOf('from mailbox_seated_invites'));
    // C20: the opt-in creates the mailbox source, never overwriting an existing row, and the audit row names it.
    expect(grant).toContain('insert into content_sources (tenant_id, kind, address, owner_user_id, provider, status)');
    expect(grant).toContain('on conflict (tenant_id, kind, lower(address)) do nothing');
    expect(grant).toContain('cardinality(v_providers) = 1');
    expect(mailboxSql).toContain("'sourceCreated'");
    // Item 1: the opt-in adopts an ownerless source and audits it, and reports whether the guard will read.
    expect(grant).toContain('update content_sources set owner_user_id = v_user');
    expect(grant).toContain('where id = v_source and owner_user_id is null');
    expect(mailboxSql).toContain("'sourceAdopted'");
    expect(grant).toContain("'reading', v_reason is null, 'readingReason', v_reason");
    // Round 3, H1: an ownerless source that still holds provenance rows is archived (renamed, paused, stamped), never
    // adopted, and the archive is audited; a firm admin merges it through the one signed-in RPC that does.
    expect(code).toContain('add column if not exists archived_at timestamptz');
    expect(code).toContain('add column if not exists archived_from_address text');
    expect(grant).toContain('v_owner is null and exists (select 1 from source_item_sources s where s.content_source_id = v_source)');
    expect(grant).toContain("status = 'paused'");
    expect(grant).toContain("'~' ||");
    expect(grant).toContain(`'${DISCOVERY_AUDIT_ACTION.MAILBOX_SOURCE_ARCHIVED}'`);
    expect(grant).toContain("'archivedSourceId', v_archived");
    const unify = /create or replace function discovery_unify_mailbox_sources\(p_archived uuid, p_target uuid\)[\s\S]*?\n\$\$;/.exec(code)?.[0] ?? '';
    expect(unify).toContain(`'${DISCOVERY_AUDIT_ACTION.MAILBOX_SOURCES_UNIFIED}'`);
    expect(unify).toContain("firm_role = 'admin'");
    expect(unify).toContain('on conflict (source_item_id, content_source_id) do nothing');
    expect(unify).toContain('discovery_refresh_candidate_visibility(v_cand)');
    expect(code).toContain('grant execute on function discovery_unify_mailbox_sources(uuid, uuid) to authenticated;');
    // Round 4: the merge needs an active target on the archived row's provider and checks deal_discovery itself
    // (failing closed: no row, no merge); an archive forgets the guard's last refusal for the address; the fresh
    // source takes the old provider only while it is eligible; the firm's CCO is told with the admins; and the
    // last_reason CHECK is restated after the table, so a database that ran an earlier version takes the new reasons.
    expect(unify).toContain("v_tgt.status <> 'active'");
    expect(unify).toContain('v_tgt.provider is distinct from v_arch.provider');
    for (const refusal of ['unify_target_not_active', 'unify_provider_mismatch', 'unify_discovery_disabled']) {
      expect(unify, refusal).toContain(`raise exception '${refusal}' using errcode = 'P0001'`);
    }
    expect(unify).toContain("select 1 from feature_flags where key = 'deal_discovery' and enabled");
    expect(grant).toContain('delete from mailbox_guard_state where tenant_id = v_seat.tenant_id and address = v_seat.address;');
    expect(grant).toContain('v_old_provider = any (v_providers)');
    expect(grant).toContain("u.firm_role in ('admin', 'cco')");
    expect(grant).toContain("jsonb_build_object('archivedSourceId', v_archived)");
    expect(code).toMatch(
      /alter table mailbox_guard_state drop constraint if exists mailbox_guard_state_last_reason_check;\s*alter table mailbox_guard_state add constraint mailbox_guard_state_last_reason_check\s*check \(last_reason in \(/,
    );
    // Round 3, A2: the opt-in needs MD or deal team on a deal of the member's tenant (every provider), refused
    // not_eligible; the helper is the one place the rule lives, and only the grant and the status helper call it.
    const onDeal = /create or replace function mailbox_member_on_a_deal\([\s\S]*?\n\$\$;/.exec(code)?.[0] ?? '';
    expect(onDeal).toContain("dm.deal_role in ('md', 'deal_team')");
    expect(onDeal).toContain('d.tenant_id = p_tenant_id');
    expect(grant).toContain('mailbox_member_on_a_deal(v_seat.tenant_id, v_user)');
    // After the already-consented return (a precondition for opening a consent, not for keeping one), before the insert.
    expect(grant.indexOf('mailbox_member_on_a_deal')).toBeGreaterThan(grant.indexOf('Already consented'));
    expect(grant.indexOf('mailbox_member_on_a_deal')).toBeLessThan(grant.indexOf('insert into mailbox_consents (tenant_id'));
    expect(grant).toContain("raise exception 'not_eligible' using errcode = '42501'");
    // Not a guard condition (the owner can flip that): mailbox_guard_check never reads deal memberships.
    for (const decision of [guard, verdict]) {
      expect(decision).not.toContain('deal_memberships');
      expect(decision).not.toContain('mailbox_member_on_a_deal');
    }
    // A takeover starts a fresh backfill, and the firm admins hear of each binding.
    expect(grant).toContain('delta_checkpoint = null');
    expect(grant).toContain(`'${NOTIFICATION_EVENT.MAILBOX_CONNECTED}'`);
    // The readiness reasons are the TS mirror (audit round 3, A3): the verdict's reasons (the caller's provider_mismatch
    // is not a member's), the two the helper decides before the verdict (domain, not_on_a_deal), and no_invite, which
    // the status reports for a caller with no seat. The helper calls the verdict and decides nothing else.
    const reading = /create or replace function mailbox_reading_reason\([\s\S]*?\n\$\$;/.exec(code)?.[0] ?? '';
    expect(reading).toContain('mailbox_guard_verdict(p_tenant_id, p_address, null, true, p_user)');
    const returnedBy = (fn: string) =>
      [...fn.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]).filter((value): value is string => Boolean(value));
    const verdictReasons = returnedBy(verdict);
    expect(verdictReasons.length).toBeGreaterThan(0);
    // Every reason the verdict returns is one the guard's own check constraint and TS list know.
    for (const reason of verdictReasons) expect(MAILBOX_REFUSAL_REASONS as string[], reason).toContain(reason);
    const memberReasons = returnedBy(reading);
    expect([...MAILBOX_READING_REASONS].sort()).toEqual(
      [
        ...new Set([
          ...verdictReasons.filter((reason) => reason !== MAILBOX_REFUSAL_REASON.PROVIDER_MISMATCH),
          ...memberReasons,
          MAILBOX_READING_REASON.NO_INVITE,
        ]),
      ].sort(),
    );
    const statusSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261001140000_mailbox_consent_status.sql'),
      'utf8',
    ).replace(/--.*$/gm, '');
    expect(statusSql).toContain(`'readingReason', '${MAILBOX_READING_REASON.NO_INVITE}'`);
    expect(statusSql).toContain("'readingReason', v_reason");
    // C13: a voluntary withdrawal states its reason instead of reading it from the seat.
    const withdraw = /create or replace function mailbox_consent_withdraw\(\)[\s\S]*?\n\$\$;/.exec(mailboxSql)?.[0] ?? '';
    expect(withdraw).toContain("set_config('conductia.mailbox_withdraw_reason', 'withdrawn', true)");
  });

  it('reads graph_reader_registrations only from the provider-aware functions and the Graph-only site view (C5)', () => {
    // The claim #259 relies on: nothing takes the firm, the domains or "is the reader active" from the
    // Graph registration alone except these. A new reader of it must go through the provider-aware
    // functions (so a Google mailbox can never pass on the Graph registration), or be Graph-only on purpose.
    const dir = join(process.cwd(), 'supabase/migrations');
    const readers = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
      const code = readFileSync(join(dir, file), 'utf8').replace(/--.*$/gm, '');
      const definitions = [
        ...code.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z_0-9]+)\s*\([\s\S]*?\$\$;/gi),
        ...code.matchAll(/create\s+(?:or\s+replace\s+)?view\s+([a-z_0-9]+)\s+as[\s\S]*?;/gi),
      ];
      for (const [text, name] of definitions) if (text.includes('graph_reader_registrations')) readers.add(name);
    }
    expect([...readers].sort()).toEqual([
      'allowed_sites',
      // Graph-only on purpose (#243): the Graph connector's health panel shows its
      // registration's status and consent date, and decides no access (pinned below).
      'discovery_ingestion_health',
      // Provider-aware: locks both providers' registration rows before the active check.
      'discovery_purge_tenant',
      'firm_company_ids',
      'reader_firm_company_ids',
      'reader_mailbox_domains',
      'reader_registration_active',
    ]);
    const health = readFileSync(join(dir, '20260925150000_discovery_health.sql'), 'utf8').replace(/--.*$/gm, '');
    const uses = health.match(/[^\n]*\n[^\n]*from graph_reader_registrations[^\n]*/g) ?? [];
    expect(uses).toEqual([
      "      select jsonb_build_object('status', r.status, 'consentedAt', r.consented_at)\n      from graph_reader_registrations r",
    ]);
  });

  it('keeps the site allowlist tables, reasons and Graph-only view aligned with their migration', () => {
    const siteSql = readFileSync(join(process.cwd(), 'supabase/migrations/20261001180000_site_allowlist.sql'), 'utf8');
    const code = siteSql.replace(/--.*$/gm, '');
    expect(code).toContain(`create table if not exists ${TABLE.REGISTERED_SITES} (`);
    expect(code).toMatch(new RegExp(`alter table ${TABLE.REGISTERED_SITES}\\s+enable row level security`));
    expect(code).toMatch(new RegExp(`view ${TABLE.ALLOWED_SITES}\\b`));
    // Every site reason the guard can return is a value the SQL writes.
    for (const reason of SITE_REFUSAL_REASONS) expect(code).toContain(`'${reason}'`);
    // L8: a lost registrant is told apart from a wrong firm, before it, with the one standing predicate.
    const siteGuard = /create or replace function site_guard_check\([\s\S]*?\n\$\$;/.exec(code)?.[0] ?? '';
    expect(siteGuard).toContain(`v_reason := '${SITE_REFUSAL_REASON.SITE_REGISTRANT_LOST}'`);
    expect(siteGuard).toContain('not site_registrant_stands(v_latest.tenant_id, v_latest.firm_company_id, v_latest.registered_by)');
    expect(siteGuard.indexOf(SITE_REFUSAL_REASON.SITE_REGISTRANT_LOST)).toBeLessThan(siteGuard.indexOf(SITE_REFUSAL_REASON.SITE_WRONG_FIRM));
    // The three site audit actions are written here and declared in the CHECK.
    for (const action of [
      DISCOVERY_AUDIT_ACTION.SITE_REGISTERED,
      DISCOVERY_AUDIT_ACTION.SITE_UNREGISTERED,
      DISCOVERY_AUDIT_ACTION.SITE_REFUSED,
    ]) {
      expect(code).toContain(`'${action}'`);
    }
    // Round 2, item 7: a site source can only be Microsoft's, because the site
    // guard judges every site against the Microsoft registration.
    expect(code).toMatch(/add constraint content_sources_site_provider_check\s+check \(kind <> 'sharepoint_site' or provider = 'microsoft'\)/);
    // Sites are read by the Graph reader only: the view keys on the active Graph
    // registration and never on reader_firm_company_ids(), which #259 extends
    // with the Google registration's firm, so that cannot admit a site.
    const view = /create or replace view allowed_sites as[\s\S]*?;/.exec(code)?.[0] ?? '';
    expect(view).toContain('join graph_reader_registrations');
    expect(view).not.toContain('reader_firm_company_ids');
    // Append-only: DELETE is revoked from the service role explicitly.
    expect(code).toMatch(/revoke all on registered_sites from [^;]*service_role;/);
    // No INSERT for the service role either (audit round 1, item 15): a row comes only from site_register().
    expect(code).toContain('grant select, update on registered_sites to service_role;');
    expect(code).not.toMatch(/grant [^;]*insert[^;]* on registered_sites to service_role/);
  });

  it('keeps the Google registration table, statuses and source constraints aligned with their migrations (#259, plan D1, D8)', () => {
    const dir = join(process.cwd(), 'supabase/migrations');
    const strip = (file: string): string => readFileSync(join(dir, file), 'utf8').replace(/--.*$/gm, '');
    const registration = strip('20261002175000_google_reader_registrations.sql');
    expect(registration).toContain(`create table if not exists ${TABLE.GOOGLE_READER_REGISTRATIONS} (`);
    expect(registration).toMatch(new RegExp(`alter table ${TABLE.GOOGLE_READER_REGISTRATIONS}\\s+enable row level security`));
    const statusList = /check \(status in \(([^)]*)\)\)/.exec(registration)?.[1];
    expect(statusList, 'google_reader_registrations.status CHECK').toBeDefined();
    expect(quotedValues(statusList ?? '').sort()).toEqual([...GOOGLE_REGISTRATION_STATUSES].sort());
    expect(GOOGLE_READER_TABLE).toBe(TABLE.GOOGLE_READER_REGISTRATIONS);
    // No user reaches the table (the worker and operator scripts use the service role).
    expect(registration).toMatch(/revoke all on google_reader_registrations from public, anon, authenticated;/);

    const sources = strip('20261002180000_discovery_google_sources.sql');
    expect(sources).toContain('add constraint content_sources_google_mailbox_check check (provider <> \'google\' or kind = \'mailbox\')');
    // Each provider's sources reference that provider's registration, on delete restrict (C14).
    expect(sources).toMatch(/content_sources_ms_registration_fkey\s+foreign key \(ms_registration_tenant\) references graph_reader_registrations \(tenant_id\) on delete restrict/);
    expect(sources).toMatch(/content_sources_g_registration_fkey\s+foreign key \(g_registration_tenant\) references google_reader_registrations \(tenant_id\) on delete restrict/);
    expect(sources).toContain('drop constraint if exists content_sources_tenant_id_fkey');
  });

  it('revokes from service_role, by name, before each narrow grant on the allowlist relations (audit round 1, item 17)', () => {
    const strip = (file: string): string =>
      readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/--.*$/gm, '');
    const sources: Array<[string, string, string[]]> = [
      ['20261001130000_mailbox_allowlist.sql', 'mailbox_consents', ['select, update']],
      ['20261001130000_mailbox_allowlist.sql', 'mailbox_seated_invites, allowed_mailboxes', ['select']],
      ['20261001130000_mailbox_allowlist.sql', 'mailbox_guard_state', ['select, insert, update, delete']],
      ['20261001160000_mailbox_allowlist_drift.sql', 'mailbox_allowlist_drift', ['select, insert, update, delete']],
      ['20261001180000_site_allowlist.sql', 'registered_sites', ['select, update']],
      ['20261001180000_site_allowlist.sql', 'allowed_sites', ['select']],
    ];
    for (const [file, relations, [privileges]] of sources) {
      const code = strip(file);
      const revoke = code.indexOf(`revoke all on ${relations} from public, anon, authenticated, service_role;`);
      const grant = code.indexOf(`grant ${privileges} on ${relations} to service_role;`);
      expect(revoke, `${file}: revoke for ${relations}`).toBeGreaterThanOrEqual(0);
      expect(grant, `${file}: grant for ${relations}`).toBeGreaterThan(revoke);
    }
  });

  it('binds an opt-in and a site registration to the session and guards invite deletes (audit round 1, items 13, 14, 15)', () => {
    const strip = (file: string): string =>
      readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/--.*$/gm, '');
    const mailbox = strip('20261001130000_mailbox_allowlist.sql');
    expect(mailbox).toMatch(/create trigger mailbox_consents_require_owner before insert on mailbox_consents/);
    expect(mailbox).toContain('auth.uid() is distinct from new.user_id');
    expect(mailbox).toMatch(/create trigger mailbox_consents_close_on_invite_delete before delete on invites/);
    const sites = strip('20261001180000_site_allowlist.sql');
    expect(sites).toContain('auth.uid() is distinct from v_admin');
    expect(sites).toMatch(/create trigger source_item_sources_tenant_match\s+before insert/);
    expect(sites).toMatch(/create trigger evidence_links_tenant_match\s+before insert/);
  });

  it('keeps the allowlist drift enums, table and notification event aligned with their migration', () => {
    const listAfter = (marker: RegExp): string[] => {
      const match = marker.exec(mailboxAllowlistDriftSql.replace(/--.*$/gm, ''));
      expect(match, String(marker)).not.toBeNull();
      return quotedValues(match?.[1] ?? '');
    };
    expect(listAfter(/provider\s+text not null check \(provider in \(([^)]*)\)/)).toEqual(MAILBOX_PROVIDERS);
    expect(listAfter(/status\s+text not null check \(status in \(([^)]*)\)/)).toEqual(DRIFT_STATUSES);
    expect(mailboxAllowlistDriftSql).toContain(`create table if not exists ${TABLE.MAILBOX_ALLOWLIST_DRIFT} (`);
    expect(mailboxAllowlistDriftSql).toMatch(
      new RegExp(`alter table ${TABLE.MAILBOX_ALLOWLIST_DRIFT}\\s+enable row level security`),
    );
    expect(mailboxAllowlistDriftSql).toContain(`'${NOTIFICATION_EVENT.MAILBOX_ALLOWLIST_DRIFT}'`);
    expect(mailboxAllowlistDriftSql).toContain(`'${NOTIFICATION_EVENT.MAILBOX_CONNECTED}'`);
  });

  it('keeps the milestone, assessment and ledger enums aligned with the milestones migration', () => {
    const milestonesSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261002200000_discovery_milestones.sql'),
      'utf8',
    ).replace(/--.*$/gm, '');
    const listAfter = (marker: RegExp): string[] => {
      const match = marker.exec(milestonesSql);
      expect(match, String(marker)).not.toBeNull();
      return quotedValues(match?.[1] ?? '');
    };
    // The milestone types, in order: the engine's vocabulary and the CHECK are one list.
    expect(listAfter(/\btype\s+text not null check \(type in \(([^)]*)\)/)).toEqual([...MILESTONE_TYPES]);
    // The trigger list as first created, and as 20261023130100 restates it ('purge', #173 G-07): a widening only.
    const scopedSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261023130100_discovery_scoped_assessments.sql'),
      'utf8',
    ).replace(/--.*$/gm, '');
    const restated = /add constraint stage_assessments_trigger_check\s+check \(trigger in \(([^)]*)\)\)/.exec(scopedSql);
    expect(restated, 'the restated trigger CHECK').not.toBeNull();
    expect(quotedValues(restated?.[1] ?? '')).toEqual(STAGE_TRIGGERS);
    expect(STAGE_TRIGGERS.slice(0, 3)).toEqual(listAfter(/\btrigger\s+text not null check \(trigger in \(([^)]*)\)/));
    expect(listAfter(/check \(flags <@ array\[([^\]]*)\]/)).toEqual(ASSESSMENT_FLAGS);
    expect(listAfter(/check \(lifecycle_suggestion in \(([^)]*)\)/)).toEqual(LIFECYCLE_SUGGESTIONS);
    expect(listAfter(/\boutcome\s+text not null check \(outcome in \(([^)]*)\)/)).toEqual(MODEL_CALL_OUTCOMES);
    expect(listAfter(/\btransport\s+text not null check \(transport in \(([^)]*)\)/)).toEqual(MODEL_CALL_TRANSPORTS);
    for (const key of ['MILESTONE_EVENTS', 'STAGE_ASSESSMENTS', 'MODEL_CALLS', 'DISCOVERY_RECOMPUTE_REQUESTS'] as const) {
      expect(milestonesSql, key).toContain(`create table if not exists ${TABLE[key]} (`);
      expect(milestonesSql, key).toMatch(new RegExp(`alter table ${TABLE[key]}\\s+enable row level security`));
    }
    // The widened ai_usage source, and the one source that may have no actor (T13).
    expect(listAfter(/add constraint ai_usage_source_check\s+check \(source in \(([^)]*)\)/)).toEqual([
      'screen',
      'agent_run',
      'bench_chat',
      'twin_chat',
      'discovery_extract',
    ]);
    expect(milestonesSql).toMatch(/check \(actor_id is not null or source = 'discovery_extract'\)/);
  });

  it('keeps the demo proposal outcomes aligned with the proposals migration, a table with no text column (#460)', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261014120000_discovery_model_proposals.sql'),
      'utf8',
    ).replace(/--.*$/gm, '');
    const outcomes = /\boutcome\s+text not null check \(outcome in \(([^)]*)\)/.exec(sql);
    expect(outcomes).not.toBeNull();
    expect(quotedValues(outcomes?.[1] ?? '')).toEqual(PROPOSAL_OUTCOMES);
    expect(sql).toContain(`create table if not exists ${TABLE.DISCOVERY_MODEL_PROPOSALS} (`);
    expect(sql).toMatch(new RegExp(`alter table ${TABLE.DISCOVERY_MODEL_PROPOSALS}\\s+enable row level security`));
    // No mail text: no subject, body, address, participant or display-name column.
    const columns = /create table if not exists discovery_model_proposals \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? '';
    expect(columns).not.toMatch(/\b(subject|body|body_text|address|participants|display_name|internet_message_id)\b/);
  });

  it('keeps the tenant capabilities aligned with the shared approvals migration, a table only a migration writes (G-01 #173)', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261023110100_discovery_tenant_approvals.sql'),
      'utf8',
    ).replace(/--.*$/gm, '');
    const capabilities = /\bcapability\s+text not null check \(capability in \(([^)]*)\)/.exec(sql);
    expect(capabilities).not.toBeNull();
    expect(quotedValues(capabilities?.[1] ?? '')).toEqual(TENANT_CAPABILITIES);
    expect(sql).toContain(`create table if not exists ${TABLE.DISCOVERY_TENANT_APPROVALS} (`);
    expect(sql).toMatch(new RegExp(`alter table ${TABLE.DISCOVERY_TENANT_APPROVALS}\\s+enable row level security`));
    // Closed to every API role but a read for the worker, and the audit action is the one the constants declare.
    expect(sql).toMatch(
      new RegExp(`revoke all on ${TABLE.DISCOVERY_TENANT_APPROVALS} from public, anon, authenticated, service_role`),
    );
    expect(sql).toMatch(new RegExp(`grant select on ${TABLE.DISCOVERY_TENANT_APPROVALS} to service_role`));
    expect(sql).not.toMatch(/grant\s+(?:insert|update|delete|truncate|all)\b/i);
    expect(sql).toContain(`'${DISCOVERY_AUDIT_ACTION.TENANT_APPROVAL_CHANGED}'`);
  });

  it('keeps the team proposal pass aligned with its migration, a table only three definers write (G-01 #173)', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261023110200_discovery_team_proposal_pass.sql'),
      'utf8',
    ).replace(/--.*$/gm, '');
    const outcomes = /\boutcome\s+text check \(outcome in \(([^)]*)\)/.exec(sql);
    expect(outcomes).not.toBeNull();
    expect(quotedValues(outcomes?.[1] ?? '')).toEqual(TEAM_PROPOSAL_PASS_OUTCOMES);
    expect(sql).toContain(`create table if not exists ${TABLE.DISCOVERY_TEAM_PROPOSAL_PASSES} (`);
    expect(sql).toMatch(new RegExp(`alter table ${TABLE.DISCOVERY_TEAM_PROPOSAL_PASSES}\\s+enable row level security`));
    // Closed to every API role but a read for the worker; the definers are the only writers.
    expect(sql).toMatch(
      new RegExp(`revoke all on ${TABLE.DISCOVERY_TEAM_PROPOSAL_PASSES} from public, anon, authenticated, service_role`),
    );
    expect(sql).toMatch(new RegExp(`grant select on ${TABLE.DISCOVERY_TEAM_PROPOSAL_PASSES} to service_role`));
    expect(sql).not.toMatch(/grant\s+(?:insert|update|delete|truncate|all)\b/i);
    expect(sql).toContain(`'${DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_PROPOSAL_STARTED}'`);
    expect(sql).toContain(`'${DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_PROPOSAL_FINISHED}'`);
    // The pass checks the approval through the one shared reader, for exactly the team_proposals capability.
    expect(sql).toContain(`app_tenant_capability_on(p_tenant, o_firm, '${TENANT_CAPABILITY.TEAM_PROPOSALS}')`);
  });

  it('keeps the model proposal dismissals aligned with their migration, the key out of every message (G-02a #173)', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261023120100_model_proposal_dismissals.sql'),
      'utf8',
    ).replace(/--.*$/gm, '');
    expect(sql).toContain(`create table if not exists ${TABLE.DISCOVERY_MODEL_PROPOSAL_DISMISSALS} (`);
    expect(sql).toMatch(new RegExp(`alter table ${TABLE.DISCOVERY_MODEL_PROPOSAL_DISMISSALS}\\s+enable row level security`));
    for (const action of [
      DISCOVERY_AUDIT_ACTION.MODEL_PROPOSAL_DISMISSED,
      DISCOVERY_AUDIT_ACTION.MODEL_PROPOSAL_DISMISSAL_RESTORED,
    ]) {
      expect(sql, action).toContain(`'${action}'`);
    }
    // The deal key carries a slug of a mail-derived name: no raised message and no audit insert names it.
    const raises = [...sql.matchAll(/raise exception[^;]*;/g)].map((m) => m[0]);
    expect(raises.length).toBeGreaterThan(0);
    for (const raise of raises) expect(raise).not.toMatch(/p_deal_key|%/);
    const audits = [...sql.matchAll(/insert into audit_log[\s\S]*?;/g)].map((m) => m[0]);
    expect(audits).toHaveLength(2);
    for (const audit of audits) expect(audit).not.toMatch(/deal_key/);
    // A restore marks, never deletes; the dismiss RPC is the signed-in role's, the helper and restore are not.
    expect(sql).not.toMatch(/delete\s+from\s+discovery_model_proposal_dismissals/i);
    expect(sql).toContain('grant execute on function discovery_dismiss_model_proposal(text) to authenticated;');
    expect(sql).not.toMatch(/grant execute on function app_can_read_model_proposal[^;]*authenticated/);
    expect(sql).not.toMatch(/grant execute on function discovery_restore_model_proposal_dismissals[^;]*authenticated/);
  });

  it('keeps the model proposal accepts aligned with their migration, the key out of every message (G-02b #173)', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261023140100_model_proposal_accepts.sql'),
      'utf8',
    ).replace(/--.*$/gm, '');
    expect(sql).toContain(`create table if not exists ${TABLE.DISCOVERY_MODEL_PROPOSAL_ACCEPTS} (`);
    expect(sql).toMatch(new RegExp(`alter table ${TABLE.DISCOVERY_MODEL_PROPOSAL_ACCEPTS}\\s+enable row level security`));
    // The audit action it writes is the one the constant names; the other is slice 1b's finish.
    expect(sql).toContain(`'${DISCOVERY_AUDIT_ACTION.MODEL_PROPOSAL_ACCEPT_REQUESTED}'`);
    // The deal key carries a slug of a mail-derived name: no raised message and no audit insert names it.
    const raises = [...sql.matchAll(/raise exception[^;]*;/g)].map((m) => m[0]);
    expect(raises.length).toBeGreaterThan(0);
    for (const raise of raises) expect(raise).not.toMatch(/p_deal_key|%/);
    const audits = [...sql.matchAll(/insert into audit_log[\s\S]*?;/g)].map((m) => m[0]);
    expect(audits).toHaveLength(1);
    for (const audit of audits) expect(audit).not.toMatch(/deal_key|cluster/);
    // The request is stored and audited, and nothing else: no candidate, proposal row, station or mail is written.
    expect(sql).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+(deal_candidates|discovery_model_proposals|corrections|source_items|evidence_links|deals)\b/i);
    expect(sql).not.toMatch(/station_override|current_step_seq|current_deal_step_id/);
    // Signed-in users read the rows and call the RPC; they never write the table.
    expect(sql).toContain('grant execute on function discovery_accept_model_proposal(text, text) to authenticated;');
    expect(sql).toMatch(/grant select on discovery_model_proposal_accepts to authenticated;/);
    expect(sql).not.toMatch(/grant [^;]*(insert|update|delete)[^;]* on discovery_model_proposal_accepts to authenticated/i);
  });

  it('keeps the route methods and correction actions aligned with the latest restatement of their CHECKs (G-02b #173)', () => {
    // Each widening restates the whole CHECK; the newest restatement is the one in force.
    const dir = join(process.cwd(), 'supabase/migrations');
    const files = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
    const latestList = (constraint: string, column: string): string[] => {
      const found = files
        .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8').replace(/--.*$/gm, '') }))
        .map(({ file, text }) => ({
          file,
          list: new RegExp(`add constraint ${constraint}\\s+check \\(${column} in \\(([^)]*)\\)\\)`).exec(text)?.[1],
        }))
        .filter((entry) => entry.list !== undefined)
        .at(-1);
      expect(found, constraint).toBeDefined();
      return quotedValues(found?.list ?? '');
    };
    expect(latestList('evidence_links_method_check', 'method')).toEqual(ROUTE_METHODS);
    expect(latestList('routing_ledger_method_check', 'method')).toEqual(ROUTE_METHODS);
    expect(latestList('corrections_action_check', 'action')).toEqual(CORRECTION_ACTIONS);
    expect(ROUTE_METHODS).toContain(ROUTE_METHOD.MODEL_PROPOSAL);
    expect(CORRECTION_ACTIONS).toContain(CORRECTION_ACTION.ACCEPT_PROPOSAL);
    // The two big tables go back NOT VALID (supabase/lint/big-tables.txt); the small correction log is validated.
    const checks = readFileSync(join(dir, '20261023140200_model_proposal_accept_checks.sql'), 'utf8').replace(/--.*$/gm, '');
    expect(checks).toMatch(/evidence_links_method_check[^;]*not valid;/);
    expect(checks).toMatch(/routing_ledger_method_check[^;]*not valid;/);
    expect(checks).not.toMatch(/corrections_action_check[^;]*not valid/);
  });

  it('keeps the accept worker definers service-role only, the key and the text out of every message (G-02b #173)', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261023140300_model_proposal_accept_worker.sql'),
      'utf8',
    ).replace(/--.*$/gm, '');
    const definers = [
      'discovery_claim_model_proposal_accepts',
      'discovery_renew_model_proposal_accept',
      'discovery_model_proposal_accept_live_keys',
      'discovery_mark_model_proposal_accept_storing',
      'discovery_mark_model_proposal_accept_stored',
      'discovery_finish_model_proposal_accept',
      'discovery_expire_model_proposal_accepts',
    ];
    for (const name of definers) {
      expect(sql, name).toContain(`create or replace function ${name}(`);
      expect(sql, name).toMatch(new RegExp(`revoke all on function ${name}\\([^)]*\\) from public, anon, authenticated;`));
      expect(sql, name).toMatch(new RegExp(`grant execute on function ${name}\\([^)]*\\) to service_role;`));
    }
    expect(sql.match(/security definer set search_path = public, pg_temp/g)).toHaveLength(definers.length);
    expect(sql).not.toMatch(/grant execute on function[^;]*\bto\b[^;]*\b(authenticated|anon|public)\b/i);
    // No raised message and no audit insert carries the deal key, a slug, a name or a message key.
    const raises = [...sql.matchAll(/raise exception[^;]*;/g)].map((m) => m[0]);
    expect(raises.length).toBeGreaterThan(0);
    for (const raise of raises) expect(raise).not.toMatch(/deal_key|%/);
    const audits = [...sql.matchAll(/insert into audit_log[\s\S]*?;/g)].map((m) => m[0]);
    expect(audits).toHaveLength(2);
    for (const audit of audits) {
      expect(audit).toContain(`'${DISCOVERY_AUDIT_ACTION.MODEL_PROPOSAL_ACCEPT_FINISHED}'`);
      expect(audit).not.toMatch(/deal_key|cluster|message_key|storing_keys|mkey/);
    }
    // The accept path writes no station, pin, deal or cursor, and deletes no item or text (the orphan collector does).
    expect(sql).not.toMatch(/station_override|current_step_seq|current_deal_step_id|\bpinned\b/);
    expect(sql).not.toMatch(
      /\b(insert\s+into|update|delete\s+from)\s+(deals|deal_steps|deal_candidates|source_items|source_item_texts|evidence_links)\b/i,
    );
    // The re-key sets the key and the candidate id together; the purge touches this source's holder rows only.
    expect(sql).toMatch(/deal_key = 'c:' \|\| v_target::text, candidate_id = v_target/);
    expect(sql).toMatch(/delete from source_item_sources d\s+using gone g\s+where d\.source_item_id = g\.item_id and d\.content_source_id = v_req\.content_source_id/);
    expect(sql).toMatch(/conversation_id = s\.conversation_id, internet_message_id = s\.internet_message_id/);
    // An accept purges only what it newly stored: the write-ahead records only keys the source does not hold (and
    // returns them), and the purge has no evidence exemption.
    expect(sql).toMatch(
      /function discovery_mark_model_proposal_accept_storing\(p_request uuid, p_token text, p_keys text\[\]\)\s+returns text\[\]/,
    );
    expect(sql).not.toMatch(/\bv_own\b/);
    expect(sql).toMatch(/v_purge := array\(select k from unnest\(v_keys\) k where not \(k = any \(v_linked\)\)\);/);
    // Expire also finishes lapsed in-flight requests, through the finish, on a fresh token; a null tenant covers all.
    expect(sql).toMatch(/'expire:' \|\| gen_random_uuid\(\)::text/);
    expect(sql).toMatch(/discovery_finish_model_proposal_accept\(v_req\.id, v_token, null, 'source_unavailable'\)/);
    expect(sql).toMatch(/create index if not exists discovery_model_proposal_accepts_inflight_idx/);
  });

  it('keeps the ledger sources aligned with the latest ai_usage_source_check (skill_run, skill_authoring, #155)', () => {
    // Each widening restates the whole CHECK; the newest restatement is the one in force.
    const dir = join(process.cwd(), 'supabase/migrations');
    const latest = readdirSync(dir)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => readFileSync(join(dir, file), 'utf8').replace(/--.*$/gm, ''))
      .filter((text) => text.includes('add constraint ai_usage_source_check'))
      .at(-1);
    expect(latest).toBeDefined();
    const sql = latest ?? '';
    const match = /add constraint ai_usage_source_check\s+check \(source in \(([^)]*)\)/.exec(sql);
    expect(match).not.toBeNull();
    expect(quotedValues(match?.[1] ?? '')).toEqual([...AI_USAGE_SOURCES]);
  });

  it('keeps the correction actions and the log aligned with the corrections migration', () => {
    const correctionsSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261002210000_discovery_corrections.sql'),
      'utf8',
    ).replace(/--.*$/gm, '');
    const match = /\baction\s+text not null check \(action in \(([^)]*)\)/.exec(correctionsSql);
    expect(match).not.toBeNull();
    // Widened by G-02b's checks migration (accept_proposal), pinned in its own test below; the original ten stay first.
    expect(CORRECTION_ACTIONS.slice(0, 10)).toEqual(quotedValues(match?.[1] ?? ''));
    expect(correctionsSql).toContain(`create table if not exists ${TABLE.CORRECTIONS} (`);
    expect(correctionsSql).toMatch(new RegExp(`alter table ${TABLE.CORRECTIONS}\\s+enable row level security`));
  });

  it('keeps the Gmail pause and status RPCs aligned with their migration (#259 phase 4)', () => {
    const code = googleConnectSql.replace(/--.*$/gm, '');
    // The one new audit action is declared and written by pause and resume.
    expect(code).toContain(`'${DISCOVERY_AUDIT_ACTION.MAILBOX_ACCESS_CHANGED}'`);
    // Connecting is #262's one-click opt-in: no connect RPC, no 'connected' change, no second notification event.
    expect(code).not.toContain('discovery_connect_google_mailbox');
    expect(code).not.toMatch(/'change',\s*'connected'/);
    expect(code).not.toContain('notifications_event_type_check');
    // The CHECK restated here keeps every action the previous one held, develop's archive and merge included.
    const history = actionCheckHistory();
    const last = history.at(-1);
    // #263 restated the CHECK with discovery.exclusion_policy_changed, the rail catalog with
    // rail.template_published, #370 with the two reader pass actions, #461 with
    // discovery.mailbox_purged, then discovery.content_collected, then discovery.tenant_purged, then
    // discovery.retention_policy_set and discovery.mailbox_retained, #490 with the sending mailbox actions, and the
    // team inbox (#581) with its five discovery.team_mailbox_* actions, the shared tenant approvals (G-01 #173) with
    // discovery.tenant_approval_changed, the team inbox pass (G-01 #173) with its started and finished actions,
    // G-02a (#173) with the two discovery.model_proposal_dismissed/_restored actions, the rule detector (#173 G-07
    // slice 3b) with its two detection actions, and G-02b (#173) with the two discovery.model_proposal_accept_*
    // actions, so the pin moved to its migration.
    expect(last?.file).toBe('20261023140000_model_proposal_accept_audit.sql');
    expect(history.some((entry) => entry.file === '20261023130600_discovery_milestone_rules.sql')).toBe(true);
    expect(history.some((entry) => entry.file === '20261023120000_model_proposal_dismissal_audit.sql')).toBe(true);
    expect(history.some((entry) => entry.file === '20261023110200_discovery_team_proposal_pass.sql')).toBe(true);
    expect(history.some((entry) => entry.file === '20261017120000_mailbox_connections_google.sql')).toBe(true);
    expect(history.some((entry) => entry.file === '20261014160000_tenant_retention_policy.sql')).toBe(true);
    expect(history.some((entry) => entry.file === '20261014140000_discovery_purge_tenant.sql')).toBe(true);
    expect(history.some((entry) => entry.file === '20261014130000_discovery_purge_wiring.sql')).toBe(true);
    expect(history.some((entry) => entry.file === '20261014120500_discovery_purge.sql')).toBe(true);
    expect(history.some((entry) => entry.file === '20261006120000_discovery_reader_pass.sql')).toBe(true);
    expect(history.some((entry) => entry.file === '20261005100000_rail_catalog_publish.sql')).toBe(true);
    expect(history.some((entry) => entry.file === '20261003110000_discovery_exclusion_policy.sql')).toBe(true);
    expect(history.some((entry) => entry.file === '20261002181000_discovery_google_connect.sql')).toBe(true);
    for (const action of [...AUDIT_ACTIONS, ...DISCOVERY_AUDIT_ACTIONS]) expect(last?.actions).toContain(action);
    // Two signed-in RPCs, none reachable by anon, each granted to authenticated.
    for (const fn of ['discovery_google_mailbox_status()', 'discovery_set_mailbox_source_status(uuid, text)']) {
      expect(code).toContain(fn);
    }
    expect(code).toMatch(/revoke all on function [^;]*from public, anon;/);
    expect(code).toMatch(/grant execute on function [^;]*to authenticated, service_role;/);
    // The notification the opt-in sends stays #262's.
    expect(mailboxAllowlistDriftSql).toContain(`'${NOTIFICATION_EVENT.MAILBOX_CONNECTED}'`);
  });

  it('keeps the one reader liveness window aligned with its migration (reader liveness)', () => {
    // The latest migration that defines discovery_reader_live(): the window both the source row and the reader line use.
    const dir = join(process.cwd(), 'supabase/migrations');
    const file = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) => /create or replace function discovery_reader_live\(/.test(readFileSync(join(dir, f), 'utf8')))
      .at(-1);
    expect(file, 'a migration defines discovery_reader_live').toBeDefined();
    const code = readFileSync(join(dir, file!), 'utf8').replace(/--.*$/gm, '');
    const live = /function discovery_reader_live\([\s\S]*?\$\$([\s\S]*?)\$\$/.exec(code)?.[1] ?? '';
    expect(live).toContain(`interval '${READER_LIVENESS_SECONDS} seconds'`);
    // The unfinished pass and the reader line are both judged by it, and the progress mark feeds both.
    expect(code).toMatch(/discovery_reader_live\(greatest\(lp\.started_ts, c\.reader_progress_at\)\)/);
    expect(code).toMatch(/not discovery_reader_live\(r\.last_active_at\)/);
    expect(code).toMatch(/greatest\(act\.ts, c\.reader_progress_at\) as activity_at/);
  });

  it('keeps the halted-source restart RPC aligned with its migration (reader liveness)', () => {
    const code = readFileSync(join(process.cwd(), 'supabase/migrations/20261008210000_discovery_restart_source.sql'), 'utf8').replace(
      /--.*$/gm,
      '',
    );
    // It writes the existing audit action with the new change, and keys on the code handleExpiry writes.
    expect(code).toContain(`'${DISCOVERY_AUDIT_ACTION.MAILBOX_ACCESS_CHANGED}'`);
    expect(code).toMatch(/'change',\s*'restarted'/);
    expect(code).toContain(`'${HISTORY_WINDOW_EXCEEDED}'`);
    // The restart cooldown is the TS twin's, and the only interval in the RPC.
    expect([...code.matchAll(/interval '(\d+) seconds'/g)].map((m) => Number(m[1]))).toEqual([SOURCE_RESTART_COOLDOWN_SECONDS]);
    // One signed-in RPC, not reachable by anon, granted to authenticated.
    expect(code).toContain('discovery_restart_mailbox_source(uuid)');
    expect(code).toMatch(/revoke all on function [^;]*from public, anon;/);
    expect(code).toMatch(/grant execute on function [^;]*to authenticated, service_role;/);
    // The action list is not restated: no new action, so the CHECK keeps its last definition.
    expect(code).not.toContain('audit_log_action_check');
  });

  it('keeps the ingestion window default aligned with its migration (#353)', () => {
    const code = readFileSync(join(process.cwd(), 'supabase/migrations/20261016120000_discovery_backfill_window.sql'), 'utf8').replace(
      /--.*$/gm,
      '',
    );
    expect(code).toMatch(/add column if not exists backfill_since date;/);
    // Both day counts, the never-read backfill and every later insert's DEFAULT, are the TS twin's, and the only ones.
    expect([...code.matchAll(/::date - (\d+)/g)].map((m) => Number(m[1]))).toEqual([BACKFILL_WINDOW_DEFAULT_DAYS, BACKFILL_WINDOW_DEFAULT_DAYS]);
    expect(code).toContain(`set backfill_since = (created_at at time zone 'utc')::date - ${BACKFILL_WINDOW_DEFAULT_DAYS}`);
    expect(code).toContain(`set default ((now() at time zone 'utc')::date - ${BACKFILL_WINDOW_DEFAULT_DAYS})`);
    // Only Google mailboxes that have never read get it: a source that has read keeps the whole mailbox it read.
    expect(code.replace(/\s+/g, ' ')).toContain(
      "where provider = 'google' and kind = 'mailbox' and archived_at is null " +
        'and delta_checkpoint is null and backfill_started_at is null and backfill_completed_at is null;',
    );
  });

  it('keeps the team inbox registry and connect RPC aligned with their migration (#581)', () => {
    const code = readFileSync(join(process.cwd(), 'supabase/migrations/20261019100000_team_mailboxes.sql'), 'utf8').replace(
      /--.*$/gm,
      '',
    );
    const flat = code.replace(/\s+/g, ' ');
    expect(code).toContain(`create table if not exists ${TABLE.TEAM_MAILBOXES} (`);
    expect(code).toMatch(new RegExp(`alter table ${TABLE.TEAM_MAILBOXES} enable row level security;`));
    expect(code).not.toMatch(/create policy/i);
    // The CHECK enums are the constants'.
    const status = /check_status\s+text not null default 'pending' check \(check_status in \(([^)]*)\)\)/.exec(code);
    expect(quotedValues(status?.[1] ?? '')).toEqual(TEAM_MAILBOX_CHECK_STATUSES);
    const reason = /check_reason\s+text check \(check_reason in\s*\(([^)]*)\)\)/.exec(code);
    expect(quotedValues(reason?.[1] ?? '')).toEqual(TEAM_MAILBOX_CHECK_REASONS);
    const error = /last_check_error\s+text check \(last_check_error in \(([^)]*)\)\)/.exec(code);
    expect(quotedValues(error?.[1] ?? '')).toEqual(TEAM_MAILBOX_CHECK_ERRORS);
    const disconnect = /disconnected_reason text check \(disconnected_reason in \(([^)]*)\)\)/.exec(code);
    // Phase 3 widens it (no_mail); every reason here stays one of the constants'.
    expect(TEAM_MAILBOX_DISCONNECT_REASONS).toEqual(expect.arrayContaining(quotedValues(disconnect?.[1] ?? '')));
    expect(flat).toContain("provider text not null check (provider = 'google')");
    // The attestation starts at the constant's version, and the window bounds are the constants'.
    expect(TEAM_MAILBOX_ATTESTATION_VERSION).toBeGreaterThanOrEqual(1);
    expect(flat).toContain('p_attestation_version < 1');
    expect([...code.matchAll(/v_today - (\d+)/g)].map((m) => Number(m[1]))).toEqual([TEAM_MAILBOX_WINDOW_MAX_DAYS]);
    // The default window is the ingestion window's: the only day count besides the bound above.
    expect([...code.matchAll(/::date - (\d+)/g)].map((m) => Number(m[1]))).toEqual([BACKFILL_WINDOW_DEFAULT_DAYS]);
    // The connect RPC is closed to every API role until its route lands, and the audit actions are declared.
    expect(code).toMatch(
      /revoke all on function discovery_connect_team_mailbox\(text, integer, date\) from public, anon, authenticated;/,
    );
    expect(code).not.toMatch(/grant execute on function discovery_connect_team_mailbox/);
    for (const action of [
      DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_CONNECTED,
      DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_CHECKED,
      DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_MEMBER_ADDED,
      DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_MEMBER_REMOVED,
      DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_DISCONNECTED,
    ]) {
      expect(code, action).toContain(`'${action}'`);
    }
    // No audit row written here (the connect and the archive) names the address.
    const audits = [...code.matchAll(/insert into audit_log[\s\S]*?;/g)].map((m) => m[0]);
    expect(audits.length).toBeGreaterThan(0);
    for (const audit of audits) expect(audit, 'audit detail').not.toMatch(/v_address|v_tm\.address|archive_address/);
    // The notification and the source row are where the address is allowed to be.
    expect(code).toContain("'mailbox_connected'");
  });

  it('keeps the team inbox list, connect grant and remove aligned with their migration (#581 phase 3)', () => {
    const code = readFileSync(join(process.cwd(), 'supabase/migrations/20261019120000_team_mailbox_list.sql'), 'utf8').replace(
      /--.*$/gm,
      '',
    );
    // The connect RPC reaches the signed-in role here and nowhere else; the two new RPCs are closed to anon and PUBLIC.
    expect(code).toContain('grant execute on function discovery_connect_team_mailbox(text, integer, date) to authenticated;');
    for (const fn of ['discovery_team_mailboxes()', 'discovery_remove_team_mailbox(uuid)']) {
      expect(code, fn).toContain(`revoke all on function ${fn} from public, anon, authenticated;`);
      expect(code, fn).toContain(`grant execute on function ${fn} to authenticated;`);
    }
    // Remove closes with never_verified or no_mail, the CHECK it restates is the constants', and it audits with the
    // declared action, ids only.
    const widened = /add constraint team_mailboxes_disconnected_reason_check\s+check \(disconnected_reason in \(([^)]*)\)\)/.exec(code);
    expect(quotedValues(widened?.[1] ?? '')).toEqual(TEAM_MAILBOX_DISCONNECT_REASONS);
    expect(code).toContain("v_reason := case when v_tm.verified_at is null then 'never_verified' else 'no_mail' end;");
    expect(code).toContain('disconnected_reason = v_reason');
    expect(code).toContain(`'${DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_DISCONNECTED}'`);
    const audits = [...code.matchAll(/insert into audit_log[\s\S]*?;/g)].map((m) => m[0]);
    expect(audits.length).toBeGreaterThan(0);
    for (const audit of audits) expect(audit, 'audit detail').not.toMatch(/address/);
    // The audit CHECK is not restated: phase 1's carries the team actions.
    expect(code).not.toContain('audit_log_action_check');
  });

  it('keeps the team inbox check functions aligned with their migration (#581 phase 5)', () => {
    const code = readFileSync(join(process.cwd(), 'supabase/migrations/20261019130000_team_mailbox_check.sql'), 'utf8').replace(
      /--.*$/gm,
      '',
    );
    const flat = code.replace(/\s+/g, ' ');
    // Both are the worker's: the service role alone, no signed-in grant anywhere in the file.
    for (const fn of ['discovery_team_mailbox_check_due(uuid)', 'discovery_record_team_mailbox_check(uuid, text, text, text)']) {
      expect(code, fn).toContain(`revoke all on function ${fn} from public, anon, authenticated;`);
      expect(code, fn).toContain(`grant execute on function ${fn} to service_role;`);
    }
    expect(code).not.toMatch(/to authenticated|to anon|to public/i);
    // The refusal reasons the recorder accepts are the registry's CHECK list, and the one transient error is the constant's.
    const reasons = /p_reason not in \(([^)]*)\)/.exec(code);
    expect(quotedValues(reasons?.[1] ?? '')).toEqual(TEAM_MAILBOX_CHECK_REASONS);
    expect(TEAM_MAILBOX_CHECK_ERRORS).toEqual(['directory_error']);
    expect(code).toContain("p_reason is distinct from 'directory_error'");
    expect(code).toContain("last_check_error = 'directory_error'");
    // The statuses the worker reports are the registry's, plus the transient error that is not a status.
    expect(quotedValues(/p_status not in \(([^)]*)\)/.exec(code)?.[1] ?? '')).toEqual([
      ...TEAM_MAILBOX_CHECK_STATUSES.filter((status) => status !== 'pending'),
      'error',
    ]);
    // When a check is due: a verified row at 15 minutes (the freshness window is 65), a pending or refused one at 4
    // (every tick, which is every 5 minutes).
    expect(flat).toContain("tm.verified_at < now() - interval '15 minutes'");
    expect(flat).toContain("tm.checked_at < now() - interval '4 minutes'");
    // A status or reason change is audited with the declared action, ids and fixed codes only; the audit CHECK is not restated.
    expect(code).toContain(`'${DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_CHECKED}'`);
    const audits = [...code.matchAll(/insert into audit_log[\s\S]*?;/g)].map((m) => m[0]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).not.toMatch(/address/);
    expect(code).not.toContain('audit_log_action_check');
  });

  it('keeps the team inbox guard aligned with its migration, and the personal path of the verdict byte for byte (#581 phase 7)', () => {
    const dir = join(process.cwd(), 'supabase/migrations');
    const read = (file: string) => readFileSync(join(dir, file), 'utf8').replace(/--.*$/gm, '');
    const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
    const code = read('20261019140000_team_mailbox_guard.sql');
    const original = read('20261001130000_mailbox_allowlist.sql');
    const phase2 = read('20261019110000_team_mailbox_audit_ids.sql');
    const fn = (sql: string, name: string) => new RegExp(`create or replace function ${name}\\([\\s\\S]*?\\n\\$\\$;`).exec(sql)?.[0] ?? '';

    // The guard's remembered reasons: restated whole, in the TS list's order; the original is that list without the team ones.
    const TEAM_REASONS: string[] = [
      MAILBOX_REFUSAL_REASON.TEAM_MAILBOX_UNVERIFIED,
      MAILBOX_REFUSAL_REASON.TEAM_MAILBOX_DISCONNECTED,
      MAILBOX_REFUSAL_REASON.TEAM_MAILBOX_PERSON,
    ];
    expect(quotedValues(/check \(last_reason in \(([^)]*)\)/.exec(code)?.[1] ?? '')).toEqual(SOURCE_REFUSAL_REASONS);
    expect(code).toMatch(/alter table mailbox_guard_state drop constraint if exists mailbox_guard_state_last_reason_check;\s*alter table mailbox_guard_state add constraint mailbox_guard_state_last_reason_check/);
    expect(SOURCE_REFUSAL_REASONS.filter((reason) => !TEAM_REASONS.includes(reason))).toEqual(
      quotedValues(/check \(last_reason in \(([^)]*)\)/.exec(original)?.[1] ?? ''),
    );
    // Not restated: the audit action CHECK. Phase 1's list still stands.
    expect(code).not.toContain('audit_log_action_check');

    // The view: no clock, a confirmed and unrefused open registration, nobody's address, service role only.
    const view = /create or replace view allowed_team_mailboxes as[\s\S]*?;/.exec(code)?.[0] ?? '';
    expect(view).not.toBe('');
    expect(view).not.toMatch(/now\(\)|interval|current_(date|timestamp)|clock_timestamp/i);
    const flatView = norm(view);
    for (const condition of [
      'tm.disconnected_at is null',
      'tm.verified_at is not null',
      "tm.check_status <> 'refused'",
      'p.provider = tm.provider',
      'mailbox_reader_providers(tm.tenant_id, tm.address, tm.firm_company_id)',
      'from users u where lower(u.email) = tm.address',
      "i.status in ('pending', 'accepted')",
    ]) {
      expect(flatView, condition).toContain(condition);
    }
    expect(code).toContain('revoke all on allowed_team_mailboxes from public, anon, authenticated, service_role;');
    expect(code).toContain('grant select on allowed_team_mailboxes to service_role;');
    expect(TABLE.ALLOWED_TEAM_MAILBOXES).toBe('allowed_team_mailboxes');

    // The verdict: the five-argument function goes, the six-argument one takes the purpose, service role only.
    expect(code).toContain('drop function if exists mailbox_guard_verdict(uuid, text, text, boolean, uuid);');
    expect(code.indexOf('drop function if exists mailbox_guard_verdict(')).toBeLessThan(code.indexOf('create or replace function mailbox_guard_verdict('));
    const verdict = fn(code, 'mailbox_guard_verdict');
    const originalVerdict = fn(original, 'mailbox_guard_verdict');
    expect(verdict).not.toBe('');
    expect(norm(verdict)).toContain("p_purpose text default 'provider_read'");
    expect(norm(verdict)).toContain('set search_path = public, pg_temp');
    expect(code).toContain('revoke all on function mailbox_guard_verdict(uuid, text, text, boolean, uuid, text) from public, anon, authenticated;');
    expect(code).toContain('grant execute on function mailbox_guard_verdict(uuid, text, text, boolean, uuid, text) to service_role;');
    expect(verdict).not.toMatch(/\b(insert|update|delete)\b/i);
    // The personal path is #262's, byte for byte: the source lookup and provider test above the team branch, and everything
    // from the allowlist lookup down.
    const head = (text: string, end: string) => norm(text.slice(text.indexOf('select * into v_source from content_sources cs'), text.indexOf(end)));
    expect(head(verdict, 'if v_source.team_mailbox_id is not null then')).toBe(head(originalVerdict, 'select * into v_allowed from allowed_mailboxes'));
    const tail = (text: string) => norm(text.slice(text.indexOf('select * into v_allowed from allowed_mailboxes')));
    expect(tail(verdict)).toBe(tail(originalVerdict));
    // The team branch sits between them, ahead of the allowlist lookup, and returns each team reason.
    expect(verdict.indexOf('if v_source.team_mailbox_id is not null then')).toBeGreaterThan(verdict.indexOf("return 'provider_mismatch'"));
    expect(verdict.indexOf('if v_source.team_mailbox_id is not null then')).toBeLessThan(verdict.indexOf('select * into v_allowed from allowed_mailboxes'));
    for (const reason of TEAM_REASONS) expect(verdict, reason).toContain(`return '${reason}'`);
    // Freshness is judged here, once, from verified_at, and is the only interval in the file; the check is renewed
    // sooner (phase 5's due rule), so a pass starts with the difference to read in.
    expect([...code.matchAll(/interval '(\d+) minutes'/g)].map((m) => Number(m[1]))).toEqual([TEAM_MAILBOX_READ_WINDOW_MINUTES]);
    expect(norm(verdict)).toContain(`v_verified <= now() - interval '${TEAM_MAILBOX_READ_WINDOW_MINUTES} minutes'`);
    expect(TEAM_MAILBOX_READ_WINDOW_MINUTES).toBe(65);
    expect(TEAM_MAILBOX_RENEW_MINUTES).toBeLessThan(TEAM_MAILBOX_READ_WINDOW_MINUTES);
    expect(norm(read('20261019130000_team_mailbox_check.sql'))).toContain(`tm.verified_at < now() - interval '${TEAM_MAILBOX_RENEW_MINUTES} minutes'`);
    // A team source has no owner: a named owner and any purpose but the worker's provider_read are refused, as owner_mismatch.
    const team = norm(verdict.slice(verdict.indexOf('if v_source.team_mailbox_id is not null then'), verdict.indexOf('select * into v_allowed from allowed_mailboxes')));
    expect(team).toContain("if p_owner_user_id is not null then return 'owner_mismatch'; elsif p_purpose is distinct from 'provider_read' then return 'owner_mismatch';");
    expect(team).toContain("elsif v_source.status <> 'active' then return 'source_paused';");

    // The guard passes the purpose to the verdict and is otherwise phase 2's body.
    const guard = fn(code, 'mailbox_guard_check');
    expect(norm(guard)).toContain('mailbox_guard_verdict(p_tenant_id, v_address, p_provider, coalesce(p_check_owner, false), p_owner_user_id, p_purpose)');
    expect(norm(guard.replace('p_owner_user_id, p_purpose)', 'p_owner_user_id)'))).toBe(norm(fn(phase2, 'mailbox_guard_check')));
    expect(code).toContain('grant execute on function mailbox_guard_check(uuid, text, text, text, boolean, uuid, text, text) to service_role;');
    // Its refusal row stays ids only for a team source.
    expect(norm(guard)).toContain("jsonb_build_object('teamMailboxId', v_team)");
  });

  it('keeps the team inbox members aligned with their migration, and Remove and the list restated from phase 3 (#581 phase 8)', () => {
    const dir = join(process.cwd(), 'supabase/migrations');
    const read = (file: string) => readFileSync(join(dir, file), 'utf8').replace(/--.*$/gm, '');
    const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
    const fn = (sql: string, name: string) => new RegExp(`create or replace function ${name}\\([\\s\\S]*?\\n\\$\\$;`).exec(sql)?.[0] ?? '';
    const code = read('20261019150000_team_mailbox_members.sql');
    const phase3 = read('20261019120000_team_mailbox_list.sql');
    const flat = norm(code);

    // The table: RLS and no policy, service role reads it, nobody signed in touches it; the removal reasons are the constant's.
    expect(code).toContain(`create table if not exists ${TABLE.TEAM_MAILBOX_MEMBERS} (`);
    expect(code).toMatch(new RegExp(`alter table ${TABLE.TEAM_MAILBOX_MEMBERS} enable row level security;`));
    expect(code).not.toMatch(/create policy/i);
    expect(quotedValues(/removed_reason\s+text check \(removed_reason in \(([^)]*)\)\)/.exec(code)?.[1] ?? '')).toEqual(
      TEAM_MAILBOX_MEMBER_REMOVED_REASONS,
    );
    expect(code).toContain(`revoke all on ${TABLE.TEAM_MAILBOX_MEMBERS} from public, anon, authenticated, service_role;`);
    expect(code).toContain(`grant select on ${TABLE.TEAM_MAILBOX_MEMBERS} to service_role;`);
    // The readers view: open members of an open registration, judged now, with no clock; the service role's alone.
    const view = norm(/create or replace view team_mailbox_readers as[\s\S]*?;/.exec(code)?.[0] ?? '');
    expect(view).not.toBe('');
    expect(view).not.toMatch(/now\(\)|interval|current_(date|timestamp)|clock_timestamp/i);
    for (const condition of ['tm.disconnected_at is null', 'm.removed_at is null', 'u.company_id = tm.firm_company_id']) {
      expect(view, condition).toContain(condition);
    }
    expect(code).toContain(`revoke all on ${TABLE.TEAM_MAILBOX_READERS} from public, anon, authenticated, service_role;`);
    expect(code).toContain(`grant select on ${TABLE.TEAM_MAILBOX_READERS} to service_role;`);

    // One eligibility test, in the view, the add RPC and the list: kept identical.
    const eligible = "status = 'active' and is_external = false and firm_role is distinct from 'admin'";
    expect(flat.replace(/\b(?:u|eu)\./g, '').split(eligible).length - 1).toBe(3);

    // The four RPCs are the signed-in role's, closed to anon and PUBLIC; the three trigger functions are nobody's.
    for (const rpc of [
      'discovery_add_team_mailbox_member(uuid, uuid)',
      'discovery_remove_team_mailbox_member(uuid, uuid)',
      'discovery_team_mailboxes()',
      'discovery_remove_team_mailbox(uuid)',
    ]) {
      expect(code, rpc).toContain(`revoke all on function ${rpc} from public, anon, authenticated;`);
      expect(code, rpc).toContain(`grant execute on function ${rpc} to authenticated;`);
    }
    for (const trigger of ['guard', 'audit', 'close_on_seat_loss']) {
      expect(code, trigger).toContain(`revoke all on function team_mailbox_members_${trigger}() from public, anon, authenticated;`);
    }
    expect([...code.matchAll(/grant execute on function ([a-z_]+)/g)].map((m) => m[1]).sort()).toEqual([
      'discovery_add_team_mailbox_member',
      'discovery_remove_team_mailbox',
      'discovery_remove_team_mailbox_member',
      'discovery_team_mailboxes',
    ]);

    // Every writer of membership takes the tenant's discovery lock before it writes anything (design R5).
    const writes = /\b(?:insert into|update|delete from)\b/;
    for (const name of [
      'discovery_add_team_mailbox_member',
      'discovery_remove_team_mailbox_member',
      'discovery_remove_team_mailbox',
      'team_mailbox_members_close_on_seat_loss',
    ]) {
      const body = fn(code, name);
      expect(body, name).not.toBe('');
      const lock = body.indexOf('perform discovery_lock_tenant(');
      expect(lock, `${name} takes the tenant lock`).toBeGreaterThan(-1);
      expect(lock, `${name} locks before it writes`).toBeLessThan(body.search(writes));
    }

    // Audit: the declared actions, written by the trigger alone for membership, ids and a fixed reason only.
    expect(code).toContain(`'${DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_MEMBER_ADDED}'`);
    expect(code).toContain(`'${DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_MEMBER_REMOVED}'`);
    expect(norm(fn(code, 'team_mailbox_members_audit'))).toContain(
      "jsonb_build_object('teamMailboxId', new.team_mailbox_id, 'userId', new.user_id)",
    );
    const audits = [...code.matchAll(/insert into audit_log[\s\S]*?;/g)].map((m) => m[0]);
    expect(audits.length).toBeGreaterThan(0);
    for (const audit of audits) expect(audit, 'audit detail').not.toMatch(/address|email|\bname\b/i);
    expect(code).not.toContain('audit_log_action_check');
    // The rules of the membership row: closed once, and a seat lost is no admin's act.
    expect(flat).toContain("removed_reason is distinct from 'removed' or removed_by is not null");
    expect(flat).toContain("removed_reason is distinct from 'seat_lost' or removed_by is null");

    // Remove is phase 3's body, restated with exactly two additions: the lock first, and the members closed.
    const removeNow = norm(fn(code, 'discovery_remove_team_mailbox'));
    const removeThen = norm(fn(phase3, 'discovery_remove_team_mailbox'));
    expect(removeThen).not.toBe('');
    expect(norm(
      removeNow
        .replace('perform discovery_lock_tenant(v_user.tenant_id);', '')
        .replace(
          "update team_mailbox_members set removed_at = now(), removed_by = v_uid, removed_reason = 'disconnected' where team_mailbox_id = v_tm.id and removed_at is null;",
          '',
        ),
    )).toBe(removeThen);
    expect(removeNow).toContain("removed_reason = 'disconnected'");
    // The list keeps its phase 3 columns and adds the two.
    const listNow = norm(fn(code, 'discovery_team_mailboxes'));
    for (const key of ['id', 'address', 'provider', 'connectedAt', 'checkStatus', 'checkReason', 'checkedAt', 'lastCheckError', 'sourceId', 'sourceStatus', 'backfillSince', 'removable']) {
      expect(listNow, key).toContain(`'${key}'`);
      expect(norm(fn(phase3, 'discovery_team_mailboxes')), key).toContain(`'${key}'`);
    }
    expect(listNow).toContain("'members', coalesce(");
    expect(listNow).toContain("'eligible', coalesce(");
  });

  it('keeps the team inbox visibility aligned with its migration, and the personal branches of the helpers unchanged (#581 phase 10)', () => {
    const dir = join(process.cwd(), 'supabase/migrations');
    const read = (file: string) => readFileSync(join(dir, file), 'utf8').replace(/--.*$/gm, '');
    const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
    const fn = (sql: string, name: string) => new RegExp(`create or replace function ${name}\\([\\s\\S]*?\\n\\$\\$;`).exec(sql)?.[0] ?? '';
    // A function's body after its header, which is the part the personal path is judged by.
    const body = (sql: string, name: string) => {
      const text = norm(fn(sql, name));
      return text.slice(text.indexOf('as $$') + 5);
    };
    const code = read('20261019160000_team_mailbox_visibility.sql');
    const sites = read('20261001180000_site_allowlist.sql');
    const rls = read('20261001150000_mailbox_allowlist_rls.sql');
    const core = read('20260925120000_discovery_core.sql');
    const members = read('20261019150000_team_mailbox_members.sql');

    // No clock anywhere: the check's age is the guard's question alone (review round 2, M-A).
    expect(code).not.toMatch(/now\(\)|interval|current_(date|timestamp)|clock_timestamp/i);
    // The team-blind test stays team-blind, so the colleague branch cannot reach a team-only item.
    expect(code).not.toMatch(/create (?:or replace )?function app_item_has_allowed_source/);
    // Every definer here pins its path with pg_temp, which `create or replace` would otherwise reset.
    const created = [...code.matchAll(/create or replace function ([a-z_]+)\(/g)].map((m) => m[1]);
    expect(created).toEqual([
      'app_item_cco_allowed_source',
      'app_owns_item',
      'app_can_see_candidate',
      'app_can_see_item',
      'discovery_refresh_candidate_visibility',
      'team_mailbox_members_refresh_visibility',
      'app_visible_candidate_ids',
    ]);
    for (const name of created) expect(norm(fn(code, name)), name).toContain('set search_path = public, pg_temp');
    // Grants: the new helper is the service role's, the trigger function is nobody's, and nothing reaches a signed-in role.
    expect(code).toContain('revoke all on function app_item_cco_allowed_source(uuid) from public, anon, authenticated;');
    expect(code).toContain('grant execute on function app_item_cco_allowed_source(uuid) to service_role;');
    expect(code).toContain('revoke all on function team_mailbox_members_refresh_visibility() from public, anon, authenticated;');
    // The one signed-in grant and the one policy are audit item 5's: the set the evidence_links policy tests, asked once
    // per statement, and that policy restated with it in place of the per-link candidate call.
    const signedIn = [...code.matchAll(/^.*(?:to authenticated|to anon|to public).*$/gim)].map((m) => m[0].trim());
    expect(signedIn).toEqual([
      'grant execute on function app_visible_candidate_ids() to authenticated, service_role;',
      'create policy evidence_links_select on evidence_links for select to authenticated',
    ]);
    const visible = norm(fn(code, 'app_visible_candidate_ids'));
    expect(visible).toContain('where app_can_see_candidate(dc.id, auth.uid())');
    expect(visible).toContain('join users u on u.id = auth.uid() and u.tenant_id = dc.tenant_id');
    // The policy is 20261001150000's but for the candidate test.
    const policyOf = (sql: string) => norm(/create policy evidence_links_select[\s\S]*?\);\n/.exec(sql)?.[0] ?? '');
    expect(policyOf(code)).not.toBe('');
    expect(policyOf(code).replace('candidate_id in (select app_visible_candidate_ids())', 'app_can_see_candidate(candidate_id, auth.uid())')).toBe(
      policyOf(rls),
    );
    expect(code).not.toContain('audit_log_action_check');

    // app_owns_item: #318's two disjuncts, byte for byte, then the team one. It is PL/pgSQL for its plan cache (a SQL
    // function called from inside app_can_see_item is re-planned on every call), returning the same query.
    expect(norm(fn(code, 'app_owns_item'))).toContain('returns boolean language plpgsql security definer stable');
    const ownsBody = body(code, 'app_owns_item');
    expect(ownsBody.startsWith(' begin return (')).toBe(true);
    expect(ownsBody.endsWith('); end; $$;')).toBe(true);
    // Read as the SQL function it was: `begin return <q>; end;` holds the same query as `select <q>;`.
    const owns = ownsBody.replace(/^ begin return /, ' select ').replace(/ end; \$\$;$/, ' $$;');
    const ownsThen = body(sites, 'app_owns_item');
    const head = (text: string) => text.slice(0, text.indexOf('app_is_firm_admin(c.tenant_id, p_user))') + 'app_is_firm_admin(c.tenant_id, p_user))'.length);
    expect(head(ownsThen)).not.toBe('');
    expect(head(owns)).toBe(head(ownsThen));
    const ownsTeam = owns.slice(head(owns).length);
    for (const piece of [
      'c.team_mailbox_id is not null',
      'join allowed_team_mailboxes a on a.team_mailbox_id = c.team_mailbox_id and a.tenant_id = c.tenant_id and a.address = lower(c.address) and a.provider = c.provider',
      'm.user_id = p_user and m.removed_at is null',
      'ru.company_id = a.firm_company_id',
    ]) {
      expect(ownsTeam, piece).toContain(piece);
    }

    // app_can_see_item: the owner and colleague branches are the original's; only the CCO's test changed.
    const seeItem = body(code, 'app_can_see_item');
    const seeItemThen = body(rls, 'app_can_see_item');
    expect(seeItemThen).not.toBe('');
    expect(seeItem.replace('app_item_cco_allowed_source(si.id)', 'app_item_has_allowed_source(si.id)')).toBe(seeItemThen);
    expect(seeItem).toContain('(app_item_has_allowed_source(p_item) and exists (');

    // app_can_see_candidate: the personal evidence test keeps the original's conditions, the CCO's test changed, the team
    // test is new, and the two backing-evidence tests share ONE scan of the candidate's links (the evidence_links policy
    // calls this per link, so a scan the viewer fails before the other would walk every link per row).
    const seeCand = body(code, 'app_can_see_candidate');
    const seeCandThen = body(sites, 'app_can_see_candidate');
    expect(seeCandThen).toContain(
      "join content_sources c on c.id = s.content_source_id and c.kind = 'mailbox' and c.tenant_id = dc.tenant_id and c.owner_user_id = p_user " +
        'join allowed_mailboxes a on a.tenant_id = c.tenant_id and a.address = lower(c.address) and a.user_id = p_user and a.provider = c.provider',
    );
    expect(seeCand).toContain(
      "join content_sources c on c.id = s.content_source_id and c.kind = 'mailbox' and c.tenant_id = dc.tenant_id " +
        "where l.candidate_id = dc.id and l.state <> 'rejected' and (l.route_tier = 'firm' or l.state = 'confirmed')",
    );
    expect(seeCand).toContain(
      '(c.owner_user_id = p_user and exists (select 1 from allowed_mailboxes a ' +
        'where a.tenant_id = c.tenant_id and a.address = lower(c.address) and a.user_id = p_user and a.provider = c.provider))',
    );
    // One scan for the viewer, one for the control room.
    expect(seeCandThen.split('from evidence_links l').length - 1).toBe(2);
    expect(seeCand.split('from evidence_links l').length - 1).toBe(2);
    expect(seeCand.replace('app_item_cco_allowed_source(si.id)', 'app_item_has_allowed_source(si.id)')).toContain(
      seeCandThen.slice(seeCandThen.indexOf('or (app_is_firm_cco(dc.tenant_id, p_user)')),
    );
    expect(seeCand).not.toContain('app_item_has_allowed_source');
    for (const piece of [
      'c.team_mailbox_id is not null',
      'from allowed_team_mailboxes a join team_mailbox_members m on m.team_mailbox_id = a.team_mailbox_id',
      'where a.team_mailbox_id = c.team_mailbox_id and a.tenant_id = c.tenant_id and a.address = lower(c.address) and a.provider = c.provider',
      'm.user_id = p_user and m.removed_at is null',
      'a.firm_company_id = u.company_id',
    ]) {
      expect(seeCand, piece).toContain(piece);
    }

    // One reader test, in the view, the add RPC and the list (phase 8) and in these two helpers: kept identical.
    const eligible = "status = 'active' and is_external = false and firm_role is distinct from 'admin'";
    const count = (text: string) => text.replace(/\b(?:u|eu|ru)\./g, '').split(eligible).length - 1;
    expect(count(norm(code))).toBe(2);
    expect(count(norm(members))).toBe(3);

    // The refresh: the personal half is discovery_core's, the team half reads the readers view, summed per person.
    const refresh = body(code, 'discovery_refresh_candidate_visibility');
    const refreshThen = body(core, 'discovery_refresh_candidate_visibility');
    const personalRows =
      'from evidence_links l join deal_candidates dc on dc.id = l.candidate_id join source_item_sources s on s.source_item_id = l.source_item_id ' +
      'join content_sources c on c.id = s.content_source_id and c.tenant_id = dc.tenant_id join users u on u.id = c.owner_user_id and u.tenant_id = dc.tenant_id ' +
      "where l.candidate_id = p_candidate_id and l.state <> 'rejected' and (l.route_tier = 'firm' or l.state = 'confirmed')";
    expect(refreshThen).toContain(personalRows);
    expect(refresh).toContain(personalRows);
    expect(refresh).toContain('join team_mailbox_readers r on r.team_mailbox_id = c.team_mailbox_id and r.tenant_id = dc.tenant_id');
    expect(refresh).not.toContain('allowed_team_mailboxes');
    expect(refresh).toContain('union all');
    expect(refresh).toContain('count(distinct p.source_item_id)::integer');
    expect(refresh).toContain('group by p.candidate_id, p.person_id');

    // Lock order: the trigger takes the tenant's discovery lock before it refreshes, and it fires ahead of the audit trigger.
    const trigger = fn(code, 'team_mailbox_members_refresh_visibility');
    expect(trigger.indexOf('perform discovery_lock_tenant(')).toBeGreaterThan(-1);
    expect(trigger.indexOf('perform discovery_lock_tenant(')).toBeLessThan(trigger.indexOf('perform discovery_refresh_candidate_visibility('));
    const ours = /create trigger (\w+)\s+after insert or update of removed_at on team_mailbox_members/.exec(code)?.[1];
    const audit = /create trigger (\w+) after insert or update on team_mailbox_members/.exec(members)?.[1];
    expect(ours).toBe('team_mailbox_members_aa_visibility');
    expect(audit).toBe('team_mailbox_members_audit');
    expect(ours! < audit!, 'triggers of one event fire in name order').toBe(true);
  });

  it('keeps the team-blind helper and the model batch out of every G-07 migration (#173 G-07, design R1)', () => {
    // Team-inbox station suggestions (20261023130000..140900) add audiences beside the shared rows. They never make
    // app_item_has_allowed_source team-aware, and never touch the batch, so team-only mail still reaches no model.
    const dir = join(process.cwd(), 'supabase/migrations');
    const files = readdirSync(dir).filter((file) => /^20261023130\d{3}_.*\.sql$/.test(file));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const code = readFileSync(join(dir, file), 'utf8').replace(/--.*$/gm, '');
      expect(code, file).not.toMatch(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(?:app_item_has_allowed_source|discovery_extract_batch)\b/i);
    }
  });

  it('keeps the team inbox attach aligned with its migration: the verdict admits a reader and nothing else changes, and the Q21 predicate gains a reader disjunct (#581 phase 11)', () => {
    const dir = join(process.cwd(), 'supabase/migrations');
    const read = (file: string) => readFileSync(join(dir, file), 'utf8').replace(/--.*$/gm, '');
    const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
    const fn = (sql: string, name: string) => new RegExp(`create or replace function ${name}\\([\\s\\S]*?\\n\\$\\$;`).exec(sql)?.[0] ?? '';
    const code = read('20261019170000_team_mailbox_attach.sql');
    const guard = read('20261019140000_team_mailbox_guard.sql');
    const corrections = read('20261002210000_discovery_corrections.sql');

    // Two definers, restated in this order, each with the pinned path that `create or replace` would otherwise reset.
    const created = [...code.matchAll(/create or replace function ([a-z_]+)\(/g)].map((m) => m[1]);
    expect(created).toEqual(['mailbox_guard_verdict', 'discovery_item_owner_seated']);
    for (const name of created) expect(norm(fn(code, name)), name).toContain('set search_path = public, pg_temp');
    // Read-only: no write, so neither takes the tenant's discovery lock; the audit CHECK and the audit row are not this file's.
    expect(code).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(code).not.toContain('discovery_lock_tenant');
    expect(code).not.toContain('audit_log');
    // Grants are kept, never widened.
    expect(code).toContain('revoke all on function mailbox_guard_verdict(uuid, text, text, boolean, uuid, text) from public, anon, authenticated;');
    expect(code).toContain('grant execute on function mailbox_guard_verdict(uuid, text, text, boolean, uuid, text) to service_role;');
    expect(code).toContain('revoke all on function discovery_item_owner_seated(uuid, uuid) from public, anon, authenticated;');
    expect(code).toContain('grant execute on function discovery_item_owner_seated(uuid, uuid) to service_role;');
    expect(code).not.toMatch(/to authenticated|to anon|to public/i);
    // The signature is unchanged, so nothing is dropped and the guard (which passes owner and purpose through) is not restated.
    expect(code).not.toMatch(/drop function/i);
    expect(code).not.toContain('create or replace function mailbox_guard_check');

    // The verdict is phase 7's body but for the one block that decides a named person: everything above it (the source
    // lookup, the provider test, the freshness test) and everything below it (the not-in-view reasons and the personal path).
    const verdict = norm(fn(code, 'mailbox_guard_verdict'));
    const verdictThen = norm(fn(guard, 'mailbox_guard_verdict'));
    expect(verdict).not.toBe('');
    expect(verdictThen).not.toBe('');
    const named = 'if p_owner_user_id is not null then';
    const rest = 'select * into v_tm from team_mailboxes t';
    expect(verdict.slice(0, verdict.indexOf(named))).toBe(verdictThen.slice(0, verdictThen.indexOf(named)));
    expect(verdict.slice(verdict.indexOf(rest))).toBe(verdictThen.slice(verdictThen.indexOf(rest)));
    // The block: a named person must be a reader of THIS registration, now, in the same tenant; a null owner stays the
    // worker's provider_read alone; a pause still stops a reader; and a reader is judged after the freshness test.
    const block = verdict.slice(verdict.indexOf(named), verdict.indexOf(rest));
    expect(block).toContain(
      'from team_mailbox_readers r where r.team_mailbox_id = v_source.team_mailbox_id and r.tenant_id = p_tenant_id and r.user_id = p_owner_user_id',
    );
    expect(block).toContain("elsif p_purpose is distinct from 'provider_read' then return 'owner_mismatch';");
    expect(block.match(/return 'source_paused'/g)).toHaveLength(2);
    expect(verdict.indexOf("return 'team_mailbox_unverified'")).toBeLessThan(verdict.indexOf(named));
    // Freshness stays the verdict's alone, once.
    expect([...code.matchAll(/interval '(\d+) minutes'/g)].map((m) => Number(m[1]))).toEqual([TEAM_MAILBOX_READ_WINDOW_MINUTES]);
    // The readers view is the truth: the verdict does not re-derive the eligibility test.
    expect(verdict).not.toContain("firm_role is distinct from 'admin'");

    // Q21: the personal disjunct is 20261002210000's, byte for byte, then the team one.
    const seated = norm(fn(code, 'discovery_item_owner_seated'));
    const seatedThen = norm(fn(corrections, 'discovery_item_owner_seated'));
    expect(seatedThen).not.toBe('');
    const personal = (text: string) => text.slice(text.indexOf('select exists ('), text.indexOf('where sis.source_item_id = p_item') + 'where sis.source_item_id = p_item'.length);
    expect(personal(seated)).toBe(personal(seatedThen));
    expect(personal(seated)).toContain('join allowed_mailboxes a on a.tenant_id = cs.tenant_id and a.address = lower(cs.address) and a.user_id = cs.owner_user_id and a.provider = cs.provider');
    const team = seated.slice(seated.indexOf('or exists ('));
    for (const piece of [
      'cs.team_mailbox_id is not null',
      'join allowed_team_mailboxes a on a.team_mailbox_id = cs.team_mailbox_id and a.tenant_id = cs.tenant_id and a.address = lower(cs.address) and a.provider = cs.provider',
      'm.removed_at is null',
      'ru.company_id = a.firm_company_id',
      'join deal_memberships dm on dm.user_id = m.user_id and dm.deal_id = p_deal',
    ]) {
      expect(team, piece).toContain(piece);
    }
    // The same reader test as app_owns_item's team branch (phase 10), and no clock in the predicate.
    const eligible = "status = 'active' and is_external = false and firm_role is distinct from 'admin'";
    expect(team.replace(/\bru\./g, '').split(eligible).length - 1).toBe(1);
    expect(seated).not.toMatch(/now\(\)|interval|current_(date|timestamp)|clock_timestamp/i);
  });

  it('keeps the set-window RPC aligned with the owner decision and the health lock (#353)', () => {
    const code = readFileSync(join(process.cwd(), 'supabase/migrations/20261018110000_discovery_set_source_window.sql'), 'utf8').replace(
      /--.*$/gm,
      '',
    );
    // The 730-day bound is the TS twin's, and the only day count in the RPC.
    expect([...code.matchAll(/v_today - (\d+)/g)].map((m) => Number(m[1]))).toEqual([BACKFILL_WINDOW_MAX_DAYS]);
    expect([...code.matchAll(/ - (\d+)/g)].map((m) => Number(m[1]))).toEqual([BACKFILL_WINDOW_MAX_DAYS]);
    expect(code).toContain("v_today date := (now() at time zone 'utc')::date;");
    // The lock is the predicate the health RPC reports as windowLocked, so the panel's gate and the refusal agree.
    const lock = 'delta_checkpoint is not null or backfill_started_at is not null or backfill_completed_at is not null';
    expect(code.replace(/\s+/g, ' ').replace(/v_src\./g, '')).toContain(lock);
    const health = readFileSync(join(process.cwd(), 'supabase/migrations/20261018100000_discovery_health_window.sql'), 'utf8').replace(
      /--.*$/gm,
      '',
    );
    expect(health.replace(/\s+/g, ' ').replace(/\bc\./g, '')).toContain(lock);
    // It writes the existing audit action with the new change, and restates no action list.
    expect(code).toContain(`'${DISCOVERY_AUDIT_ACTION.MAILBOX_ACCESS_CHANGED}'`);
    expect(code).toMatch(/'change',\s*'window_set'/);
    expect(code).not.toContain('audit_log_action_check');
    // A definer that pins search_path (#312's form), not reachable by anon, granted to authenticated.
    expect(code).toMatch(/security definer set search_path = public, pg_temp/);
    expect(code).toContain('discovery_set_mailbox_source_window(uuid, date)');
    expect(code).toMatch(/revoke all on function [^;]*from public, anon;/);
    expect(code).toMatch(/grant execute on function [^;]*to authenticated, service_role;/);
  });

  it('mints the Gmail reader token under the readonly scope only: the window listing needs q, which metadata refuses (#353)', () => {
    const dir = join(process.cwd(), 'src/lib/google/reader');
    const scopes = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => [...readFileSync(join(dir, f), 'utf8').matchAll(/GMAIL_READER_SCOPE\.([A-Z_]+)/g)].map((m) => `${f}:${m[1]}`));
    expect(scopes).toEqual(['registration.ts:READONLY']);
    expect(GMAIL_READER_SCOPE.READONLY).toBe('https://www.googleapis.com/auth/gmail.readonly');
  });

  it('keeps the Google admin health aligned with its migration (#259 phase 5)', () => {
    const code = readFileSync(join(process.cwd(), 'supabase/migrations/20261002183000_discovery_google_health.sql'), 'utf8').replace(
      /--.*$/gm,
      '',
    );
    const list = /delegation_status text\s+check \(delegation_status in \(([^)]*)\)\)/.exec(code)?.[1];
    expect(list, 'google_reader_registrations.delegation_status CHECK').toBeDefined();
    expect(quotedValues(list ?? '').sort()).toEqual([...DELEGATION_STATUSES].sort());
    // The gate is #262's final one (20261001160000, C5), verbatim: the caller is active, internal, an admin
    // or CCO, seated in a firm firm_company_ids names (which unions both providers' registrations), and a
    // tenant that names no firm gets the empty no-registration shape. This migration sorts after #262's, so
    // restating anything narrower would regress it.
    const drift = readFileSync(join(process.cwd(), 'supabase/migrations/20261001160000_mailbox_allowlist_drift.sql'), 'utf8').replace(
      /--.*$/gm,
      '',
    );
    const gate = (sql: string): string => {
      const body = /create or replace function discovery_ingestion_health\(\)[\s\S]*?\n  with ledger as/.exec(sql)?.[0] ?? '';
      expect(body, 'discovery_ingestion_health gate').not.toBe('');
      return body.replace(/\s+/g, ' ');
    };
    const firmFrom = (sql: string) => sql.slice(sql.indexOf('v_uid uuid :='));
    expect(firmFrom(gate(code)).replace(/'registrations', '\[\]'::jsonb, 'allowlist', '\[\]'::jsonb, /, '').replace(/'viewerCanManageSources', false, 'reconciliation', 'not_built', /, '')).toBe(
      firmFrom(gate(drift)),
    );
    expect(code).toContain("v_role not in ('admin', 'cco')");
    expect(code).toContain('v_firms := firm_company_ids(v_tenant);');
    expect(code).toContain('(v_company = any (v_firms)) is not true');
    expect(code).toContain('status = \'active\' and is_external = false');
    // A mailbox's waiting reason is the database's own live verdict, then only the worker's provider-group reasons.
    expect(code).toContain('mailbox_guard_verdict(c.tenant_id, c.address, c.provider)');
    expect(code).toContain("g.last_reason in ('not_in_provider_group', 'mirror_unavailable')");
    // The Graph registration is only reported here, never used to decide access.
    expect((code.match(/graph_reader_registrations/g) ?? []).length).toBe(2);
    for (const key of ['registration', 'registrations', 'allowlist', 'sources', 'viewerCanManageSources', 'reconciliation', 'totals']) {
      expect(code, `payload key ${key}`).toContain(`'${key}'`);
    }
    // Reconciliation is reported as not built, never as a clean state.
    expect(code).toContain("'reconciliation', 'not_built'");
    // The group drift is counts only: no member address leaves the function.
    expect(code).not.toContain('missing_in_group,');
    expect(code).toContain('cardinality(d.missing_in_group)');
    expect(code).toContain('cardinality(d.extra_in_group)');
    expect(code).toMatch(/grant execute on function discovery_ingestion_health\(\) to authenticated, service_role;/);
  });

  it('keeps the exclusion health aligned with the Google health it restates (#263 phase 4)', () => {
    const read = (file: string) =>
      readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/--.*$/gm, '');
    const google = read('20261002183000_discovery_google_health.sql');
    const code = read('20261003120000_discovery_exclusion_health.sql');
    // The gate is #262's, via #259's restatement, verbatim: the only differences are the keys this migration
    // adds to the no-registration shape (policyVersion null, itemsExcluded 0).
    const gate = (sql: string): string => {
      const body = /create or replace function discovery_ingestion_health\(\)[\s\S]*?\n  with ledger as/.exec(sql)?.[0] ?? '';
      expect(body, 'discovery_ingestion_health gate').not.toBe('');
      return body.slice(body.indexOf('v_uid uuid :=')).replace(/\s+/g, ' ');
    };
    expect(gate(code).replace("'policyVersion', null, ", '').replace("'itemsExcluded', 0, ", '')).toBe(gate(google));
    expect(code).toContain("v_role not in ('admin', 'cco')");
    expect(code).toContain('v_firms := firm_company_ids(v_tenant);');
    expect(code).toContain('(v_company = any (v_firms)) is not true');
    // Every key the previous body returned is still returned.
    for (const key of ['registration', 'registrations', 'allowlist', 'sources', 'viewerCanManageSources', 'reconciliation', 'totals', 'itemsSkipped', 'waitingFor']) {
      expect(code, `payload key ${key}`).toContain(`'${key}'`);
    }
    // The count covers every policy reason the ledger CHECK admits, after-fetch included; the version is its own key.
    for (const reason of POLICY_SKIP_REASONS) expect(code).toContain(`'${reason}'`);
    expect(code).toContain("'itemsExcluded'");
    expect(code).toContain("'policyVersion', (select max(p.version) from discovery_exclusion_policies p where p.tenant_id = v_tenant)");
    // Only the version number is read from the policy table: no rule, condition or hash leaves the function.
    expect((code.match(/discovery_exclusion_policies/g) ?? []).length).toBe(1);
    expect(code).not.toMatch(/\.rules\b|rules_sha256|requested_by|exclusion_rule|provider_thread_id/);
    expect(code).toMatch(/revoke all on function discovery_ingestion_health\(\) from public, anon;/);
    expect(code).toMatch(/grant execute on function discovery_ingestion_health\(\) to authenticated, service_role;/);
  });

  it('registers recent rollout surfaces as typed, fail-closed flags', async () => {
    expect(FLAG_REGISTRY).toHaveProperty('company_access_management');
    expect(FLAG_REGISTRY).toHaveProperty('setup_walkthroughs');
    const flags = await resolveFlags(async () => []);
    expect(flags.company_access_management).toBe(false);
    expect(flags.setup_walkthroughs).toBe(false);
  });

  it('covers every user status in the status CHECK', () => {
    // 'invited' arrives in the onboarding migration, which re-adds the full
    // widened CHECK; earlier statuses live in the base migration.
    for (const status of Object.values(USER_STATUS)) {
      const inBase = sql.includes(`'${status}'`);
      const inOnboarding = onboardingInvitesSql.includes(`'${status}'`);
      expect(inBase || inOnboarding).toBe(true);
    }
  });

  it('covers every invite status, delivery status, and document room in the onboarding migration', () => {
    for (const status of Object.values(INVITE_STATUS)) {
      expect(onboardingInvitesSql).toContain(`'${status}'`);
    }
    for (const delivery of Object.values(INVITE_DELIVERY_STATUS)) {
      expect(onboardingInvitesSql).toContain(`'${delivery}'`);
    }
    for (const room of Object.values(DOCUMENT_ROOM)) {
      expect(onboardingInvitesSql).toContain(`'${room}'`);
    }
  });

  it('covers every lead_relationships and lead_stakeholders enum in the lead-crm-maps migration', () => {
    for (const type of RELATIONSHIP_TYPES) {
      expect(leadCrmMapsSql).toContain(`'${type}'`);
    }
    for (const level of STRENGTH_LEVELS) {
      expect(leadCrmMapsSql).toContain(`'${level}'`);
    }
    for (const source of RELATIONSHIP_SOURCES) {
      expect(leadCrmMapsSql).toContain(`'${source}'`);
    }
    for (const role of DECISION_ROLES) {
      expect(leadCrmMapsSql).toContain(`'${role}'`);
    }
    for (const motivation of MOTIVATIONS) {
      expect(leadCrmMapsSql).toContain(`'${motivation}'`);
    }
    for (const stance of STANCES) {
      expect(leadCrmMapsSql).toContain(`'${stance}'`);
    }
  });

  it('covers lead_relationship_paths.path_type in the paths migration', () => {
    for (const pathType of PATH_TYPES) {
      expect(leadRelationshipPathsSql).toContain(`'${pathType}'`);
    }
  });

  it('covers every access-request destination in the destination CHECK', () => {
    for (const destination of ACCESS_DESTINATIONS) {
      const inBase = accessRequestsSql.includes(`'${destination}'`);
      const inCreate = accessRequestsLeadsCreateSql.includes(`'${destination}'`);
      const inOrg = accessRequestsOrgDestinationsSql.includes(`'${destination}'`);
      const inRailTemplates = railTemplatesSql.includes(`'${destination}'`);
      expect(inBase || inCreate || inOrg || inRailTemplates).toBe(true);
    }
  });
});

describe('catalog publish mirrors', () => {
  it('publishes catalog templates against the census the deal routes seed', () => {
    const publishSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261005100000_rail_catalog_publish.sql'),
      'utf8',
    );
    const census = /function rail_catalog_census_version\(\)[\s\S]*?select '([^']+)'::text/.exec(publishSql)?.[1];
    expect(census).toBe(RAIL_CENSUS_VERSION);
  });

  it('keeps the template change decisions table aligned with its migration', () => {
    const reviewSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261005200000_template_change_review.sql'),
      'utf8',
    );
    expect(reviewSql).toContain(`create table if not exists ${TABLE.DEAL_TEMPLATE_CHANGE_DECISIONS} (`);
    expect(reviewSql).toMatch(
      new RegExp(`alter table ${TABLE.DEAL_TEMPLATE_CHANGE_DECISIONS}\\s+enable row level security`),
    );
  });

  it('keeps the template change notice aligned with its migration', () => {
    const reviewSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261005200000_template_change_review.sql'),
      'utf8',
    );
    // The CHECK is restated whole by each migration that widens it; the newest
    // restatement is the one in force and must hold every event.
    const dir = join(process.cwd(), 'supabase/migrations');
    const latest = readdirSync(dir)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => readFileSync(join(dir, file), 'utf8').replace(/--.*$/gm, ''))
      .filter((text) => text.includes('add constraint notifications_event_type_check'))
      .at(-1);
    const check = /notifications_event_type_check\s+check \(event_type in \(([\s\S]*?)\)\)/.exec(
      latest ?? '',
    )?.[1];
    expect(check, 'notifications_event_type_check').toBeDefined();
    expect(quotedValues(check ?? '').sort()).toEqual([...NOTIFICATION_EVENTS].sort());
    expect(reviewSql).toMatch(
      /perform rail_template_notify_deals\([^;]*p_actor_id, p_protected_ids\);\s*return jsonb_build_object\(/,
    );
  });

  it('keeps the review migration copy of publish_rail_template equal to the publish migration plus the notice call', () => {
    const definition = (file: string) => {
      const sql = readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8');
      const start = sql.indexOf('create or replace function publish_rail_template(');
      const end = sql.indexOf('\n$$;', start);
      expect(start, `${file} defines publish_rail_template`).toBeGreaterThan(-1);
      expect(end, `${file} closes publish_rail_template`).toBeGreaterThan(start);
      return sql.slice(start, end);
    };
    const published = definition('20261005100000_rail_catalog_publish.sql');
    const reviewed = definition('20261005200000_template_change_review.sql');
    const notice = '  perform rail_template_notify_deals(v_revision.id, p_actor_id, p_protected_ids);\n\n';

    expect(reviewed.split(notice)).toHaveLength(2);
    expect(reviewed.replace(notice, '')).toBe(published);
  });
});

function aiBudgetAlertsSql(): string {
  return readFileSync(join(process.cwd(), 'supabase/migrations/20261009180000_ai_budget_alerts.sql'), 'utf8');
}

describe('AI budget alerts mirror (D83)', () => {
  it('creates the budget table with RLS, and alerts only at the thresholds the code names', () => {
    const sql = aiBudgetAlertsSql();
    expect(sql).toContain(`create table if not exists ${TABLE.AI_BUDGETS} (`);
    expect(sql).toMatch(new RegExp(`alter table ${TABLE.AI_BUDGETS}\\s+enable row level security`));
    expect(sql).toMatch(/alter table ai_budget_alerts\s+enable row level security/);
    const check = /threshold\s+smallint not null check \(threshold in \(([^)]*)\)\)/.exec(sql)?.[1];
    expect(check?.split(',').map((v) => Number(v.trim()))).toEqual([...AI_BUDGET_THRESHOLDS]);
    expect(sql).toContain(`array[${AI_BUDGET_THRESHOLDS.join(', ')}]::smallint[]`);
    expect(sql).toContain(`'${NOTIFICATION_EVENT.AI_BUDGET_THRESHOLD}'`);
  });
});
