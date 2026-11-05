'use client';

import * as React from 'react';
import Link from 'next/link';

import { Badge } from '@/components/atoms/Badge';
import { StageStatus } from '@/components/shell/StageStatus';
import type { CandidateSummary } from '@/lib/discovery/api';
import { formatDate } from '@/lib/format/date';

import { stepLine } from './StepSuggestion';

/**
 * CandidateList: the proposed deals on /discovery. Reads
 * GET /api/v1/discovery/candidates, which answers under RLS with the viewer's
 * own session, so the list is exactly what the viewer may see. Each row shows
 * the codename, the outside parties, the date range of the evidence and how
 * much of it came from the viewer's own mailbox.
 */

function formatDay(value: string | null): string | null {
  if (!value) return null;
  return formatDate(value, { timeZone: 'UTC' }) || null;
}

export function dateRangeLabel(first: string | null, last: string | null): string {
  const from = formatDay(first);
  const to = formatDay(last);
  if (from && to) return from === to ? from : `${from} to ${to}`;
  return from ?? to ?? 'Date unknown';
}

export function evidenceLabel(total: number, own: number): string {
  const items = `${total} evidence ${total === 1 ? 'item' : 'items'}`;
  if (own === 0) return `${items}, none from your mailbox`;
  if (own >= total) return `${items}, all from your mailbox`;
  return `${items}, ${own} from your mailbox`;
}

function CandidateRow({ candidate }: { candidate: CandidateSummary }) {
  return (
    <li
      className="flex flex-col gap-[var(--space-2)] border-b border-[var(--stroke)] py-[var(--space-4)] last:border-b-0"
      data-candidate-id={candidate.id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--space-3)]">
        <h3 className="deal-identity text-[var(--ink)]">
          <Link href={`/discovery/${candidate.id}`} className="hover:underline">
            {candidate.name}
          </Link>
        </h3>
        <span className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          {dateRangeLabel(candidate.firstSeenAt, candidate.lastSeenAt)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-[var(--space-2)]">
        {candidate.parties.length > 0 ? (
          <ul aria-label="Parties" className="flex list-none flex-wrap gap-[var(--space-2)] p-0">
            {candidate.parties.map((party) => (
              <li key={party.domain}>
                <Badge tone="neutral">
                  <span title={party.domain}>{party.name}</span>
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
            No outside party identified
          </span>
        )}
      </div>
      <p className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {candidate.station ? stepLine(candidate.station) : 'No step yet'}
      </p>
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {evidenceLabel(candidate.evidenceCount, candidate.ownEvidenceCount)}
      </p>
    </li>
  );
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; candidates: CandidateSummary[] };

export function CandidateList() {
  const [state, setState] = React.useState<LoadState>({ status: 'loading' });

  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/discovery/candidates', { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`discovery candidates: ${res.status}`);
        return (await res.json()) as { candidates?: CandidateSummary[] };
      })
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', candidates: data.candidates ?? [] });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <StageStatus kind="loading">
        <p role="status">Loading proposed deals</p>
      </StageStatus>
    );
  }

  if (state.status === 'error') {
    return (
      <StageStatus kind="error">
        <p role="alert">Proposed deals could not be loaded. Try again shortly.</p>
      </StageStatus>
    );
  }

  const { candidates } = state;
  return (
    <section
      aria-label="Proposed deals"
      className="flex flex-col rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-5)] py-[var(--space-2)]"
    >
      {candidates.length === 0 ? (
        <p role="status" className="py-[var(--space-4)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          No proposed deals. A deal appears here once your own mail is evidence for it.
        </p>
      ) : (
        <ul className="flex list-none flex-col p-0">
          {candidates.map((candidate) => (
            <CandidateRow key={candidate.id} candidate={candidate} />
          ))}
        </ul>
      )}
    </section>
  );
}

export default CandidateList;
