'use client';

import * as React from 'react';

import type { Origin } from '@/lib/discovery/origin';
import { MVP_DEAL_RAIL, orderedSteps, stepDisplayNumber } from '@/lib/rail/dealRail';

import { CorrectionDialog, FIELD_CLASS } from './CorrectionDialog';

/** What the dialog offers the MD to confirm: a step a machine proposed, and the sentence that says why. */
export type StationProposal = {
  stepId: string;
  reason: string;
  /** The accepted model proposal's step, or the evidence's own suggestion. */
  source: 'model_proposal' | 'evidence';
};

/** The reason box's starting text when the dialog opens on a proposal. The MD can edit it. */
export const CONFIRMED_PROPOSAL_REASON = 'Confirmed the proposed step';

/**
 * Set the step the MD says the deal is at. The evidence's own suggestion stays beneath it.
 *
 * On a model-origin deal (G-02b, design T2 and R10) this dialog is where a machine's step is adopted, so it names
 * the proposal and its reason, and the MD's submit is the confirmation. It never falls back to the first step:
 * with nothing proposed and no step set, it starts on "Choose a step" and cannot submit until one is picked.
 */
export function SetStepDialog({
  candidateId,
  currentStepId,
  proposal = null,
  origin,
  onClose,
  onDone,
}: {
  candidateId: string;
  /** The override if there is one, else the proposal's step (model-origin) or the evidence's suggestion, else null. */
  currentStepId: string | null;
  /** Shown as "Proposed" with its reason, and the reason box starts as a confirmation of it. Null when the MD already set a step. */
  proposal?: StationProposal | null;
  /** Only an explicit 'rules' may fall back to the first step; 'model_proposal' and an absent origin never start on a step the MD or a proposal did not name. */
  origin?: Origin;
  onClose: () => void;
  onDone: () => void;
}) {
  const steps = React.useMemo(() => orderedSteps(MVP_DEAL_RAIL), []);
  const modelOrigin = origin !== 'rules';
  const [stepId, setStepId] = React.useState(() => {
    if (!modelOrigin) return currentStepId ?? steps[0]?.id ?? '';
    return steps.some((s) => s.id === currentStepId) ? (currentStepId ?? '') : '';
  });
  const buildBody = React.useCallback((reason: string) => ({ stepId, reason }), [stepId]);
  const proposed = proposal ? steps.find((s) => s.id === proposal.stepId) : undefined;
  const nn = (id: string) => String(stepDisplayNumber(id, MVP_DEAL_RAIL)).padStart(2, '0');
  const proposedBlockId = React.useId();
  const showsProposal = Boolean(proposal && proposed);
  // The default reason confirms the proposal, so it belongs to the proposed step only. On any other step it is
  // cleared (the MD must give their own reason, which this dialog already requires), and it returns when they switch
  // back. A reason the MD typed is never replaced: CorrectionDialog only follows this value until they type.
  const confirmsProposal = showsProposal && stepId === proposal?.stepId;
  return (
    <CorrectionDialog
      candidateId={candidateId}
      route="station"
      eyebrow="Set step · logged"
      title="Set the step"
      submitLabel="Set step"
      reasonPlaceholder="What you know that the mail does not show."
      initialReason={confirmsProposal ? CONFIRMED_PROPOSAL_REASON : ''}
      reasonDescribedBy={showsProposal ? proposedBlockId : undefined}
      ready={stepId !== ''}
      buildBody={buildBody}
      onClose={onClose}
      onDone={onDone}
    >
      {proposal && proposed ? (
        // Design to confirm (TH-6): the "Proposed" block follows the Workbench filled-field surface; the incoming
        // designer sets its final weight.
        <div
          id={proposedBlockId}
          className="mt-[var(--space-3)] rounded-[var(--radius-input)] bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)]"
        >
          <span className="bank-label">Proposed</span>
          <p className="font-mono text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
            {nn(proposed.id)} · {proposed.title}
          </p>
          <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">{proposal.reason}</p>
        </div>
      ) : null}
      <label className="mt-[var(--space-3)] block">
        <span className="bank-label">Step</span>
        <select
          aria-label="Step"
          aria-describedby={showsProposal ? proposedBlockId : undefined}
          value={stepId}
          onChange={(e) => setStepId(e.target.value)}
          className={FIELD_CLASS}
        >
          {stepId === '' ? <option value="">Choose a step</option> : null}
          {steps.map((step) => (
            <option key={step.id} value={step.id}>
              {nn(step.id)} · {step.title}
            </option>
          ))}
        </select>
      </label>
    </CorrectionDialog>
  );
}

export default SetStepDialog;
