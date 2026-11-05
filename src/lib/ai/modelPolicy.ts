// The model gate for the app's own model calls (#339 phase 1, design R11).
// The pre-send screen and the codename suggester send a tenant's content to
// the AI Gateway's Messages client (#505), so each one needs this tenant
// decision first, and each entry point takes it as a required positional
// argument.
//
// The lists and the environment rule live in src/lib/ai/processorRules.ts,
// shared with #325's processorGate, so the extractor and these calls cannot
// drift apart (thread T9); both reach GATEWAY_PROCESSOR. The lists are TS
// constants, so a deploy cannot widen them: opening the verified path is a
// reviewed PR that adds GATEWAY_PROCESSOR to VERIFIED_MODEL_PROCESSORS (how
// R4 is recorded; Jev's second opinion has its own id, JEV_PROCESSOR,
// verified separately), and a synthetic tenant is honored only on a local
// stack that says it is dev or local. Unlike the extractor, this gate does
// not also require VERIFIED_MODEL_TENANT_IDS (docs/03-engineering/api-v1.md,
// "Model gate", proposed, owner to confirm).
//
// A decision is a run-time fact as well as a type, the ActingUser pattern
// (src/lib/mailboxAccess/principal.ts): modelCallsAllowed() records every
// decision it returns in a module-private WeakMap, bound to the purpose and
// tenant it was asked for, and the entry points call assertModelDecision()
// with their own purposes, which refuses anything not in the map or minted
// for another purpose. A hand-built { allowed: true }, a spread copy or a JSON
// round trip is not in the map.
//
// The minting function takes no env and no policy: it reads process.env and
// the shipped constants, so no caller can mint an allowed decision by passing
// a wider list or a fake local URL. The rules themselves live in the pure
// evaluateModelPolicy(), which tests exercise with injected envs and lists;
// it returns a plain verdict that no entry point accepts. The fence test
// (tests/model-call-fence.test.ts) keeps production code off the evaluator.

import {
  type GateEnv,
  GATEWAY_PROCESSOR,
  grantFor,
  SYNTHETIC_MODEL_TENANT_IDS,
  syntheticEnvWithheld,
  type VerifiedModelSurface,
  VERIFIED_MODEL_PROCESSORS,
} from '@/lib/ai/processorRules';

export { GATEWAY_PROCESSOR, SYNTHETIC_MODEL_TENANT_IDS, VERIFIED_MODEL_PROCESSORS };
export type { GateEnv };
/**
 * The processor id of Jev's second opinion (D87): TypeSafe AI's model through the AI Gateway. Its own id, so
 * verifying the gateway's Anthropic path never opens Jev; it opens only when this id is verified on its own.
 */
export const JEV_PROCESSOR = 'vercel-ai-gateway:typesafe-ai:jev';

/**
 * What the call is for. Every purpose follows the same rules, against the processor it calls
 * (processorFor); F1 adds 'reply_draft'.
 */
export type ModelPurpose =
  | 'mail_send_screen'
  | 'mail_screen'
  | 'codename_suggest'
  | 'screening_eval'
  | 'mail_send_second_opinion';

/** The processor a purpose's call reaches: Jev for the send's second opinion, the gateway's Anthropic path for the rest. */
export function processorFor(purpose: ModelPurpose): string {
  return purpose === 'mail_send_second_opinion' ? JEV_PROCESSOR : GATEWAY_PROCESSOR;
}

const surfaceForPurpose = (purpose: ModelPurpose): VerifiedModelSurface | null => {
  if (purpose === 'codename_suggest') return 'codename';
  if (purpose === 'mail_send_second_opinion') return null;
  return 'screen';
};

export type ModelAllowBasis = 'verified_processor' | 'verified_tenant' | 'synthetic_tenant';
export type ModelWithheldReason = 'tenant_unresolved' | 'not_local' | 'prod' | 'not_dev' | 'tenant_not_synthetic';

/** The rules' answer, before it is minted: a plain value no entry point accepts. */
export type ModelPolicyVerdict =
  | { allowed: true; basis: ModelAllowBasis }
  | { allowed: false; reason: ModelWithheldReason };

declare const modelDecisionBrand: unique symbol;
type Minted = { readonly [modelDecisionBrand]: true };

export type ModelCallDecision =
  | ({ readonly allowed: true; readonly basis: ModelAllowBasis } & Minted)
  | ({ readonly allowed: false; readonly reason: ModelWithheldReason } & Minted);

/** The plain record a decision leaves in an audit row (and in a send-as-is token). */
export type ModelDecisionRecord = {
  allowed: boolean;
  basis?: ModelAllowBasis;
  reason?: ModelWithheldReason;
  purpose: ModelPurpose;
  tenantId: string | null;
};

/** The two lists, injectable into the evaluator so a test can open a path. */
export type ModelPolicy = {
  verifiedProcessors: readonly string[];
  syntheticTenantIds: readonly string[];
};

const SHIPPED_POLICY: ModelPolicy = Object.freeze({
  verifiedProcessors: VERIFIED_MODEL_PROCESSORS,
  syntheticTenantIds: SYNTHETIC_MODEL_TENANT_IDS,
});

type Binding = { purpose: ModelPurpose; tenantId: string | null };

// Filled only by modelCallsAllowed(); never exported.
const minted = new WeakMap<object, Binding>();

/**
 * The rules, in order, as a pure function. The null tenant comes first, so no
 * allow rule can rescue a request whose tenant could not be resolved. The
 * verified path checks the processor this purpose calls (processorFor). The
 * synthetic path follows syntheticEnvWithheld (src/lib/ai/processorRules.ts):
 * a loopback URL and NEXT_PUBLIC_APP_ENV saying dev or local; unset, staging or
 * anything unrecognized is withheld, and so is prod. Production code calls
 * modelCallsAllowed, never this.
 */
export function evaluateModelPolicy(
  tenantId: string | null,
  env: GateEnv,
  policy: ModelPolicy,
  purpose: ModelPurpose,
): ModelPolicyVerdict {
  if (!tenantId) return { allowed: false, reason: 'tenant_unresolved' };
  if (policy.verifiedProcessors.includes(processorFor(purpose))) return { allowed: true, basis: 'verified_processor' };
  const surface = surfaceForPurpose(purpose);
  if (surface && processorFor(purpose) === GATEWAY_PROCESSOR && grantFor(tenantId, env, surface)) {
    return { allowed: true, basis: 'verified_tenant' };
  }
  const withheld = syntheticEnvWithheld(env);
  if (withheld) return { allowed: false, reason: withheld };
  if (policy.syntheticTenantIds.includes(tenantId)) return { allowed: true, basis: 'synthetic_tenant' };
  return { allowed: false, reason: 'tenant_not_synthetic' };
}

/**
 * Whether a model call for this purpose may see this tenant's content,
 * under the shipped lists and this process's environment. The only minter of
 * a ModelCallDecision.
 */
export function modelCallsAllowed(tenantId: string | null, purpose: ModelPurpose): ModelCallDecision {
  const decision = Object.freeze({ ...evaluateModelPolicy(tenantId, process.env, SHIPPED_POLICY, purpose) }) as ModelCallDecision;
  minted.set(decision, Object.freeze({ purpose, tenantId: tenantId || null }));
  return decision;
}

/**
 * The value itself when modelCallsAllowed() minted it for one of `purposes`,
 * else a throw. Every entry point that can reach a model calls this, with the
 * purposes it serves, before it does anything else.
 */
export function assertModelDecision(value: unknown, purposes: readonly ModelPurpose[]): ModelCallDecision {
  const binding = typeof value === 'object' && value !== null ? minted.get(value) : undefined;
  if (!binding) throw new Error('a model call needs a decision minted by modelCallsAllowed');
  if (!purposes.includes(binding.purpose)) {
    throw new Error(`a decision minted for ${binding.purpose} cannot open a ${purposes.join(' or ')} call`);
  }
  return value as ModelCallDecision;
}

/** The decision as the audit row records it, with the purpose and tenant it is bound to. */
export function modelDecisionRecord(decision: ModelCallDecision): ModelDecisionRecord {
  const binding = minted.get(decision);
  if (!binding) throw new Error('a model call needs a decision minted by modelCallsAllowed');
  return decision.allowed
    ? { allowed: true, basis: decision.basis, ...binding }
    : { allowed: false, reason: decision.reason, ...binding };
}
