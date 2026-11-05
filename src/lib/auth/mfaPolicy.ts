import { isMfaBypassEnabled } from '@/lib/auth/mfaBypass';

export const EMAIL_INVITE_ACCOUNT_ORIGIN = 'email_invite';

type MfaPolicyUser = {
  app_metadata?: Record<string, unknown>;
};

/** Server-owned metadata written when the platform creates an invited identity. */
export function emailInviteAppMetadata() {
  return { account_origin: EMAIL_INVITE_ACCOUNT_ORIGIN };
}

export function wasCreatedFromEmailInvite(user: MfaPolicyUser): boolean {
  return user.app_metadata?.account_origin === EMAIL_INVITE_ACCOUNT_ORIGIN;
}

/** Supabase providers that are not an external identity provider. */
const FIRST_PARTY_PROVIDERS = new Set(['email', 'phone']);

/**
 * Does this account carry an external (OAuth) identity? Reads only the
 * server-owned `app_metadata.providers`, which the client cannot write. Any
 * provider other than email/phone counts, not just google/azure: a stricter
 * reading that also covers the local test broker (keycloak).
 */
export function isWorkIdentityUser(user: MfaPolicyUser): boolean {
  const providers = user.app_metadata?.providers;
  if (!Array.isArray(providers)) return false;
  return providers.some((provider) => typeof provider === 'string' && !FIRST_PARTY_PROVIDERS.has(provider));
}

/**
 * Work-identity accounts always require Conductia MFA: upstream provider MFA
 * never counts, in every enforcement mode and under the development bypass.
 * Otherwise `invite_only` lets established accounts stay at AAL1 while
 * identities created by the invitation pipeline still enroll and challenge at
 * AAL2. Invalid values retain the platform-wide MFA boundary in every
 * environment.
 */
export function isMfaRequiredForUser(user: MfaPolicyUser, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isWorkIdentityUser(user)) return true;
  const mode = env.MFA_ENFORCEMENT?.trim().toLowerCase();
  if (mode === 'invite_only') {
    return wasCreatedFromEmailInvite(user);
  }
  return !isMfaBypassEnabled(env);
}
