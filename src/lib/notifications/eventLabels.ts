import type { NotificationEvent } from '@/lib/constants/notifications';

/** Human labels for the notification event types — shared by the bell and
 *  the Conductor Center so the same event never reads two ways. */
export const NOTIFICATION_EVENT_LABEL: Record<NotificationEvent, string> = {
  deal_created: 'New mandate opened',
  compliance_hold: 'Compliance hold',
  nda_pending: 'NDA pending',
  nda_signed: 'NDA countersigned',
  phase_promoted: 'Phase promoted',
  expense_approved: 'Expense approved',
  member_added: 'Team member added',
  step_assigned: 'Step assigned to you',
  step_completed: 'Step completed',
  access_requested: 'Access request',
  access_approved: 'Access approved',
  access_denied: 'Access denied',
  mailbox_allowlist_drift: 'Mailbox allowlist differs from the provider group',
  mailbox_connected: 'Mailbox connected',
  rail_template_updated: 'Template updated',
  ai_budget_threshold: 'AI budget alert',
  work_identity_replaced: 'Work sign-in moved to a new account',
  mail_queued_for_review: 'Sent mail queued for your review',
  compliance_settings_changed: 'Compliance settings changed',
  team_mailbox_refused: 'Team inbox failed the address check',
};

export function notificationEventLabel(eventType: string): string {
  return (NOTIFICATION_EVENT_LABEL as Record<string, string>)[eventType] ?? eventType;
}
