/**
 * PhaseMeter — the deal's phase progress mark, one segment per phase
 * (`phaseCount`). Position is encoded by the filled segments, never colour
 * alone (kit §10): field-gray track segments, ink up to the current phase. The
 * text names the phase only, with no number or count: the aria-label reads
 * "Phase: {name}" ("No active phase" when there is none), and the caption shows
 * the name when `size === 'full'` or `withCaption` is set.
 *
 * One meter, two registers: `compact` is the DealContextBar's inline mark in the
 * shell top bar; `full` is the page-foot instrument on the deal home, which
 * always carries the caption. Sizes and the caption are the only differences —
 * the grammar is shared so the two never drift apart.
 */

import { activeSteps, type ProjectRail } from '@/lib/rail/projectRail';

export type PhaseMeterSize = 'compact' | 'full';

export type PhaseMeterProps = {
  rail: ProjectRail;
  withCaption?: boolean;
  size?: PhaseMeterSize;
  /** Extra classes for the track wrapper (responsive visibility, shrink). */
  className?: string;
};

const SEGMENT: Record<PhaseMeterSize, string> = {
  compact: 'h-[3px] w-[16px]',
  full: 'h-[5px] w-[52px]',
};

const TRACK_GAP: Record<PhaseMeterSize, string> = {
  compact: 'gap-[3px]',
  full: 'gap-[var(--space-1)]',
};

function populatedPhaseIndices(rail: ProjectRail): number[] {
  return [...new Set(activeSteps(rail).map((step) => step.phaseIndex))].sort((a, b) => a - b);
}

export function phaseCountFromRail(rail: ProjectRail): number {
  return populatedPhaseIndices(rail).length || rail.phases.length;
}

export function currentPhaseIndexFromRail(rail: ProjectRail): number {
  const current = activeSteps(rail).find((step) => step.id === rail.currentStepId);
  return current?.phaseIndex ?? 0;
}

export function currentPhasePositionFromRail(rail: ProjectRail): number {
  const index = currentPhaseIndexFromRail(rail);
  if (index === 0) return 0;
  return populatedPhaseIndices(rail).indexOf(index) + 1;
}

export function PhaseMeter({ rail, withCaption, size = 'compact', className }: PhaseMeterProps) {
  const phaseCount = phaseCountFromRail(rail);
  const position = currentPhasePositionFromRail(rail);
  const name = rail.phases.find((phase) => phase.index === currentPhaseIndexFromRail(rail))?.name;

  const track = (
    <div
      role="img"
      aria-label={name ? `Phase: ${name}` : 'No active phase'}
      className={`flex items-center ${TRACK_GAP[size]}${className ? ` ${className}` : ''}`}
    >
      {Array.from({ length: phaseCount }, (_, i) => i + 1).map((i) => (
        <span
          key={i}
          className={
            `${SEGMENT[size]} rounded-full ` +
            (i <= position ? 'bg-[var(--ink)]' : 'bg-[var(--surface-subtle)]')
          }
        />
      ))}
    </div>
  );

  if (!(withCaption || size === 'full') || !name) return track;

  return (
    <div className="flex flex-col items-center gap-[var(--space-2)]">
      {track}
      <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">{name}</p>
    </div>
  );
}
