'use client';

import * as React from 'react';
import { ArrowUpDown, GripVertical, Lock, Pencil, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/atoms/Button';
import { PreviewBanner, PreviewChip } from '@/components/overlay';
import { MoveStepDialog, type MoveTarget } from '@/components/rail/MoveStepDialog';
import type { StepCardItem } from '@/components/rail/RailBoard';
import { SortableStack } from '@/components/rail/SortableStack';
import { formatDateTime } from '@/lib/format/date';
import { PROTECTED_STEP_IDS } from '@/lib/rail/protectedSteps';
import type { ProjectRailStep } from '@/lib/rail/projectRail';
import { allowedMoveIndices, applyPreviewOrder, useReorderPreview } from '@/lib/rail/railPreview';
import {
  DEFAULT_RAIL_TEMPLATE_NAME,
  publishedLabel,
  startedFromLabel,
  type CatalogStepChoice,
  type TemplatePublication,
  type TemplateStepView,
} from '@/lib/rail/railTemplateModel';
import type { TemplateChangeView } from '@/lib/rail/templateChanges';
import type { Placement } from '@/lib/skillAuthoring/types';
import { RemoveTemplateStepDialog, StepDetailsDialog } from './TemplateDialogs';
import { publishAudience } from './templateListModel';
import { TemplateSkillBuilder, railFromSteps } from './TemplateSkillBuilder';

export type TemplateDetail = {
  template: {
    id: string | null;
    name: string;
    description: string;
    kind: 'default' | 'saved';
    editable: boolean;
    forkedFromName: string | null;
    forkedFromRemoved?: boolean;
  };
  steps: TemplateStepView[];
  availableCatalogSteps: CatalogStepChoice[];
  phases: { index: number; name: string }[];
  published?: TemplatePublication | null;
  hasUnpublishedChanges?: boolean;
};

export const DEFAULT_LOCKED_COPY = `${DEFAULT_RAIL_TEMPLATE_NAME} is built into Conductia, so its steps and description stay as they are. To change them, start a new template from it.`;

export const FIXED_STEP_COPY = 'Every deal needs this step, so it stays in place.';

export const REORDER_PREVIEW_COPY = 'Only you see this order. Nothing here is saved to the template.';

/**
 * Publish never carries a Preview order, so the line says the moved order is
 * left out (handoff E1).
 */
export const PUBLISH_PREVIEW_ORDER_COPY =
  "The order you moved in this browser is not included. Publishing uses the template's saved order.";

const ICON_BUTTON =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50';

const REMOVE_BUTTON =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-subtle)] hover:text-[var(--negative-deep)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50';

const TEXT_BUTTON =
  'inline-flex h-8 shrink-0 items-center rounded-[var(--radius-control)] px-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';

function isFixed(step: ProjectRailStep): boolean {
  return PROTECTED_STEP_IDS.has(step.stepId);
}

export function TemplateDetailPanel({
  detail,
  error,
  editing,
  changes,
  publishing,
  publishError,
  changeReviewOn,
  headingRef,
  onPublish,
  onAdded,
  onRemove,
  onSaveDescription,
  onSaveTemplateDescription,
  onUndo,
  onStartFromDefault,
}: {
  detail: TemplateDetail | null;
  error: string | null;
  editing: boolean;
  changes: TemplateChangeView[];
  publishing: boolean;
  publishError: string | null;
  /** Template change review is on: a publish offers open deals the change. */
  changeReviewOn: boolean;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onPublish: () => void;
  onAdded: () => void;
  onRemove: (stepRowId: string) => void;
  /** A step's description through the existing PATCH; resolves to the refusal, or null once saved. */
  onSaveDescription: (stepRowId: string, description: string) => Promise<string | null>;
  /** Saves through the existing PATCH; resolves to the refusal, or null once saved. */
  onSaveTemplateDescription: (description: string) => Promise<string | null>;
  onUndo: (changeId: string) => void;
  onStartFromDefault: () => void;
}) {
  const [detailsKey, setDetailsKey] = React.useState<string | null>(null);
  const [composer, setComposer] = React.useState<Placement | null>(null);
  // The builder stays mounted after closing so its exit motion plays.
  const [composerOpen, setComposerOpen] = React.useState(false);
  const openComposer = (placement: Placement) => {
    setComposer(placement);
    setComposerOpen(true);
  };
  const [moveTarget, setMoveTarget] = React.useState<MoveTarget | null>(null);
  const [removeTarget, setRemoveTarget] = React.useState<{ id: string; title: string } | null>(null);

  // Template step order is a Preview (handoff E1 "Save a step reorder", the
  // move-step persistence entry: a `move_step` catalog action;
  // docs/03-engineering/walkthrough-handoff-2026-10-22.md). It lives in memory
  // for this template only: never sent, not published, gone on reload or Reset.
  const reorder = useReorderPreview(`template:${detail?.template.id ?? 'default'}`);

  const editable = Boolean(detail?.template.editable && detail.template.id);
  const rail = React.useMemo(
    () => (detail ? railFromSteps(detail.phases, detail.steps) : null),
    [detail],
  );
  const viewById = React.useMemo(
    () => new Map((detail?.steps ?? []).flatMap((step) => (step.id ? [[step.id, step] as const] : []))),
    [detail],
  );
  const details = detail?.steps.find((step) => (step.id ?? step.stepId) === detailsKey) ?? null;

  if (detail === null) {
    return (
      <section
        aria-label="Template steps"
        className="rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-5)]"
      >
        {error ? (
          <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
            {error}
          </p>
        ) : (
          <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">Loading steps</p>
        )}
      </section>
    );
  }

  const phases = new Map<number, { name: string; steps: TemplateStepView[] }>();
  for (const step of detail.steps) {
    const entry = phases.get(step.phaseIndex) ?? { name: step.phaseName, steps: [] };
    entry.steps.push(step);
    phases.set(step.phaseIndex, entry);
  }

  const allowedFor = (phaseSteps: readonly ProjectRailStep[], step: ProjectRailStep) =>
    allowedMoveIndices(phaseSteps, step, isFixed);
  const canMove = (phaseSteps: readonly ProjectRailStep[], step: ProjectRailStep) =>
    !isFixed(step) && allowedFor(phaseSteps, step).size > 1;
  const moveStep = (
    phaseIndex: number,
    shown: readonly ProjectRailStep[],
    step: ProjectRailStep,
    toIndex: number,
  ) => {
    if (!allowedFor(shown, step).has(toIndex)) return;
    const savedIds = (rail?.steps ?? []).filter((s) => s.phaseIndex === phaseIndex).map((s) => s.id);
    reorder.move(phaseIndex, shown.map((s) => s.id), step.id, toIndex, savedIds);
  };

  function stepRow(
    view: TemplateStepView,
    opts: {
      item?: StepCardItem;
      shown?: readonly ProjectRailStep[];
      railStep?: ProjectRailStep;
      phaseName: string;
      savedNext?: TemplateStepView;
    },
  ) {
    const { item, shown, railStep, phaseName, savedNext } = opts;
    const movable = Boolean(editable && railStep && shown && canMove(shown, railStep));
    const moved = railStep ? reorder.moved.has(railStep.id) : false;
    return (
      <li
        key={view.id ?? view.stepId}
        ref={item?.ref}
        style={item?.style}
        data-step-row={view.id ?? view.stepId}
        className="group/row relative"
      >
        <div className="flex min-h-11 items-center gap-[var(--space-2)] rounded-[var(--radius-control)] pl-[var(--space-1)] pr-[var(--space-1)] transition-colors hover:bg-[var(--surface-raised)]">
          {editable ? (
            <StepGrip movable={movable} fixed={PROTECTED_STEP_IDS.has(view.stepId)} handle={item?.handle} />
          ) : null}
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 py-[var(--space-2)]">
            <span className="min-w-0 text-[length:var(--text-sm)] text-[var(--ink)]">{view.title}</span>
            {view.hasSkill ? (
              <span className="text-[length:var(--text-xs)] font-medium uppercase tracking-wide text-[var(--ink-tertiary)]">
                Skill
              </span>
            ) : null}
            {moved ? (
              // Preview: handoff E1 "Save a step reorder (deal rail and rail templates)".
              <span className="inline-flex items-center gap-[var(--space-2)] text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">
                <PreviewChip />
                <span>Moved in this browser</span>
              </span>
            ) : null}
          </span>
          <button type="button" onClick={() => setDetailsKey(view.id ?? view.stepId)} className={TEXT_BUTTON}>
            Details
          </button>
          {movable && railStep && shown ? (
            <button
              type="button"
              aria-label={`Move ${view.title}`}
              title="Move to…"
              onClick={() =>
                setMoveTarget({
                  step: railStep,
                  phaseName,
                  phaseSteps: shown,
                  numberOf: (s) => String(s.displayOrder).padStart(2, '0'),
                  allowed: allowedFor(shown, railStep),
                  description: `Choose where it sits in ${phaseName}. Steps move within their phase, after any step every deal needs.`,
                  previewNote: REORDER_PREVIEW_COPY,
                })
              }
              className={ICON_BUTTON}
            >
              <ArrowUpDown aria-hidden="true" className="size-4" />
            </button>
          ) : null}
          {/* A step every deal needs stays in place (the lock line says so):
              no Remove (handoff E30, the server does not refuse it). */}
          {editable && view.id && !PROTECTED_STEP_IDS.has(view.stepId) ? (
            <button
              type="button"
              disabled={editing}
              aria-label={`Remove ${view.title}`}
              title="Remove step"
              onClick={() => setRemoveTarget({ id: view.id as string, title: view.title })}
              className={REMOVE_BUTTON}
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </button>
          ) : null}
        </div>
        {editable && view.id ? (
          <InsertGap
            disabled={editing}
            onOpen={() =>
              openComposer(
                savedNext
                  ? { kind: 'after', phaseIndex: view.phaseIndex, afterStepId: view.id as string }
                  : { kind: 'phase_end', phaseIndex: view.phaseIndex },
              )
            }
          />
        ) : null}
      </li>
    );
  }

  return (
    <section
      aria-label={`${detail.template.name} steps`}
      className="min-w-0 rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)] md:p-[var(--space-5)]"
    >
      {error ? (
        <p role="alert" className="mb-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {error}
        </p>
      ) : null}
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="text-[length:var(--text-lg)] font-semibold text-[var(--ink)] focus-visible:outline-none"
      >
        {detail.template.name}
      </h2>
      {detail.template.kind === 'saved' ? (
        <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          {startedFromLabel(detail.template.forkedFromName ?? 'another template', Boolean(detail.template.forkedFromRemoved))}
          {editable ? ' Hover the line between steps to add one.' : ''}
        </p>
      ) : null}
      {detail.template.id ? (
        <TemplateDescription
          key={detail.template.id}
          description={detail.template.description ?? ''}
          editable={editable}
          onSave={onSaveTemplateDescription}
        />
      ) : null}
      {detail.template.kind === 'default' ? (
        <div className="mt-[var(--space-3)] flex flex-wrap items-center gap-[var(--space-3)] rounded-[var(--radius-control)] bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)]">
          <p className="flex min-w-0 flex-1 items-start gap-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            <Lock aria-hidden="true" className="mt-[3px] size-3.5 shrink-0" />
            <span>{DEFAULT_LOCKED_COPY}</span>
          </p>
          <Button size="sm" variant="secondary" onClick={onStartFromDefault}>
            New template from {DEFAULT_RAIL_TEMPLATE_NAME}
          </Button>
        </div>
      ) : null}
      {editable ? (
        <PublishBar
          name={detail.template.name}
          published={detail.published ?? null}
          hasUnpublishedChanges={detail.hasUnpublishedChanges ?? false}
          publishing={publishing}
          error={publishError}
          changeReviewOn={changeReviewOn}
          previewOrderPending={reorder.active}
          onPublish={onPublish}
        />
      ) : null}
      {reorder.active ? (
        // Preview: handoff E1 "Save a step reorder (deal rail and rail templates)". The template order stays in this browser.
        <PreviewBanner message={REORDER_PREVIEW_COPY} onReset={reorder.reset} className="mt-[var(--space-4)]" />
      ) : null}
      <div className="mt-[var(--space-4)] space-y-[var(--space-5)]">
        {[...phases.entries()].map(([phaseIndex, phase]) => {
          const headingId = `template-phase-${phaseIndex}`;
          const savedRail = (rail?.steps ?? []).filter((s) => s.phaseIndex === phaseIndex);
          const shown = applyPreviewOrder(savedRail, reorder.order[phaseIndex]);
          const savedNextOf = (view: TemplateStepView) => {
            const at = phase.steps.indexOf(view);
            return at >= 0 ? phase.steps[at + 1] : undefined;
          };
          return (
            <div key={phaseIndex}>
              <h3
                id={headingId}
                className="flex items-baseline gap-[var(--space-2)] border-b border-[var(--stroke)] pb-[var(--space-1)] text-[length:var(--text-sm)] font-medium text-[var(--ink)]"
              >
                <span>{phase.name}</span>
                <span className="text-[length:var(--text-xs)] font-normal text-[var(--ink-tertiary)]">
                  {phase.steps.length === 1 ? '1 step' : `${phase.steps.length} steps`}
                </span>
              </h3>
              <ul aria-labelledby={headingId} className={editable ? 'relative mt-1 pl-6' : 'mt-1'}>
                {editable && phase.steps[0] ? (
                  <li className="relative h-0">
                    <InsertGap
                      disabled={editing}
                      onOpen={() => openComposer({ kind: 'phase_start', phaseIndex })}
                    />
                  </li>
                ) : null}
                {editable && shown.length > 0 ? (
                  <SortableStack
                    steps={shown}
                    canDrag={(step) => canMove(shown, step)}
                    canMoveTo={(step, toIndex) => allowedFor(shown, step).has(toIndex)}
                    onMove={(step, toIndex) => moveStep(phaseIndex, shown, step, toIndex)}
                    renderCard={(railStep, item) => {
                      const view = viewById.get(railStep.id);
                      if (!view) return null;
                      return stepRow(view, {
                        item,
                        shown,
                        railStep,
                        phaseName: phase.name,
                        savedNext: savedNextOf(view),
                      });
                    }}
                  />
                ) : (
                  phase.steps.map((view) => stepRow(view, { phaseName: phase.name }))
                )}
              </ul>
            </div>
          );
        })}
      </div>
      {editable ? <TemplateHistory changes={changes} onUndo={onUndo} /> : null}
      {composer && editable && detail.template.id ? (
        <TemplateSkillBuilder
          open={composerOpen}
          templateId={detail.template.id}
          phases={detail.phases}
          steps={detail.steps}
          placement={composer}
          onClose={() => setComposerOpen(false)}
          onAdded={onAdded}
        />
      ) : null}
      <StepDetailsDialog
        step={details}
        editable={Boolean(details && editable && details.id)}
        saving={editing}
        onClose={() => setDetailsKey(null)}
        onSave={async (description) => {
          if (!details?.id) return 'Could not save the description.';
          return onSaveDescription(details.id, description);
        }}
      />
      <RemoveTemplateStepDialog
        step={removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={(stepRowId) => {
          setRemoveTarget(null);
          // The removed step leaves the reorder Preview too.
          const removed = rail?.steps.find((s) => s.id === stepRowId);
          if (removed) {
            reorder.drop(
              removed.phaseIndex,
              removed.id,
              (rail?.steps ?? []).filter((s) => s.phaseIndex === removed.phaseIndex).map((s) => s.id),
            );
          }
          onRemove(stepRowId);
        }}
      />
      <MoveStepDialog
        target={moveTarget}
        onClose={() => setMoveTarget(null)}
        onMove={(step, toIndex) => {
          if (moveTarget) moveStep(step.phaseIndex, moveTarget.phaseSteps, step, toIndex);
          setMoveTarget(null);
        }}
      />
    </section>
  );
}

/**
 * The template description, click to type: the text itself is the control.
 * Saves through the existing PATCH. A refused save puts the saved text back,
 * says it was not saved, and offers the typed text again.
 */
function TemplateDescription({
  description,
  editable,
  onSave,
}: {
  description: string;
  editable: boolean;
  onSave: (description: string) => Promise<string | null>;
}) {
  const [mode, setMode] = React.useState<'view' | 'edit' | 'saving'>('view');
  const [draft, setDraft] = React.useState(description);
  const [failure, setFailure] = React.useState<{ error: string; draft: string } | null>(null);
  const [saved, setSaved] = React.useState(false);
  // The text just saved, shown until the reloaded template carries it, so a
  // saved edit never reads as the old text if the reload is slow or fails.
  const [savedText, setSavedText] = React.useState<string | null>(null);
  if (savedText !== null && savedText === description) setSavedText(null);
  const shownText = savedText ?? description;
  const textareaId = React.useId();
  const viewRef = React.useRef<HTMLButtonElement>(null);

  if (!editable) {
    return description ? (
      <p
        data-template-description
        className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)] [overflow-wrap:anywhere]"
      >
        {description}
      </p>
    ) : null;
  }

  const startEditing = (text: string) => {
    setFailure(null);
    setSaved(false);
    setSavedText(null);
    setDraft(text);
    setMode('edit');
  };
  const cancel = () => {
    setMode('view');
    requestAnimationFrame(() => viewRef.current?.focus());
  };
  const save = async () => {
    if (mode === 'saving') return;
    const next = draft.trim();
    if (next === shownText) {
      cancel();
      return;
    }
    setMode('saving');
    let refusal: string | null;
    try {
      refusal = await onSave(next);
    } catch {
      refusal = 'Could not save the description.';
    } finally {
      setMode('view');
    }
    if (refusal) {
      setFailure({ error: refusal, draft });
    } else {
      setSavedText(next);
      setSaved(true);
    }
    requestAnimationFrame(() => viewRef.current?.focus());
  };

  if (mode !== 'view') {
    return (
      <form
        className="mt-[var(--space-2)]"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="sr-only" htmlFor={textareaId}>
          Template description
        </label>
        <textarea
          id={textareaId}
          autoFocus
          value={draft}
          rows={2}
          maxLength={500}
          readOnly={mode === 'saving'}
          placeholder="What this template is for"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            } else if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void save();
            }
          }}
          className="block w-full resize-none rounded-[var(--radius-input)] border border-[var(--accent)] bg-[var(--surface)] px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1"
        />
        <div className="mt-[var(--space-2)] flex items-center gap-[var(--space-2)]">
          <Button type="submit" size="sm" disabled={mode === 'saving'}>
            {mode === 'saving' ? 'Saving' : 'Save description'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={cancel} disabled={mode === 'saving'}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="mt-[var(--space-2)]">
      <button
        ref={viewRef}
        type="button"
        onClick={() => startEditing(shownText)}
        className="group/desc -mx-[var(--space-2)] flex w-[calc(100%+var(--space-4))] items-start gap-[var(--space-2)] rounded-[var(--radius-control)] px-[var(--space-2)] py-[var(--space-1)] text-left transition-colors hover:bg-[var(--surface-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <span className="sr-only">Edit description. </span>
        <span
          data-template-description
          className={
            shownText
              ? 'min-w-0 flex-1 text-[length:var(--text-sm)] text-[var(--ink-secondary)] [overflow-wrap:anywhere]'
              : 'min-w-0 flex-1 text-[length:var(--text-sm)] text-[var(--ink-tertiary)] [overflow-wrap:anywhere]'
          }
        >
          {shownText || 'Add a description'}
        </span>
        <Pencil
          aria-hidden="true"
          className="mt-[3px] size-3.5 shrink-0 text-[var(--ink-tertiary)] transition-colors group-hover/desc:text-[var(--ink)]"
        />
      </button>
      {failure ? (
        <div role="alert" className="mt-[var(--space-1)] flex flex-wrap items-center gap-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          <span>{failure.error} Your edit was not saved.</span>
          <Button size="sm" variant="ghost" onClick={() => startEditing(failure.draft)}>
            Edit again
          </Button>
        </div>
      ) : null}
      <p role="status" className="sr-only">
        {saved ? 'Description saved.' : ''}
      </p>
    </div>
  );
}

function PublishBar({
  name,
  published,
  hasUnpublishedChanges,
  publishing,
  error,
  changeReviewOn,
  previewOrderPending,
  onPublish,
}: {
  name: string;
  published: TemplatePublication | null;
  hasUnpublishedChanges: boolean;
  publishing: boolean;
  error: string | null;
  changeReviewOn: boolean;
  /** A reorder Preview is active: say plainly that Publish leaves it out. */
  previewOrderPending: boolean;
  onPublish: () => void;
}) {
  const audienceId = React.useId();
  return (
    <div className="mt-[var(--space-4)] rounded-[var(--radius-control)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-3)]">
      <div className="flex flex-wrap items-center justify-between gap-[var(--space-3)]">
        <div>
          <p className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">{publishedLabel(published)}</p>
          {published && hasUnpublishedChanges ? (
            <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">Changes not published</p>
          ) : null}
        </div>
        <Button
          size="sm"
          disabled={publishing || !hasUnpublishedChanges}
          onClick={onPublish}
          aria-describedby={audienceId}
        >
          {publishing ? 'Publishing' : 'Publish changes'}
        </Button>
      </div>
      <p
        id={audienceId}
        data-testid="publish-audience"
        className="mt-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
      >
        {publishAudience(name, published, changeReviewOn)}
      </p>
      {previewOrderPending ? (
        <p data-testid="publish-preview-order" className="mt-[var(--space-1)] text-[length:var(--text-xs)] text-[var(--ink)]">
          {PUBLISH_PREVIEW_ORDER_COPY}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function TemplateHistory({
  changes,
  onUndo,
}: {
  changes: TemplateChangeView[];
  onUndo: (changeId: string) => void;
}) {
  return (
    <div className="mt-[var(--space-5)] border-t border-[var(--stroke)] pt-[var(--space-4)]">
      <h3 className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">History</h3>
      {changes.length === 0 ? (
        <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          Changes to this template show up here.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-[var(--stroke)]">
          {changes.map((change) => (
            <li key={change.id} className="flex items-center justify-between gap-3 py-2">
              <div>
                <p className="text-[length:var(--text-sm)] text-[var(--ink)]">
                  {change.actorName} · {change.summary}
                </p>
                <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                  {formatDateTime(change.createdAt)}
                  {change.undoesId ? ' · Reverses an earlier change' : ''}
                </p>
              </div>
              {change.canUndo ? (
                <button type="button" onClick={() => onUndo(change.id)} className={TEXT_BUTTON}>
                  Undo
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The grip beside an editable row: a drag handle, a lock on a step every deal needs, or a spacer. */
function StepGrip({
  movable,
  fixed,
  handle,
}: {
  movable: boolean;
  fixed: boolean;
  handle?: StepCardItem['handle'];
}) {
  if (movable) {
    return (
      <span
        ref={handle?.setActivatorNodeRef}
        {...(handle?.listeners ?? {})}
        aria-hidden="true"
        title="Drag to preview a new order"
        data-drag-handle
        className="inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center text-[var(--ink-tertiary)] hover:text-[var(--ink)] active:cursor-grabbing"
      >
        <GripVertical className="size-4" />
      </span>
    );
  }
  if (fixed) {
    return (
      <span title={FIXED_STEP_COPY} className="inline-flex size-6 shrink-0 items-center justify-center text-[var(--ink-quiet)]">
        <Lock aria-hidden="true" className="size-3.5" />
        <span className="sr-only">{FIXED_STEP_COPY}</span>
      </span>
    );
  }
  return <span aria-hidden="true" className="size-6 shrink-0" />;
}

/** The plus on the line under a step (or above a phase's first): opens the skill builder there. */
function InsertGap({ disabled, onOpen }: { disabled: boolean; onOpen: () => void }) {
  return (
    <div className="group/gap absolute -bottom-3 -left-6 z-10 flex h-6 w-6 items-center justify-center">
      <button
        type="button"
        aria-label="Add a step here"
        title="Add a step here"
        disabled={disabled}
        onClick={onOpen}
        className="flex size-6 items-center justify-center text-[var(--ink)] opacity-0 transition-opacity group-hover/gap:opacity-100 group-hover/row:opacity-100 focus-visible:opacity-100 disabled:pointer-events-none [@media(hover:none)]:opacity-60"
      >
        <span className="flex size-5 items-center justify-center rounded-full border border-[var(--stroke-strong)] bg-[var(--surface)] shadow-[var(--elev-2)] group-hover/gap:border-[var(--accent)]">
          <Plus className="size-3" aria-hidden="true" />
        </span>
      </button>
    </div>
  );
}
