import { createHmac } from 'node:crypto';

/**
 * RFC 6238 TOTP over node:crypto (design D9). Roughly twenty-five lines, so
 * the suite gains no dependency and no supply-chain surface for what is a
 * fixed, thirty-year-old algorithm.
 *
 * MFA enrollment is a mandatory step of the invite flow, not an adjacent auth
 * concern: under MFA_ENFORCEMENT=invite_only, isMfaRequiredForUser returns
 * wasCreatedFromEmailInvite(user) and never consults isMfaBypassEnabled, so
 * DISABLE_MFA=1 does not exempt an invitee (design D8).
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(secret: string): Buffer {
  const normalized = secret.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error(`"${character}" is not a base32 character`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** Whole seconds left in the current 30-second step. 30 at the top, 1 at the end. */
export function secondsRemainingInStep(atMs: number = Date.now()): number {
  return STEP_SECONDS - (Math.floor(atMs / 1000) % STEP_SECONDS);
}

export function totpCode(secret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/**
 * The window guard (design D9). A code generated with under three seconds left
 * can expire between generation and GoTrue's verification, so wait for the
 * next step rather than submit a value that is about to be wrong. GoTrue
 * tolerates one step of skew and the hermetic Supabase runs on the host clock,
 * so drift is not a factor; only the boundary is.
 */
export async function totpCodeWithWindowGuard(secret: string): Promise<string> {
  const remaining = secondsRemainingInStep();
  if (remaining < 3) {
    await new Promise((resolve) => setTimeout(resolve, (remaining + 1) * 1000));
  }
  return totpCode(secret);
}
