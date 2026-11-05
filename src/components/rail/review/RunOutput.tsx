'use client';

import * as React from 'react';
import { AnimatePresence } from 'framer-motion';

import { Markdown } from '@/components/atoms';
import { outputVersions, plural, unsentTaughtCount, versionLabel } from '@/lib/skillRun/revisionView';
import type { SkillRunSummary } from '@/lib/skillRun/types';

import { REVIEW_COPY, reviseButton, statusLine, teachButton } from './reviewCopy';
import { ReviewOutputDialog } from './ReviewOutputDialog';
import { useRunRevisions } from './useRunRevisions';
import { wholeOutputRange } from './wholeOutput';
import { formatDateTime } from '@/lib/format/date';

type Props = {
  runsPath: string;
  run: SkillRunSummary;
  documents: SkillRunSummary['documents'];
  reload: () => Promise<SkillRunSummary[]>;
  pollMs?: number;
  onTeach?: () => void;
};

export function RunOutput({ runsPath, run, documents, reload, pollMs, onTeach }: Props) {
  const review = useRunRevisions({ runsPath, run, reload, pollMs });
  const [open, setOpen] = React.useState(false);
  const [ask, setAsk] = React.useState('');
  const askId = React.useId();

  const versions = outputVersions(run);
  const head = versions[versions.length - 1];
  if (!head || run.headText === null) return null;

  const status = open ? null : statusLine(review.status);
  const waiting = review.pending.length;
  const taught = onTeach ? unsentTaughtCount(run) : 0;
  const applying = review.status.kind === 'applying';

  return (
    <div className="space-y-[var(--space-2)]">
      <div className="flex flex-wrap items-center justify-between gap-[var(--space-2)]">
        <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          {versionLabel(versions, head.id)} · {head.actorName} ·{' '}
          {formatDateTime(head.createdAt)}
          {waiting > 0 ? ` · ${plural(waiting, 'pending edit')}` : ''}
        </p>
        <div className="flex flex-wrap items-center gap-[var(--space-2)]">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--ink-tertiary)]"
          >
            {REVIEW_COPY.open}
          </button>
          {onTeach && taught > 0 ? (
            <button
              type="button"
              onClick={onTeach}
              className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--ink-tertiary)]"
            >
              {teachButton(taught)}
            </button>
          ) : null}
        </div>
      </div>

      {status ? (
        <p
          role={review.status.kind === 'error' ? 'alert' : 'status'}
          className={`text-[length:var(--text-sm)] ${
            review.status.kind === 'error'
              ? 'text-[var(--negative-deep)]'
              : 'text-[var(--ink-secondary)]'
          }`}
        >
          {status}
        </p>
      ) : null}

      <Markdown className="max-h-72 overflow-auto rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)]">
        {run.headText}
      </Markdown>

      {wholeOutputRange(run.headText) === null ? (
        // Nothing to revise: the box would send a comment over no text.
        <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">{REVIEW_COPY.reviseEmpty}</p>
      ) : (
        <form
          className="space-y-[var(--space-1)]"
          onSubmit={(event) => {
            event.preventDefault();
            // The typed change is kept until the next version is recorded, so a
            // refusal or a timeout never throws away what the banker wrote.
            void review.reviseWhole(ask).then((recorded) => {
              if (recorded) setAsk('');
            });
          }}
        >
          <label htmlFor={`${askId}-ask`} className="bank-label block">
            {REVIEW_COPY.reviseLabel}
          </label>
          <textarea
            id={`${askId}-ask`}
            value={ask}
            rows={3}
            disabled={applying}
            aria-describedby={`${askId}-hint`}
            onChange={(event) => setAsk(event.target.value)}
            className="w-full rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60"
          />
          <p id={`${askId}-hint`} className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            {REVIEW_COPY.reviseHint}
          </p>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={applying || ask.trim() === ''}
              className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-sm)] font-semibold text-[var(--ink-on-dark)] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {reviseButton(versions.length + 1)}
            </button>
          </div>
        </form>
      )}

      {documents.length > 0 ? (
        <ul
          aria-label="Documents this run filed"
          className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
        >
          {documents.map((document) => (
            <li key={document.id}>{document.name}</li>
          ))}
        </ul>
      ) : null}

      <AnimatePresence>
      {open ? (
        <ReviewOutputDialog
          key="review-output"
          runsPath={runsPath}
          run={run}
          versions={versions}
          review={review}
          canTeach={onTeach !== undefined}
          onClose={() => setOpen(false)}
        />
      ) : null}
      </AnimatePresence>
    </div>
  );
}
