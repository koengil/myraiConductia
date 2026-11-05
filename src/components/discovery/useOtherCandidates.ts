'use client';

import * as React from 'react';

import type { CandidateSummary } from '@/lib/discovery/api';

/**
 * The caller's other proposed deals, read from GET /api/v1/discovery/candidates
 * (so only what RLS lets them see): the choices of the merge and reassign dialogs.
 */
export type OtherCandidates =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; candidates: CandidateSummary[] };

/** `onReady` must be stable (a useCallback): a new function would read the list again. */
export function useOtherCandidates(candidateId: string, onReady?: (candidates: CandidateSummary[]) => void): OtherCandidates {
  const [options, setOptions] = React.useState<OtherCandidates>({ status: 'loading' });

  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/discovery/candidates', { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`discovery candidates: ${res.status}`);
        return (await res.json()) as { candidates?: CandidateSummary[] };
      })
      .then((data) => {
        if (cancelled) return;
        const others = (data.candidates ?? []).filter((c) => c.id !== candidateId);
        setOptions({ status: 'ready', candidates: others });
        onReady?.(others);
      })
      .catch(() => {
        if (!cancelled) setOptions({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [candidateId, onReady]);

  return options;
}
