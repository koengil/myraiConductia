// The worker's progress mark for one source's pass (reader liveness, #409): content_sources.reader_progress_at, written
// at most every READER_PROGRESS_MARK_SECONDS while the reader makes progress (src/lib/discovery/source/progress.ts).
// discovery_ingestion_health() reads it: an unfinished pass reads Reading while its last mark (or its start) is within
// READER_LIVENESS_SECONDS, and the reader line uses the same mark. The write is the worker's clock, like
// checkpoint_updated_at. It never fails or slows a read: a failed write is dropped, a write still hanging after
// PROGRESS_WRITE_TIMEOUT_MS is given up on (so it cannot stop later marks), and the next mark tries again.

import type { SupabaseClient } from '@supabase/supabase-js';

import { READER_PROGRESS_MARK_SECONDS } from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';

/** How long one progress write may hang before the marker stops waiting for it. */
export const PROGRESS_WRITE_TIMEOUT_MS = 10_000;

export function progressMarker(
  db: SupabaseClient,
  source: { id: string; tenantId: string },
  options: { intervalMs?: number; now?: () => number; timeoutMs?: number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? READER_PROGRESS_MARK_SECONDS * 1000;
  const timeoutMs = options.timeoutMs ?? PROGRESS_WRITE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  let lastAt = -Infinity;
  let writing = false;
  return () => {
    const at = now();
    if (writing || at - lastAt < intervalMs) return;
    lastAt = at;
    writing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        const write = Promise.resolve(
          db
            .from(TABLE.CONTENT_SOURCES)
            .update({ reader_progress_at: new Date(at).toISOString() })
            .eq('id', source.id)
            .eq('tenant_id', source.tenantId),
        );
        const giveUp = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        });
        await Promise.race([write, giveUp]);
      } catch {
        // Dropped: progress is evidence for the health view, never a reason to stop reading.
      } finally {
        if (timer) clearTimeout(timer);
        writing = false;
      }
    })();
  };
}
