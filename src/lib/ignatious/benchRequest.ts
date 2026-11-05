import { after } from 'next/server';

import { meterBenchStream, type BenchTurnUsage } from './benchMeter';
import { isBenchModelAlias, type BenchModelAlias, type ProcessTag } from './processTag';

export type ParsedBenchChat = {
  message: string;
  conversationId: string | null;
  selection: ProcessTag | null;
  model: BenchModelAlias | null;
  /** The rail step the turn was run from, for the AI spend ledger. Never sent upstream. */
  stepId: string | null;
};

const STEP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/i;

export function parseBenchChatBody(body: unknown): ParsedBenchChat | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Invalid JSON body' };
  const rec = body as Record<string, unknown>;
  const message = typeof rec.message === 'string' ? rec.message.trim() : '';
  if (!message) return { error: 'message is required' };

  const conversationId =
    typeof rec.conversationId === 'string' && rec.conversationId.trim()
      ? rec.conversationId.trim()
      : null;

  const selectionRaw = rec.selection && typeof rec.selection === 'object' ? rec.selection : null;
  const selection =
    selectionRaw && typeof (selectionRaw as { stageId?: unknown }).stageId === 'string'
      ? {
          stageId: (selectionRaw as { stageId: string }).stageId,
          applicationId:
            typeof (selectionRaw as { applicationId?: unknown }).applicationId === 'string'
              ? (selectionRaw as { applicationId: string }).applicationId
              : null,
        }
      : null;

  return {
    message,
    conversationId,
    selection,
    model: isBenchModelAlias(rec.model) ? rec.model : null,
    stepId: typeof rec.stepId === 'string' && STEP_ID.test(rec.stepId) ? rec.stepId : null,
  };
}

/**
 * Stream the bench reply to the browser and put the turn on the AI spend
 * ledger (D53). The cost is read server-side off the same frames the browser
 * gets, and the write runs in `after()`, so it lands even when the banker
 * closes the tab before the turn ends.
 */
export function streamMeteredBenchResponse(
  upstream: Response,
  record: (usage: BenchTurnUsage) => Promise<unknown>,
): Response {
  if (!upstream.body) return streamBenchResponse(upstream);
  const metered = meterBenchStream(upstream.body);
  const write = async () => {
    const usage = await metered.usage;
    if (usage) await record(usage);
  };
  // The meter must never be able to break the chat: where after() is not
  // available the write simply runs unanchored.
  try {
    after(write);
  } catch {
    void write().catch(() => {});
  }
  return streamBenchResponse(new Response(metered.client));
}

export function streamBenchResponse(upstream: Response): Response {
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
