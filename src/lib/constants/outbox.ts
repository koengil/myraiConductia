// Outbound-message status constants. Mirror the outbound_messages.status CHECK
// enum; source of truth is supabase/migrations/20260729130000_outbound_messages.sql
// ('rejected' + review columns added by 20260730150000_mail_inbound_review_mailbox.sql,
// 'pending' by 20260803120000_outbox_pending_status.sql).

export const OUTBOX_STATUS = {
  SENT: 'sent',
  HELD: 'held',
  BLOCKED: 'blocked',
  REJECTED: 'rejected',
  /** In-flight: recorded before the provider send; never re-releasable. */
  PENDING: 'pending',
} as const;

export type OutboxStatus = (typeof OUTBOX_STATUS)[keyof typeof OUTBOX_STATUS];
export const OUTBOX_STATUSES = Object.values(OUTBOX_STATUS) as OutboxStatus[];

// Risk bands (#192, decided 2026-08-24). Mirror the outbound_messages.risk_band
// CHECK enum; source of truth is supabase/migrations/20260824120000_risk_band.sql.
// Band only, never the raw score; names per Dan/Storm's written decision
// (low/elevated/severe rejected for their legal implications).
export const RISK_BAND = {
  /** No risk issues worth supervision; covered by traceability alone. */
  ROUTINE: 'routine',
  /** Feeds the periodic sampling view the CCO spot-checks. */
  SAMPLED: 'sampled',
  /** Lands in the CCO's post-send review queue. */
  QUEUED: 'queued',
} as const;

export type RiskBand = (typeof RISK_BAND)[keyof typeof RISK_BAND];

// Recipient boundary (#171, Storm Q3 A). Mirror the outbound_messages
// recipient_boundary CHECK enum; source of truth is
// supabase/migrations/20260921160000_outbound_recipient_boundary.sql.
export const RECIPIENT_BOUNDARY = {
  /** Every recipient is on one of the sender company's verified domains. */
  INTERNAL: 'internal',
  /** At least one recipient is not. */
  EXTERNAL: 'external',
  /** No verified domains configured, an unfinished address, or the lookup failed. */
  UNVERIFIED: 'unverified',
} as const;

export type RecipientBoundary = (typeof RECIPIENT_BOUNDARY)[keyof typeof RECIPIENT_BOUNDARY];
export const RECIPIENT_BOUNDARIES = Object.values(RECIPIENT_BOUNDARY) as RecipientBoundary[];
/** Validation list for the GET /outbox band filter (slice 3). */
export const RISK_BANDS = Object.values(RISK_BAND) as RiskBand[];
