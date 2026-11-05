'use client';

import * as React from 'react';

import {
  ACCESS_REQUEST_STATUS,
  type AccessDestination,
} from '@/lib/constants/accessRequests';

type MineRequest = {
  destination: string;
  status: string;
};

/** Load the caller's pending request for a destination and send a new one. */
export function useRequestAccess(destination: AccessDestination) {
  const [pending, setPending] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void fetch('/api/v1/access-requests', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { mine?: MineRequest[] };
        if (cancelled) return;
        setPending(
          (body.mine ?? []).some(
            (row) =>
              row.destination === destination && row.status === ACCESS_REQUEST_STATUS.PENDING,
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [destination]);

  async function requestAccess() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? 'The request could not be sent.');
        return;
      }
      setPending(true);
    } catch {
      setError('The request could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  return { pending, busy, error, requestAccess };
}
