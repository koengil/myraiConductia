'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Badge } from '@/components/atoms/Badge';
import { StageStatus } from '@/components/shell/StageStatus';
import type { CandidateDetail } from '@/lib/discovery/api';
import { proposalReason } from '@/lib/discovery/propose/station';

import { CandidateActions } from './CandidateActions';
import { dateRangeLabel } from './CandidateList';
import { DecisionHistory } from './DecisionHistory';
import { EvidenceList } from './EvidenceExcerpt';
import { MilestoneTimeline } from './MilestoneTimeline';
import type { StationProposal } from './SetStepDialog';
import { StepSuggestion } from './StepSuggestion';

/**
 * One proposed deal. Reads GET /api/v1/discovery/candidates/{id} once, which
 * answers under RLS with the viewer's own session: what is on this page is
 * what the viewer may see, and a colleague's mail arrives as metadata.
 *
 * A proposal row's "Promote to mandate" lands here with ?promote=1 (G-02a, #173). The Promote dialog then opens on
 * its own, but only when canAct and canResolve both allow it; otherwise the page shows its usual disabled reason.
 * The param is read once and dropped from the URL, so a reload or a bookmark does not reopen the dialog.
 * ?station=1 (G-02b) opens Set station the same way, whenever canAct allows it, so a link can land on the review of a
 * model proposal's station.
 *
 * A model-origin deal (R10) shows "The model proposes Station NN" until the MD sets a station, and none of the
 * actions starts at a station a machine chose except the Set station dialog, which names the proposal and its reason.
 */
type LoadState =
  | { status: 'loading' }
  | { status: 'error'; notFound: boolean }
  | { status: 'ready'; candidate: CandidateDetail };

export function CandidateDetailView({ candidateId }: { candidateId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Read once on mount: the replace below drops the params before the detail read settles.
  const [promoteRequested] = React.useState(() => searchParams.get('promote') === '1');
  const [stationRequested] = React.useState(() => searchParams.get('station') === '1');
  const dropParams = React.useRef(promoteRequested || stationRequested);
  React.useEffect(() => {
    if (!dropParams.current) return;
    dropParams.current = false;
    // Drop only promote and station; any other query the page carries survives.
    const rest = new URLSearchParams(searchParams.toString());
    rest.delete('promote');
    rest.delete('station');
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [router, pathname, searchParams]);

  const [state, setState] = React.useState<LoadState>({ status: 'loading' });
  // A correction changes the page, so it asks for a fresh read; the first read shows the loading state.
  const [reloads, setReloads] = React.useState(0);
  // True from the correction until its reload settles: the page it holds is stale meanwhile, and says so.
  const [refreshing, setRefreshing] = React.useState(false);
  const reload = React.useCallback(() => {
    setRefreshing(true);
    setReloads((n) => n + 1);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/discovery/candidates/${candidateId}`, { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (res.status === 404) return { notFound: true as const };
        if (!res.ok) throw new Error(`discovery candidate: ${res.status}`);
        return (await res.json()) as { candidate: CandidateDetail };
      })
      .then((data) => {
        if (cancelled) return;
        setState('notFound' in data ? { status: 'error', notFound: true } : { status: 'ready', candidate: data.candidate });
        setRefreshing(false);
      })
      .catch(() => {
        if (cancelled) return;
        setState({ status: 'error', notFound: false });
        setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [candidateId, reloads]);

  const back = (
    <p className="eyebrow mb-1">
      <Link href="/discovery">Discovery</Link>
    </p>
  );

  if (state.status === 'loading') {
    return (
      <article className="mx-auto max-w-[880px] px-6 py-10">
        {back}
        <StageStatus kind="loading">
          <p role="status">Loading proposed deal</p>
        </StageStatus>
      </article>
    );
  }

  if (state.status === 'error') {
    return (
      <article className="mx-auto max-w-[880px] px-6 py-10">
        {back}
        <StageStatus kind="error">
          <p role="alert">
            {state.notFound
              ? 'This proposed deal is not available to you.'
              : 'The proposed deal could not be loaded. Try again shortly.'}
          </p>
        </StageStatus>
      </article>
    );
  }

  const c = state.candidate;
  const modelOrigin = c.origin === 'model_proposal';
  // What a machine proposes, for the Set station dialog to confirm. Not offered once the MD has set a station.
  const proposal: StationProposal | null =
    !modelOrigin || c.override
      ? null
      : c.modelProposal
        ? { stepId: c.modelProposal.stepId, reason: proposalReason(c.modelProposal), source: 'model_proposal' }
        : c.station
          ? { stepId: c.station.stepId, reason: c.station.reason, source: 'evidence' }
          : null;
  const initialOpen =
    promoteRequested && c.canAct.ok && c.canResolve.ok ? 'promote' : stationRequested && c.canAct.ok ? 'station' : null;
  return (
    <article aria-busy={refreshing} className="mx-auto flex max-w-[880px] flex-col gap-[var(--space-5)] px-6 py-10">
      <header className="flex flex-col gap-[var(--space-2)]">
        {back}
        {refreshing ? (
          <p role="status" className="font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
            Refreshing
          </p>
        ) : null}
        <h1 className="deal-identity text-[var(--ink)]">{c.name}</h1>
        <p className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          {dateRangeLabel(c.firstSeenAt, c.lastSeenAt)}
        </p>
        {c.parties.length > 0 ? (
          <ul aria-label="Parties" className="flex list-none flex-wrap gap-[var(--space-2)] p-0">
            {c.parties.map((party) => (
              <li key={party.domain}>
                <Badge tone="neutral">
                  <span title={party.domain}>{party.name}</span>
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
        {c.mergedInto ? (
          <p role="status" className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            {c.mergedInto.name ? (
              <>
                Merged into{' '}
                <Link href={`/discovery/${c.mergedInto.id}`} className="font-medium text-[var(--ink)] underline">
                  {c.mergedInto.name}
                </Link>
              </>
            ) : (
              <>
                Merged into{' '}
                <Link href={`/discovery/${c.mergedInto.id}`} className="font-medium text-[var(--ink)] underline">
                  another proposed deal
                </Link>
              </>
            )}
          </p>
        ) : null}
      </header>
      <CandidateActions
        candidateId={c.id}
        name={c.name}
        // Model-origin: the override, else the proposal the dialog names with its reason, else nothing (R10).
        placedStepId={
          modelOrigin ? (c.override?.stepId ?? proposal?.stepId ?? null) : (c.override?.stepId ?? c.station?.stepId ?? null)
        }
        origin={c.origin}
        overrideStepId={c.override?.stepId ?? null}
        proposal={proposal}
        canAct={c.canAct}
        canResolve={c.canResolve}
        codename={c.codename}
        parties={c.parties}
        items={c.items}
        onChanged={reload}
        initialOpen={initialOpen}
      />
      <StepSuggestion station={c.station} override={c.override} />
      <MilestoneTimeline milestones={c.milestones} />
      <EvidenceList evidence={c.evidence} />
      <DecisionHistory decisions={c.decisions} candidateId={c.id} />
    </article>
  );
}

export default CandidateDetailView;
