import { apiV1, ApiV1Error } from '@/lib/api/v1Client';

/**
 * Saves a deal's rail position (PATCH /api/v1/deals/{id}/progress), one write
 * at a time per deal for the whole page session. The endpoint sets the cursor
 * unconditionally, so overlapping writes could land out of order: a newer
 * position waits and is sent when the current write settles, and only the
 * newest waiting one is kept. There is one saver per deal (progressSaverFor),
 * so leaving a deal and coming back, or a remount, never starts a second queue.
 * Subscribers hear the outcome of the newest position only: an older write's
 * result never overrides a newer one.
 */
export type ProgressSaveResult =
  | { ok: true }
  | {
      ok: false;
      seq: number;
      message: string | null;
      /** A 404: the caller is not on this deal (D65), which a retry cannot change. */
      notOnDeal?: true;
    };

export type ProgressSaver = {
  save(seq: number): void;
  /** Sends the newest position again, unless a write for it is already queued or in flight. */
  retry(): void;
  /** Hears every newest outcome; a new subscriber first hears the last one, so a failure that landed while the rail was unmounted still shows. */
  subscribe(listener: (result: ProgressSaveResult) => void): () => void;
};

export function createProgressSaver(projectId: string): ProgressSaver {
  let inFlight: number | null = null;
  let waiting: number | null = null;
  let latest: number | null = null;
  let last: ProgressSaveResult | null = null;
  const listeners = new Set<(result: ProgressSaveResult) => void>();
  const report = (result: ProgressSaveResult) => {
    last = result;
    listeners.forEach((listener) => listener(result));
  };

  function send() {
    if (inFlight !== null || waiting === null) return;
    const seq = waiting;
    waiting = null;
    inFlight = seq;
    apiV1('PATCH', `/deals/${encodeURIComponent(projectId)}/progress`, { currentStepSeq: seq })
      .then(
        () => {
          if (waiting === null) report({ ok: true });
        },
        (error: unknown) => {
          if (waiting === null) {
            if (error instanceof ApiV1Error && error.status === 404) {
              report({ ok: false, seq, message: null, notOnDeal: true });
            } else {
              report({ ok: false, seq, message: error instanceof ApiV1Error ? error.userMessage : null });
            }
          }
        },
      )
      .finally(() => {
        inFlight = null;
        send();
      });
  }

  return {
    save(seq) {
      latest = seq;
      waiting = seq;
      send();
    },
    retry() {
      if (latest === null || waiting !== null || inFlight === latest) return;
      waiting = latest;
      send();
    },
    subscribe(listener) {
      listeners.add(listener);
      if (last) listener(last);
      return () => listeners.delete(listener);
    },
  };
}

const savers = new Map<string, ProgressSaver>();

/** The one saver for this deal in this page session. */
export function progressSaverFor(projectId: string): ProgressSaver {
  let saver = savers.get(projectId);
  if (!saver) {
    saver = createProgressSaver(projectId);
    savers.set(projectId, saver);
  }
  return saver;
}
