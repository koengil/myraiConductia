// The two ways a model request leaves `callModel`: the AI Gateway (a live
// call, through the shared client in ./gatewayClient) and a recording
// (nothing leaves the process).

import type { AiCallUsage } from '@/lib/ai/usage';
import { logServerEvent } from '@/lib/log';

import { postGatewayMessages, type ZdrReason } from './gatewayClient';
import type { ModelCallResult, ModelRequest } from './index';
import { dealProposalV2 } from './prompts/dealProposal.v2';
import { milestoneExtractV1 } from './prompts/milestoneExtract.v1';

export {
  GATEWAY_MESSAGES_URL,
  ZDR_REFUSED_MESSAGE,
  gatewayModelId,
  postGatewayMessages,
  warnOnce,
  __resetWarnOnceForTests,
  type GatewayMessagesResult,
} from './gatewayClient';

export type TransportKind = 'gateway' | 'recorded';

export interface ModelTransport {
  kind: TransportKind;
  send(req: ModelRequest): Promise<ModelCallResult>;
}

const TIMEOUT_MS = 25_000;
export const MAX_TOKENS = 2048;

/** The system and user text a request sends, by purpose and prompt version. */
export function promptFor(req: ModelRequest): { system: string; user: string } {
  // Demo-only (#460): delete this branch with prompts/dealProposal.v2.ts when #459 lands.
  if (req.purpose === 'deal_proposal' && req.promptVersion === 'v2') {
    return { system: dealProposalV2.system, user: dealProposalV2.user(req.input) };
  }
  if (req.purpose === 'milestone_extract' && req.promptVersion === 'v1') {
    return { system: milestoneExtractV1.system, user: milestoneExtractV1.user(req.input) };
  }
  throw new Error(`unknown prompt version: ${String((req as { promptVersion: unknown }).promptVersion)}`);
}

export function gatewayTransport(opts: { apiKey?: string; fetchImpl?: typeof fetch } = {}): ModelTransport {
  const apiKey = opts.apiKey ?? process.env.AI_GATEWAY_API_KEY;
  return {
    kind: 'gateway',
    async send(req) {
      const started = Date.now();
      const fail = (
        code: 'no_key' | 'timeout' | 'http' | 'zdr_unavailable',
        zdrReason?: ZdrReason,
        /** A failure after a 2xx header: billed, so its usage and id go on the ledger (#645). */
        bill?: { usage: AiCallUsage | null; responseId: string },
      ) => ({
        ok: false as const,
        outcome: 'failed' as const,
        code,
        ...(zdrReason ? { zdrReason } : {}),
        ...(bill ? { billed: true as const, usage: bill.usage, responseId: bill.responseId } : {}),
        transport: 'gateway' as const,
        latencyMs: Date.now() - started,
      });
      // The key is the one read when the transport was built, so no_key is decided here, before
      // the prompt, and logged here: postGatewayMessages would read the env again (#474).
      if (!apiKey) {
        const result = fail('no_key');
        logServerEvent({ evt: 'model_outcome', feature: req.purpose, outcome: 'no_key', tenant: req.tenantId, ms: result.latencyMs });
        return result;
      }
      const prompt = promptFor(req);
      const r = await postGatewayMessages({
        feature: req.purpose,
        tenant: req.tenantId,
        model: req.model,
        system: prompt.system,
        user: prompt.user,
        thinking: { type: 'disabled' },
        maxTokens: MAX_TOKENS,
        timeoutMs: TIMEOUT_MS,
        apiKey,
        fetchImpl: opts.fetchImpl,
      });
      if (!r.ok) {
        // The caller logs a code, never the body.
        return fail(r.code, r.zdrReason, r.billed ? { usage: r.usage ?? null, responseId: r.responseId ?? '' } : undefined);
      }
      return {
        ok: true,
        text: r.text ?? '',
        responseId: r.responseId,
        usage: r.usage,
        transport: 'gateway',
        latencyMs: Date.now() - started,
      };
    },
  };
}
