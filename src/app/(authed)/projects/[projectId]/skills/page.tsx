'use client';

import * as React from 'react';
import { AnimatePresence } from 'framer-motion';

import { shortPhaseName } from '@/components/rail/railBoardModel';
import { getApi } from '@/lib/api';
import type { Skill } from '@/lib/api/types';
import {
  DEAL_RAIL,
  orderedSteps,
  phaseForStep,
  totalSteps,
  type RailStep,
} from '@/lib/rail/dealRail';
import { Pill } from '@/components/atoms';
import { logAudit } from '@/lib/audit/store';
import { useActiveDealState } from '@/lib/deals/useDeals';
import { DealListUnavailable } from '@/components/deals/DealsUnavailable';
import { useProjectId } from '@/lib/project/useProjectId';
import { SkillLibraryCard } from '@/components/skills/SkillLibraryCard';
import { SkillDetailPanel } from '@/components/skills/SkillDetailPanel';
import { BenchCatalog } from '@/components/skills/BenchCatalog';
import { approvalStateForStep } from '@/components/skills/governance';

/**
 * Skills — the governed library (develop-design vision spec §4.5).
 *
 * REFRAMED 2026-07-08: the catalogue-with-a-Pro-upsell surface is replaced by
 * the governed, org-distributed library of all 65 step-skills on the deal
 * rail, grouped by ledger phase (the reference UI steal #8: card grammar + org scoping;
 * the self-serve enable toggle and the per-seat paywall are deliberately
 * ABSENT — the approval-state chip carries governance instead). PaywallLock
 * itself is untouched; other surfaces still use it.
 *
 * The library is derived, never stored: cards come straight from DEAL_RAIL
 * (the canonical 5-phase / 65-step census), and each card's approval state is
 * derived from the step's seam-skill link + reality axis
 * (src/components/skills/governance.ts). The five live seam skills
 * (financial-performance, acquirer-fit, culture-signal, deal-readiness,
 * synergy-engine) surface as Active on their steps and stay reachable: their
 * cards open the same detail with the live panel noted.
 *
 * Design: the reference language on tokens — light working canvas (dark ink),
 * hairline-separated 2-column card grid per phase, airy density. NAVY is the
 * single accent (--accent / semantic tokens, never hardcoded): ★ priority
 * marks, Active state chips, primary actions, and filter-pill selection.
 * Token-driven throughout; the conductor re-skins token values at
 * integration. No em-dashes in visible copy (brand voice); they survive only
 * in code comments and ARIA separators.
 */

type FilterId =
  | 'all'
  | 'rts'
  | 'futureproofing'
  | 'priority'
  | `phase-${number}`;

const FILTERS: ReadonlyArray<{
  id: FilterId;
  label: string;
  match: (step: RailStep, phaseIndex: number) => boolean;
}> = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'rts', label: 'RTS', match: (s) => s.buildOwner === 'rts' },
  {
    id: 'futureproofing',
    label: 'Futureproofing',
    match: (s) => s.buildOwner === 'futureproofing-os',
  },
  { id: 'priority', label: '★ Priority', match: (s) => s.priorityBuild },
  ...DEAL_RAIL.map((p) => ({
    id: `phase-${p.index}` as FilterId,
    // The phase's name, never a bare "Phase N" (glossary).
    label: shortPhaseName(p.name),
    match: (_s: RailStep, phaseIndex: number) => phaseIndex === p.index,
  })),
];

export default function SkillsPage() {
  const [filter, setFilter] = React.useState<FilterId>('all');
  const [detailStep, setDetailStep] = React.useState<RailStep | null>(null);
  // Seam skills by id — enriches Active details with their live panel name.
  const [seamSkills, setSeamSkills] = React.useState<Record<string, Skill>>({});
  // Outside the rail gate (#162): a failed deal list is stated, with Try
  // again, rather than the placeholder deal standing in for the real one.
  const { deal, unavailable: dealUnavailable, retry: retryDeals } = useActiveDealState(
    useProjectId(),
  );

  // Compliance record: opening a skill's contract is a tracked action.
  const openDetail = React.useCallback(
    (step: RailStep) => {
      logAudit('skill', 'Opened', step.title, { deal: deal.codename });
      setDetailStep(step);
    },
    [deal.codename],
  );

  React.useEffect(() => {
    let active = true;
    getApi()
      .getSkills()
      .then((list) => {
        if (!active) return;
        setSeamSkills(Object.fromEntries(list.map((s) => [s.id, s])));
      })
      .catch((err) => {
        // The library renders without the seam names; the detail falls back
        // to the honest mechanism note. Surface the failure for diagnosis.
        console.error('[Skills route] failed to load skills', { err });
      });
    return () => {
      active = false;
    };
  }, []);

  const total = totalSteps();
  const counts = React.useMemo(() => {
    const c = { active: 0, approved: 0, proposed: 0 };
    for (const step of orderedSteps()) c[approvalStateForStep(step)] += 1;
    return c;
  }, []);

  const activeFilter = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];
  const phases = DEAL_RAIL.map((phase) => ({
    phase,
    steps: phase.steps.filter((s) => activeFilter.match(s, phase.index)),
  })).filter((p) => p.steps.length > 0);

  return (
    <section
      aria-label="Skills"
      className="page-shell flex w-full flex-1 flex-col gap-[var(--space-7)] py-[var(--space-6)]"
    >
      <header className="flex flex-col gap-[var(--space-3)]">
        <span className="eyebrow">Governed library</span>
        <h1 className="display-1 max-w-[24ch] text-[var(--ink)]">
          Skill library
        </h1>
        <p className="max-w-[62ch] font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          Every step on the deal rail is a governed skill. Compliance approves
          each one before it runs; distribution is organizational, not
          self-serve. RTS owns the vertical deal skills, the Futureproofing OS
          owns the platform layer.
        </p>
        <div className="flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-2)] pt-[var(--space-1)]">
          <Pill tone="neutral">{total} step skills</Pill>
          <Pill tone="positive">{counts.active} Active</Pill>
          <Pill tone="hold">{counts.approved} Approved</Pill>
          <Pill tone="neutral">{counts.proposed} Proposed</Pill>
        </div>
        {dealUnavailable ? <DealListUnavailable onRetry={retryDeals} /> : null}
      </header>

      <BenchCatalog />

      {/* Filter pills — All / owner / ★ / by phase. Selection fills with the
          single accent (navy), per the reference selection grammar. */}
      <div
        role="group"
        aria-label="Filter skills"
        className="flex flex-wrap gap-[var(--space-2)]"
      >
        {FILTERS.map((f) => {
          const selected = f.id === filter;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              aria-pressed={selected}
              className={[
                'inline-flex min-h-[28px] items-center rounded-[var(--radius-pill)] border px-[var(--space-3)] py-[var(--space-1)] ',
                'font-sans text-[length:var(--text-xs)] font-medium leading-none tracking-[0.01em] ',
                'transition-colors duration-150 ease-out ',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 ',
                selected
                  ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]'
                  : 'border-[var(--stroke-strong)] bg-[var(--surface)] text-[var(--ink-secondary)] hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]',
              ].join('')}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Phase sections — serif headers, hairline-separated 2-col card grid. */}
      {phases.map(({ phase, steps }) => (
        <section
          key={phase.id}
          aria-label={`Phase ${phase.index}: ${phase.name}`}
          className="flex flex-col gap-[var(--space-3)]"
        >
          <div className="flex items-baseline justify-between gap-[var(--space-4)]">
            <div className="flex flex-col gap-[var(--space-1)]">
              <h2 className="font-sans text-[length:var(--text-xl)] font-semibold leading-tight tracking-[-0.01em] text-[var(--ink)]">
                {phase.name}
              </h2>
              {phase.index === 1 ? (
                <p className="font-sans text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                  New Business Development: separate timeline (post-MVP). The
                  mandate-formation steps carry onto the execution rail; the rest
                  runs pre-mandate.
                </p>
              ) : null}
            </div>
            <span className="font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)] tnum">
              {steps.length} {steps.length === 1 ? 'skill' : 'skills'}
            </span>
          </div>

          <ul
            className="grid grid-cols-1 overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] md:grid-cols-2"
            role="list"
          >
            {steps.map((step) => (
              <li
                key={step.id}
                className="border-b border-[var(--stroke)] last:border-b-0 md:odd:border-r"
              >
                <SkillLibraryCard step={step} onOpen={openDetail} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {/* Governance note — the surface that replaced the Pro upsell states
          the model plainly. */}
      <footer className="border-t border-[var(--stroke)] pt-[var(--space-4)]">
        <p className="max-w-[62ch] font-sans text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          Skills move Proposed to Approved to Active through compliance review.
          There are no self-serve toggles on this surface; a step-skill runs
          from the rail once it is Active.
        </p>
      </footer>

      <AnimatePresence>
      {detailStep ? (
        <SkillDetailPanel
          key="skill-detail"
          step={detailStep}
          phase={phaseForStep(detailStep.id)}
          total={total}
          seamSkill={
            detailStep.skillId ? seamSkills[detailStep.skillId] : undefined
          }
          onClose={() => setDetailStep(null)}
        />
      ) : null}
      </AnimatePresence>
    </section>
  );
}
