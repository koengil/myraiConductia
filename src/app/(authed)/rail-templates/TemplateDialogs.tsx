'use client';

import * as React from 'react';

import { Button } from '@/components/atoms/Button';
import { Dialog, useRetainedWhileClosing } from '@/components/overlay';
import {
  DEFAULT_RAIL_TEMPLATE_NAME,
  RAIL_TEMPLATE_NAME_MAX,
  type RailTemplateSummary,
  type TemplateStepView,
} from '@/lib/rail/railTemplateModel';
import { startingPointLine } from './templateListModel';

/*
 * The three Rails configuration dialogs, on the shared overlay Dialog (focus
 * trap, Escape, focus restored to the opener). Behaviour and server calls are
 * the page's, unchanged: POST /rail-catalog, DELETE /rail-catalog/[id] and
 * PATCH /rail-catalog/[id]/steps/[row].
 */

export const FIELD_CLASS =
  'mt-1 block w-full rounded-[var(--radius-input)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] transition-colors placeholder:text-[var(--ink-quiet)] hover:border-[var(--ink-quiet)] focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:opacity-60';

const LABEL_CLASS = 'block text-[length:var(--text-sm)] font-medium text-[var(--ink)]';

const DANGER_BUTTON =
  'inline-flex h-[34px] items-center justify-center whitespace-nowrap rounded-[var(--radius-control)] bg-[var(--negative-deep)] px-4 font-sans text-(length:--text-base) font-medium text-[var(--ink-on-dark)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:opacity-50';

function ErrorLine({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="mt-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--negative-deep)]">
      {children}
    </p>
  );
}

export function NewTemplateDialog({
  open,
  name,
  sourceId,
  templates,
  error,
  saving,
  onNameChange,
  onSourceChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  name: string;
  sourceId: string;
  templates: readonly RailTemplateSummary[];
  error: string | null;
  saving: boolean;
  onNameChange: (value: string) => void;
  onSourceChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const formId = React.useId();
  const startsId = React.useId();
  const errorId = React.useId();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissOnScrim={false}
      eyebrow="Rails configuration"
      title="New template"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={saving}>
            {saving ? 'Creating' : 'Create template'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-[var(--space-3)]">
        <label className={LABEL_CLASS}>
          Name
          <input
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            className={FIELD_CLASS}
            maxLength={RAIL_TEMPLATE_NAME_MAX}
            aria-describedby={error ? errorId : undefined}
            required
          />
        </label>
        <label className={LABEL_CLASS}>
          Start from
          <select
            value={sourceId}
            onChange={(event) => onSourceChange(event.target.value)}
            className={FIELD_CLASS}
            aria-describedby={startsId}
          >
            <option value="">{DEFAULT_RAIL_TEMPLATE_NAME} (your default rail)</option>
            {templates
              .filter((template) => template.id)
              .map((template) => (
                <option key={template.id} value={template.id ?? ''}>
                  {template.name}
                </option>
              ))}
          </select>
        </label>
        <p
          id={startsId}
          data-testid="template-starting-point"
          className="rounded-[var(--radius-control)] bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
        >
          {startingPointLine(sourceId, templates)}
        </p>
      </form>
      {error ? <ErrorLine id={errorId}>{error}</ErrorLine> : null}
    </Dialog>
  );
}

export function DeleteTemplateDialog({
  template,
  error,
  deleting,
  onClose,
  onConfirm,
}: {
  /** The template to delete; null closes the dialog. */
  template: RailTemplateSummary | null;
  error: string | null;
  deleting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const shown = useRetainedWhileClosing(template);
  const name = shown?.name ?? 'template';
  return (
    <Dialog
      open={template !== null}
      onClose={onClose}
      dismissOnScrim={false}
      size="sm"
      title={`Delete ${name}?`}
      description={`Templates that started from it keep their steps. They still show that they started from ${name}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <button type="button" disabled={deleting} onClick={onConfirm} className={DANGER_BUTTON}>
            {deleting ? 'Deleting' : 'Delete template'}
          </button>
        </>
      }
    >
      {error ? <ErrorLine>{error}</ErrorLine> : null}
    </Dialog>
  );
}

export function StepDetailsDialog({
  step,
  editable,
  saving,
  onClose,
  onSave,
}: {
  /** The step to show; null closes the dialog. */
  step: TemplateStepView | null;
  editable: boolean;
  saving: boolean;
  onClose: () => void;
  /** Resolves to the refusal, shown inside the dialog, or null once saved. */
  onSave: (description: string) => Promise<string | null>;
}) {
  const shown = useRetainedWhileClosing(step);
  return (
    <Dialog
      open={step !== null}
      onClose={onClose}
      dismissOnScrim={!editable}
      eyebrow={shown?.phaseName}
      title={shown?.title ?? 'Step'}
    >
      {shown ? (
        <StepDetailsBody
          key={shown.id ?? shown.stepId}
          step={shown}
          editable={editable}
          saving={saving}
          onClose={onClose}
          onSave={onSave}
        />
      ) : null}
    </Dialog>
  );
}

function StepDetailsBody({
  step,
  editable,
  saving,
  onClose,
  onSave,
}: {
  step: TemplateStepView;
  editable: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (description: string) => Promise<string | null>;
}) {
  const [description, setDescription] = React.useState(step.description);
  const [error, setError] = React.useState<string | null>(null);
  const errorId = React.useId();
  const [savedDescription, setSavedDescription] = React.useState(step.description);
  if (step.description !== savedDescription) {
    setSavedDescription(step.description);
    setDescription(step.description);
  }
  const kind = step.hasSkill ? 'Skill step' : step.origin === 'catalog' ? 'House step' : 'Custom step';

  return (
    <>
      <dl className="space-y-2 text-[length:var(--text-sm)]">
        <div>
          <dt className="text-[var(--ink-secondary)]">Kind</dt>
          <dd className="text-[var(--ink)]">{kind}</dd>
        </div>
        {step.seq != null ? (
          <div>
            <dt className="text-[var(--ink-secondary)]">Sequence</dt>
            <dd className="text-[var(--ink)]">{step.seq}</dd>
          </div>
        ) : null}
        {editable ? null : (
          <div>
            <dt className="text-[var(--ink-secondary)]">Description</dt>
            <dd className="text-[var(--ink)]">{step.description || 'No further description.'}</dd>
          </div>
        )}
      </dl>
      {editable ? (
        <form
          className="mt-[var(--space-3)]"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            void onSave(description.trim()).then(setError, () => setError('Could not save the description.'));
          }}
        >
          <label className={LABEL_CLASS} htmlFor="step-description">
            Description
          </label>
          <textarea
            id="step-description"
            value={description}
            maxLength={4000}
            rows={5}
            placeholder="Add context for this step"
            aria-describedby={
              [step.origin === 'catalog' ? 'step-description-scope' : null, error ? errorId : null]
                .filter(Boolean)
                .join(' ') || undefined
            }
            onChange={(event) => setDescription(event.target.value)}
            className={`${FIELD_CLASS} resize-none`}
          />
          {step.origin === 'catalog' ? (
            <p id="step-description-scope" className="mt-1 text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              This description stays on this template. It is not part of the published version.
            </p>
          ) : null}
          {error ? <ErrorLine id={errorId}>{error} Your edit was not saved.</ErrorLine> : null}
          <div className="mt-[var(--space-4)] flex justify-end gap-[var(--space-2)]">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || description.trim() === step.description}>
              {saving ? 'Saving' : 'Save'}
            </Button>
          </div>
        </form>
      ) : null}
    </>
  );
}

/**
 * One confirmation before a template step is removed: nothing is sent
 * until Remove is pressed here. Steps every deal needs offer no Remove at all.
 */
export function RemoveTemplateStepDialog({
  step,
  onClose,
  onConfirm,
}: {
  /** The step to remove; null closes the dialog. */
  step: { id: string; title: string } | null;
  onClose: () => void;
  onConfirm: (stepRowId: string) => void;
}) {
  const shown = useRetainedWhileClosing(step);
  return (
    <Dialog
      open={step !== null}
      onClose={onClose}
      size="sm"
      title={`Remove ${shown?.title ?? 'this step'} from this template?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <button
            type="button"
            onClick={() => {
              if (shown) onConfirm(shown.id);
            }}
            className={DANGER_BUTTON}
          >
            Remove
          </button>
        </>
      }
    />
  );
}
