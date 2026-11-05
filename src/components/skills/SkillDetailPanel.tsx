'use client';

import * as React from 'react';

import { processTagForRailStep } from '@/lib/ignatious/processTag';
import {
  BUILD_OWNER_LABEL,
  MD_BRIEFING_STEP_ID,
  type RailPhase,
  type RailStep,
} from '@/lib/rail/dealRail';
import type { Skill } from '@/lib/api/types';
import { Badge, Pill } from '@/components/atoms';
import {
  approvalStateForStep,
  APPROVAL_STATE_EXPLAINED,
  APPROVAL_STATE_LABEL,
  APPROVAL_STATE_TONE,
} from './governance';
import { Dialog } from '@/components/overlay';

/**
 * SkillDetailPanel — the governed skill for one step, reduced to what the
 * banker needs (WS6: expose the value and the governance, not the mechanism).
 *
 * A centered Dialog (no right-side drawers) with the step's title and approval-state chip, a
 * provenance metadata row (seq + phase + owner), a "why it's better" value
 * line, and the governance the moat rests on: approval state explained, the
 * approval gate, and compliance notes. The io contract (inputs → transformation
 * → outputs), the execution-class code, the tool list, and the repo mechanism
 * note are all deliberately WITHHELD here — the skill is governed and
 * distributed, not reverse-engineerable.
 *
 * The master state is a chip, never a toggle: approval is governed, not
 * self-serve. The five Active seam skills note their live panel here so the
 * existing skills stay reachable from the library.
 *
 * Contrast: LIGHT surface (dark ink) over the shared scrim.
 */
export function SkillDetailPanel({
  step,
  phase,
  total,
  seamSkill,
  onClose,
}: {
  step: RailStep;
  /** The phase the step belongs to (provenance line). */
  phase: RailPhase | undefined;
  /** Total steps on the rail (provenance line). */
  total: number;
  /** The live seam skill this step links to, when one exists. */
  seamSkill?: Skill;
  onClose: () => void;
}) {
  const state = approvalStateForStep(step);

  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow="Step skill"
      title={
        <>
          {step.title}
          {step.priorityBuild ? (
            <>
              {' '}
              <span aria-hidden="true" className="text-[var(--accent-dark)]">
                ★
              </span>
              <span className="sr-only">Priority build.</span>
            </>
          ) : null}
        </>
      }
      size="lg"
    >
      <div className="flex flex-col gap-[var(--space-5)]">
        {/* Metadata row: approval state, provenance and owner. Execution
            class, layer and the io contract are withheld from the banker
            surface (WS6). */}
        <div className="flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-2)]">
          <Badge tone={APPROVAL_STATE_TONE[state]} className="shrink-0">
            {APPROVAL_STATE_LABEL[state]}
          </Badge>
          <span className="inline-flex items-center rounded-[6px] bg-[var(--surface-subtle)] px-[var(--space-2)] py-[var(--space-1)] font-mono text-[length:var(--text-xs)] leading-none text-[var(--ink-tertiary)] tnum">
            Step {step.seq} of {total}
            {phase ? ` · Phase ${phase.index} · ${phase.name}` : ''}
          </span>
          <Pill tone="neutral">{BUILD_OWNER_LABEL[step.buildOwner]}</Pill>
        </div>

      {/* Why it's better — the value proposition, not the description. */}
      <GovernanceBlock label="Why it's better">
        <p className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink)]">
          {step.whyBetter ?? step.description}
        </p>
      </GovernanceBlock>

      {/* Approval state — the master state, explained. */}
      <GovernanceBlock label="Approval state">
        <div className="flex items-center gap-[var(--space-2)]">
          <Badge tone={APPROVAL_STATE_TONE[state]}>
            {APPROVAL_STATE_LABEL[state]}
          </Badge>
        </div>
        <p className="font-sans text-[length:var(--text-sm)] leading-snug text-[var(--ink-secondary)]">
          {APPROVAL_STATE_EXPLAINED[state]}
        </p>
        {seamSkill ? (
          <p className="font-sans text-[length:var(--text-sm)] leading-snug text-[var(--ink-secondary)]">
            Live panel:{' '}
            <span className="font-medium text-[var(--ink)]">
              {seamSkill.name}
            </span>
            . Runs today on the acquirer deep-dive canvas.
          </p>
        ) : null}
        {step.live ? (
          <p className="font-sans text-[length:var(--text-sm)] leading-snug text-[var(--ink-secondary)]">
            Live workflow:{' '}
            <span className="font-medium text-[var(--ink)]">
              {step.id === MD_BRIEFING_STEP_ID ? 'MD brief' : 'Teaser'}
            </span>
            . Runs on the deal rail: Conductia drafts, you review and sign off.
          </p>
        ) : processTagForRailStep(step.id) ? (
          <p className="font-sans text-[length:var(--text-sm)] leading-snug text-[var(--ink-secondary)]">
            Sandbox bench:{' '}
            <span className="font-medium text-[var(--ink)]">
              The skill for this step
            </span>
            . Opus / sonnet / haiku, versioned on the bench. Not deal-safe until a
            governed port exists.
          </p>
        ) : null}
      </GovernanceBlock>

      <GovernanceBlock label="Approval gate">
        <p className="font-sans text-[length:var(--text-sm)] leading-snug text-[var(--ink-secondary)]">
          {step.approvalBy || 'No approval gate recorded in the ledger.'}
        </p>
      </GovernanceBlock>

      {step.compliance.length > 0 ? (
        <GovernanceBlock label="Compliance notes">
          <ul className="flex flex-col gap-[var(--space-2)]" role="list">
            {step.compliance.map((note, i) => (
              <li
                key={i}
                className="font-sans text-[length:var(--text-sm)] leading-snug text-[var(--ink-secondary)]"
              >
                {note}
              </li>
            ))}
          </ul>
        </GovernanceBlock>
      ) : null}

        {/* Footer: provenance restated; the honest governance line. */}
        <p className="rounded-[var(--radius-input)] bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)] tnum">
          {step.id} · owned by {BUILD_OWNER_LABEL[step.buildOwner]} · approval
          is governed, not self-serve
        </p>
      </div>
    </Dialog>
  );
}

function GovernanceBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-[var(--space-2)]">
      <span className="eyebrow">{label}</span>
      {children}
    </section>
  );
}

export default SkillDetailPanel;
