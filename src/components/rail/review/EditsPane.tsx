'use client';

import * as React from 'react';

import { Badge, Markdown } from '@/components/atoms';
import type { OutputVersion, PendingEdit } from '@/lib/skillRun/revisionView';
import type { RevisionEditSummary } from '@/lib/skillRun/types';

import { REVIEW_COPY } from './reviewCopy';

type Props = {
  atHead: boolean;
  locked: boolean;
  pending: PendingEdit[];
  onOpen: (edit: PendingEdit) => void;
  onRemove: (key: string) => void;
  viewing: OutputVersion;
  versions: OutputVersion[];
};

const HEADING = 'text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]';
const ITEM = 'border-t border-[var(--stroke)] py-[var(--space-3)] first:border-t-0';
const LINK = 'text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] underline disabled:opacity-50';
const EXCERPT_LENGTH = 80;

function excerpt(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > EXCERPT_LENGTH ? `${line.slice(0, EXCERPT_LENGTH)}...` : line;
}

function PendingItem({
  edit,
  number,
  locked,
  onOpen,
  onRemove,
}: {
  edit: PendingEdit;
  number: number | null;
  locked: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <li className={ITEM}>
      <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        {number === null ? '' : `${String(number)} · `}
        {edit.kind === 'comment' ? REVIEW_COPY.comment : REVIEW_COPY.editedByHand}
        {edit.teach ? (
          <Badge tone="accent" className="ml-[var(--space-2)] whitespace-nowrap">
            {REVIEW_COPY.teachesSkill}
          </Badge>
        ) : null}
      </p>
      <p className="mt-1 font-[family-name:var(--font-display)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {excerpt(edit.passage)}
      </p>
      <p className="mt-1 break-words text-[length:var(--text-sm)] text-[var(--ink)]">
        {edit.detached ? edit.value : excerpt(edit.value)}
      </p>
      {edit.problem ? (
        <p className="mt-[var(--space-2)] flex flex-wrap items-center gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          <Badge tone="hold">{REVIEW_COPY.notApplied}</Badge>
          {edit.problem}
        </p>
      ) : null}
      <div className="mt-[var(--space-2)] flex gap-[var(--space-3)]">
        <button type="button" className={LINK} disabled={locked || edit.detached} onClick={onOpen}>
          {REVIEW_COPY.edit}
        </button>
        <button type="button" className={LINK} disabled={locked} onClick={onRemove}>
          {REVIEW_COPY.remove}
        </button>
      </div>
    </li>
  );
}

function ChangedItem({ edit, actorName }: { edit: RevisionEditSummary; actorName: string }) {
  const [open, setOpen] = React.useState(false);
  const rewritten = edit.kind === 'comment' && edit.status === 'applied';
  const byHand = edit.kind === 'hand';
  const label = rewritten
    ? REVIEW_COPY.rewritten
    : byHand
      ? REVIEW_COPY.editedByHand
      : REVIEW_COPY.comment;
  return (
    <li className={ITEM}>
      <p className="flex items-center gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        {rewritten || byHand ? (
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 rounded-full ${rewritten ? 'bg-[var(--ai)]' : 'bg-[var(--ink)]'}`}
          />
        ) : null}
        {label} · {actorName}
        {edit.teach && edit.status === 'applied' ? (
          <Badge tone="accent" className="shrink-0 whitespace-nowrap">
            {REVIEW_COPY.teachesSkill}
          </Badge>
        ) : null}
      </p>
      {edit.comment ? (
        <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink)]">{edit.comment}</p>
      ) : null}
      {edit.status === 'applied' ? null : (
        <p className="mt-[var(--space-2)] flex flex-wrap items-center gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          <Badge tone="hold">{REVIEW_COPY.notApplied}</Badge>
          {edit.reason}
        </p>
      )}
      {edit.before !== null && edit.status === 'applied' ? (
        <>
          <button
            type="button"
            className={`mt-[var(--space-2)] ${LINK}`}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? REVIEW_COPY.hideBefore : REVIEW_COPY.showBefore}
          </button>
          {open ? (
            <Markdown className="mt-[var(--space-2)] rounded-[var(--radius-input)] border border-[var(--stroke)] bg-[var(--surface-warm)] p-[var(--space-3)]">
              {edit.before}
            </Markdown>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

export function EditsPane({ atHead, locked, pending, onOpen, onRemove, viewing, versions }: Props) {
  const revision = viewing.revision;
  const restoredFrom = versions.find((version) => version.id === revision?.restoredFrom);
  const numbers = new Map(
    pending.filter((edit) => !edit.detached).map((edit, index) => [edit.key, index + 1]),
  );

  return (
    <div className="space-y-[var(--space-5)]">
      {atHead ? (
        <section>
          <h3 className={HEADING}>
            {REVIEW_COPY.pending}
            {pending.length > 0 ? ` · ${String(pending.length)}` : ''}
          </h3>
          {pending.length === 0 ? (
            <p className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
              {REVIEW_COPY.emptyPending}
            </p>
          ) : (
            <ul aria-label={REVIEW_COPY.pending} className="mt-[var(--space-2)]">
              {pending.map((edit) => (
                <PendingItem
                  key={edit.key}
                  edit={edit}
                  number={numbers.get(edit.key) ?? null}
                  locked={locked}
                  onOpen={() => onOpen(edit)}
                  onRemove={() => onRemove(edit.key)}
                />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section>
        <h3 className={HEADING}>{REVIEW_COPY.changed}</h3>
        {revision === null ? (
          <p className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            {REVIEW_COPY.firstOutput}
          </p>
        ) : revision.kind === 'restore' ? (
          <p className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)]">
            Restored from version {String(restoredFrom?.number ?? 1)} by {revision.actorName}.
          </p>
        ) : (
          <>
            {revision.skillMounted === false ? (
              <p className="mt-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                {REVIEW_COPY.skillNotMounted}
              </p>
            ) : null}
            <ul aria-label={REVIEW_COPY.changed} className="mt-[var(--space-2)]">
              {revision.edits.map((edit) => (
                <ChangedItem key={edit.id} edit={edit} actorName={revision.actorName} />
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
