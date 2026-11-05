// The model gateway: one seam between the deal-zone worker and a model. The
// worker and its tests both call `callModel`; a transport owns the wire, so a
// test or a recorded run never opens a socket. The classification zone never
// imports this module (ESLint fence, Q1).

import { randomUUID } from 'node:crypto';

import type { AiCallUsage } from '@/lib/ai/usage';

import type { ZdrReason } from './gatewayClient';
import type { DealProposalInput } from './prompts/dealProposal.v2';
import type { ModelTransport, TransportKind } from './transports';

export type { ModelTransport, TransportKind } from './transports';

export type MilestoneRequest = {
  purpose: 'milestone_extract';
  promptVersion: 'v1';
  model: string;
  /** The tenant the call serves, for the call's log line (#474). Not part of a recorded reply's key. */
  tenantId: string;
  sourceItemId: string;
  contentHash: string;
  input: { subject: string; sentAt: string | null; body: string };
};

/** The demo-only deal proposal step (#460): one unrouted message, never stored, so no item id. Delete with #459. */
export type DealProposalRequest = {
  purpose: 'deal_proposal';
  promptVersion: 'v2';
  model: string;
  /** As on MilestoneRequest: for the log line only, never a recorded reply's key. */
  tenantId: string;
  contentHash: string;
  input: DealProposalInput;
};

export type ModelRequest = MilestoneRequest | DealProposalRequest;

export type ModelCallResult =
  | {
      ok: true;
      text: string;
      responseId: string;
      usage: AiCallUsage | null;
      transport: TransportKind;
      latencyMs: number;
    }
  | {
      ok: false;
      outcome: 'failed';
      code: 'no_key' | 'timeout' | 'http' | 'zdr_unavailable' | 'recording_miss';
      /** Set with zdr_unavailable from the gateway: which refusal it was (D106). */
      zdrReason?: ZdrReason;
      /** Set when the gateway answered 2xx but the reply could not be used: the attempt was billed (#645). */
      billed?: true;
      /** Set with billed: the reply's usage, null when it carried none or was not read. */
      usage?: AiCallUsage | null;
      /** Set with billed: the reply's id, '' when it carried none or was not read. */
      responseId?: string;
      transport: TransportKind;
      latencyMs: number;
    };

export async function callModel(req: ModelRequest, transport: ModelTransport): Promise<ModelCallResult> {
  return transport.send(req); // one seam for tests and the worker; the transport owns the wire
}

/** One billed gateway attempt as the ai_usage ledger records it (#645). */
export type BilledAttempt = { externalId: string; model: string; usage: AiCallUsage | null };

/** The ai_usage token columns are int4. */
const INT4_MAX = 2 ** 31 - 1;

/** A token count the ledger can store: a non-negative int4 integer, so a stray count is never a write error. */
const tokens = (n: number): number => (Number.isFinite(n) ? Math.min(INT4_MAX, Math.max(0, Math.round(n))) : 0);

/**
 * The ledger row one attempt owes, or null when it owes none: a replay, a
 * refusal or a failure before any reply was not billed (D72, D91). A billed
 * failure owes a row as a success does, retried or not. A reply without usage
 * owes an unpriced row under the requested model, and one without an id a
 * key of its own, never the shared ''. A usage block with neither an input
 * nor an output count is unknown, not free: it owes an unpriced row too.
 */
export function billedAttempt(call: ModelCallResult, requestedModel: string): BilledAttempt | null {
  if (call.transport !== 'gateway') return null;
  if (!call.ok && !call.billed) return null;
  const u = call.usage ?? null;
  const inputTokens = tokens(u?.inputTokens ?? 0);
  const outputTokens = tokens(u?.outputTokens ?? 0);
  return {
    externalId: call.responseId || `local:${randomUUID()}`,
    model: u?.model ?? requestedModel,
    // usageFromAnthropicReply reads a missing count as 0, so no count at all reaches here as two zeros.
    usage:
      u && (inputTokens > 0 || outputTokens > 0)
        ? {
            model: u.model,
            inputTokens,
            outputTokens,
            ...(u.cacheReadTokens === undefined ? {} : { cacheReadTokens: tokens(u.cacheReadTokens) }),
            ...(u.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: tokens(u.cacheWriteTokens) }),
          }
        : null,
  };
}
