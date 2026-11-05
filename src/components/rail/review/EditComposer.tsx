'use client';

import * as React from 'react';

import { Button } from '@/components/atoms/Button';
import { REVISION_LIMITS } from '@/lib/skillRun/types';

import { REVIEW_COPY } from './reviewCopy';

type Mode = 'comment' | 'hand';

type Props = {
  passage: string;
  existing: { kind: Mode; value: string; problem: string | null; teach: boolean } | null;
  onSave: (kind: Mode, value: string, teach: boolean) => void;
  onCancel: () => void;
  onRemove: (() => void) | null;
};

const MODES: { mode: Mode; label: string }[] = [
  { mode: 'comment', label: REVIEW_COPY.comment },
  { mode: 'hand', label: REVIEW_COPY.editText },
];

const FIELD =
  'mt-1 w-full rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';

export function EditComposer({ passage, existing, onSave, onCancel, onRemove }: Props) {
  const [mode, setMode] = React.useState<Mode>(existing?.kind ?? 'comment');
  const [comment, setComment] = React.useState(existing?.kind === 'comment' ? existing.value : '');
  const [text, setText] = React.useState(existing?.kind === 'hand' ? existing.value : passage);
  const [teach, setTeach] = React.useState(existing?.kind === 'comment' ? existing.teach : false);
  const fieldRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fieldId = React.useId();
  const teachId = React.useId();
  const teachHelpId = React.useId();

  React.useEffect(() => {
    fieldRef.current?.focus();
  }, [mode]);

  const commenting = mode === 'comment';
  const ready = commenting ? comment.trim() !== '' : text !== passage;
  const updating = existing?.kind === mode;
  const saveLabel = commenting
    ? updating
      ? REVIEW_COPY.updateComment
      : REVIEW_COPY.addComment
    : updating
      ? REVIEW_COPY.updateEdit
      : REVIEW_COPY.saveEdit;

  return (
    <div
      role="group"
      aria-label={REVIEW_COPY.composer}
      className="rounded-[var(--radius-card)] border border-[var(--stroke-strong)] bg-[var(--surface)] p-[var(--space-3)] shadow-[var(--shadow-ambient)]"
    >
      <div className="flex gap-[var(--space-2)]">
        {MODES.map((option) => (
          <button
            key={option.mode}
            type="button"
            aria-pressed={mode === option.mode}
            onClick={() => setMode(option.mode)}
            className="rounded-[var(--radius-control)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)] aria-pressed:bg-[var(--surface-subtle)] aria-pressed:text-[var(--ink)]"
          >
            {option.label}
          </button>
        ))}
      </div>

      <label
        htmlFor={fieldId}
        className="mt-[var(--space-3)] block text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
      >
        {commenting ? REVIEW_COPY.commentLabel : REVIEW_COPY.textLabel}
      </label>
      <textarea
        id={fieldId}
        ref={fieldRef}
        rows={commenting ? 3 : 6}
        value={commenting ? comment : text}
        maxLength={commenting ? REVISION_LIMITS.comment : REVISION_LIMITS.text}
        onChange={(event) =>
          commenting ? setComment(event.target.value) : setText(event.target.value)
        }
        className={commenting ? FIELD : `${FIELD} font-mono`}
      />

      {commenting ? (
        <div className="mt-[var(--space-3)] flex items-start gap-[var(--space-2)]">
          <input
            id={teachId}
            type="checkbox"
            checked={teach}
            aria-describedby={teachHelpId}
            onChange={(event) => setTeach(event.target.checked)}
            className="mt-[2px] h-4 w-4 accent-[var(--ai)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          />
          <div>
            <label htmlFor={teachId} className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
              {REVIEW_COPY.teach}
            </label>
            <p id={teachHelpId} className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              {REVIEW_COPY.teachHelp}
            </p>
          </div>
        </div>
      ) : null}

      {existing?.problem ? (
        <p className="mt-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--negative-deep)]">
          {REVIEW_COPY.notApplied}. {existing.problem}
        </p>
      ) : null}

      <div className="mt-[var(--space-3)] flex items-center justify-between gap-[var(--space-3)]">
        <div>
          {onRemove ? (
            <Button variant="ghost" size="sm" onClick={onRemove}>
              {REVIEW_COPY.remove}
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-[var(--space-2)]">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            {REVIEW_COPY.cancel}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!ready}
            onClick={() => onSave(mode, commenting ? comment.trim() : text, commenting && teach)}
          >
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
