import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signing and verification for the Conductia trigger token.
 *
 * The token is minted HERE, on a platform route, handed to Ignatious with a
 * skill run, and forwarded back verbatim on every `/v1/leads/...` callback.
 * Both ends of that round trip are this deployment, so the seam can hold the
 * token to a signature without any change on the agents backend.
 *
 * Before this module the signature segment was the literal string `local-dev`
 * and nothing read it: `readTriggerClaims` base64-decoded the payload and a
 * non-null return WAS the authentication decision. Any caller who could reach
 * `/v1` could mint a token naming any agent, any deal and any acting user.
 *
 * Format stays the three-part `header.payload.signature` shape so a decoder
 * that only reads `parts[1]` keeps working. The signature covers
 * `header.payload`, so the `alg` field cannot be swapped or stripped.
 *
 * This module is pure crypto: it holds no domain types and imports nothing
 * from the seam, so `jwt.ts` can depend on it without a cycle.
 */

/** Domain-separates the fallback key from the pepper's other derived uses. */
const KEY_PURPOSE = 'conductia:ignatious-trigger-token:v1';

/**
 * A skill run can file its brief long after it was triggered, so this bounds
 * replay without cutting a slow run off mid-flight.
 */
export const TRIGGER_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const TRIGGER_TOKEN_KEY_MISSING =
  'CONDUCTIA_TRIGGER_TOKEN_SECRET (or INVITE_VERIFICATION_PEPPER) is not set';

/**
 * Read at request time rather than as `process.env.FOO`. Next inlines a static
 * read at build; Vercel Sensitive vars exist only at runtime.
 */
function runtimeEnv(name: string): string | undefined {
  return process.env[name];
}

function signingKeyOrNull(): Buffer | null {
  const dedicated = runtimeEnv('CONDUCTIA_TRIGGER_TOKEN_SECRET')?.trim();
  if (dedicated) return Buffer.from(dedicated, 'utf8');
  // Every environment already carries the invite pepper, so the seam can sign
  // on day one without a new secret being provisioned first. Derived, never
  // used raw, so a leak of one key does not hand over the other's use.
  const pepper = runtimeEnv('INVITE_VERIFICATION_PEPPER')?.trim();
  if (pepper) return createHmac('sha256', pepper).update(KEY_PURPOSE).digest();
  return null;
}

/**
 * Whether this deployment can sign and verify at all. The seam checks it
 * before it decides how to treat a token, so a missing key closes the token
 * path rather than silently accepting anything that decodes.
 */
export function hasTriggerTokenKey(): boolean {
  return signingKeyOrNull() !== null;
}

/** The JWS signing input: everything before the signature segment. */
export function signingInput(headerB64: string, payloadB64: string): string {
  return `${headerB64}.${payloadB64}`;
}

/** Null rather than a throw when unkeyed, so callers choose the fallback. */
export function signTriggerInput(input: string): string | null {
  const key = signingKeyOrNull();
  if (!key) return null;
  return createHmac('sha256', key).update(input, 'utf8').digest('base64url');
}

/**
 * Whether `token` carries a signature this deployment produced. False for a
 * malformed token, an unsigned one, a wrong-key signature, and for every
 * token when no key is configured. Never throws.
 */
export function hasValidTriggerSignature(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, sig] = parts;
  if (!headerB64 || !payloadB64 || !sig) return false;

  const expected = signTriggerInput(signingInput(headerB64, payloadB64));
  if (!expected) return false;

  const given = Buffer.from(sig, 'base64url');
  const want = Buffer.from(expected, 'base64url');
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

/**
 * Whether a mint timestamp is inside the replay window. A token with no `iat`
 * predates signing and is stale by definition.
 */
export function isTriggerTokenFresh(
  iat: unknown,
  opts: { now?: number; maxAgeMs?: number } = {},
): boolean {
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return false;
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? TRIGGER_TOKEN_MAX_AGE_MS;
  // A token minted slightly in the future is clock skew, not an attack.
  if (iat - now > 60_000) return false;
  return now - iat <= maxAge;
}

/** Strips the scheme so callers can pass a raw `Authorization` header. */
export function bearerToken(authorization: string | null): string | null {
  const token = authorization?.replace(/^Bearer\s+/i, '').trim();
  return token ? token : null;
}

/**
 * How the seam treats a token it cannot verify.
 *
 * `enforce` refuses it. `observe` accepts it and records the fact, so a
 * deployment can prove what its agents backend actually presents before the
 * legacy path is closed. Anything other than an explicit `observe` is
 * `enforce`, so a missing or misspelled value fails closed.
 *
 * Temporary, and an env var rather than a feature flag on purpose: the seam
 * gate is synchronous and `isEnabled` is an async database read.
 */
export type TriggerTokenMode = 'observe' | 'enforce';

export function triggerTokenMode(): TriggerTokenMode {
  return runtimeEnv('CONDUCTIA_TRIGGER_TOKEN_MODE')?.trim().toLowerCase() === 'observe'
    ? 'observe'
    : 'enforce';
}
