// The processor lists and the synthetic-content environment rule, owned once for both model gates (thread T9): the
// extractor's processorGate (src/lib/modelGateway/processorGate.ts) and the screen and code-name gate
// (src/lib/ai/modelPolicy.ts). Since #505 both reach the same processor, the AI Gateway (GATEWAY_PROCESSOR).
// A leaf module: it imports nothing that can reach a model or mail. The lists are TS constants, so a deploy cannot
// widen them.

import { DEV_TENANT_ID } from '@/lib/db/tenant';

/** The processor id of every Anthropic call the app makes: through the AI Gateway, ZDR, Anthropic only (#505). */
export const GATEWAY_PROCESSOR = 'vercel-ai-gateway:anthropic';
/**
 * One line per ADR-0017 processor-table row that reads Verified: Yes (#270 T1): GATEWAY_PROCESSOR for every
 * Anthropic call (the extractor, the screen, the code names), 'vercel-ai-gateway:typesafe-ai:jev' for Jev's second
 * opinion (D87). Ships empty.
 */
export const VERIFIED_MODEL_PROCESSORS: readonly string[] = Object.freeze([]);
/** Tenants whose mail may be synthetic. A TS constant, so a deploy cannot widen it. */
export const SYNTHETIC_MODEL_TENANT_IDS: readonly string[] = Object.freeze([DEV_TENANT_ID]);

/** An environment as the gates read it: a plain map, so a test needs no NODE_ENV. */
export type GateEnv = Readonly<Record<string, string | undefined>>;

/** A model surface the pair-scoped grants may open (Track D, D-TBD). */
export type VerifiedModelSurface = 'extract' | 'propose' | 'screen' | 'codename';

/** One tenant on one host and app env, with an explicit surface list. A TS constant, so a deploy cannot widen it. */
export type VerifiedModelGrant = Readonly<{
  tenantId: string;
  host: string;
  appEnv: string;
  surfaces: readonly VerifiedModelSurface[];
  label: string;
}>;

/**
 * Pair-scoped verified grants (D-TBD): each entry matches tenant id, Supabase REST host and NEXT_PUBLIC_APP_ENV
 * together. Unlike a cross product of tenant and host lists, staging sandbox access does not open prod tenants on
 * staging or this tenant on prod. Placement approval for extraction is implied per grant; global
 * DISCOVERY_OUTPUT_PLACEMENT_APPROVED stays false.
 */
export const VERIFIED_MODEL_GRANTS: readonly VerifiedModelGrant[] = Object.freeze([
  Object.freeze({
    tenantId: 'd8803681-440f-4d35-be12-9d2ae7ac5ebb',
    host: 'sfiqfmqecormenlfoklc.supabase.co',
    appEnv: 'staging',
    surfaces: Object.freeze(['extract', 'propose', 'screen', 'codename'] as const),
    label: 'sandbox-staging',
  }),
]);

/** The hostname of an exact https origin: https, the default port, no userinfo. Any other form is null (fails closed). */
export function httpsOriginHostOf(url?: string): string | null {
  try {
    const u = new URL(url ?? '');
    return u.protocol === 'https:' && u.port === '' && u.username === '' && u.password === '' ? u.hostname : null;
  } catch {
    return null;
  }
}

/** The grant that matches this tenant, env and surface, or null when none do. */
export function grantFor(
  tenantId: string,
  env: GateEnv,
  surface: VerifiedModelSurface,
  grants: readonly VerifiedModelGrant[] = VERIFIED_MODEL_GRANTS,
): VerifiedModelGrant | null {
  const host = httpsOriginHostOf(env.NEXT_PUBLIC_SUPABASE_URL);
  if (host === null) return null;
  const appEnv = env.NEXT_PUBLIC_APP_ENV?.trim().toLowerCase();
  for (const grant of grants) {
    if (grant.tenantId === tenantId && grant.host === host && grant.appEnv === appEnv && grant.surfaces.includes(surface)) {
      return grant;
    }
  }
  return null;
}

export const isLocalUrl = (url?: string) => {
  try {
    return ['127.0.0.1', 'localhost'].includes(new URL(url ?? '').hostname);
  } catch {
    return false;
  }
};

export type SyntheticEnvWithheld = 'not_local' | 'prod' | 'not_dev';

/**
 * The one environment rule for synthetic content: a loopback Supabase URL, and NEXT_PUBLIC_APP_ENV saying dev or
 * local (trimmed, any case). prod or production, unset, staging or anything unrecognized is withheld. Null when the
 * environment allows synthetic content.
 */
export function syntheticEnvWithheld(env: GateEnv): SyntheticEnvWithheld | null {
  if (!isLocalUrl(env.NEXT_PUBLIC_SUPABASE_URL)) return 'not_local';
  const appEnv = env.NEXT_PUBLIC_APP_ENV?.trim().toLowerCase();
  if (appEnv === 'prod' || appEnv === 'production') return 'prod';
  if (appEnv !== 'dev' && appEnv !== 'local') return 'not_dev';
  return null;
}
