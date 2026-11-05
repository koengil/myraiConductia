// Anonymous counters of emails sent after an email warning. Mirror the
// mail_warning_outcomes CHECK enums; source of truth is
// supabase/migrations/20261001200000_mail_warning_outcomes.sql (kind) and
// supabase/migrations/20261008200000_mail_warning_outcomes_sent_only.sql
// (outcome: no record of an email that was not sent, D80).

export const MAIL_WARNING_KIND = {
  /** The Risk Patcher returned the email with issues. */
  RISK_ISSUES: 'risk_issues',
  /** The recipient review asked for a confirmation. */
  RECIPIENT_REVIEW: 'recipient_review',
} as const;

export type MailWarningKind = (typeof MAIL_WARNING_KIND)[keyof typeof MAIL_WARNING_KIND];
export const MAIL_WARNING_KINDS = Object.values(MAIL_WARNING_KIND) as MailWarningKind[];

export const MAIL_WARNING_OUTCOME = {
  SENT_AFTER_WARNING: 'sent_after_warning',
} as const;

export type MailWarningOutcome = (typeof MAIL_WARNING_OUTCOME)[keyof typeof MAIL_WARNING_OUTCOME];
export const MAIL_WARNING_OUTCOMES = Object.values(MAIL_WARNING_OUTCOME) as MailWarningOutcome[];
