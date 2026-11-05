'use client';

import * as React from 'react';
import Link from 'next/link';

import { getApi } from '@/lib/api';
import type { Acquirer, Skill } from '@/lib/api/types';
import {
  DEFAULT_WEIGHTS,
  computeWeightedScore,
  type ScoreWeights,
} from '@/lib/scoring/composite';
import { resolveAcquirerId } from '@/components/_shared/resolveAcquirerId';
import { ScoreDial } from '@/components/atoms';
import {
  SegmentedControl,
  type SegmentedControlItem,
} from '@/components/atoms';
import { ScoreWeightsControl } from '@/components/acquirers/ScoreWeightsControl';
import { FootballFieldPanel } from '@/components/acquirers/FootballFieldPanel';
import { CultureMatrixPanel } from '@/components/acquirers/CultureMatrixPanel';
import { SynergyStressTestPanel } from '@/components/acquirers/SynergyStressTestPanel';
import { FounderReadPanel } from '@/components/acquirers/FounderReadPanel';
import { StageStatus } from '@/components/shell/StageStatus';
import SkillShelf from '@/components/skills/SkillShelf';
import { Canvas } from '@/components/skills/Canvas';
import { PaywallLock } from '@/components/team/PaywallLock';

/**
 * `/acquirers/[id]` — the deep-dive workspace as a real route (design spec
 * §10.2; personas-and-jobs §2 Job 3).
 *
 * The platform reframe of the linear-spine DeepDive stage. The URL segment
 * `[id]` is the canonical acquirer identifier; the session store no longer
 * carries the selection (no `SELECT_ACQUIRER`, no `NEXT`). Selection is the
 * URL. If the id is missing/invalid the shared `resolveAcquirerId` helper
 * warns loudly and falls back to the top acquirer so the demo never dead-ends
 * (same policy DeepDive and Canvas already share).
 *
 * Composed primitives:
 *   - SkillShelf — the draggable skill deck (self-fetches its catalogue).
 *   - Canvas — the dark workspace drop target. Canvas owns the compliance
 *     round-trip — it dispatches `SET_COMPLIANCE` exactly as it does today
 *     (compliance is a global concern; the single `[data-compliance-status]`
 *     element stays mounted ONCE in the shell — this route mounts no second
 *     indicator).
 *   - PaywallLock — the locked-skill modal, surfaced by Canvas via
 *     `onLocked`.
 *
 * Load contract (mirrors DeepDive): the unmount-safe `active` flag, the
 * loading string `Loading the acquirer workspace…`, the error string `This
 * acquirer workspace could not be loaded right now.`, and the
 * `console.error('[Acquirer route] failed to load acquirer workspace', { err,
 * id: idFromUrl })` diagnostic on reject. The skill catalogue is fetched in a
 * second guarded effect for the Canvas touch-path; failure hides the touch
 * shortcut, drag remains.
 *
 * Workbench restyle (3B-1): the route now reads in the warm light register —
 * white cards, hairline strokes, ink text. The Canvas workspace remains a
 * self-styled dark subtree of its own (skills slice).
 */

type LoadState = 'loading' | 'ready' | 'unscreened' | 'error';

/**
 * The analytical artifacts, presented one at a time via the SegmentedControl
 * (Phase 5b — the prior tall vertical stack scrolled like a tear). Labels are
 * plain and decisive per the brand voice. The first segment (Valuation /
 * Football field) is the default. Each panel mounts only when its segment is
 * active, so a panel self-fetches via its seam method exactly once, on
 * selection — this also trims the initial fetch count to a single panel.
 */
const ANALYSIS_SEGMENTS = [
  { id: 'valuation', label: 'Valuation' },
  { id: 'culture', label: 'Culture' },
  { id: 'synergy', label: 'Synergy' },
  { id: 'founder', label: 'Founder' },
] as const satisfies readonly SegmentedControlItem[];

type AnalysisSegmentId = (typeof ANALYSIS_SEGMENTS)[number]['id'];

export default function AcquirerDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; id: string }>;
}) {
  // Next 16: `params` is a Promise. In a client component we unwrap with
  // `React.use` — this suspends until resolved, no manual state required. The
  // route is project-scoped, so the back affordance carries the projectId.
  const { projectId, id: idFromUrl } = React.use(params);

  const [acquirer, setAcquirer] = React.useState<Acquirer | null>(null);
  const [skills, setSkills] = React.useState<Skill[] | null>(null);
  const [lockedSkill, setLockedSkill] = React.useState<Skill | null>(null);
  const [loadState, setLoadState] = React.useState<LoadState>('loading');
  // Phase C of the sandbox merge (ADR-0002): bucket-level weights are user
  // editable. Reset when the acquirer in the URL changes per the
  // per-acquirer-exploration model (the reset is done with the React-docs
  // "adjusting state when a prop changes" pattern below — setState during
  // render, no effect). The displayed composite is computed locally from
  // the acquirer's fitInputs + the current weights so slider feedback is
  // instant; the seam's getAcquirerScore is the future backend's
  // default-weights entry point and is exercised by the API contract
  // tests, not by this surface.
  const [weights, setWeights] = React.useState<ScoreWeights>(DEFAULT_WEIGHTS);
  const [weightsAcquirerId, setWeightsAcquirerId] =
    React.useState<string>(idFromUrl);
  if (weightsAcquirerId !== idFromUrl) {
    setWeightsAcquirerId(idFromUrl);
    setWeights(DEFAULT_WEIGHTS);
  }

  // Phase 5b: the four analytical panels are now a segmented artifact switcher
  // instead of a vertical stack. The active segment defaults to the first
  // (Valuation). It resets to the default alongside the weights when the
  // acquirer in the URL changes, using the same setState-during-render pattern.
  const [activeSegment, setActiveSegment] =
    React.useState<AnalysisSegmentId>('valuation');
  if (weightsAcquirerId !== idFromUrl) {
    setActiveSegment('valuation');
  }

  // reqToken: race-cancel guard for the load effect. The effect re-runs when
  // idFromUrl changes (navigating between acquirers); without a token, a
  // stale prior response could overwrite the current acquirer's data. Phase
  // F sandbox merge (2026-05-20) — pattern ported from
  // intelibank-sandbox/components/scenes/AcquirersClient.tsx + already in
  // CultureMatrixPanel from Phase D. Mandate page (`src/app/page.tsx`)
  // keeps the simpler `active` boolean because its effect has empty deps —
  // no re-run, no race.
  const reqToken = React.useRef(0);

  React.useEffect(() => {
    const myToken = ++reqToken.current;
    const api = getApi();

    async function load() {
      try {
        const acqList = await api.getAcquirers(projectId);
        if (myToken !== reqToken.current) return;

        if (acqList.length === 0) {
          setLoadState('unscreened');
          return;
        }

        const resolvedId = resolveAcquirerId(idFromUrl, acqList);
        const found = acqList.find((a) => a.id === resolvedId) ?? null;
        if (!found) {
          setLoadState('error');
          return;
        }
        setAcquirer(found);
        setLoadState('ready');
      } catch (err) {
        if (myToken !== reqToken.current) return;
        console.error('[Acquirer route] failed to load acquirer workspace', {
          err,
          id: idFromUrl,
        });
        setLoadState('error');
      }
    }

    void load();
    // No cleanup: the next effect run increments reqToken, which is itself
    // the cancellation signal for any in-flight load.
  }, [projectId, idFromUrl]);

  const displayScore = acquirer
    ? computeWeightedScore(acquirer.fitInputs, weights)
    : null;

  // The skill catalogue for the Canvas mobile "Add to canvas" affordance —
  // matches DeepDive's guarded-but-non-fatal pattern (drag remains if this
  // fails; we still surface a console signal).
  React.useEffect(() => {
    let active = true;
    getApi()
      .getSkills()
      .then((s) => {
        if (active) setSkills(s);
      })
      .catch((err) => {
        console.warn(
          '[Acquirer route] skill catalogue unavailable, mobile tap-to-add disabled',
          { err },
        );
      });
    return () => {
      active = false;
    };
  }, []);

  if (loadState === 'loading') {
    return (
      <StageStatus kind="loading" eyebrow="Acquirer deep-dive">
        <p
          className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
          aria-live="polite"
        >
          Loading the acquirer workspace…
        </p>
      </StageStatus>
    );
  }

  if (loadState === 'unscreened') {
    return (
      <section
        aria-label="Acquirer deep-dive"
        className="page-shell flex w-full flex-1 flex-col gap-[var(--space-3)] py-[var(--space-6)]"
      >
        <Link
          href={`/projects/${projectId}/acquirers`}
          className="inline-flex w-fit items-center gap-[var(--space-2)] font-sans text-[length:var(--text-sm)] text-[var(--ink-tertiary)] outline-none transition-colors hover:text-[var(--ink)] focus-visible:text-[var(--ink)] focus-visible:underline focus-visible:underline-offset-4"
        >
          <span aria-hidden="true">◂</span>
          <span>Acquirers</span>
        </Link>
        <span className="eyebrow text-[var(--ink-tertiary)]">
          Acquirer deep-dive
        </span>
        <h1 className="display-1 max-w-[18ch] text-[var(--ink)]">
          Nothing to open here yet.
        </h1>
        <p
          role="status"
          className="max-w-[52ch] font-sans text-[length:var(--text-md)] leading-relaxed text-[var(--ink-secondary)]"
        >
          This acquirer is not on the screened landscape for this deal.
        </p>
      </section>
    );
  }

  if (loadState === 'error') {
    return (
      <StageStatus kind="error" eyebrow="Acquirer deep-dive">
        <p
          role="status"
          className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
        >
          This acquirer workspace could not be loaded right now.
        </p>
      </StageStatus>
    );
  }

  return (
    // Workbench register: the deep-dive sits on the shared warm canvas, so no
    // dark bleed is needed under the shell's floating console reserve — the
    // root simply fills the visible height.
    <div className="min-h-full w-full">
      <section
        aria-label="Acquirer deep-dive"
        className="flex w-full flex-col"
      >
        <div className="page-shell flex w-full flex-col gap-[var(--space-6)] py-[var(--space-6)]">
          <header className="flex flex-col gap-[var(--space-6)] border-b border-[var(--stroke)] pb-[var(--space-6)] lg:flex-row lg:items-start lg:justify-between">
            <div className="flex flex-col gap-[var(--space-3)]">
              <Link
                href={`/projects/${projectId}/acquirers`}
                className="inline-flex w-fit items-center gap-[var(--space-2)] font-sans text-[length:var(--text-sm)] text-[var(--ink-tertiary)] outline-none transition-colors hover:text-[var(--ink)] focus-visible:text-[var(--ink)] focus-visible:underline focus-visible:underline-offset-4"
              >
                <span aria-hidden="true">◂</span>
                <span>Acquirers</span>
              </Link>
              <span className="eyebrow text-[var(--ink-tertiary)]">
                Acquirer deep-dive
              </span>
              <h1 className="display-1 text-[var(--ink)]">
                {acquirer!.name}
              </h1>
              <p className="max-w-[52ch] font-sans text-[length:var(--text-md)] leading-relaxed text-[var(--ink-secondary)]">
                {acquirer!.tagline}
              </p>
              <p className="max-w-[52ch] font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-tertiary)]">
                Compose the analysis. Each skill routes through compliance before
                it surfaces.
              </p>
            </div>

            {displayScore ? (
              <div className="flex shrink-0 flex-col gap-[var(--space-5)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-8)] py-[var(--space-6)] lg:min-w-[320px]">
                <div className="flex items-center gap-[var(--space-6)]">
                  <div className="flex flex-col gap-[var(--space-1)]">
                    <span className="eyebrow text-[var(--ink-tertiary)]">
                      Composite fit
                    </span>
                    <span className="font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                      Move a weight to re-tally
                    </span>
                  </div>
                  <ScoreDial
                    value={displayScore.total}
                    size={116}
                    label="Composite fit"
                    surface="light"
                  />
                </div>
                <div className="border-t border-[var(--stroke)] pt-[var(--space-5)]">
                  <ScoreWeightsControl
                    weights={weights}
                    onWeightsChange={setWeights}
                    surface="light"
                  />
                </div>
              </div>
            ) : null}
          </header>

          {/* Workspace: a compact source rail (the skill shelf) feeds the
              canvas, which is the working surface and carries the visual
              weight. The shelf is a fixed, narrow sidebar on lg+ and stacks
              above the canvas below it. The canvas takes the remaining width
              with `min-w-0` so its panels can shrink rather than overflow. */}
          <div className="flex flex-col gap-[var(--space-8)] lg:flex-row lg:items-start lg:gap-[var(--space-8)]">
            <div className="w-full shrink-0 lg:w-[260px]">
              <SkillShelf />
            </div>
            <div className="flex w-full min-w-0 flex-1 flex-col">
              <Canvas onLocked={setLockedSkill} skills={skills ?? undefined} />
            </div>
          </div>
        </div>
      </section>

      {/* Analytical panels — Phase D of the sandbox merge (2026-05-20),
          carried into the warm workbench register (3B-1): the section is
          transparent over the shared warm canvas so the two sections meet
          seamlessly. Each panel self-fetches via its seam method
          (getValuation / getCultureMatrix / getSynergyStressTest /
          getFounderRead).

          The sticky right-rail (lg+) carries a compact acquirer context
          (name + composite ScoreDial) that stays in view while the MD
          scrolls the panels. The operator surface (full score card with
          sliders) stays in the workspace header; the rail is reference,
          not operator. Hidden below lg (the header score card suffices). */}
      <section
        aria-label="Acquirer analysis"
        className="flex w-full flex-col text-[var(--ink)]"
      >
        <div className="page-shell w-full py-[var(--space-6)] lg:grid lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start lg:gap-[var(--space-6)]">
          <div className="flex flex-col gap-[var(--space-5)]">
            <SegmentedControl
              items={ANALYSIS_SEGMENTS}
              value={activeSegment}
              onChange={(id) => setActiveSegment(id as AnalysisSegmentId)}
              idBase="acquirer-analysis"
              aria-label="Analytical artifacts"
              panelIdFor={(id) => `acquirer-analysis-panel-${id}`}
            />

            {/* One artifact at a time. Only the active panel is rendered, so it
                mounts (and self-fetches) on selection. We key the panels on the
                acquirer id so switching acquirers re-mounts cleanly. */}
            <div
              role="tabpanel"
              id="acquirer-analysis-panel-valuation"
              aria-labelledby="acquirer-analysis-tab-valuation"
              hidden={activeSegment !== 'valuation'}
            >
              {activeSegment === 'valuation' ? <FootballFieldPanel /> : null}
            </div>

            <div
              role="tabpanel"
              id="acquirer-analysis-panel-culture"
              aria-labelledby="acquirer-analysis-tab-culture"
              hidden={activeSegment !== 'culture'}
            >
              {activeSegment === 'culture' ? (
                <CultureMatrixPanel acquirerId={acquirer!.id} />
              ) : null}
            </div>

            <div
              role="tabpanel"
              id="acquirer-analysis-panel-synergy"
              aria-labelledby="acquirer-analysis-tab-synergy"
              hidden={activeSegment !== 'synergy'}
            >
              {activeSegment === 'synergy' ? (
                <SynergyStressTestPanel acquirerId={acquirer!.id} />
              ) : null}
            </div>

            <div
              role="tabpanel"
              id="acquirer-analysis-panel-founder"
              aria-labelledby="acquirer-analysis-tab-founder"
              hidden={activeSegment !== 'founder'}
            >
              {activeSegment === 'founder' ? (
                <FounderReadPanel acquirerId={acquirer!.id} />
              ) : null}
            </div>
          </div>
          {displayScore ? (
            <aside
              aria-label="Acquirer rail"
              className="hidden lg:flex lg:flex-col lg:gap-[var(--space-3)] lg:rounded-[var(--radius-card)] lg:border lg:border-[var(--stroke)] lg:bg-[var(--surface)] lg:px-[var(--space-4)] lg:py-[var(--space-4)]"
              style={{
                position: 'sticky',
                top: 'calc(var(--shell-header-h) + var(--space-4))',
              }}
            >
              <span className="eyebrow text-[var(--ink-tertiary)]">Acquirer</span>
              <p className="font-sans text-[length:var(--text-lg)] font-medium text-[var(--ink)]">
                {acquirer!.name}
              </p>
              <ScoreDial
                value={displayScore.total}
                size={88}
                label="Composite fit"
                surface="light"
              />
              <p className="font-sans text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-tertiary)]">
                Live composite. Adjust weights in the workspace above.
              </p>
            </aside>
          ) : null}
        </div>
      </section>

      <PaywallLock skill={lockedSkill} onClose={() => setLockedSkill(null)} />
    </div>
  );
}
