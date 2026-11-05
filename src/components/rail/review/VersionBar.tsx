'use client';

import * as React from 'react';

import { Button } from '@/components/atoms/Button';
import { versionLabel, type OutputVersion } from '@/lib/skillRun/revisionView';

import { REVIEW_COPY } from './reviewCopy';
import { formatDateTime } from '@/lib/format/date';

type Props = {
  versions: OutputVersion[];
  viewing: OutputVersion;
  busy: boolean;
  onView: (id: string) => void;
  onRestore: () => void;
};

const STEP =
  'rounded-[var(--radius-control)] px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-sm)] text-[var(--ink-secondary)] hover:bg-[var(--surface-subtle)] disabled:opacity-40 disabled:hover:bg-transparent';

export function VersionBar({ versions, viewing, busy, onView, onRestore }: Props) {
  const index = versions.findIndex((version) => version.id === viewing.id);
  const atHead = index === versions.length - 1;

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-[var(--space-3)] border-b border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-2)]">
      <div className="flex flex-wrap items-center gap-[var(--space-2)]">
        <button
          type="button"
          className={STEP}
          aria-label={REVIEW_COPY.earlier}
          disabled={index <= 0}
          onClick={() => onView(versions[index - 1].id)}
        >
          Earlier
        </button>
        <p className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
          {versionLabel(versions, viewing.id)}
        </p>
        <button
          type="button"
          className={STEP}
          aria-label={REVIEW_COPY.later}
          disabled={atHead}
          onClick={() => onView(versions[index + 1].id)}
        >
          Later
        </button>
        <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          {viewing.actorName} · {formatDateTime(viewing.createdAt)}
        </p>
      </div>
      {atHead ? null : (
        <div className="flex flex-wrap items-center gap-[var(--space-3)]">
          <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
            {REVIEW_COPY.readOnly}
          </p>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onRestore}>
            {REVIEW_COPY.restore}
          </Button>
        </div>
      )}
    </div>
  );
}
