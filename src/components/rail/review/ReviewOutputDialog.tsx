'use client';

import * as React from 'react';
import { motion, useIsPresent, useReducedMotion } from 'framer-motion';

import { Button } from '@/components/atoms/Button';
import { blockRanges, blocksWithin, type Range } from '@/lib/skillRun/blocks';
import { fetchVersionText } from '@/lib/skillRun/revisionClient';
import { plural, type OutputVersion, type PendingEdit } from '@/lib/skillRun/revisionView';
import type { SkillRunSummary } from '@/lib/skillRun/types';
import { overlayTransition, travel } from '@/components/overlay';
import { useModalDialog } from '@/lib/ui/useModalDialog';

import { EditComposer } from './EditComposer';
import { EditsPane } from './EditsPane';
import { REVIEW_COPY, statusLine, teachNote } from './reviewCopy';
import { ReviewDocument } from './ReviewDocument';
import type { RunRevisions } from './useRunRevisions';
import { VersionBar } from './VersionBar';

type Props = {
  runsPath: string;
  run: SkillRunSummary;
  versions: OutputVersion[];
  review: RunRevisions;
  canTeach: boolean;
  onClose: () => void;
};

function passageMarks(
  text: string | null,
  viewing: OutputVersion,
  pending: PendingEdit[],
  applyingKeys: string[] | null,
) {
  const marks = new Map<number, string>();
  const labels = new Map<number, string>();
  if (text === null) return { marks, labels };
  const blocks = blockRanges(text);

  for (const edit of viewing.revision?.edits ?? []) {
    if (edit.status !== 'applied' || edit.resultStart === null || edit.resultEnd === null) continue;
    for (const block of blocksWithin(blocks, { start: edit.resultStart, end: edit.resultEnd })) {
      marks.set(block.start, edit.kind);
    }
  }

  pending
    .filter((edit) => !edit.detached)
    .forEach((edit, index) => {
      const covered = blocksWithin(blocks, edit);
      for (const block of covered) {
        marks.set(
          block.start,
          edit.kind === 'comment' && applyingKeys?.includes(edit.key) ? 'applying' : 'pending',
        );
      }
      if (covered[0]) labels.set(covered[0].start, String(index + 1));
    });
  return { marks, labels };
}

/**
 * The review workspace for a skill run's output: the document beside the
 * edits pane, a version bar, and Apply. It stays outside the shared Dialog
 * (on the shared `--scrim` token): it is wider and taller than the largest
 * Dialog size, and Escape first closes the passage composer, then the review.
 */
export function ReviewOutputDialog({ runsPath, run, versions, review, canTeach, onClose }: Props) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const [pinnedId, setPinnedId] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<{ headId: string; range: Range } | null>(null);
  const [fetched, setFetched] = React.useState<Record<string, string | null>>({});
  const refocus = React.useRef<number | 'panel' | null>(null);
  const pressedBackdrop = React.useRef(false);

  const selection = picked && picked.headId === run.headId ? picked.range : null;
  const head = versions[versions.length - 1];
  const viewing = versions.find((version) => version.id === pinnedId) ?? head;
  const atHead = viewing.id === head.id;
  const applying = review.status.kind === 'applying' ? review.status.keys : null;
  const locked = applying !== null;
  const needsFetch = !atHead && viewing.id !== run.id;
  const text = atHead
    ? run.headText
    : viewing.id === run.id
      ? run.resultText
      : (fetched[viewing.id] ?? null);

  const isPresent = useIsPresent();
  const reduce = useReducedMotion() ?? false;
  const panelMotion = travel(reduce);
  useModalDialog(panelRef, () => (selection ? closeComposer() : onClose()), {
    active: isPresent,
    initialFocus: panelRef,
  });

  React.useEffect(() => {
    const target = refocus.current;
    if (target === null) return;
    refocus.current = null;
    const panel = panelRef.current;
    if (!panel) return;
    const block =
      target === 'panel' || panel.querySelector('[data-readonly]')
        ? null
        : panel.querySelector<HTMLElement>(`[data-block-start="${String(target)}"]`);
    (block ?? panel).focus();
  });

  React.useEffect(() => {
    if (!needsFetch || viewing.id in fetched) return;
    let live = true;
    void fetchVersionText(runsPath, run.id, viewing.id).then((value) => {
      if (live) setFetched((prior) => ({ ...prior, [viewing.id]: value }));
    });
    return () => {
      live = false;
    };
  }, [needsFetch, viewing.id, fetched, runsPath, run.id]);

  const { marks, labels } = passageMarks(text, viewing, atHead ? review.pending : [], applying);

  const editing =
    selection === null
      ? null
      : (review.pending.find(
          (edit) => !edit.detached && edit.start === selection.start && edit.end === selection.end,
        ) ?? null);
  const sendable = review.pending.filter((edit) => !edit.detached).length;
  const teaching = review.pending.filter((edit) => !edit.detached && edit.kind === 'comment' && edit.teach).length;
  const status = statusLine(review.status);

  function closeComposer() {
    if (selection) refocus.current = selection.start;
    setPicked(null);
  }

  function select(range: Range | null) {
    setPicked(range ? { headId: run.headId, range } : null);
  }

  function handleSelect(range: Range) {
    const hit = review.pending.find(
      (edit) => !edit.detached && edit.start < range.end && edit.end > range.start,
    );
    select(hit ? { start: hit.start, end: hit.end } : range);
  }

  function handleView(id: string) {
    select(null);
    setPinnedId(id === head.id ? null : id);
  }

  function handleRestore() {
    const id = viewing.id;
    refocus.current = 'panel';
    setPinnedId(null);
    void review.restore(id);
  }

  return (
    <motion.div
      role="presentation"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={overlayTransition}
      style={{ pointerEvents: isPresent ? undefined : 'none' }}
      onMouseDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const closing = pressedBackdrop.current && event.target === event.currentTarget;
        pressedBackdrop.current = false;
        if (closing) onClose();
      }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--scrim)] p-[var(--space-4)]"
    >
      <motion.div
        ref={panelRef}
        tabIndex={-1}
        initial={panelMotion.initial}
        animate={panelMotion.animate}
        exit={panelMotion.exit}
        transition={overlayTransition}
        role="dialog"
        aria-modal="true"
        aria-label={REVIEW_COPY.title}
        onClick={(event) => event.stopPropagation()}
        className="flex h-[min(860px,92vh)] w-full max-w-[1180px] flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] shadow-[var(--shadow-ambient)]"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-3)]">
          <h2 className="text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
            {REVIEW_COPY.title}
          </h2>
          {status ? (
            <p
              role={review.status.kind === 'error' ? 'alert' : 'status'}
              className={`max-w-[60ch] text-[length:var(--text-sm)] ${
                review.status.kind === 'error'
                  ? 'text-[var(--negative-deep)]'
                  : 'text-[var(--ink-secondary)]'
              }`}
            >
              {status}
            </p>
          ) : null}
        </div>

        <VersionBar
          versions={versions}
          viewing={viewing}
          busy={locked}
          onView={handleView}
          onRestore={handleRestore}
        />

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto min-[860px]:grid min-[860px]:grid-cols-[minmax(0,1fr)_320px] min-[860px]:overflow-visible">
          <div className="shrink-0 px-[var(--space-5)] py-[var(--space-4)] min-[860px]:min-h-0 min-[860px]:overflow-y-auto">
            {text === null ? (
              <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                {viewing.id in fetched
                  ? REVIEW_COPY.versionUnavailable
                  : REVIEW_COPY.loadingVersion}
              </p>
            ) : (
              <ReviewDocument
                text={text}
                readOnly={!atHead || locked}
                marks={marks}
                labels={labels}
                selection={selection}
                onSelect={handleSelect}
              >
                {selection ? (
                  <EditComposer
                    key={`${String(selection.start)}-${String(selection.end)}`}
                    passage={text.slice(selection.start, selection.end)}
                    existing={
                      editing
                        ? { kind: editing.kind, value: editing.value, problem: editing.problem, teach: editing.teach }
                        : null
                    }
                    onSave={(kind, value, teach) => {
                      review.save({
                        headId: picked?.headId ?? run.headId,
                        key: editing?.key,
                        kind,
                        start: selection.start,
                        end: selection.end,
                        passage: text.slice(selection.start, selection.end),
                        value,
                        teach,
                      });
                      closeComposer();
                    }}
                    onCancel={closeComposer}
                    onRemove={
                      editing
                        ? () => {
                            review.remove(editing.key);
                            closeComposer();
                          }
                        : null
                    }
                  />
                ) : null}
              </ReviewDocument>
            )}
          </div>

          <aside className="shrink-0 border-t border-[var(--stroke)] bg-[var(--surface-warm)] px-[var(--space-4)] py-[var(--space-4)] min-[860px]:min-h-0 min-[860px]:overflow-y-auto min-[860px]:border-l min-[860px]:border-t-0">
            <EditsPane
              atHead={atHead}
              locked={locked}
              pending={review.pending}
              onOpen={(edit) => select({ start: edit.start, end: edit.end })}
              onRemove={review.remove}
              viewing={viewing}
              versions={versions}
            />
          </aside>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-[var(--space-3)] border-t border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-3)]">
          <Button
            variant="ghost"
            disabled={review.pending.length === 0 || locked}
            onClick={() => {
              select(null);
              review.discard();
            }}
          >
            {REVIEW_COPY.discard}
          </Button>
          <div className="flex flex-wrap items-center gap-[var(--space-3)]">
            {teaching > 0 ? (
              <p className="max-w-[48ch] rounded-[var(--radius-input)] bg-[var(--hold-tint)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--hold-deep)]">
                {teachNote(teaching, canTeach)}
              </p>
            ) : null}
            <Button variant="secondary" onClick={onClose}>
              {REVIEW_COPY.close}
            </Button>
            <Button
              variant="primary"
              disabled={!atHead || locked || sendable === 0}
              onClick={() => {
                select(null);
                void review.apply();
              }}
            >
              {sendable === 0 ? REVIEW_COPY.applyNone : `Apply ${plural(sendable, 'edit')}`}
            </Button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
