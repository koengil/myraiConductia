'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';

import { VitalsStrip } from '@/components/mandate/VitalsStrip';
import { PhaseMeter } from '@/components/rail/PhaseMeter';
import { DealListUnavailableStage, NotOnDealStage } from '@/components/deals/DealsUnavailable';
import { DESTINATION_TITLES } from '@/lib/perspective/destinationTitles';
import { StageStatus } from '@/components/shell/StageStatus';
import { getApi } from '@/lib/api';
import type { Acquirer, CompositeScore } from '@/lib/api/types';
import { dealRow } from '@/lib/deals/commandCenter';
import { useResolvedDeal, type ListedDeal } from '@/lib/deals/useDeals';
import { resolveProjectId } from '@/lib/project/resolveProjectId';
import { useProjectRail } from '@/lib/rail/projectRail';

type LoadState = 'loading' | 'ready' | 'error';

type DashboardData = {
  pipeline: number;
  topScore: number | null;
  topAcquirerName: string | null;
  teamCount: number;
};

/**
 * The next move: the deal's real current step from the deal list,
 * linking where the rail's "Open current step" goes. A deal with no active
 * step has no next move to name, so the card is absent.
 */
function NextMove({ deal }: { deal: ListedDeal }) {
  const row = dealRow(deal);
  if (!row.hasCurrentStep) return null;
  return (
    <section aria-labelledby="next-move-heading" className="flex flex-col gap-[var(--space-2)]">
      <h2 id="next-move-heading" className="eyebrow">
        The next move
      </h2>
      <div className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          {row.phase}
        </p>
        <Link
          href={row.href}
          className="inline-flex min-h-[36px] items-center rounded-[var(--radius-control)] bg-[var(--accent)] px-3 text-[length:var(--text-sm)] font-medium text-[var(--accent-contrast)] transition-colors duration-150 hover:bg-[var(--accent-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
        >
          Open current step: {row.stepTitle}
        </Link>
      </div>
    </section>
  );
}

export function ProjectDashboard() {
  const projectId = resolveProjectId(
    useParams()?.projectId as string | string[] | undefined,
  );
  const identity = useResolvedDeal(projectId);
  const { rail } = useProjectRail(projectId);
  const [loadState, setLoadState] = React.useState<LoadState>('loading');
  const [data, setData] = React.useState<DashboardData | null>(null);

  React.useEffect(() => {
    let active = true;
    const api = getApi();

    async function load() {
      try {
        const [team, acquirers] = await Promise.all([
          api.getTeam(projectId),
          api.getAcquirers(projectId),
        ]);

        let topScore: CompositeScore | null = null;
        let topAcquirer: Acquirer | null = null;
        for (const acquirer of acquirers) {
          const score = await api.getAcquirerScore(projectId, acquirer.id);
          if (!topScore || score.total > topScore.total) {
            topScore = score;
            topAcquirer = acquirer;
          }
        }

        if (!active) return;
        setData({
          pipeline: acquirers.length,
          topScore: topScore?.total ?? null,
          topAcquirerName: topAcquirer?.name ?? null,
          teamCount: team.length,
        });
        setLoadState('ready');
      } catch (err) {
        console.error('[Project dashboard] failed to load', { err });
        if (!active) return;
        setLoadState('error');
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [projectId]);

  if (identity.status === 'error') {
    // The deal list failed (#162): never "not found", never a fixture.
    return <DealListUnavailableStage onRetry={identity.retry} />;
  }

  if (identity.status === 'unknown') {
    // Not in the viewer's deal list: the list is the deals they are on.
    return <NotOnDealStage title={DESTINATION_TITLES.mandate} />;
  }

  if (identity.status === 'resolving' || loadState === 'loading') {
    return (
      <StageStatus
        kind="loading"
        eyebrow={identity.status === 'ready' ? identity.deal.codename : undefined}
      >
        <p
          role="status"
          aria-live="polite"
          className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
        >
          Loading dashboard…
        </p>
      </StageStatus>
    );
  }

  const deal = identity.deal;

  if (loadState === 'error' || !data) {
    return (
      <StageStatus kind="error" eyebrow={deal.codename}>
        <p role="status" className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          The project dashboard could not be loaded right now.
        </p>
      </StageStatus>
    );
  }

  // Working surface first: the deal's name once, left-aligned, then the rail
  // with its phase meter, the vitals and the next move. No code subtitle (the
  // code lives in the deal switcher menu) and no centered hero. Vitals show
  // only when the deal has analysis behind them: a deal with none would read
  // "Pipeline 0" and "Team 0" from the seam's empty dataset.
  const hasAnalysis = data.pipeline > 0 || data.teamCount > 0;
  return (
    <div className="min-h-full w-full bg-[var(--surface-warm)]">
      <div className="mx-auto flex max-w-[820px] flex-col px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="deal-identity mb-4 text-[var(--ink)]">{deal.codename}</h1>

        <section className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)]">
          <Link
            href={`/projects/${projectId}/rail`}
            className="block p-4 transition-colors duration-150 hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ink)]"
          >
            <span className="text-[length:var(--text-md)] font-semibold text-[var(--ink)]">Deal rail</span>
            {rail ? (
              <div className="mt-4">
                <PhaseMeter rail={rail} withCaption size="full" />
              </div>
            ) : null}
          </Link>
        </section>

        {hasAnalysis ? (
          <div className="mt-[var(--space-5)]">
            <VitalsStrip
              pipeline={data.pipeline}
              topScore={data.topScore}
              topAcquirerName={data.topAcquirerName}
              teamCount={data.teamCount}
            />
          </div>
        ) : null}

        <div className="mt-[var(--space-5)]">
          <NextMove deal={deal} />
        </div>
      </div>
    </div>
  );
}

export default ProjectDashboard;
