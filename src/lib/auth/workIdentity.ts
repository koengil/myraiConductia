import { createHash, randomBytes } from 'node:crypto';
import {
  USER_PROVISIONING,
  WORK_IDENTITY_COOKIE,
} from '@/lib/constants/workIdentity';
import { USER_STATUS } from '@/lib/constants/users';

/** A 32-byte flow secret, base64url. Held only in an httpOnly cookie. */
export function newFlowSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** sha256 hex of a flow secret: the only form the database ever stores. */
export function digest(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

type CookieOptions = {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
};

/** httpOnly, SameSite=Lax, Secure outside development. */
export function flowCookieOptions(
  maxAgeSeconds: number,
  env: NodeJS.ProcessEnv = process.env,
): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV !== 'development',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/** `cw_attempt` value: `<attemptId>.<secret>`. */
export function encodeAttemptCookie(attemptId: string, secret: string): string {
  return `${attemptId}.${secret}`;
}

export function decodeAttemptCookie(
  value: string | undefined | null,
): { attemptId: string; secret: string } | null {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  return { attemptId: value.slice(0, dot), secret: value.slice(dot + 1) };
}

export const ATTEMPT_COOKIE = WORK_IDENTITY_COOKIE.ATTEMPT;
export const CONNECT_COOKIE = WORK_IDENTITY_COOKIE.CONNECT;

/** Re-exported: lives with the MFA policy so the edge middleware can use it without node:crypto. */
export { isWorkIdentityUser } from '@/lib/auth/mfaPolicy';

type ProfileLike = {
  id: string;
  status: string | null;
  company_id: string | null;
  tenant_id: string | null;
};

/**
 * The token hook's pending-isolation predicate, mirrored: an invited profile
 * with no company in its own private tenant. Routing keys on this current
 * state, never on the historical `provisioning` marker.
 */
export function isPendingIsolated(profile: ProfileLike | null | undefined): boolean {
  if (!profile) return false;
  return (
    profile.status === USER_STATUS.INVITED &&
    profile.company_id === null &&
    profile.tenant_id === profile.id
  );
}

/** A contained profile has no tenant yet, so it is compatible with any invite. */
export function isContainedProfile(profile: { provisioning?: string | null } | null | undefined): boolean {
  return profile?.provisioning === USER_PROVISIONING.CONTAINED;
}

export { workIdentityErrorCopy, type WorkIdentityRecovery } from '@/lib/auth/workIdentityCopy';
