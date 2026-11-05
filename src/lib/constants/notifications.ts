// Notification event-type constants. Mirror the notifications.event_type CHECK
// enum in supabase/migrations/20260714161000_notifications.sql, widened by later
// migrations up to 20261023100000_team_mailbox_refusal_notify.sql (the migration
// is the source of truth). Kept in sync by tests/constants-schema-sync.test.ts.

export const NOTIFICATION_EVENT = {
  DEAL_CREATED: 'deal_created',
  COMPLIANCE_HOLD: 'compliance_hold',
  NDA_PENDING: 'nda_pending',
  NDA_SIGNED: 'nda_signed',
  PHASE_PROMOTED: 'phase_promoted',
  EXPENSE_APPROVED: 'expense_approved',
  MEMBER_ADDED: 'member_added',
  STEP_ASSIGNED: 'step_assigned',
  STEP_COMPLETED: 'step_completed',
  ACCESS_REQUESTED: 'access_requested',
  ACCESS_APPROVED: 'access_approved',
  ACCESS_DENIED: 'access_denied',
  MAILBOX_ALLOWLIST_DRIFT: 'mailbox_allowlist_drift',
  MAILBOX_CONNECTED: 'mailbox_connected',
  RAIL_TEMPLATE_UPDATED: 'rail_template_updated',
  AI_BUDGET_THRESHOLD: 'ai_budget_threshold',
  WORK_IDENTITY_REPLACED: 'work_identity_replaced',
  MAIL_QUEUED_FOR_REVIEW: 'mail_queued_for_review',
  COMPLIANCE_SETTINGS_CHANGED: 'compliance_settings_changed',
  TEAM_MAILBOX_REFUSED: 'team_mailbox_refused',
} as const;

export type NotificationEvent =
  (typeof NOTIFICATION_EVENT)[keyof typeof NOTIFICATION_EVENT];
export const NOTIFICATION_EVENTS = Object.values(
  NOTIFICATION_EVENT,
) as NotificationEvent[];
