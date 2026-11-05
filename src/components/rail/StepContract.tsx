'use client';

import * as React from 'react';
import { Check, Info } from 'lucide-react';

import { processTagForRailStep } from '@/lib/ignatious/processTag';
import {
  MD_BRIEFING_STEP_ID,
  TEASER_STEP_ID,
  stepAgentFeatures,
  RELATIONSHIP_PATHING_STEP_ID,
  type RailPhase,
  type RailStep,
} from '@/lib/rail/dealRail';
import { stepSkillCopy } from '@/lib/ignatious/stepSkillIo';
import type { ProjectRailStep } from '@/lib/rail/projectRail';
import { GATE0_NOTIFY_STEP_ID } from '@/lib/rail/gate0';
import { useStepCompletionState, TEAM_STEP_ID } from '@/lib/rail/stepRecords';
import { useServerStepPresence } from '@/lib/rail/serverStep';
import { useDealTeamRoster } from '@/lib/rail/dealTeam';
import { DealTeamRosterPanel } from '@/components/team/DealTeamRosterPanel';
import { appendVersion, RECEIPT_VERDICT_LABEL, type StepReceipt, type StepVersion } from './railRunState';
import type { StepSkipRecord } from '@/lib/rail/projectRail';
import { skipApproverLabel } from '@/lib/rail/skipApproverLabel';
import { StepRunner } from './StepRunner';
import { RelationshipPathingPanel } from './RelationshipPathingPanel';
import { ManualStepPanel } from './ManualStepPanel';
import { AssignStepControls } from './AssignStepControls';
import { isReferenceOnly, type StepState } from './stepState';
import { MANUAL_STEP_IDS, manualStepDef } from '@/lib/rail/manualStepDefs';
import { formatDate } from '@/lib/format/date';
import { shortPhaseName } from './railBoardModel';
import {
  ADVANCE_ONLY_LABEL,
  ADVANCE_ONLY_NOTE,
  MANUAL_PLAIN_LINE,
  NO_SKILL_YET,
  OPEN_EARLIER_DRAFTS,
  PRIOR_PLAIN_LINE,
  RELATIONSHIP_PATHING_PLAIN_LINE,
  SEAT_CANNOT_ACT,
  SKILL_NOT_READ,
  SKIPPED_PLAIN_LINE,
  draftPlainLine,
  gate0PlainLine,
  hasKnownOutput,
  openDraftLabel,
} from './stepActionCopy';
import { useStepSkillResolution } from './useStepSkillResolution';
import { useFlag } from '@/lib/flags/FlagsContext';
import { useActiveDeal } from '@/lib/deals/useDeals';
import { DEAL_ROLE, DEAL_ROLE_LABELS } from '@/lib/constants/roles';

/**
 * A record day as the app writes dates ("Oct 23, 2026"), at display time only:
 * the stored value (a calendar day, 'YYYY-MM-DD') is left alone. UTC keeps
 * the calendar day from shifting with the viewer's zone.
 */
function recordDay(value: string): string {
  return formatDate(value, { timeZone: 'UTC' }) || value;
}

/** Step reference copy — shown from the header info control on hover/focus.
 *  A reference-only step drops the runner note: its reference sentence is
 *  its one line about who does what. */
function StepAboutInfo({ step, referenceOnly }: { step: RailStep; referenceOnly: boolean }) {
  return (
    <div className="group/info relative shrink-0">
      <button
        type="button"
        aria-label="About this step"
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ink-tertiary)] transition-colors hover:bg-[var(--surface-subtle)] hover:text-[var(--ink-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <Info size={16} aria-hidden />
      </button>
      <div
        role="tooltip"
        className="pointer-events-none absolute right-0 top-[calc(100%+6px)] z-50 hidden w-[min(320px,80vw)] space-y-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-3)] text-left shadow-[var(--shadow-ambient)] group-hover/info:block group-focus-within/info:block"
      >
        <p className="text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
          {step.description}
        </p>
        {step.note && !referenceOnly ? (
          <p className="text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">{step.note}</p>
        ) : null}
        <div>
          <p className="bank-label mb-1">Produces</p>
          <p className="text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-secondary)]">
            {step.io.outputs[0]?.what ?? 'A completed, logged step on the deal record.'}
          </p>
        </div>
        <div>
          <p className="bank-label mb-1">Approval gate</p>
          <p className="text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-secondary)]">
            {step.approvalBy || 'None declared.'}
          </p>
          {step.compliance.length ? (
            <ul className="mt-1 space-y-0.5">
              {step.compliance.map((c, i) => (
                <li key={i} className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                  {c}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * StepContract — the contract of one step, rendered when the rail zooms
 * into it: description, what the step produces, approval gate,
 * compliance notes, versioned outputs, the run log, and the actions row
 * (the step's draft button / Move to the next step / Skip…). The full io mechanism (inputs →
 * transformation → outputs, tools) is deliberately withheld from the banker
 * surface (WS6). Hairline dividers over boxes.
 */
/** Whether the step's own work panel carries its owner line and Assign…. */
export function stepPanelAssigns(step: RailStep): boolean {
  return step.id === RELATIONSHIP_PATHING_STEP_ID || (MANUAL_STEP_IDS.has(step.id) && !step.live);
}

export function StepContract({
  step,
  projectStep,
  phase,
  state,
  dealId,
  receipts,
  skip,
  versions,
  onComplete,
  onSkip,
  onEnhance,
  canTeach,
  builderChanges,
  stepNumber,
  onAssigned,
}: {
  step: RailStep;
  projectStep: ProjectRailStep;
  phase: RailPhase;
  state: StepState;
  dealId: string;
  receipts: StepReceipt[];
  skip?: StepSkipRecord;
  versions: StepVersion[];
  /**
   * `recorded` is true when the step PATCH already completed the step on the
   * server, which advanced the rail there (#200); the rail then skips its own
   * /progress write.
   */
  onComplete: (options?: { recorded?: boolean; currentStepId?: string | null }) => void;
  onSkip: () => void;
  onEnhance?: (runId: string | null, teach?: boolean) => void;
  canTeach?: boolean;
  builderChanges?: number;
  stepNumber: number;
  /** After an assignment here: the board's own owner read refreshes. */
  onAssigned?: () => void;
}) {
  const [running, setRunning] = React.useState(false);
  const advanceNoteId = React.useId();
  const seatNoteId = React.useId();
  // The manual panel's Mark step complete reason: when this seat cannot
  // complete the step it cannot skip it either (one server capability), so
  // Skip is disabled and points at the same visible reason.
  const manualReasonId = React.useId();
  const [manualCompleteBlocked, setManualCompleteBlocked] = React.useState(false);
  // The client already knows an Observer's seat cannot complete or skip:
  // the controls stay visible, disabled, with the reason beside them.
  const viewerRole = useActiveDeal(dealId).dealRole;
  const seatBlocked =
    viewerRole === DEAL_ROLE.READ_ONLY || viewerRole === DEAL_ROLE_LABELS[DEAL_ROLE.READ_ONLY];
  const { record: completion, loading: completionLoading } = useStepCompletionState(
    dealId,
    step.id,
  );
  const stepPresence = useServerStepPresence(dealId, step.id);
  const statusLoading = completionLoading || stepPresence === 'loading';
  // Notify Compliance is a synthetic Gate 0 receipt (notifications rows), not
  // a deal_steps step. A 404 here is expected and must not look like a gap.
  const missingOnServer =
    step.id !== GATE0_NOTIFY_STEP_ID && stepPresence === 'missing';
  const teamRoster = useDealTeamRoster(dealId);
  /** Gate 0 already satisfied this step (e.g. conflicts at mandate intake). */
  const intakeSatisfied = completion?.source === 'gate0';
  const isComplete = intakeSatisfied || state === 'done';
  const isRelationshipPathing = step.id === RELATIONSHIP_PATHING_STEP_ID;
  const isMdBriefing = step.id === MD_BRIEFING_STEP_ID;
  const isManualStep = MANUAL_STEP_IDS.has(step.id) && !step.live;
  // Skipped and pre-entry steps are closed: read them, never work them.
  const referenceOnly = isReferenceOnly(state);
  const showRelationshipPathing =
    isRelationshipPathing &&
    !missingOnServer &&
    !intakeSatisfied &&
    !referenceOnly;
  const showManualStep =
    isManualStep &&
    !missingOnServer &&
    !intakeSatisfied &&
    !referenceOnly;
  const showStepWork = showRelationshipPathing || showManualStep;
  const skipBlockedByPanel = showManualStep && manualCompleteBlocked;
  const hasStepSkill =
    Boolean(step.live) ||
    stepAgentFeatures(step).length > 0 ||
    processTagForRailStep(step.id) != null;
  const runnable =
    !intakeSatisfied &&
    !step.gate0 &&
    hasStepSkill &&
    state !== 'done' &&
    !referenceOnly;
  const canAct = !intakeSatisfied && !step.gate0 && state === 'active';
  // A step that drafts through its bound skill (the skill runner, not the
  // in-process teaser or MD brief) names a skill only once one resolves.
  const sandboxTeaser = useFlag('teaser_sandbox_runner');
  const liveRun =
    step.id === TEASER_STEP_ID ? sandboxTeaser : step.id === MD_BRIEFING_STEP_ID || Boolean(step.live);
  const needsSkill =
    runnable && !liveRun && !hasKnownOutput(step.id) && processTagForRailStep(step.id) != null;
  const skill = useStepSkillResolution(dealId, projectStep, needsSkill && !missingOnServer);
  const canRerunLive = Boolean(step.live) && !intakeSatisfied && state === 'done';
  const showActions = canAct || canRerunLive || runnable;
  const offersDraft = runnable && (!needsSkill || (skill.status === 'ready' && skill.hasSkill));
  // One plain line under the step name: what the banker does here and what
  // Conductia does. A reference-only step is read, never worked: its
  // reference sentence is its one line. A Gate 0 step says what intake
  // recorded. A drafting step says it while its draft is offered, and a done
  // step with a known output keeps it; its runner says it once it is open.
  // The MD brief says it in its own line below.
  const draftLineShown =
    (offersDraft || (state === 'done' && hasKnownOutput(step.id))) &&
    !running &&
    !isMdBriefing &&
    !missingOnServer &&
    !statusLoading;
  const plainLine = referenceOnly
    ? state === 'skipped'
      ? SKIPPED_PLAIN_LINE
      : PRIOR_PLAIN_LINE
    : step.gate0
      ? gate0PlainLine(step.id)
      : isManualStep
        ? MANUAL_PLAIN_LINE
        : isRelationshipPathing
          ? RELATIONSHIP_PATHING_PLAIN_LINE
          : draftLineShown
            ? draftPlainLine(step.id, step.title)
            : null;
  // The append-version control on a done step's outputs; the sentence about
  // it shows only while it is in view.
  const editInView = versions.length > 0 && !showStepWork && state === 'done' && !intakeSatisfied;
  // The actions footer's last branches: todo, then the done line. A
  // reference-only step has nothing there; a done line needs its subject.
  const footerEmpty =
    !running &&
    !missingOnServer &&
    !showActions &&
    state !== 'todo' &&
    (referenceOnly || (!isRelationshipPathing && !editInView));

  return (
    <div className="space-y-[var(--space-4)]">
      <header className="flex items-start justify-between gap-[var(--space-3)]">
        {/* The step name is the hero; its place on the rail is secondary. */}
        <div className="min-w-0">
          <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            Step <span className="font-mono tabular-nums">{String(stepNumber).padStart(2, '0')}</span>
            {' · '}
            {shortPhaseName(phase.name)}
          </p>
          <h2 className="mt-1 text-[length:var(--text-2xl)] font-semibold leading-tight text-[var(--ink)]">
            {step.title}
          </h2>
          {plainLine ? (
            <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{plainLine}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-[var(--space-2)]">
          {statusLoading ? (
            <span className="inline-flex items-center rounded-[6px] bg-[var(--surface-subtle)] px-2 py-0.5 text-[length:var(--text-xxs)] font-medium text-[var(--ink-tertiary)]">
              Loading
            </span>
          ) : isComplete ? (
            <span className="inline-flex items-center gap-1 rounded-[6px] bg-[var(--positive-fill)] px-2 py-0.5 text-[length:var(--text-xxs)] font-medium text-[var(--positive-deep)]">
              <Check size={12} aria-hidden strokeWidth={2.5} />
              Complete
            </span>
          ) : null}
          <StepAboutInfo step={step} referenceOnly={referenceOnly} />
        </div>
      </header>

      {statusLoading ? (
        <p
          role="status"
          aria-live="polite"
          className="border-t border-[var(--stroke)] pt-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
        >
          Loading this step…
        </p>
      ) : null}

      {!statusLoading && isMdBriefing && !missingOnServer && !referenceOnly ? (
        <p className="text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
          {stepSkillCopy(step.id, step.title).uses}
        </p>
      ) : null}

      {!statusLoading && missingOnServer ? (
        <section
          aria-label="Step record"
          data-step-record="missing"
          className="rounded-[var(--radius-card)] border border-[var(--hold)] bg-[var(--hold-tint)] p-[var(--space-3)]"
        >
          <p className="text-[length:var(--text-sm)] font-semibold text-[var(--hold-deep)]">
            Not on the deal record
          </p>
          <p className="mt-1 text-[length:var(--text-sm)] leading-relaxed text-[var(--hold-deep)]">
            The platform holds no record of this step on this deal. What
            follows is the standard contract for the step, not deal work.
            Nothing here can be assigned, completed or audited until the step
            exists on the record.
          </p>
        </section>
      ) : null}

      {!statusLoading && completion ? (
        <section aria-label="What was done" className="border-t border-[var(--stroke)] pt-[var(--space-3)]">
          <p className="text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
            {completion.approvedWhat}
          </p>
          {step.id !== TEAM_STEP_ID ? (
            <dl className="mt-[var(--space-3)] grid gap-[var(--space-3)] sm:grid-cols-2">
              <div>
                <dt className="text-[length:var(--text-xxs)] font-medium text-[var(--ink-tertiary)]">
                  {completion.byLabel ?? 'Approved by'}
                </dt>
                <dd className="mt-0.5 text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
                  {completion.approvedBy}
                </dd>
              </div>
              <div>
                <dt className="text-[length:var(--text-xxs)] font-medium text-[var(--ink-tertiary)]">
                  {completion.onLabel ?? 'Approved on'}
                </dt>
                <dd className="mt-0.5 font-mono text-[length:var(--text-sm)] tabular-nums text-[var(--ink)]">
                  {recordDay(completion.approvedOn)}
                </dd>
              </div>
              {completion.completedBy ? (
                <div>
                  <dt className="text-[length:var(--text-xxs)] font-medium text-[var(--ink-tertiary)]">
                    Marked complete by
                  </dt>
                  <dd className="mt-0.5 text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
                    {completion.completedBy}
                  </dd>
                </div>
              ) : null}
              {completion.completedOn ? (
                <div>
                  <dt className="text-[length:var(--text-xxs)] font-medium text-[var(--ink-tertiary)]">
                    Marked complete on
                  </dt>
                  <dd className="mt-0.5 font-mono text-[length:var(--text-sm)] tabular-nums text-[var(--ink)]">
                    {recordDay(completion.completedOn)}
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </section>
      ) : null}

      {!statusLoading && step.id === TEAM_STEP_ID && (showManualStep || teamRoster.isComplete) ? (
        <section
          aria-label="Deal team roster"
          className={
            completion || showManualStep
              ? 'pt-[var(--space-3)]'
              : 'border-t border-[var(--stroke)] pt-[var(--space-3)]'
          }
        >
          <DealTeamRosterPanel intake={teamRoster.intake} later={teamRoster.later} />
        </section>
      ) : null}

      {!statusLoading && showRelationshipPathing ? (
        <section
          aria-label="Relationship pathing"
          className="border-t border-[var(--stroke)] pt-[var(--space-3)]"
        >
          <p className="mb-[var(--space-3)] text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
            {step.description}
          </p>
          <AssignStepControls dealId={dealId} stepId={step.id} stepTitle={step.title} disabled={state === 'done'} onAssigned={onAssigned} />
          <div className="mt-[var(--space-3)]">
            <RelationshipPathingPanel
              dealId={dealId}
              canApprove={canAct}
              seatBlocked={seatBlocked}
              readOnly={state === 'done'}
              onApproved={canAct ? (currentStepId) => onComplete({ recorded: currentStepId !== undefined, currentStepId }) : undefined}
            />
          </div>
        </section>
      ) : null}

      {!statusLoading && showManualStep ? (
        <section
          aria-label="Manual step work"
          className="border-t border-[var(--stroke)] pt-[var(--space-3)]"
        >
          {/* One description: the step's own, or the checklist summary on the
              team step, whose roster sits above. */}
          <p className="mb-[var(--space-3)] text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
            {step.id !== TEAM_STEP_ID ? step.description : manualStepDef(step.id)?.summary}
          </p>
          <ManualStepPanel
            dealId={dealId}
            stepId={step.id}
            stepTitle={step.title}
            onCompleted={(currentStepId) => onComplete({ recorded: true, currentStepId })}
            onAssigned={onAssigned}
            completeReasonId={manualReasonId}
            onCompleteBlockedChange={setManualCompleteBlocked}
          />
        </section>
      ) : null}

      {/* Versioned skill outputs — only when a run has actually filed one. */}
      {!statusLoading && versions.length > 0 && !showStepWork ? (
      <section aria-label="Output versions" className="border-t border-[var(--stroke)] pt-[var(--space-3)]">
        <div className="flex items-center gap-[var(--space-2)]">
          <p className="bank-label">Outputs · versions</p>
          {editInView ? (
            <button
              type="button"
              onClick={() =>
                appendVersion(
                  dealId,
                  step.id,
                  'Edited after completion',
                  'MD revision. Appended as a new version, nothing overwritten.',
                )
              }
              className="ml-auto rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-2)] py-0.5 text-[length:var(--text-xxs)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--ink-tertiary)]"
            >
              Edit · append version
            </button>
          ) : null}
        </div>
        <ol className="mt-[var(--space-2)] divide-y divide-[var(--stroke)]">
          {versions.map((v) => (
            <li key={v.version} className="py-[var(--space-2)] first:pt-0 last:pb-0">
              <div className="flex items-baseline gap-[var(--space-2)]">
                <span className="font-mono text-[length:var(--text-xxs)] font-semibold text-[var(--ink)]">
                  V{v.version}
                </span>
                <span className="text-[length:var(--text-xs)] font-medium text-[var(--ink)]">
                  {v.label}
                </span>
                <span className="ml-auto font-mono text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">
                  {formatDate(v.at)}
                </span>
              </div>
              {v.note ? (
                <p className="mt-0.5 text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">{v.note}</p>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
      ) : null}

      {/* Run log: receipts + the logged skip */}
      {!statusLoading && (receipts.length || skip) ? (
        <section aria-label="Run log" className="border-t border-[var(--stroke)] pt-[var(--space-3)]">
          <p className="bank-label mb-[var(--space-2)]">Run log</p>
          <ol className="space-y-1.5">
            {receipts.map((r) => (
              <li key={r.id} className="font-mono text-[length:var(--text-xxs)] text-[var(--ink-secondary)]">
                {r.label} · {RECEIPT_VERDICT_LABEL[r.verdict]} · {r.checks.join(' · ')} · {r.seconds}s
              </li>
            ))}
            {skip ? (
              <li className="font-mono text-[length:var(--text-xxs)] text-[var(--ink-secondary)]">
                {/* An empty approver or reason drops its segment, never "approved by  ·". */}
                {[
                  'Skipped',
                  skipApproverLabel(skip) ? `approved by ${skipApproverLabel(skip)}` : null,
                  skip.reason || null,
                  'routed onward',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </li>
            ) : null}
          </ol>
        </section>
      ) : null}

      {/* Runner / actions — omitted once Gate 0 satisfied the step, and when
          it would hold nothing (a reference-only step says so in its plain
          line; a done step with no Edit in view has nothing to add). */}
      {!statusLoading && !intakeSatisfied && !footerEmpty ? (
      <section aria-label="Actions" className="border-t border-[var(--stroke)] pt-[var(--space-3)]">
        {running && !referenceOnly ? (
          <StepRunner
            step={step}
            projectStep={projectStep}
            dealId={dealId}
            onClose={() => setRunning(false)}
            onEnhance={onEnhance}
            canTeach={canTeach}
            builderChanges={builderChanges}
          />
        ) : missingOnServer ? (
          <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            No actions on a step the record does not hold.
          </p>
        ) : showActions ? (
          <div>
            {!runnable && !showStepWork && step.offPlatform ? (
              <p className="mb-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                Handled off the platform. Confirm here once it is done.
              </p>
            ) : showStepWork && canAct ? (
              <p className="mb-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                Every action is audited.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-[var(--space-2)]">
              {offersDraft ? (
                <button
                  type="button"
                  onClick={() => setRunning(true)}
                  className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-semibold text-[var(--ink-on-dark)] transition-opacity hover:opacity-90"
                >
                  {openDraftLabel(step.id, step.title)}
                </button>
              ) : runnable && needsSkill && skill.status === 'ready' ? (
                <>
                  <span className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{NO_SKILL_YET}</span>
                  {/* Offered unless the runs read said there are none (unknown keeps it). */}
                  {skill.hasRuns !== false ? (
                    <button
                      type="button"
                      onClick={() => setRunning(true)}
                      className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--ink-tertiary)]"
                    >
                      {OPEN_EARLIER_DRAFTS}
                    </button>
                  ) : null}
                </>
              ) : runnable && needsSkill && skill.status === 'unavailable' ? (
                <span className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{SKILL_NOT_READ}</span>
              ) : null}
              {canAct && !showStepWork ? (
                <button
                  type="button"
                  onClick={() => onComplete()}
                  disabled={seatBlocked}
                  aria-describedby={seatBlocked ? `${seatNoteId} ${advanceNoteId}` : advanceNoteId}
                  className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--ink-tertiary)] disabled:opacity-50"
                >
                  {ADVANCE_ONLY_LABEL}
                </button>
              ) : null}
              {canAct ? (
                <button
                  type="button"
                  onClick={onSkip}
                  disabled={seatBlocked || skipBlockedByPanel}
                  aria-describedby={
                    seatBlocked ? seatNoteId : skipBlockedByPanel ? manualReasonId : undefined
                  }
                  className="text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)] underline underline-offset-4 transition-colors hover:text-[var(--ink)] disabled:opacity-50 disabled:no-underline"
                >
                  Skip…
                </button>
              ) : null}
            </div>
            {canAct && seatBlocked ? (
              <p id={seatNoteId} className="mt-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                {SEAT_CANNOT_ACT}
              </p>
            ) : null}
            {canAct && !showStepWork ? (
              // Handoff E28: this path writes the cursor only (pre-existing).
              <p id={advanceNoteId} className="mt-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                {ADVANCE_ONLY_NOTE}
              </p>
            ) : null}
          </div>
        ) : state === 'todo' ? (
          <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            {showStepWork
              ? 'Draft work above now. Complete prior steps on the rail to approve and mark done.'
              : 'Ahead of the cursor. Advance the rail to act on this step.'}
          </p>
        ) : (
          <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            {isRelationshipPathing
              ? 'Complete. The approved paths are on the record above.'
              : 'Complete. Edit appends a new version, nothing is overwritten.'}
          </p>
        )}
      </section>
      ) : null}
    </div>
  );
}

export default StepContract;
