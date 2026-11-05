'use client';

import * as React from 'react';


import { getApi } from '@/lib/api';
import { useProjectId } from '@/lib/project/useProjectId';
import type { TeamMember } from '@/lib/api/types';
import { useDealTeamRoster } from '@/lib/rail/dealTeam';
import { DealTeamRosterPanel } from '@/components/team/DealTeamRosterPanel';
import { Badge, Card } from '@/components/atoms';
import { ShieldIcon } from '@/components/brand/icons';
import { StageStatus } from '@/components/shell/StageStatus';

/**
 * Team drawer — experience-spine.md § Step 6:
 *   "A team drawer with three profiles: MD (Storm Duncan, the bank MD running
 *   the mandate), CFO, and M&A Advisor."
 *
 * Editorial Institutional (design spec §6 ComplianceTheatre — "a real
 * communications surface; elegant team profile rows"). This is the pre-onboarded
 * deal team rendered as institutional identity rows, not a SaaS contact list:
 * a monogram chip, the principal's name, the role as a precise instrument
 * label, and a quiet compliance assurance line tying the roster to the moat
 * (strategy-and-moat.md §1 — every message routes through compliance before it
 * sends).
 *
 * This is the only TeamDrawer concern that touches the API
 * (getApi().getTeam()). It loads the roster once. No interaction; the
 * MessageComposer (composed by the /team page) owns the send beat.
 *
 * The async load is GUARDED: a try/catch resolves to an explicit error state
 * and an unmount-safe `active` flag prevents a post-unmount setState. The view
 * is never an eternal "Loading…" — every branch (loading / error / ready) has
 * a terminal rendering. Loading / error are framed by the one designed
 * <StageStatus> (master §3.6.2 — StageStatus owns only the look; this caller
 * still owns the asserted strings + their role/aria, byte-identical).
 */

type LoadState = 'loading' | 'ready' | 'error';

export function TeamDrawer() {
  const dealId = useProjectId();
  const teamRoster = useDealTeamRoster(dealId);
  const [members, setMembers] = React.useState<TeamMember[]>([]);
  const [loadState, setLoadState] = React.useState<LoadState>('loading');

  React.useEffect(() => {
    let active = true;
    const api = getApi();

    async function load() {
      try {
        const roster = await api.getTeam(dealId);
        if (!active) return;
        setMembers(roster);
        setLoadState('ready');
      } catch (err) {
        if (!active) return;
        console.error('[TeamDrawer] failed to load team', { err });
        setLoadState('error');
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [dealId]);

  if (loadState === 'loading') {
    return (
      <StageStatus kind="loading" eyebrow="Deal team">
        <p
          role="status"
          aria-live="polite"
          className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
        >
          Loading team…
        </p>
      </StageStatus>
    );
  }

  if (loadState === 'error') {
    return (
      <StageStatus kind="error" eyebrow="Deal team">
        <p
          role="status"
          className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
        >
          The team roster could not be loaded right now.
        </p>
      </StageStatus>
    );
  }

  return (
    <Card
      aria-label="Team"
      className="flex flex-col gap-[var(--space-6)]"
    >
      <div className="flex items-start justify-between gap-[var(--space-4)]">
        <div className="flex flex-col gap-[var(--space-2)]">
          <span className="eyebrow">Deal team</span>
          <p className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
            Pre-onboarded. Every message routes through compliance before it
            sends.
          </p>
        </div>
        <span className="mt-[2px] inline-flex shrink-0 items-center gap-[var(--space-2)] rounded-[6px] bg-[var(--positive-fill)] px-[var(--space-2)] py-[var(--space-1)] text-[var(--positive-deep)]">
          <ShieldIcon size={14} className="text-[var(--positive-deep)]" />
          <span className="font-sans text-[length:var(--text-xs)] font-medium">
            Monitored
          </span>
        </span>
      </div>

      {teamRoster.isComplete ? (
        <DealTeamRosterPanel
          intake={teamRoster.intake}
          later={teamRoster.later}
          layout="table"
        />
      ) : (
        <ul className="flex flex-col">
          {members.map((m, i) => (
            <li
              key={m.id}
              className={
                'flex items-center gap-[var(--space-4)] py-[var(--space-4)]' +
                (i > 0 ? ' border-t border-[var(--stroke)]' : '')
              }
            >
              <span
                aria-hidden="true"
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--stroke)] bg-[var(--surface-subtle)] font-mono text-[length:var(--text-sm)] font-medium tracking-[0.02em] text-[var(--ink-secondary)]"
              >
                {m.initials}
              </span>
              <span className="flex min-w-0 flex-col gap-[2px]">
                <span className="truncate font-sans text-[length:var(--text-md)] font-medium tracking-tight text-[var(--ink)]">
                  {m.name}
                </span>
                <span className="font-sans text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
                  Pre-onboarded
                </span>
              </span>
              <span className="ml-auto shrink-0">
                <Badge tone="neutral">{m.role}</Badge>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default TeamDrawer;
