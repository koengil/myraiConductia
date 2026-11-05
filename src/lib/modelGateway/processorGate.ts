// The ADR-0017 processor gate (design R19). Before any mail text is read, the
// extractor asks which path it is on. The three constants of the verified path
// ship closed, so the only live path today is a synthetic run against a local
// stack. The verified path serves a listed tenant alone (ADR-0017 Amendment 1).

import {
  type GateEnv,
  GATEWAY_PROCESSOR,
  grantFor,
  isLocalUrl,
  SYNTHETIC_MODEL_TENANT_IDS,
  syntheticEnvWithheld,
  VERIFIED_MODEL_GRANTS,
  VERIFIED_MODEL_PROCESSORS,
} from '@/lib/ai/processorRules';

import { SYNTHETIC_MESSAGE_IDS } from './syntheticCorpus.generated';
import type { TransportKind } from './transports';

// The lists and the environment rule live in src/lib/ai/processorRules.ts, shared with the direct-call gate.
export { GATEWAY_PROCESSOR, SYNTHETIC_MODEL_TENANT_IDS, VERIFIED_MODEL_GRANTS, VERIFIED_MODEL_PROCESSORS };
export type { GateEnv };

/**
 * T11 (a): may model outputs about real mail rest in the control-plane tables? Opens only once
 * ADR-0017 Amendment 1 (the single-tenant pilot exception, #374) reads Accepted, and has an effect
 * only for a tenant in VERIFIED_MODEL_TENANT_IDS. Ships false.
 */
export const DISCOVERY_OUTPUT_PLACEMENT_APPROVED: boolean = false;
/**
 * Tenants the verified path may serve. Amendment 1 is a single-tenant exception, so the flip PR lists
 * the Ignatious tenant alone. A TS constant, so a deploy cannot widen it. Ships empty.
 */
export const VERIFIED_MODEL_TENANT_IDS: readonly string[] = Object.freeze([]);
export const DEFAULT_EXTRACT_MODEL = 'anthropic/claude-sonnet-5'; // Q10's pin
const COVERED_MODEL = /fable|mythos/i; // ADR-0017 bars Covered Models for bank content

export type ProcessorPath = 'recorded' | 'verified' | 'synthetic';

export class ProcessorRefusedError extends Error {
  readonly code = 'processor_not_verified';
  constructor(readonly why: string) {
    super(`processor_not_verified: ${why}`);
  }
}

/** The three flips of the verified path, injectable by tests only (tests/model-policy-injection-fence.test.ts). */
export type ProcessorPolicy = {
  verifiedProcessors: readonly string[];
  outputPlacementApproved: boolean;
  verifiedTenantIds: readonly string[];
};

const SHIPPED_POLICY: ProcessorPolicy = {
  verifiedProcessors: VERIFIED_MODEL_PROCESSORS,
  outputPlacementApproved: DISCOVERY_OUTPUT_PLACEMENT_APPROVED,
  verifiedTenantIds: VERIFIED_MODEL_TENANT_IDS,
};

export function assertProcessorAllowed(
  tenantId: string,
  transport: TransportKind,
  env: GateEnv = process.env,
  policy: ProcessorPolicy = SHIPPED_POLICY,
): ProcessorPath {
  if (transport === 'recorded') {
    // Nothing leaves the process, but a replay misses every real item, and three failed calls retire an
    // item from the batch for good. Off loopback only a synthetic tenant may replay.
    if (!isLocalUrl(env.NEXT_PUBLIC_SUPABASE_URL) && !SYNTHETIC_MODEL_TENANT_IDS.includes(tenantId)) {
      throw new ProcessorRefusedError('recorded_not_synthetic');
    }
    return 'recorded';
  }
  if (env.DISCOVERY_EXTRACT_TRANSPORT !== 'gateway') throw new ProcessorRefusedError('transport_not_selected');
  if (grantFor(tenantId, env, 'extract')) return 'verified';
  const verifiedOpen = policy.verifiedProcessors.includes(GATEWAY_PROCESSOR) && policy.outputPlacementApproved;
  if (verifiedOpen && policy.verifiedTenantIds.includes(tenantId)) return 'verified';
  const withheld = syntheticEnvWithheld(env);
  // Off loopback only the verified path could serve; say why it did not.
  if (withheld === 'not_local' && verifiedOpen) throw new ProcessorRefusedError('tenant_not_verified');
  if (withheld) throw new ProcessorRefusedError(withheld);
  if (!SYNTHETIC_MODEL_TENANT_IDS.includes(tenantId)) throw new ProcessorRefusedError('tenant_not_synthetic');
  return 'synthetic';
}

/** Per-item provenance on the synthetic path: only committed corpus mail is ever sent. */
export const isSyntheticItem = (internetMessageId: string) => SYNTHETIC_MESSAGE_IDS.has(internetMessageId);

export function resolveExtractModel(env: GateEnv = process.env, path?: ProcessorPath): string {
  const model = env.DISCOVERY_EXTRACT_MODEL?.trim() || DEFAULT_EXTRACT_MODEL;
  if (COVERED_MODEL.test(model)) throw new ProcessorRefusedError('covered_model');
  // Real mail goes only to the model its processor row names, and that model is priced.
  if (path === 'verified' && model !== DEFAULT_EXTRACT_MODEL) throw new ProcessorRefusedError('model_not_verified');
  return model;
}
