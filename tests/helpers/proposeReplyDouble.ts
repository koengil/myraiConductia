import type { ProposalReply } from '@/lib/discovery/propose/parse';
import type { ModelCallResult, ModelRequest } from '@/lib/modelGateway';
import type { DealProposalInput } from '@/lib/modelGateway/prompts/dealProposal.v2';
import type { ModelTransport, TransportKind } from '@/lib/modelGateway/transports';

// A test-owned model for the demo-only proposal step (#460). It answers each
// deal_proposal request with `answer(input, contentHash)`, which a test writes.
// It is never written to model-replies/ and never loaded by app code. Delete
// with the step when #459 lands.

export type ProposeAnswer = ProposalReply | string;

export function proposeReplyDouble(
  answer: (input: DealProposalInput, contentHash: string) => ProposeAnswer,
  opts: {
    kind?: TransportKind;
    /** Content hashes whose first call fails, once. */
    failFirstFor?: ReadonlySet<string>;
    /** Content hashes whose first call is a billed failure, once: a 2xx whose content could not be read, with its usage and id (#645). */
    billedFailFirstFor?: ReadonlySet<string>;
    /** Every call fails. */
    alwaysFail?: boolean;
    /** Absent, every reply carries no usage block, as a 2xx without one does (#645). */
    usage?: { model: string; inputTokens: number; outputTokens: number };
    /** The id every reply carries; '' is a reply with no id (#645). */
    responseId?: string;
  } = {},
): ModelTransport & { sent: Array<{ contentHash: string; input: DealProposalInput }> } {
  const kind = opts.kind ?? 'recorded';
  const failed = new Set<string>();
  const sent: Array<{ contentHash: string; input: DealProposalInput }> = [];
  return {
    kind,
    sent,
    async send(req: ModelRequest): Promise<ModelCallResult> {
      if (req.purpose !== 'deal_proposal') throw new Error('proposeReplyDouble answers deal_proposal only');
      sent.push({ contentHash: req.contentHash, input: req.input });
      const responseId = opts.responseId ?? `msg_propose_double_${sent.length}`;
      const failOnce = opts.failFirstFor?.has(req.contentHash) && !failed.has(req.contentHash);
      if (opts.alwaysFail || failOnce) {
        failed.add(req.contentHash);
        return { ok: false, outcome: 'failed', code: 'http', transport: kind, latencyMs: 0 };
      }
      if (opts.billedFailFirstFor?.has(req.contentHash) && !failed.has(req.contentHash)) {
        failed.add(req.contentHash);
        return { ok: false, outcome: 'failed', code: 'http', billed: true, usage: opts.usage ?? null, responseId, transport: kind, latencyMs: 0 };
      }
      const reply = answer(req.input, req.contentHash);
      return {
        ok: true,
        text: typeof reply === 'string' ? reply : JSON.stringify(reply),
        responseId,
        usage: opts.usage ?? null,
        transport: kind,
        latencyMs: 0,
      };
    },
  };
}
