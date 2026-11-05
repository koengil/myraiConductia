// Demo-only (#460): the locks in front of the deal proposal step. Delete this folder when #459 lands.
//
// Five locks must all be open before a message the firm rules missed reaches a model:
//   1. the CLI flag classify-once --propose (the worker's job, not this file's);
//   2. the global flag discovery_model_proposals_demo, off by default (flagOn here);
//   3. MODEL_PROPOSAL_TENANT_IDS below, empty: the tenant scope D91 gives the extractor;
//   4. the ADR-0017 processor gate, unchanged and called with no policy, with
//      DISCOVERY_PROPOSE_TRANSPORT standing in for DISCOVERY_EXTRACT_TRANSPORT;
//   5. the ZDR literal in gatewayTransport, unchanged.
// This file checks 2 to 4 and pins the model, before any mail text is read.
// A team inbox needs more (G-01 #173): TEAM_PROPOSAL_FIRMS below AND a live team_proposals approval row, checked
// again in SQL at begin, at every renew and in the writer (passes.ts, store.ts).

import { grantFor } from '@/lib/ai/processorRules';
import {
  assertProcessorAllowed,
  ProcessorRefusedError,
  type GateEnv,
  type ProcessorPath,
} from '@/lib/modelGateway/processorGate';
import type { TransportKind } from '@/lib/modelGateway/transports';

import { resolveProposalModel } from './model';

/**
 * Tenants whose real mail the proposal step may read on the verified path. A TS constant, so a deploy
 * cannot widen it: opening it for a tenant is a reviewed flip after written ZDR confirmation and the
 * owner's approval. Ships empty. The synthetic and recorded paths are confined by the processor gate.
 */
export const MODEL_PROPOSAL_TENANT_IDS: readonly string[] = Object.freeze([]);

/** One firm company, in one tenant, whose team inboxes the proposal step may read. */
export type TeamProposalFirm = { tenantId: string; firmCompanyId: string };

/**
 * ADR-0026 residual 4 ("exclusion 4"), the reviewed TS half of the team_proposals switch (G-01 #173). A team inbox's
 * mail reaches a model only for a firm company named here AND holding a live `team_proposals` row in
 * the shared tenant approvals table (the migration-written half): neither is enough alone. Frozen and EMPTY: lifting the
 * exclusion for a firm is the owner's decision (Q1), a reviewed change to this list plus a reviewed migration row,
 * never a deploy setting. While it is empty the proposal step reads a person's own mailbox only, as before.
 */
export const TEAM_PROPOSAL_FIRMS: readonly TeamProposalFirm[] = Object.freeze([]);

/**
 * The firm company ids this tenant's list names, distinct. `list` is a tests-only override (ProposeOptions.teamFirmList);
 * production always runs on TEAM_PROPOSAL_FIRMS.
 */
export function listedTeamFirms(tenantId: string, list: readonly TeamProposalFirm[] = TEAM_PROPOSAL_FIRMS): string[] {
  return [...new Set(list.filter((f) => f.tenantId === tenantId).map((f) => f.firmCompanyId))];
}

export type ProposalGateInput = {
  tenantId: string;
  transportKind: TransportKind;
  /** The discovery_model_proposals_demo flag, read by the caller. */
  flagOn: boolean;
  env?: GateEnv;
  /** Tests only: the verified tenants. Production always runs on MODEL_PROPOSAL_TENANT_IDS. */
  tenantIds?: readonly string[];
};

export type ProposalGate =
  | { ok: true; path: ProcessorPath; model: string }
  /** A code only (flag_off, tenant_not_listed, or the processor gate's reason): never mail text. */
  | { ok: false; code: string };

export class ProposalRefusedError extends Error {
  constructor(readonly code: string) {
    super(`propose refused: ${code}`);
  }
}

export function proposalGate(input: ProposalGateInput): ProposalGate {
  if (!input.flagOn) return { ok: false, code: 'flag_off' };
  const env = input.env ?? process.env;
  try {
    // The processor gate reads DISCOVERY_EXTRACT_TRANSPORT; the proposal step has its own switch, so
    // turning live extraction on never turns live proposals on.
    const path = assertProcessorAllowed(input.tenantId, input.transportKind, {
      ...env,
      DISCOVERY_EXTRACT_TRANSPORT: env.DISCOVERY_PROPOSE_TRANSPORT,
    });
    if (path === 'verified') {
      const listed = input.tenantIds
        ? input.tenantIds.includes(input.tenantId)
        : grantFor(input.tenantId, env, 'propose') !== null || MODEL_PROPOSAL_TENANT_IDS.includes(input.tenantId);
      if (!listed) return { ok: false, code: 'tenant_not_listed' };
    }
    return { ok: true, path, model: resolveProposalModel() };
  } catch (error) {
    if (error instanceof ProcessorRefusedError) return { ok: false, code: error.why };
    throw error;
  }
}
