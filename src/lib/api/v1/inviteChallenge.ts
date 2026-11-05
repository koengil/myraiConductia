import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

const CODE_PATTERN = /^\d{6}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function verificationPepper(): string {
  const pepper = process.env.INVITE_VERIFICATION_PEPPER;
  if (!pepper) {
    throw new Error('INVITE_VERIFICATION_PEPPER is not set');
  }
  return pepper;
}
/** Generate the six-digit secret shown once to the authorized inviter. */
export function generateInviteChallengeCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function isInviteChallengeCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_PATTERN.test(value);
}

/**
 * Return the only challenge representation permitted to cross into storage.
 * HMAC makes the six-digit value impractical to brute-force without the
 * separately managed pepper.
 */
export function digestInviteChallengeCode(code: string): string {
  if (!isInviteChallengeCode(code)) {
    throw new Error('Invite verification code must contain exactly six digits');
  }
  return createHmac('sha256', verificationPepper()).update(code, 'utf8').digest('hex');
}

export function isInviteChallengeDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

/** Constant-time comparison for server-side digest checks and focused tests. */
export function inviteChallengeDigestsEqual(left: string, right: string): boolean {
  if (!isInviteChallengeDigest(left) || !isInviteChallengeDigest(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
