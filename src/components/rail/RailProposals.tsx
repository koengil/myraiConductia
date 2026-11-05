'use client';

import * as React from 'react';

import { Button } from '@/components/atoms/Button';
import { Dialog, PreviewBanner, PreviewChip } from '@/components/overlay';
import { formatRelative } from '@/lib/format/date';
import { stepTitle, type ProjectRailStep } from '@/lib/rail/projectRail';
import type { ProposalDecision, RailProposal } from '@/lib/rail/railPreview';
import { FIELD_INPUT, FIELD_LABEL } from './SkillBuilderPlacementFields';
import { ReviewDecisionRow } from './TemplateChangesDialog';

/*
 * "Propose a change" and the deal lead's review tray: a Preview in this
 * browser only (handoff E3, docs/03-engineering/walkthrough-handoff-2026-10-22.md).
 * Today nobody is notified and nothing is routed: a proposal is kept here,
 * and the "View as deal lead" toggle shows how the lead would review it.
 * Accepting or discarding marks the proposal only; it never calls the API.
 */

export const PROPOSAL_COPY = {
  propose: 'Propose a change',
  viewAsLead: 'View as deal lead',
  trayTitle: 'Proposed changes',
  stays: 'Your rail stays as it is until you choose.',
  nothingSent: 'Kept in this browser. Nobody is notified yet.',
} as const;

const DECIDED: Record<ProposalDecision, { label: string; tone: 'positive' | 'neutral' }> = {
  accepted: { label: 'Accepted', tone: 'positive' },
  discarded: { label: 'Discarded', tone: 'neutral' },
};

export function ProposeChangeDialog({
  open,
  steps,
  numberOf,
  onClose,
  onPropose,
}: {
  open: boolean;
  /** Steps a proposal can be about, in rail order. */
  steps: readonly ProjectRailStep[];
  numberOf: (step: ProjectRailStep) => string;
  onClose: () => void;
  onPropose: (stepId: string | null, text: string) => void;
}) {
  const [stepId, setStepId] = React.useState('');
  const [text, setText] = React.useState('');
  const id = React.useId();
  const close = () => {
    setStepId('');
    setText('');
    onClose();
  };
  const ready = text.trim().length > 0;
  return (
    <Dialog
      open={open}
      onClose={close}
      dismissOnScrim={false}
      eyebrow="Rail change"
      title={PROPOSAL_COPY.propose}
      description="The deal lead decides. Your rail stays as it is until they choose."
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={!ready}
            onClick={() => {
              onPropose(stepId || null, text);
              close();
            }}
          >
            Propose change
          </Button>
        </>
      }
    >
      <p className="mb-[var(--space-3)] flex flex-wrap items-center gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        {/* Preview: handoff E3 "Per-deal rail edit rights and \"Propose a change\"". */}
        <PreviewChip />
        <span>{PROPOSAL_COPY.nothingSent}</span>
      </p>
      <div className="flex flex-col gap-[var(--space-3)]">
        <div>
          <label className={FIELD_LABEL} htmlFor={`${id}-step`}>
            Step
          </label>
          <select id={`${id}-step`} value={stepId} onChange={(e) => setStepId(e.target.value)} className={FIELD_INPUT}>
            <option value="">The rail as a whole</option>
            {steps.map((s) => (
              <option key={s.id} value={s.id}>
                {numberOf(s)} · {stepTitle(s)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={FIELD_LABEL} htmlFor={`${id}-text`}>
            What should change
          </label>
          <textarea
            id={`${id}-text`}
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="mt-1 block w-full resize-none rounded-[var(--radius-input)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          />
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The deal lead's tray, as one browser simulates it: the proposals with
 * Accept and Discard in TemplateChangesDialog's layout. Deciding marks the
 * proposal here and changes nothing on the deal.
 */
export function ProposalTray({
  proposals,
  stepFor,
  numberOf,
  now,
  onDecide,
  onReset,
}: {
  proposals: readonly RailProposal[];
  stepFor: (id: string) => ProjectRailStep | undefined;
  numberOf: (step: ProjectRailStep) => string;
  now: number;
  onDecide: (id: string, decision: ProposalDecision | null) => void;
  onReset: () => void;
}) {
  return (
    <section
      aria-labelledby="rail-proposal-tray-heading"
      className="mb-[var(--space-4)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)]"
    >
      <p className="eyebrow">{PROPOSAL_COPY.viewAsLead}</p>
      <h2 id="rail-proposal-tray-heading" className="mt-1 text-[length:var(--text-lg)] font-semibold text-[var(--ink)]">
        {PROPOSAL_COPY.trayTitle}
      </h2>
      {/* Preview: handoff E3 "Per-deal rail edit rights and \"Propose a change\"". */}
      <PreviewBanner onReset={onReset} className="mt-[var(--space-3)]" />
      {proposals.length === 0 ? (
        <p className="mt-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
          No proposals yet. Use {PROPOSAL_COPY.propose} to add one.
        </p>
      ) : (
        <ul className="mt-[var(--space-3)] flex flex-col gap-[var(--space-2)]">
          {proposals.map((p) => {
            const step = p.stepId ? stepFor(p.stepId) : undefined;
            const about = step ? `${numberOf(step)} · ${stepTitle(step)}` : 'The rail as a whole';
            return (
              <ReviewDecisionRow
                key={p.id}
                title={p.text}
                meta={`${about} · Proposed by you · ${formatRelative(p.createdAt, now)}`}
                decided={p.decision ? DECIDED[p.decision] : null}
                discarded={p.decision === 'discarded'}
                acceptLabel="Accept"
                discardLabel="Discard"
                canDecide
                onAccept={() => onDecide(p.id, 'accepted')}
                onDiscard={() => onDecide(p.id, 'discarded')}
                onUndo={() => onDecide(p.id, null)}
              />
            );
          })}
        </ul>
      )}
      <p className="mt-[var(--space-3)] border-t border-[var(--stroke)] pt-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        {PROPOSAL_COPY.stays} In this Preview, Accept and Discard mark the proposal only.
      </p>
    </section>
  );
}
