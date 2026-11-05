'use client';

import * as React from 'react';

import { readGeneration, subscribeGeneration } from '@/lib/api/inflightRead';
import { useFlag } from '@/lib/flags/FlagsContext';
import type { DealStepRecord } from '@/lib/rail/dealStepRecord';

/**
 * Whether the platform holds a step record for this step on this deal.
 * `unknown` covers the fixture path (no real API behind the surface) and any
 * transport failure: only a 404 is read as "the server does not have it".
 */
export type ServerStepPresence = 'unknown' | 'loading' | 'present' | 'missing';

export function useServerStepPresence(
  dealId: string,
  stepId: string,
): ServerStepPresence {
  const apiEnabled = useFlag('gate0_api_create');
  const key = apiEnabled && dealId && stepId ? `${dealId}::${stepId}` : null;
  const [resolved, setResolved] = React.useState<{
    key: string;
    presence: ServerStepPresence;
  } | null>(null);

  React.useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void (async () => {
      let presence: ServerStepPresence = 'unknown';
      try {
        const res = await fetch(
          `/api/v1/deals/${encodeURIComponent(dealId)}/steps/${stepId}`,
          { credentials: 'include', headers: { Accept: 'application/json' } },
        );
        if (res.status === 404) presence = 'missing';
        else if (res.ok) presence = 'present';
      } catch {
        presence = 'unknown';
      }
      if (!cancelled) setResolved({ key, presence });
    })();
    return () => {
      cancelled = true;
    };
  }, [key, dealId, stepId]);

  if (!key) return 'unknown';
  return resolved?.key === key ? resolved.presence : 'loading';
}

/**
 * The platform's per-step records for a deal (assignee, completer, logged
 * skip). Fetched once per deal on the rail surface; `refresh` re-reads after
 * a write. Off (empty, no fetch) on the fixture path.
 */
export function useDealStepRecords(
  dealId: string,
  enabled: boolean,
): {
  records: readonly DealStepRecord[];
  refresh: () => void;
  /** The read failed and no good read is on screen: owners are unknown, not "Unassigned". */
  failed: boolean;
} {
  // Step records share no request; their generation only lets a retry (or an
  // identity change) refetch records that had already loaded (#162).
  const generation = React.useSyncExternalStore(
    subscribeGeneration,
    () => readGeneration(`step-records:${dealId}`),
    () => readGeneration(`step-records:${dealId}`),
  );
  const [records, setRecords] = React.useState<{
    dealId: string;
    generation: number;
    rows: DealStepRecord[];
  } | null>(null);
  const [failure, setFailure] = React.useState<{ dealId: string; generation: number } | null>(null);
  const [tick, setTick] = React.useState(0);
  const refresh = React.useCallback(() => setTick((t) => t + 1), []);

  React.useEffect(() => {
    if (!enabled || !dealId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/deals/${encodeURIComponent(dealId)}/step-records`, {
          credentials: 'include',
          // User-scoped and never cacheable: no-store keeps identical concurrent reads out of Chromium's HTTP cache lock (#162).
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { records?: DealStepRecord[] };
        if (!Array.isArray(body.records)) throw new Error('no records');
        if (!cancelled) {
          setRecords({ dealId, generation, rows: body.records });
          setFailure(null);
        }
      } catch {
        // The rail still renders from the cursor and the local run state; a
        // failed poll keeps the last good read, and with none the rail says
        // owners did not load rather than showing everyone as unassigned.
        if (!cancelled) setFailure({ dealId, generation });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dealId, enabled, tick, generation]);

  const good = records?.dealId === dealId && records.generation === generation;
  return {
    records: good ? records.rows : EMPTY_RECORDS,
    refresh,
    failed: enabled && !good && failure?.dealId === dealId && failure.generation === generation,
  };
}

const EMPTY_RECORDS: readonly DealStepRecord[] = [];
