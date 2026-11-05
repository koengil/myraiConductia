'use client';

import Link from 'next/link';
import * as React from 'react';

import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import { FIRM_ROLE } from '@/lib/constants/roles';
import { useFlag } from '@/lib/flags/FlagsContext';

/**
 * How many deals Discovery has proposed from the viewer's own mail. Reads the
 * same GET /api/v1/discovery/candidates the Discovery page lists, so the count
 * is exactly what the viewer may see (row-level security answers per person).
 * Reads nothing with the flag off, and any failure counts as none: this line
 * is an invitation, never an error state.
 */
function useProposedDealCount(enabled: boolean): number {
  const [count, setCount] = React.useState(0);
  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch('/api/v1/discovery/candidates', { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`discovery candidates: ${res.status}`);
        return (await res.json()) as { candidates?: unknown[] };
      })
      .then((data) => {
        if (!cancelled) setCount(data.candidates?.length ?? 0);
      })
      .catch(() => {
        if (!cancelled) setCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return enabled ? count : 0;
}

/** "N new deals found in your mail · Review". Renders nothing at zero. */
export function DiscoveryLine({ className }: { className?: string }) {
  const count = useProposedDealCount(useFlag('deal_discovery'));
  const { state } = useCurrentUser();
  // The control room reads every proposal at the firm, not only its own mail.
  const firmWide = state.status === 'ready' && state.data.user.firm_role === FIRM_ROLE.CCO;
  if (count === 0) return null;
  const deals = count === 1 ? 'deal' : 'deals';
  const whose = firmWide ? "your firm's" : 'your';
  return (
    <p data-testid="discovery-line" className={`text-[length:var(--text-md)] text-[var(--ink-secondary)] ${className ?? ''}`}>
      {count} new {deals} found in {whose} mail
      <span aria-hidden="true"> · </span>
      <Link
        href="/discovery"
        aria-label={`Review the new ${deals} found in ${whose} mail`}
        className="rounded-[var(--radius-control)] font-medium text-[var(--ink)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        Review
      </Link>
    </p>
  );
}
