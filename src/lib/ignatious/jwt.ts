// Conductia-shaped trigger token. We mint it, Ignatious forwards it verbatim
// on every Conductia call, and the `/v1` seam verifies it on the way back in.
// Ignatious does not verify the signature and does not need to: both ends of
// the round trip are this deployment, so the HMAC is ours to check.
//
// The signature covers `header.payload` (see `./triggerToken`), so the `alg`
// field cannot be swapped or stripped. `readTriggerClaims` below decodes
// WITHOUT verifying and must never be used as an authentication decision;
// `verifyTriggerClaims` is the one that authenticates.

import {
  bearerToken,
  hasValidTriggerSignature,
  isTriggerTokenFresh,
  signingInput,
  signTriggerInput,
} from './triggerToken';

export type TriggerClaims = {
  agentName: string;
  dealId: string;
  scopes: readonly string[];
  userId?: string;
  userEmail?: string;
  stepId?: string;
  stepTitle?: string;
  /** Mint time, ms since epoch. Absent on a legacy unsigned token. */
  iat?: number;
  /**
   * The Conductia per-firm tenant (uuid), derived server-side from the deal or
   * company at mint time. This is the claim the lead boundary trusts.
   *
   * A DIFFERENT namespace from `x-conductia-tenant-id`, which carries the
   * Ignatious control-plane handle ("tn_demo") and is one constant for the
   * whole deployment. Optional here because a legacy token has none.
   */
  conductiaTenantId?: string;
};

/**
 * What a mint site must supply. `conductiaTenantId` is REQUIRED here while
 * being optional above, so the compiler enumerates every call site that has
 * to start passing a tenant rather than a grep having to find them.
 */
export type MintTriggerClaims = Omit<TriggerClaims, 'conductiaTenantId'> & {
  conductiaTenantId: string;
};

/**
 * Who minted the token and what it may be presented to. Both are VERIFIED
 * below, not merely written: an unchecked claim is decoration. `iss` was
 * already in the payload and ignored.
 */
const TOKEN_ISSUER = 'conductia';
const TOKEN_AUDIENCE = 'conductia:agent-callback';

const MD_BRIEFING_SCOPES = [
  'lead.read',
  'documents.read',
  'documents.write',
  'maps.read',
  'library.read',
  'personas.read',
] as const;

export function mdBriefingScopes(): readonly string[] {
  return MD_BRIEFING_SCOPES;
}

const PRESEARCH_SCOPES = [
  'lead.read',
  'documents.read',
  'maps.read',
  'library.read',
  'personas.read',
] as const;

export function presearchScopes(): readonly string[] {
  return PRESEARCH_SCOPES;
}

const SOURCE_INTELLIGENCE_SCOPES = [
  'lead.read',
  'lead.write',
  'documents.read',
  'maps.read',
  'maps.write',
  'tasks.write',
  'notes.write',
  'personas.read',
] as const;

export function sourceIntelligenceScopes(): readonly string[] {
  return SOURCE_INTELLIGENCE_SCOPES;
}

const DIGITAL_TWIN_SCOPES = [
  'lead.read',
  'documents.read',
  'maps.read',
  'personas.read',
  'personas.write',
] as const;

export function digitalTwinScopes(): readonly string[] {
  return DIGITAL_TWIN_SCOPES;
}

const SKILL_STEP_RUN_SCOPES = [
  'lead.read',
  'documents.read',
  'documents.write',
  'maps.read',
  'library.read',
  'personas.read',
] as const;

export function skillStepRunScopes(): readonly string[] {
  return SKILL_STEP_RUN_SCOPES;
}

const SKILL_RUN_REVISION_SCOPES = [
  'lead.read',
  'documents.read',
  'maps.read',
  'library.read',
  'personas.read',
] as const;

export function skillRunRevisionScopes(): readonly string[] {
  return SKILL_RUN_REVISION_SCOPES;
}

/**
 * Skill bench chat runs the same tagged skills a rail step runs (MD Briefing
 * among them), and those file their output through `POST /v1/leads/:id/documents`.
 * It was minted `presearchScopes()`, which has no `documents.write`, so the
 * filing would be refused once the seam enforces scopes (#196). Same grant as
 * a skill step run, kept separate so either can narrow without the other.
 */
const BENCH_SCOPES = [
  'lead.read',
  'documents.read',
  'documents.write',
  'maps.read',
  'library.read',
  'personas.read',
] as const;

export function benchScopes(): readonly string[] {
  return BENCH_SCOPES;
}

/**
 * Mint a signed trigger token. When no signing key is configured the token is
 * still well formed but carries the legacy `local-dev` segment, so a bare
 * local environment keeps working; the seam then refuses it under
 * `enforce` and only the shared key authenticates.
 */
export function mintTriggerToken(claims: MintTriggerClaims, now: number = Date.now()): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iss: TOKEN_ISSUER,
    aud: TOKEN_AUDIENCE,
    agentName: claims.agentName,
    dealId: claims.dealId,
    conductiaTenantId: claims.conductiaTenantId,
    scopes: claims.scopes,
    ...(claims.userId ? { userId: claims.userId } : {}),
    ...(claims.userEmail ? { userEmail: claims.userEmail } : {}),
    ...(claims.stepId ? { stepId: claims.stepId } : {}),
    ...(claims.stepTitle ? { stepTitle: claims.stepTitle } : {}),
    iat: claims.iat ?? now,
  });
  const signature = signTriggerInput(signingInput(header, payload)) ?? 'local-dev';
  return `${header}.${payload}.${signature}`;
}

/**
 * Decode the claims WITHOUT verifying the signature.
 *
 * This answers "what does this token say", never "is this token genuine". It
 * exists for the legacy observe-mode path and for reading a token this
 * process just minted. Authentication goes through `verifyTriggerClaims`.
 */
export function readTriggerClaims(authorization: string | null): TriggerClaims | null {
  const token = bearerToken(authorization);
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<
      string,
      unknown
    >;
    if (typeof payload.agentName !== 'string' || typeof payload.dealId !== 'string') return null;
    return {
      agentName: payload.agentName,
      dealId: payload.dealId,
      scopes: Array.isArray(payload.scopes)
        ? payload.scopes.filter((scope): scope is string => typeof scope === 'string')
        : [],
      ...(typeof payload.userId === 'string' ? { userId: payload.userId } : {}),
      ...(typeof payload.userEmail === 'string' ? { userEmail: payload.userEmail } : {}),
      ...(typeof payload.stepId === 'string' ? { stepId: payload.stepId } : {}),
      ...(typeof payload.stepTitle === 'string' ? { stepTitle: payload.stepTitle } : {}),
      ...(typeof payload.iat === 'number' ? { iat: payload.iat } : {}),
      ...(typeof payload.conductiaTenantId === 'string' && payload.conductiaTenantId
        ? { conductiaTenantId: payload.conductiaTenantId }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The claims of a token this deployment signed and that is still inside the
 * replay window. Null for a forged, stale, malformed or unsigned token, and
 * for every token when no signing key is configured. Never throws.
 *
 * A null is not "decode failed"; it is "do not trust this caller".
 */
export function verifyTriggerClaims(
  authorization: string | null,
  opts: { now?: number; maxAgeMs?: number } = {},
): TriggerClaims | null {
  const token = bearerToken(authorization);
  if (!token) return null;
  if (!hasValidTriggerSignature(token)) return null;
  const claims = readTriggerClaims(authorization);
  if (!claims) return null;
  if (!isTriggerTokenFresh(claims.iat, opts)) return null;
  if (!hasExpectedIssuerAndAudience(token)) return null;
  return claims;
}

/**
 * `iss` and `aud` on a token whose signature already verified. Kept separate
 * because `readTriggerClaims` intentionally returns only the domain claims.
 * These stop a token minted for some future purpose under the same key from
 * being replayed at the callback seam.
 */
function hasExpectedIssuerAndAudience(token: string): boolean {
  const payload = token.split('.')[1];
  if (!payload) return false;
  try {
    const record = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    return record.iss === TOKEN_ISSUER && record.aud === TOKEN_AUDIENCE;
  } catch {
    return false;
  }
}
