// Work-identity onboarding constants (issue #316). Mirror the SQL enums in
// supabase/migrations/20261002100000_work_identity_onboarding.sql, which is
// the source of truth:
//   firm_identity_providers.provider     — 'google' | 'azure'
//   invites.auth_method                  — 'email_code' | 'work_identity'
//   users.provisioning                   — 'authorized' | 'contained'
// work_identity_bindings.via ('invite' | 'connect') has no TS mirror yet.

/** Supabase Auth native provider ids for approved firm work accounts. */
export const WORK_IDENTITY_PROVIDER = {
  GOOGLE: 'google',
  AZURE: 'azure',
} as const;

export type WorkIdentityProvider =
  (typeof WORK_IDENTITY_PROVIDER)[keyof typeof WORK_IDENTITY_PROVIDER];
export const WORK_IDENTITY_PROVIDERS = Object.values(
  WORK_IDENTITY_PROVIDER,
) as WorkIdentityProvider[];

export function isWorkIdentityProvider(value: unknown): value is WorkIdentityProvider {
  return WORK_IDENTITY_PROVIDERS.includes(value as WorkIdentityProvider);
}

/** How an invitation is accepted. Fixed at creation, never updated. */
export const INVITE_AUTH_METHOD = {
  EMAIL_CODE: 'email_code',
  WORK_IDENTITY: 'work_identity',
} as const;

export type InviteAuthMethod = (typeof INVITE_AUTH_METHOD)[keyof typeof INVITE_AUTH_METHOD];

/** users.provisioning: 'contained' until a proven transition authorizes it. */
export const USER_PROVISIONING = {
  AUTHORIZED: 'authorized',
  CONTAINED: 'contained',
} as const;

export type UserProvisioning = (typeof USER_PROVISIONING)[keyof typeof USER_PROVISIONING];

/** httpOnly cookies holding the browser-flow secrets (never the digest). */
export const WORK_IDENTITY_COOKIE = {
  /** Invitation acceptance attempt: `<attemptId>.<secret>`, 15 minutes. */
  ATTEMPT: 'cw_attempt',
  /** Existing-account connect intent secret, 10 minutes. */
  CONNECT: 'cw_connect',
  /** Set by the connect callback on a fresh binding; /profile reads and clears it. */
  CONNECTED: 'cw_connected',
} as const;

export const WORK_IDENTITY_ATTEMPT_TTL_SECONDS = 15 * 60;
export const WORK_IDENTITY_CONNECT_TTL_SECONDS = 10 * 60;

/**
 * Error codes surfaced to the browser by the work-identity routes, the token
 * hook and the legacy invitation routes. Messages live in
 * src/lib/auth/workIdentity.ts.
 */
export const WORK_IDENTITY_ERROR = {
  WRONG_ACCOUNT: 'wrong_account',
  ALIAS_MISMATCH: 'alias_mismatch',
  EMAIL_UNVERIFIED: 'email_unverified',
  ORGANIZATION_MISMATCH: 'organization_mismatch',
  CONSENT_CANCELED: 'consent_canceled',
  PROVIDER_FAILED: 'provider_failed',
  ATTEMPT_EXPIRED: 'attempt_expired',
  ATTEMPT_CONSUMED: 'attempt_consumed',
  INVITE_EXPIRED: 'invite_expired',
  INVITE_REVOKED: 'invite_revoked',
  INVITE_SUPERSEDED: 'invite_superseded',
  INVITER_AUTHORITY_LOST: 'inviter_authority_lost',
  EXISTING_ACCOUNT: 'existing_account',
  INVITE_OTHER_FIRM: 'invite_other_firm',
  NOT_CONNECTED: 'work_identity_not_connected',
  ALREADY_CONNECTED: 'work_identity_already_connected',
  LINK_STALE: 'work_identity_link_stale',
  NO_INVITATION: 'no_invitation',
  MFA_REQUIRED: 'mfa_required',
  ACCOUNT_SUSPENDED: 'account_suspended',
  PROVIDER_NOT_CONFIGURED: 'provider_not_configured',
  WORK_IDENTITY_DISABLED: 'work_identity_disabled',
  INVITE_CONTEXT_MISSING: 'invite_context_missing',
  IDENTITY_AMBIGUOUS: 'identity_ambiguous',
} as const;

export type WorkIdentityErrorCode =
  (typeof WORK_IDENTITY_ERROR)[keyof typeof WORK_IDENTITY_ERROR];
