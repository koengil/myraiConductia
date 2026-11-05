'use client';

import * as React from 'react';
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
} from 'framer-motion';


import { getApi } from '@/lib/api';
import { useProjectId } from '@/lib/project/useProjectId';
import type { Skill, SkillRunData } from '@/lib/api/types';
import { useSession } from '@/lib/session/store';
import { resolveAcquirerId } from '@/components/_shared/resolveAcquirerId';
import { FinancialMatrixPanel } from '@/components/panels/FinancialMatrixPanel';
import { CultureRadarPanel } from '@/components/panels/CultureRadarPanel';
import { ScoreBreakdownPanel } from '@/components/panels/ScoreBreakdownPanel';
import { TransformStream } from '@/components/skills/TransformStream';

/**
 * Canvas — the hero of the deep-dive (experience-spine.md § Step 4). A light
 * workbench stage drop target that turns a dragged skill into a
 * compliance-verified intelligence panel. This is THE wow beat.
 *
 * The drop → transform → through-compliance → panel sequence is built to the
 * Skill-Transform Stream contract (docs/04-brand/motion-language.md § 2):
 *
 *   1. (skill lift is owned by SkillCard on the shelf — 150ms ease-out)
 *   2. On drop: TransformStream flows a stream of strands across the canvas
 *      (~700ms, ease-in-out). "Data in transit."
 *   3. The stream curves UP and visibly terminates off the top edge toward
 *      the Compliance Instrument (the sticky header band — shell-owned). While
 *      it is in transit the instrument is `scanning` (dispatched here; the
 *      ribbon owns the Compliance Pulse motion, § 1).
 *   4. Compliance resolves to `clear` (or `idle` on a locked/premium skill).
 *   5. The panel renders with a fast fade-in (250ms, ease-out).
 *
 * `prefers-reduced-motion` collapses the stream to instant — TransformStream
 * is not mounted, the stream gate is `Promise.resolve()` (no wait), panels
 * appear with no transition. The compliance round-trip and the dispatch order
 * are byte-identical on both motion paths (master ledger §3.3/§3.5).
 *
 * Mobile (master ledger §3.6 / design spec §5): HTML5 drag-and-drop is
 * unreliable on touch, so each skill also exposes an accessible "Add to
 * canvas" control that invokes the SAME `processSkill` code path the drop
 * handler uses — same dispatch order, same seam call. The desktop drag path
 * and the jsdom DataTransfer test path are untouched.
 *
 * The seam: this is the only Canvas concern that touches the API
 * (`getApi().runSkill`). Locked (premium) skills never add a panel — they
 * surface the paywall via `onLocked`. Panels stack in drop order from
 * `state.panels` (the session store is the source of truth, never local).
 */

// motion-language.md § 2 Skill-Transform Stream — FROZEN (ledger §3.3).
const STREAM_DURATION_S = 0.7; // 700ms — transform stream
const STREAM_EASE = 'easeInOut' as const; // ease-in-out — data in transit
const PANEL_FADE_S = 0.25; // 250ms — panel render
const PANEL_EASE = 'easeOut' as const; // ease-out — decisive

// Acquirer resolution (the loud, validated fallback) lives in the shared
// resolveAcquirerId helper so Canvas and DeepDive share one policy.

const PANEL_DATA_MIME = 'application/intellibank-skill';

type CanvasProps = {
  onLocked: (skill: Skill) => void;
  /**
   * The loaded skill catalogue (DeepDive owns the touch-path fetch) — drives
   * the mobile "Add to canvas" affordance. Optional: when absent the canvas
   * still works as a pure drop target (the drag path is unaffected).
   */
  skills?: Skill[];
};

// Maps the domain SkillRunData.dataKind to the panel component that renders
// it. The mapping is presentation-layer; the wire contract carries domain
// data only (Phase F sandbox merge, 2026-05-20 — see ADR-0005 carry +
// types.ts SkillRunData).
//
// `skillId` + `skillName` are the source-skill tags, threaded through so panels
// whose `dataKind` collides (acquirer-fit and deal-readiness both produce a
// `compositeScore`) read distinctly to the MD. The eyebrow swaps to the
// source skill name and the heading swaps to a skill-specific framing —
// without these the two panels look identical (same score, same breakdown).
const COMPOSITE_SCORE_HEADING: Record<string, string> = {
  'acquirer-fit': 'Weighted financial and culture fit',
  'deal-readiness': 'Capacity to close, end-to-end',
  'synergy-engine': 'Modelled deal-structure score',
};

function renderPanel(
  data: SkillRunData,
  index: number,
  skillId: string,
  skillName: string,
): React.ReactNode {
  switch (data.dataKind) {
    case 'company':
      return <FinancialMatrixPanel key={`panel-${index}`} company={data.company} />;
    case 'cultureFactors':
      return <CultureRadarPanel key={`panel-${index}`} factors={data.factors} />;
    case 'compositeScore':
      return (
        <ScoreBreakdownPanel
          key={`panel-${index}`}
          score={data.score}
          eyebrow={skillName}
          heading={COMPOSITE_SCORE_HEADING[skillId]}
        />
      );
  }
}

export function Canvas({ onLocked, skills }: CanvasProps) {
  const dealId = useProjectId();
  const { state, dispatch } = useSession();
  const reduceMotion = useReducedMotion();
  const [streaming, setStreaming] = React.useState(false);
  const [isOver, setIsOver] = React.useState(false);
  // A small, visible canvas notice if a skill run errors (system fault, not a
  // compliance verdict). Cleared on the next drop attempt.
  const [errorNotice, setErrorNotice] = React.useState(false);
  // Sibling notice for the dedup path — dropping a skill that is already on
  // the canvas is a no-op; we surface why so the action does not feel silent.
  const [duplicateNotice, setDuplicateNotice] = React.useState<string | null>(
    null,
  );
  // Guards against overlapping drops while a transform is mid-flight.
  const busyRef = React.useRef(false);

  const panelTransition: Transition = reduceMotion
    ? { duration: 0 }
    : { duration: PANEL_FADE_S, ease: PANEL_EASE };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!isOver) setIsOver(true);
  };

  const handleDragLeave = () => {
    if (isOver) setIsOver(false);
  };

  // The single skill→panel pipeline. Both the desktop drop handler and the
  // mobile "Add to canvas" affordance funnel through here so the dispatch
  // ORDER and the seam round-trip are byte-identical on every path
  // (master ledger §3.3 Canvas dispatch order).
  const processSkill = async (skillId: string) => {
    if (busyRef.current) return;
    if (!skillId) return;

    // Dedup the drop *before* any side-effects fire: a duplicate must not
    // toggle compliance, not run the transform stream, and not hit the
    // seam. The existing panel stays in place; the notice tells the MD why
    // nothing happened.
    const existing = state.panels.find((p) => p.skillId === skillId);
    if (existing) {
      setDuplicateNotice(existing.skillName);
      return;
    }

    busyRef.current = true;
    setErrorNotice(false);
    setDuplicateNotice(null);

    // (a) Compliance boots into scanning the instant the skill lands — the
    // ribbon owns the Compliance Pulse from this dispatch (motion-language § 1).
    dispatch({ type: 'SET_COMPLIANCE', status: 'scanning' });

    // (b) Skill-Transform Stream: the stream is in transit, routing up through
    // the compliance ribbon. Run it concurrently with the API round-trip so
    // the felt sequence is stream → compliance resolve → panel, not serialised
    // latency on top of motion.
    setStreaming(true);

    const api = getApi();

    // The stream gate is the motion floor — even if the API resolves instantly
    // the felt sequence still holds (stream → resolve → panel). Reduced-motion
    // collapses it to zero per the documented contract.
    const streamGate = reduceMotion
      ? Promise.resolve()
      : new Promise<void>((r) => setTimeout(r, STREAM_DURATION_S * 1000));

    // Seed only for the error-path diagnostic; the success path assigns
    // solely from resolveAcquirerId so the fallback policy lives exclusively
    // in the audited shared helper.
    let acquirerId = state.selectedAcquirerId ?? '';

    try {
      // Resolve the skill metadata once up front — needed for both the
      // locked-paywall path and the ADD_PANEL dispatch (skillName tagging).
      const skillList = skills ?? (await api.getSkills());
      const skill = skillList.find((s) => s.id === skillId);
      if (!skill) {
        throw new Error(`unknown skill id "${skillId}"`);
      }

      const acquirers = await api.getAcquirers(dealId);
      acquirerId = resolveAcquirerId(state.selectedAcquirerId, acquirers);

      const [result] = await Promise.all([
        api.runSkill(dealId, skillId, acquirerId),
        streamGate,
      ]);

      if (result.locked) {
        // (d) Premium/locked: compliance stands down, no panel is added, the
        // paywall beat takes over (experience-spine.md § Step 5).
        dispatch({ type: 'SET_COMPLIANCE', status: 'idle' });
        onLocked(skill);
        return;
      }

      // (e) Cleared: compliance ticks green, the verified panel joins the
      // stack in drop order. `result.data` is the domain shape; the
      // renderPanel mapping above turns it into the panel component.
      // The skillId tag drives dedup + the remove affordance; skillName
      // drives panel-level differentiation for shared dataShapes.
      dispatch({ type: 'SET_COMPLIANCE', status: 'clear' });
      dispatch({
        type: 'ADD_PANEL',
        skillId,
        skillName: skill.name,
        panel: result.data,
      });
    } catch (err) {
      // A system error is NOT a compliance verdict — never show 'blocked'.
      // Stand compliance back down to idle, surface a quiet canvas notice,
      // and let the demo continue. The finally clears the busy guard so the
      // next drop still works (the canvas can never wedge).
      console.error('[Canvas] runSkill failed', { skillId, acquirerId, err });
      dispatch({ type: 'SET_COMPLIANCE', status: 'idle' });
      setErrorNotice(true);
    } finally {
      // Single source of truth for the post-drop reset — every path (success,
      // locked, error) leaves compliance out of `scanning` and the canvas
      // un-wedged through here, exactly once.
      setStreaming(false);
      busyRef.current = false;
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsOver(false);

    if (busyRef.current) return;

    const skillId =
      e.dataTransfer.getData(PANEL_DATA_MIME) ||
      e.dataTransfer.getData('text/plain');
    if (!skillId) return;

    void processSkill(skillId);
  };

  const hasPanels = state.panels.length > 0;

  return (
    <div className="flex w-full flex-col gap-[var(--space-4)]">
      <div
        data-testid="skill-canvas"
        aria-label="Analysis canvas: drop a skill to compose intelligence"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={
          'relative flex min-h-[520px] w-full flex-1 flex-col ' +
          'overflow-hidden rounded-[var(--radius-card)] ' +
          'p-[var(--space-6)] transition-[box-shadow,background-color] duration-200 sm:p-[var(--space-8)] ' +
          (isOver
            ? 'bg-[var(--surface-raised)] ring-1 ring-inset ring-[var(--ink-quiet)]'
            : 'bg-[var(--surface-subtle)] ring-1 ring-inset ring-[var(--stroke)]')
        }
      >
        {!reduceMotion ? (
          <TransformStream
            active={streaming}
            durationS={STREAM_DURATION_S}
            ease={STREAM_EASE}
          />
        ) : null}

        {errorNotice ? (
          <p
            role="status"
            className="relative z-[3] mb-[var(--space-4)] rounded-[var(--radius-control)] bg-[var(--negative-fill)] px-[var(--space-4)] py-[var(--space-3)] text-center font-sans text-[length:var(--text-sm)] text-[var(--negative-deep)]"
          >
            That skill could not be processed: try another.
          </p>
        ) : null}

        {duplicateNotice ? (
          <p
            role="status"
            className="relative z-[3] mb-[var(--space-4)] rounded-[var(--radius-control)] bg-[var(--surface)] px-[var(--space-4)] py-[var(--space-3)] text-center font-sans text-[length:var(--text-sm)] text-[var(--ink)] ring-1 ring-inset ring-[var(--stroke-strong)]"
          >
            {duplicateNotice} is already on the canvas: remove it first to
            re-run.
          </p>
        ) : null}

        {hasPanels ? (
          <div className="relative z-[1] flex flex-col gap-[var(--space-6)]">
            <AnimatePresence initial={false}>
              {state.panels.map((item, i) => (
                <motion.div
                  key={`panel-wrap-${item.skillId}`}
                  initial={{ opacity: reduceMotion ? 1 : 0, y: reduceMotion ? 0 : 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
                  transition={panelTransition}
                  className="relative"
                >
                  {renderPanel(item.data, i, item.skillId, item.skillName)}
                  <button
                    type="button"
                    onClick={() => {
                      dispatch({ type: 'REMOVE_PANEL', skillId: item.skillId });
                      if (duplicateNotice === item.skillName) {
                        setDuplicateNotice(null);
                      }
                    }}
                    aria-label={`Remove ${item.skillName} from the canvas`}
                    className="absolute right-[var(--space-3)] top-[var(--space-3)] inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] bg-[var(--surface)] text-[var(--ink-secondary)] ring-1 ring-inset ring-[var(--stroke-strong)] transition-colors duration-150 hover:bg-[var(--surface-raised)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-subtle)]"
                  >
                    <svg
                      aria-hidden="true"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M6 6l12 12M6 18 18 6" />
                    </svg>
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        ) : (
          // Empty / waiting state. A dashed drop-cue boundary marks the canvas
          // as a deliberate working surface (not a blank panel), and brightens
          // when a skill is dragged over. The copy states what a drop does.
          <div
            className={
              'relative z-[1] flex flex-1 flex-col items-center justify-center gap-[var(--space-4)] ' +
              'rounded-[var(--radius-card)] border border-dashed text-center transition-colors duration-200 ' +
              (isOver
                ? 'border-[var(--ink)]'
                : 'border-[var(--stroke-strong)]')
            }
          >
            <span className="eyebrow">
              Analysis canvas
            </span>
            <span
              aria-hidden="true"
              className="inline-flex h-14 w-14 items-center justify-center rounded-[var(--radius-card)] bg-[var(--surface)] text-[var(--ink-secondary)] ring-1 ring-inset ring-[var(--stroke)]"
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </span>
            <p className="font-sans text-[length:var(--text-lg)] font-semibold text-[var(--ink)]">
              Drag a skill here
            </p>
            <p className="max-w-[34ch] font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
              It transforms the data, routes through compliance, and surfaces
              the verdict.
            </p>
          </div>
        )}
      </div>

      {skills && skills.length > 0 ? (
        <div
          className="flex flex-wrap gap-[var(--space-2)] lg:hidden"
          aria-label="Add a skill to the canvas"
        >
          {skills.map((skill) => (
            <button
              key={skill.id}
              type="button"
              onClick={() => void processSkill(skill.id)}
              aria-label={`Add ${skill.name} to the canvas`}
              className="inline-flex items-center gap-[var(--space-2)] rounded-[var(--radius-control)] bg-[var(--surface)] px-[var(--space-3)] py-[var(--space-2)] font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink)] ring-1 ring-inset ring-[var(--stroke-strong)] transition-colors duration-150 hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-warm)]"
            >
              <svg
                aria-hidden="true"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              {skill.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default Canvas;
