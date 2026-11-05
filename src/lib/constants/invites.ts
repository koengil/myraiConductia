// Invite lifecycle constants. Mirror the invites.status / invites.delivery_status
// CHECK enums in supabase/migrations/20260731120000_onboarding_invites.sql
// (the migration is the source of truth, incl. the state machine comment).
//
// status:  pending -> accepted | revoked | expired (terminal states never revive)
// delivery_status: 'sent' only after the credential email was handed to the
// provider; the invite_sent audit is written exactly on unsent->sent.

export const INVITE_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
} as const;

export type InviteStatus = (typeof INVITE_STATUS)[keyof typeof INVITE_STATUS];

export const INVITE_DELIVERY_STATUS = {
  UNSENT: 'unsent',
  SENT: 'sent',
} as const;

export type InviteDeliveryStatus =
  (typeof INVITE_DELIVERY_STATUS)[keyof typeof INVITE_DELIVERY_STATUS];

/** Pre-send classification mirrored by invite_domain_confirmations. */
export const INVITE_DOMAIN_CLASSIFICATION = {
  MATCH: 'match',
  MISMATCH: 'mismatch',
  PERSONAL: 'personal',
  UNVERIFIED: 'unverified',
} as const;

export type InviteDomainClassification =
  (typeof INVITE_DOMAIN_CLASSIFICATION)[keyof typeof INVITE_DOMAIN_CLASSIFICATION];

export const INVITE_DOMAIN_CONFIRMATION_CLASSIFICATIONS = [
  INVITE_DOMAIN_CLASSIFICATION.MISMATCH,
  INVITE_DOMAIN_CLASSIFICATION.PERSONAL,
  INVITE_DOMAIN_CLASSIFICATION.UNVERIFIED,
] as const;

export const INVITE_CHALLENGE_MAX_ATTEMPTS = 5;
export const INVITE_DOMAIN_CONFIRMATION_TTL_MINUTES = 60;

/**
 * Lifetime of an invitation, mirroring the invites.expires_at default in
 * supabase/migrations/20260908110000_invite_ttl_alignment.sql.
 *
 * Not a free choice: what the invitee clicks is a GoTrue one-time token, and
 * Supabase caps its "Email OTP Expiration" at 24 hours. The row cannot
 * honestly promise longer than the credential lasts, so both sit at 24.
 * A project configured BELOW 24 hours kills the link earlier than this
 * number, which is why the emails say "within", never "in".
 */
export const INVITE_TTL_HOURS = 24;
