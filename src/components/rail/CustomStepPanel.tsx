'use client';

import * as React from 'react';

import { useFlag } from '@/lib/flags/FlagsContext';
import { stepDescription, stepTitle, type ProjectRailStep } from '@/lib/rail/projectRail';
import { SkillStepRunner } from './SkillStepRunner';
import { ADVANCE_ONLY_LABEL, ADVANCE_ONLY_NOTE, SEAT_CANNOT_ACT } from './stepActionCopy';
import { useActiveDeal } from '@/lib/deals/useDeals';
import { DEAL_ROLE, DEAL_ROLE_LABELS } from '@/lib/constants/roles';
import { isReferenceOnly, STEP_STATE_CHIP, STEP_STATE_LABEL, type StepState } from './stepState';

/** Step detail for a step the deal added itself (no catalog contract). */
export function CustomStepPanel({
  step,
  state,
  dealId,
  onComplete,
  onEnhance,
  canTeach,
  builderChanges,
  stepNumber,
  phaseName,
}: {
  step: ProjectRailStep;
  state: StepState;
  dealId: string;
  onComplete: () => void;
  onEnhance?: (runId: string | null, teach?: boolean) => void;
  canTeach?: boolean;
  builderChanges?: number;
  /** Where the step sits on the rail, shown as secondary text above its name. */
  stepNumber?: number;
  phaseName?: string;
}) {
  const description = stepDescription(step);
  const canRun = useFlag('skill_authoring');
  const advanceNoteId = React.useId();
  const seatNoteId = React.useId();
  // An Observer's seat cannot move the deal on, the same check as StepContract.
  // The server still accepts it: handoff E38 "[PERMISSION] A read-only
  // member can move the deal to the next step".
  const viewerRole = useActiveDeal(dealId).dealRole;
  const seatBlocked =
    viewerRole === DEAL_ROLE.READ_ONLY || viewerRole === DEAL_ROLE_LABELS[DEAL_ROLE.READ_ONLY];
  return (
    <div className="space-y-[var(--space-3)]">
      <header className="flex items-start justify-between gap-[var(--space-3)]">
        <div className="min-w-0">
          {stepNumber !== undefined ? (
            <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
              Step <span className="font-mono tabular-nums">{String(stepNumber).padStart(2, '0')}</span>
              {phaseName ? ` · ${phaseName}` : ''}
            </p>
          ) : null}
          <h2 className="mt-1 text-[length:var(--text-2xl)] font-semibold leading-tight text-[var(--ink)]">
            {stepTitle(step)}
          </h2>
        </div>
        <span className={STEP_STATE_CHIP[state]}>{STEP_STATE_LABEL[state]}</span>
      </header>
      {description ? (
        <p className="text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
          {description}
        </p>
      ) : null}
      {canRun && !isReferenceOnly(state) ? (
        <div className="border-t border-[var(--stroke)] pt-[var(--space-3)]">
          <SkillStepRunner
            projectId={dealId}
            step={step}
            onEnhance={onEnhance}
            canTeach={canTeach}
            builderChanges={builderChanges}
          />
        </div>
      ) : null}
      {/* Only the current step can move the deal on, and that writes the
          cursor only (handoff E28). Elsewhere the old button recorded
          nothing, so it is not offered. */}
      {state === 'active' ? (
        <div className="border-t border-[var(--stroke)] pt-[var(--space-3)]">
          <button
            type="button"
            onClick={onComplete}
            disabled={seatBlocked}
            aria-describedby={seatBlocked ? `${seatNoteId} ${advanceNoteId}` : advanceNoteId}
            className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--ink-tertiary)] disabled:opacity-50"
          >
            {ADVANCE_ONLY_LABEL}
          </button>
          {seatBlocked ? (
            <p id={seatNoteId} className="mt-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              {SEAT_CANNOT_ACT}
            </p>
          ) : null}
          <p id={advanceNoteId} className="mt-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            {ADVANCE_ONLY_NOTE}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export default CustomStepPanel;
