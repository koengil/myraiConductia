import type { ModelCallResult, ModelRequest } from '@/lib/modelGateway';
import type { MilestoneType } from '@/lib/discovery/milestones';
import type { ModelTransport, TransportKind } from '@/lib/modelGateway/transports';

// A test-owned model. It is built from a table of internetMessageId -> the
// milestones a model would report, each with a quote the test asserts is in the
// body. It is never written to model-replies/ and never loaded by app code (R8).

export type DoubleMilestone = { type: MilestoneType; occurred_on: string; quote: string; confidence?: number };
export type DoubleTable = Record<string, DoubleMilestone[]>;

export function replyText(milestones: DoubleMilestone[]): string {
  return JSON.stringify({
    milestones: milestones.map((m) => ({ confidence: 0.9, ...m })),
  });
}

/**
 * `kind` is what the extract loop sees: 'recorded' for the offline path, or
 * 'gateway' to stand in for a live call. `sourceItemId` is the internetMessageId
 * in the in-memory store.
 */
export function modelReplyDouble(
  table: DoubleTable,
  opts: {
    kind?: TransportKind;
    /** Item ids whose first call fails, once. */
    failFirstFor?: ReadonlySet<string>;
    /** The code of a `failFirstFor` failure. Defaults to 'http'. */
    failCode?: 'http' | 'timeout' | 'no_key';
    /** Fail every call with this code. */
    failAllWith?: 'http' | 'timeout' | 'no_key';
    usage?: { model: string; inputTokens: number; outputTokens: number };
    /** The reply's id for the n-th call (1-based). Defaults to `msg_double_<n>`; return '' for a reply with no id. */
    responseId?: (n: number) => string;
  } = {},
): ModelTransport & { sent: string[] } {
  const kind = opts.kind ?? 'recorded';
  const failed = new Set<string>();
  const sent: string[] = [];
  const fail = (code: 'http' | 'timeout' | 'no_key'): ModelCallResult => ({ ok: false, outcome: 'failed', code, transport: kind, latencyMs: 0 });
  return {
    kind,
    sent,
    async send(req: ModelRequest): Promise<ModelCallResult> {
      if (req.purpose !== 'milestone_extract') throw new Error('modelReplyDouble answers milestone_extract only');
      sent.push(req.sourceItemId);
      if (opts.failAllWith) return fail(opts.failAllWith);
      if (opts.failFirstFor?.has(req.sourceItemId) && !failed.has(req.sourceItemId)) {
        failed.add(req.sourceItemId);
        return fail(opts.failCode ?? 'http');
      }
      return {
        ok: true,
        text: replyText(table[req.sourceItemId] ?? []),
        responseId: (opts.responseId ?? ((n) => `msg_double_${n}`))(sent.length),
        usage: opts.usage ?? null,
        transport: kind,
        latencyMs: 0,
      };
    },
  };
}
