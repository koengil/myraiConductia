import { readBenchEvents } from './client';

/** What one bench turn reported about itself on the wire. */
export type BenchTurnUsage = {
  /** Null when the bench finished the turn but could not price it: still a call. */
  costUsd: number | null;
  /** The bare provider model id: from `done` when it names one (a skill run), else from `ready`; null on an older bench. */
  model: string | null;
  runId: string | null;
};

/** Longest the meter keeps reading after the browser may have gone. */
export const BENCH_METER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The bench names models by catalog id (`anthropic/claude-sonnet-5`); every
 * other ledger writer stores the provider's own id (`claude-sonnet-5`). One
 * spelling, or the spend report shows one model as two.
 */
export function bareModelId(model: string): string {
  return model.slice(model.lastIndexOf('/') + 1);
}

/**
 * The ledger's one model column for a run that reports every model it called
 * (`run.modelIds`): the bare ids, joined, or null when none was reported.
 */
export function ledgerModelOf(modelIds: readonly string[]): string | null {
  const bare = [...new Set(modelIds.map(bareModelId).filter(Boolean))];
  return bare.length ? bare.join(' + ') : null;
}

/**
 * Split a bench SSE stream in two: the bytes the browser gets, untouched, and a
 * private read that picks the turn's cost (`done`), model (`ready`) and run id
 * (`run`) off the same frames. The two branches are independent, so the meter
 * keeps reading to the end even when the browser disconnects: a turn the bank
 * paid for is on the ledger whether or not anyone stayed to watch it. The read
 * is bounded, so a hung upstream cannot hold the invocation open for ever.
 *
 * `usage` never rejects. It resolves null when the turn never finished (an
 * error frame, a broken or timed-out upstream).
 */
export function meterBenchStream(
  body: ReadableStream<Uint8Array>,
  timeoutMs: number = BENCH_METER_TIMEOUT_MS,
): {
  client: ReadableStream<Uint8Array>;
  usage: Promise<BenchTurnUsage | null>;
} {
  const [client, meter] = body.tee();
  const usage = (async (): Promise<BenchTurnUsage | null> => {
    let model: string | null = null;
    let runId: string | null = null;
    let finished = false;
    let costUsd: number | null = null;
    const events = readBenchEvents(meter);
    // A generator parked on a socket read cannot be interrupted from outside, so
    // the bound is a race: past it the meter stops waiting and reports nothing.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      for (;;) {
        const step = await Promise.race([events.next(), timedOut]);
        if (step === 'timeout' || step.done) break;
        const event = step.value;
        if (event.type === 'ready' && typeof event.model === 'string' && event.model) {
          model = bareModelId(event.model);
        } else if (event.type === 'run' && typeof event.runId === 'string') {
          runId = event.runId;
        } else if (event.type === 'done') {
          finished = true;
          costUsd = typeof event.costUsd === 'number' ? event.costUsd : null;
          // A skill run names the model on `done` (after any clamp), and may send no `ready`: it wins.
          if (typeof event.model === 'string' && event.model) model = bareModelId(event.model);
        }
      }
    } catch {
      // A broken upstream: keep whatever was already read.
    } finally {
      clearTimeout(timer);
    }
    return finished ? { costUsd, model, runId } : null;
  })();
  return { client, usage };
}
