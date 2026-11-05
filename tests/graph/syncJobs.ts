import type { SupabaseClient } from '@supabase/supabase-js';

import type { ContentSource, SourceRow } from '@/lib/graph/reader';
import { RoutingContext, SYNC_MAX_PAGES, syncSource, type SyncResult } from '../../worker/sync';

/*
 * The worker's sync jobs for one source, as worker/classify.ts runs them: each
 * job loads the source row, runs syncSource capped at SYNC_MAX_PAGES, and a job
 * that stops on the cap queues the next. The database is a stub that accepts
 * every write and keeps the source row, so the readers must be fed unrouted
 * items only (nothing is stored, every sighting is ledgered).
 */

export type SourceDbState = { delta_checkpoint: string | null; backfill_completed_at: string | null };

function stubDb(row: SourceDbState): SupabaseClient {
  const ok = { data: [], error: null };
  // An empty read, for the message index the skip rule reads on a delta pass (#461): nothing is indexed here.
  const emptyRead = { eq: () => emptyRead, in: async () => ok };
  return {
    // The message index writer (one call per page) and any other RPC: accepted, like every write.
    rpc: async () => ({ data: 0, error: null }),
    from: (table: string) => ({
      select: () => emptyRead,
      upsert: () => Object.assign(Promise.resolve(ok), { select: async () => ok }),
      update: (patch: Record<string, unknown>) => ({
        eq: async () => {
          if (table === 'content_sources') Object.assign(row, patch);
          return ok;
        },
      }),
    }),
  } as unknown as SupabaseClient;
}

/** Runs one tick's chain of jobs until one ends short of the cap, or `maxJobs` have run. */
export async function runSyncJobs(
  reader: ContentSource,
  source: SourceRow,
  row: SourceDbState,
  maxJobs = 4,
): Promise<SyncResult[]> {
  const db = stubDb(row);
  const jobs: SyncResult[] = [];
  while (jobs.length < maxJobs) {
    const result = await syncSource(db, {
      source: { ...source, deltaCheckpoint: row.delta_checkpoint, backfillCompletedAt: row.backfill_completed_at },
      reader,
      runId: `run-${jobs.length}`,
      context: new RoutingContext(),
      maxPages: SYNC_MAX_PAGES,
    });
    jobs.push(result);
    if (result.status !== 'page_limit') break;
  }
  return jobs;
}

export { SYNC_MAX_PAGES };
