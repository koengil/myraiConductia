import { bareModelId } from '@/lib/ignatious/benchMeter';
import { readBenchEvents } from '@/lib/ignatious/client';

export type EngineReplacement = { text: string } | { unresolved: string };

export type EngineOutcome = {
  replacements: Map<string, EngineReplacement> | null;
  finished: boolean;
  costUsd: number | null;
  model: string | null;
  alias: string | null;
  skillMounted: boolean | null;
  providerRunId: string | null;
  error: string | null;
};

function readItems(value: unknown): Map<string, EngineReplacement> {
  const items = new Map<string, EngineReplacement>();
  if (!Array.isArray(value)) return items;
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string') continue;
    if (typeof item.unresolved === 'string') items.set(item.id, { unresolved: item.unresolved });
    else if (typeof item.text === 'string') items.set(item.id, { text: item.text });
  }
  return items;
}

export async function readRevisionStream(body: ReadableStream<Uint8Array>): Promise<EngineOutcome> {
  const outcome: EngineOutcome = {
    replacements: null,
    finished: false,
    costUsd: null,
    model: null,
    alias: null,
    skillMounted: null,
    providerRunId: null,
    error: null,
  };

  for await (const event of readBenchEvents(body)) {
    if (event.type === 'ready' && typeof event.model === 'string' && event.model) {
      outcome.model = bareModelId(event.model);
    } else if (event.type === 'run' && typeof event.runId === 'string') {
      outcome.providerRunId = event.runId;
    } else if (event.type === 'replacements') {
      outcome.replacements = readItems(event.items);
    } else if (event.type === 'error' && typeof event.message === 'string') {
      outcome.error = event.message;
    } else if (event.type === 'done') {
      outcome.finished = true;
      outcome.costUsd = typeof event.costUsd === 'number' ? event.costUsd : null;
      if (typeof event.model === 'string' && event.model) {
        outcome.alias = event.model;
        outcome.model = bareModelId(event.model);
      }
      if (typeof event.skillMounted === 'boolean') outcome.skillMounted = event.skillMounted;
    }
  }
  return outcome;
}
