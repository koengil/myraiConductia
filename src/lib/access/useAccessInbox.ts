'use client';

import * as React from 'react';

export type AccessInboxItem = {
  id: string;
  requesterName: string | null;
  destinationLabel: string;
  createdAt: string;
};

/** The row's line when a decision did not take and the server gave no plain reason. */
export const ACCESS_DECIDE_FAILED = 'The request could not be updated.';

/**
 * The PATCH's refusals that already read as plain English to the person
 * deciding (src/app/api/v1/access-requests/[requestId]/route.ts). Anything
 * else (a database message, "Forbidden", a validation slug) reads as the
 * plain fallback.
 */
const PLAIN_DECIDE_ERRORS: ReadonlySet<string> = new Set([
  'Employee access changed concurrently. Reload and retry.',
  'You can only grant permissions you already hold.',
  'You cannot assign employee access.',
  'This person cannot receive that access.',
  'You cannot decide your own request',
]);

/** The line a refused decision shows on its row. */
export function decideErrorMessage(serverError: string | null | undefined): string {
  if (!serverError || !PLAIN_DECIDE_ERRORS.has(serverError)) return ACCESS_DECIDE_FAILED;
  return /[.!]$/.test(serverError) ? serverError : `${serverError}.`;
}

async function fetchAccessInbox(): Promise<AccessInboxItem[]> {
  try {
    const res = await fetch('/api/v1/access-requests', {
      credentials: 'include',
      // User-scoped and never cacheable: no-store keeps identical concurrent reads out of Chromium's HTTP cache lock (#162).
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { inbox?: AccessInboxItem[] };
    return body.inbox ?? [];
  } catch {
    return [];
  }
}

export function useAccessInbox() {
  const [items, setItems] = React.useState<AccessInboxItem[]>([]);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Keyed by request id, so the line shows on the row that was refused.
  const [errors, setErrors] = React.useState<Readonly<Record<string, string>>>({});

  const load = React.useCallback(async () => {
    setItems(await fetchAccessInbox());
  }, []);

  React.useEffect(() => {
    let active = true;
    fetchAccessInbox().then((list) => {
      if (!active) return;
      setItems(list);
    });
    return () => {
      active = false;
    };
  }, []);

  const decide = React.useCallback(async (id: string, decision: 'approved' | 'denied') => {
    setBusyId(id);
    setError(null);
    setErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    const fail = (message: string) => {
      setError(message);
      setErrors((prev) => ({ ...prev, [id]: message }));
    };
    try {
      const res = await fetch(`/api/v1/access-requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const alreadyDecided =
        res.status === 409 && body?.error === 'This request has already been decided';
      if (alreadyDecided) {
        setItems((prev) => prev.filter((item) => item.id !== id));
        return true;
      }
      if (!res.ok) {
        fail(decideErrorMessage(body?.error));
        return false;
      }
      setItems((prev) => prev.filter((item) => item.id !== id));
      return true;
    } catch {
      fail(ACCESS_DECIDE_FAILED);
      return false;
    } finally {
      setBusyId(null);
    }
  }, []);

  const match = React.useCallback(
    (opts: { requestId?: string | null; destinationLabel?: string | null; actor?: string | null }) => {
      if (opts.requestId) {
        return items.find((item) => item.id === opts.requestId) ?? null;
      }
      if (!opts.destinationLabel) return null;
      return (
        items.find(
          (item) =>
            item.destinationLabel === opts.destinationLabel &&
            (!opts.actor || item.requesterName === opts.actor),
        ) ?? null
      );
    },
    [items],
  );

  return { items, busyId, error, errors, decide, match, reload: load };
}
