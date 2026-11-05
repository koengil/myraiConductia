'use client';

import * as React from 'react';
import { AnimatePresence } from 'framer-motion';

import type { CandidateCanAct, CandidateItem, CandidateParty } from '@/lib/discovery/api';
import type { Origin } from '@/lib/discovery/origin';
import { MVP_DEAL_RAIL, orderedSteps, stepDisplayNumber } from '@/lib/rail/dealRail';

import { MergeDialog } from './MergeDialog';
import { PromoteDialog } from './PromoteDialog';
import { RejectDialog } from './RejectDialog';
import { ReassignDialog } from './ReassignDialog';
import { RenameDialog } from './RenameDialog';
import { SplitDialog } from './SplitDialog';
import { SetStepDialog, type StationProposal } from './SetStepDialog';

/**
 * What the MD can do to a proposed deal: rename it, set its step, merge it
 * into another, split some of its emails off, move one email to another deal,
 * reject it, or promote it into a mandate (Gate 0). A viewer without deal-create authority sees the
 * same buttons disabled with the reason beside them, never a button that fails
 * (the RemoveStepControl pattern). Each action opens a dialog that requires a
 * reason, and the change is an append-only row in the decision history.
 *
 * A model-origin deal (G-02b, R10) never starts at a step a machine chose. The step dialog is where a proposal
 * is adopted, with the proposal and its reason in view, and Promote starts only at the MD's own override.
 */
type Open = 'rename' | 'station' | 'merge' | 'split' | 'reassign' | 'reject' | 'promote' | null;

export function disabledReason(canAct: CandidateCanAct): string | null {
  if (canAct.ok) return null;
  return canAct.reason === 'candidate_state'
    ? 'This proposed deal can no longer be changed'
    : 'Needs deal-create authority';
}

/** Why promote, reject and merge are closed on a candidate whose other corrections stay open. */
export const PROMOTED_REASON = 'Promoted to a mandate. Promote, reject and merge no longer apply.';

/** The outlined action button: no violet, no status fill, no red. The proposal rows share it (ProposalActions). */
export const ACTION_BUTTON =
  'rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--ink-tertiary)] disabled:opacity-50';

export function CandidateActions({
  candidateId,
  name,
  placedStepId,
  canAct,
  canResolve = canAct,
  onChanged,
  codename = null,
  parties = [],
  items = [],
  initialOpen = null,
  origin,
  overrideStepId = null,
  proposal = null,
}: {
  candidateId: string;
  name: string;
  /** What discovery guessed, shown in the promote dialog as a suggestion. */
  codename?: string | null;
  parties?: CandidateParty[];
  /** The live emails the caller can see, which the split and reassign dialogs choose from. */
  items?: CandidateItem[];
  /**
   * Where the step dialog starts. Rules-found: the override, else the evidence's suggestion. Model-origin: the
   * override, else the proposal's step, else null (the dialog then asks the MD to choose).
   */
  placedStepId: string | null;
  /** Whether the model found this deal. Only an explicit 'rules' is rules-found; an absent origin is treated as model-origin (fail closed). */
  origin?: Origin;
  /** The MD's own step, if they set one. On a model-origin deal this is the only step Promote starts at. */
  overrideStepId?: string | null;
  /** The step a machine proposes, for the model-origin prompt and the step dialog. Null once the MD set a step. */
  proposal?: StationProposal | null;
  canAct: CandidateCanAct;
  /** Whether the actions that end the proposal (promote, reject, merge) are open; defaults to canAct. */
  canResolve?: CandidateCanAct;
  onChanged: () => void;
  /**
   * The dialog to open on first render. The detail view passes 'promote' for a proposal row's Promote (?promote=1),
   * only when canAct and canResolve both allow it, and 'station' for ?station=1, only when canAct allows it, so it
   * never opens a dialog its button would refuse.
   */
  initialOpen?: 'promote' | 'station' | null;
}) {
  const [open, setOpen] = React.useState<Open>(initialOpen ?? null);
  const modelOrigin = origin !== 'rules';
  const reason = disabledReason(canAct);
  const disabled = reason !== null;
  // Only reached when canAct is open: the candidate stands (it was promoted), but its proposal can no longer end.
  const promoted = reason === null && !canResolve.ok && canResolve.reason === 'candidate_state';
  const note = reason ?? (promoted ? PROMOTED_REASON : null);
  const endsProposal = (which: Open) => which === 'merge' || which === 'reject' || which === 'promote';
  const close = React.useCallback(() => setOpen(null), []);
  const done = React.useCallback(() => {
    setOpen(null);
    onChanged();
  }, [onChanged]);

  // Splitting needs an email to move and one to leave; reassigning needs an email to move.
  const action = (which: Exclude<Open, null>, label: string, unavailable = false) => (
    <button
      type="button"
      disabled={disabled || unavailable || (promoted && endsProposal(which))}
      title={reason ?? (promoted && endsProposal(which) ? PROMOTED_REASON : undefined)}
      onClick={() => setOpen(which)}
      className={ACTION_BUTTON}
    >
      {label}
    </button>
  );

  // "The model proposes Step 21 · Teaser and CIM": shown until the MD sets a step, so the deal page asks for the
  // confirmation. Only the accepted model proposal gets this line; an evidence suggestion has its own card.
  const proposedStep =
    modelOrigin && proposal?.source === 'model_proposal'
      ? orderedSteps(MVP_DEAL_RAIL).find((s) => s.id === proposal.stepId)
      : undefined;

  return (
    <section aria-label="Actions" className="flex flex-col gap-[var(--space-2)]">
      {proposal && proposedStep ? (
        // Design to confirm (TH-6): a quiet card in the StepSuggestion style, ink outline, no status colour.
        <div
          role="group"
          aria-label="Model proposal"
          className="flex flex-col gap-[var(--space-1)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-3)]"
        >
          <p className="text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
            The model proposes Step {String(stepDisplayNumber(proposedStep.id, MVP_DEAL_RAIL)).padStart(2, '0')} ·{' '}
            {proposedStep.title}
          </p>
          <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">{proposal.reason}. No step is set.</p>
          <div>{action('station', 'Review step')}</div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-[var(--space-2)]">
        {action('rename', 'Rename')}
        {action('station', 'Set step')}
        {action('merge', 'Merge into…')}
        {action('split', 'Split…', items.length < 2)}
        {action('reassign', 'Move an email…', items.length < 1)}
        {action('reject', 'Reject')}
        {action('promote', 'Promote to mandate')}
      </div>
      {note ? <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">{note}</p> : null}

      {/* One presence for the correction dialogs, so each plays its exit. */}
      <AnimatePresence>
        {open === 'rename' ? (
          <RenameDialog key="rename" candidateId={candidateId} currentName={name} onClose={close} onDone={done} />
        ) : null}
        {open === 'station' ? (
          <SetStepDialog
            key="station"
            candidateId={candidateId}
            currentStepId={placedStepId}
            proposal={proposal}
            origin={origin}
            onClose={close}
            onDone={done}
          />
        ) : null}
        {open === 'merge' ? <MergeDialog key="merge" candidateId={candidateId} name={name} onClose={close} onDone={done} /> : null}
        {open === 'split' ? (
          <SplitDialog key="split" candidateId={candidateId} name={name} items={items} onClose={close} onDone={done} />
        ) : null}
        {open === 'reassign' ? (
          <ReassignDialog key="reassign" candidateId={candidateId} name={name} items={items} onClose={close} onDone={done} />
        ) : null}
        {open === 'reject' ? <RejectDialog key="reject" candidateId={candidateId} name={name} onClose={close} onDone={done} /> : null}
        {open === 'promote' ? (
          <PromoteDialog
            key="promote"
            candidateId={candidateId}
            guessedName={name}
            guessedCodename={codename}
            parties={parties}
            // R10: a model-origin deal starts Promote at the MD's own override or at nothing, never at a machine step.
            defaultStepId={modelOrigin ? overrideStepId : placedStepId}
            origin={origin}
            onClose={close}
          />
        ) : null}
      </AnimatePresence>
    </section>
  );
}

export default CandidateActions;
