'use client';

import * as React from 'react';

import { readRailTemplate } from '@/lib/railTemplates/client';
import { useRailTemplates } from '@/lib/railTemplates/useRailTemplates';
import type {
  TemplatePreview,
  TemplateSelection,
} from '@/lib/railTemplates/types';
import { TRY_AGAIN_COPY } from '@/components/deals/DealsUnavailable';

const STANDARD = 'standard';

const STANDARD_TEXT = 'The default rail opens every step of the process.';
const LIST_LOADING_TEXT = "Reading your company's saved rails.";
const EMPTY_LIST_TEXT =
  "No published company rails yet. Publish one in Rails configuration.";
const PREVIEW_LOADING_TEXT = 'Reading this saved rail.';
const PREVIEW_ERROR_TEXT = 'This saved rail could not be previewed.';

const SELECT_CLASS =
  'w-full rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-base)] text-[var(--ink)] outline-none focus:ring-2 focus:ring-[var(--ink)]';

type PreviewState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  preview: TemplatePreview | null;
};

function orderedSteps(preview: TemplatePreview): TemplatePreview['steps'] {
  return [...preview.steps].sort(
    (a, b) =>
      a.phaseIndex - b.phaseIndex || a.displayOrder - b.displayOrder,
  );
}

function spanText(preview: TemplatePreview): string {
  const phases = new Set(preview.steps.map((step) => step.phaseIndex)).size;
  const steps = preview.steps.length;
  return `${steps} ${steps === 1 ? 'step' : 'steps'} across ${phases} ${
    phases === 1 ? 'phase' : 'phases'
  }.`;
}

export function RailTemplatePicker({
  value,
  onChange,
}: {
  value: TemplateSelection | null;
  onChange: (selection: TemplateSelection | null) => void;
}) {
  const { templates, loading, error, reload } = useRailTemplates();
  const selectedId = value === null ? null : value.templateId;
  const selectedRevision = value === null ? null : value.revisionId;
  const [preview, setPreview] = React.useState<PreviewState>(() => ({
    status: value === null ? 'idle' : 'loading',
    preview: null,
  }));
  const [previewNonce, setPreviewNonce] = React.useState(0);
  const onChangeRef = React.useRef(onChange);

  React.useEffect(() => {
    onChangeRef.current = onChange;
  });

  const retryPreview = React.useCallback(() => {
    setPreview({ status: 'loading', preview: null });
    setPreviewNonce((nonce) => nonce + 1);
  }, []);

  React.useEffect(() => {
    if (selectedId === null) return;
    let active = true;
    void (async () => {
      try {
        const loaded = await readRailTemplate(selectedId);
        if (!active) return;
        setPreview({ status: 'ready', preview: loaded });
        if (loaded.revisionId !== selectedRevision) {
          onChangeRef.current({
            templateId: selectedId,
            revisionId: loaded.revisionId,
          });
        }
      } catch {
        if (active) setPreview({ status: 'error', preview: null });
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedId, selectedRevision, previewNonce]);

  function choose(next: string) {
    if (next === STANDARD) {
      setPreview({ status: 'idle', preview: null });
      onChange(null);
      return;
    }
    const summary = templates.find((template) => template.id === next);
    if (summary === undefined) return;
    setPreview({ status: 'loading', preview: null });
    onChange({ templateId: summary.id, revisionId: summary.revisionId });
  }

  return (
    <div className="flex max-w-[360px] flex-col gap-1">
      <label
        htmlFor="gate0-rail-choice"
        className="text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)]"
      >
        Rail
      </label>
      <select
        id="gate0-rail-choice"
        value={selectedId ?? STANDARD}
        aria-busy={loading || preview.status === 'loading'}
        onChange={(event) => choose(event.target.value)}
        className={SELECT_CLASS}
      >
        <option value={STANDARD}>Default rail</option>
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
          </option>
        ))}
      </select>

      {loading ? (
        <p
          role="status"
          aria-live="polite"
          className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]"
        >
          {LIST_LOADING_TEXT}
        </p>
      ) : null}

      {error !== null ? (
        <div className="flex flex-col items-start gap-1">
          <p
            role="alert"
            className="text-[length:var(--text-xs)] text-[var(--negative)]"
          >
            {error}
          </p>
          <button
            type="button"
            onClick={reload}
            className="text-[length:var(--text-xs)] font-medium text-[var(--accent-dark)] underline underline-offset-4 hover:opacity-80"
          >
            {TRY_AGAIN_COPY}
          </button>
        </div>
      ) : null}

      {!loading && error === null && templates.length === 0 ? (
        <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          {EMPTY_LIST_TEXT}
        </p>
      ) : null}

      {selectedId === null ? (
        <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          {STANDARD_TEXT}
        </p>
      ) : (
        <SavedRailPreview state={preview} onRetry={retryPreview} />
      )}
    </div>
  );
}

function SavedRailPreview({
  state,
  onRetry,
}: {
  state: PreviewState;
  onRetry: () => void;
}) {
  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <p
        role="status"
        aria-live="polite"
        className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]"
      >
        {PREVIEW_LOADING_TEXT}
      </p>
    );
  }

  if (state.status === 'error' || state.preview === null) {
    return (
      <div className="flex flex-col items-start gap-1">
        <p
          role="alert"
          className="text-[length:var(--text-xs)] text-[var(--negative)]"
        >
          {PREVIEW_ERROR_TEXT}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="text-[length:var(--text-xs)] font-medium text-[var(--accent-dark)] underline underline-offset-4 hover:opacity-80"
        >
          {TRY_AGAIN_COPY}
        </button>
      </div>
    );
  }

  const preview = state.preview;
  return (
    <div className="mt-1 flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-3)]">
      <p className="text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
        {preview.name}
      </p>
      {preview.description ? (
        <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          {preview.description}
        </p>
      ) : null}
      <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
        {spanText(preview)}
      </p>
      <ol
        role="list"
        aria-label="Saved rail steps"
        className="flex max-h-[180px] list-none flex-col gap-1 overflow-y-auto"
      >
        {orderedSteps(preview).map((step, index) => (
          <li
            key={`${step.phaseIndex}-${step.displayOrder}-${index}`}
            className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
          >
            {step.title}
          </li>
        ))}
      </ol>
    </div>
  );
}

export default RailTemplatePicker;
