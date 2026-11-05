'use client';

import * as React from 'react';

import { Markdown } from '@/components/atoms';
import {
  answerPresearch,
  cancelPresearch,
  latestPresearch,
  pollPresearch,
  startPresearch,
  type PresearchPoll,
} from '@/lib/ignatious/client';
import type { MeetingType, PendingQuestion, RunLifecycleStatus } from '@/lib/ignatious/types';

const MEETING_TYPES: { id: MeetingType; label: string }[] = [
  { id: 'first_call', label: 'First call' },
  { id: 'working_session', label: 'Working session' },
  { id: 'closing', label: 'Closing' },
];

const ACTIVE: ReadonlySet<RunLifecycleStatus> = new Set(['queued', 'running']);

/** How long a completed run may keep failing or waiting to apply before polling stops. */
// Covers a two-minute stale claim plus the 30/60/120/240-second retry schedule.
export const APPLY_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_FAILURE_TIMEOUT_MS = 30_000;

/** A completed run whose memo is still being applied, or failed and will be retried. */
function applyRetrying(run: PresearchPoll): boolean {
  return Boolean(run.applying) || run.applyFailed === 'retrying';
}

export function PresearchRunner({
  companyId,
  companyName,
  onApplied,
  layout = 'card',
}: {
  companyId: string;
  companyName: string;
  onApplied?: () => void;
  /** Card chrome for the lead panel; dialog drops heading + outer card. */
  layout?: 'card' | 'dialog';
}) {
  const [meetingType, setMeetingType] = React.useState<MeetingType>('first_call');
  const [attendees, setAttendees] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [run, setRun] = React.useState<PresearchPoll | null>(null);
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [latestMemo, setLatestMemo] = React.useState<string | null>(null);
  const [appliedNote, setAppliedNote] = React.useState<string | null>(null);
  // When continuous `applying` polls began; cleared once the apply settles.
  const applyingSince = React.useRef<number | null>(null);
  const pollFailureSince = React.useRef<number | null>(null);
  const [pollingStopped, setPollingStopped] = React.useState<'apply' | 'poll' | null>(null);

  const [resumingExecution, setResumingExecution] = React.useState<string | null>(null);
  const onAppliedRef = React.useRef(onApplied);
  React.useEffect(() => { onAppliedRef.current = onApplied; }, [onApplied]);

  const handlePollError = React.useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
    pollFailureSince.current ??= Date.now();
    if (Date.now() - pollFailureSince.current >= POLL_FAILURE_TIMEOUT_MS) setPollingStopped('poll');
  }, []);

  // Every poll, including the first one after reload, has the same effects.
  const handlePoll = React.useCallback((next: PresearchPoll) => {
    pollFailureSince.current = null;
    setPollingStopped(null);
    setRun(next);
    setResumingExecution(null);
    setError(null);
    if (applyRetrying(next)) {
      applyingSince.current ??= Date.now();
      if (Date.now() - applyingSince.current >= APPLY_TIMEOUT_MS) setPollingStopped('apply');
    } else {
      applyingSince.current = null;
    }
    if (next.applied && !next.applied.alreadyApplied) {
      const saved = next.applied.peopleAdded
        ? `Added ${next.applied.peopleAdded} ${next.applied.peopleAdded === 1 ? 'person' : 'people'} from the memo.`
        : 'Saved the presearch memo on this lead.';
      const skipped = next.applied.peopleSkipped ?? 0;
      setAppliedNote(saved + (skipped
        ? ` ${skipped} ${skipped === 1 ? 'person' : 'people'} could not be added. Review the memo and add them manually.`
        : ''));

      onAppliedRef.current?.();
    }
    if (next.status === 'completed') {
      void latestPresearch(companyId)
        .then((body) => setLatestMemo(body.latest?.memo_md ?? null))
        .catch(() => undefined);
    }
  }, [companyId]);

  React.useEffect(() => {
    let cancelled = false;
    void latestPresearch(companyId)
      .then(async (body) => {
        if (cancelled) return;
        setLatestMemo(body.latest?.memo_md ?? null);
        if (!body.pending) return;
        // Retain the id even if the first poll fails so the interval can retry.
        setResumingExecution(body.pending.execution_id);
        const resumed = await pollPresearch(companyId, body.pending.execution_id);
        if (!cancelled) handlePoll(resumed);
      })
      .catch((err: unknown) => {
        if (!cancelled) handlePollError(err);
      });
    return () => { cancelled = true; };
  }, [companyId, handlePoll, handlePollError]);

  React.useEffect(() => {
    const executionId = run?.executionId ?? resumingExecution;
    if (!executionId || pollingStopped || (run && !(ACTIVE.has(run.status) || applyRetrying(run)))) return;
    const timer = window.setInterval(() => {
      if (pollFailureSince.current !== null && Date.now() - pollFailureSince.current >= POLL_FAILURE_TIMEOUT_MS) {
        setPollingStopped('poll');
        return;
      }
      void pollPresearch(companyId, executionId)
        .then(handlePoll)
        .catch(handlePollError);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [pollingStopped, companyId, handlePoll, handlePollError, resumingExecution, run]);

  function resetApplyClock() {
    applyingSince.current = null;
    pollFailureSince.current = null;
    setError(null);
    setPollingStopped(null);
  }

  async function start() {
    setBusy(true);
    setError(null);
    setAppliedNote(null);
    resetApplyClock();
    try {
      const accepted = await startPresearch(companyId, {
        meetingType,
        attendees: attendees.trim() || undefined,
      });
      handlePoll(await pollPresearch(companyId, accepted.executionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitAnswers() {
    if (!run) return;
    setBusy(true);
    try {
      const payload = (run.pendingQuestions ?? [])
        .filter((q) => answers[q.questionId]?.trim())
        .map((q) => ({ questionId: q.questionId, answer: answers[q.questionId].trim() }));
      await answerPresearch(companyId, run.executionId, payload);
      handlePoll(await pollPresearch(companyId, run.executionId));
      setAnswers({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const questions = run?.pendingQuestions ?? [];
  const waiting = questions.length > 0 && run?.status === 'running';

  const isDialog = layout === 'dialog';
  const Shell = isDialog ? 'div' : 'section';

  return (
    <Shell
      aria-label={`Presearch ${companyName}`}
      className={
        isDialog
          ? 'flex flex-col gap-[var(--space-3)]'
          : 'flex flex-col gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)]'
      }
    >
      {isDialog ? null : (
        <div className="flex flex-wrap items-start justify-between gap-[var(--space-3)]">
          <div>
            <p className="eyebrow">Ignatious</p>
            <h3 className="font-sans text-[length:var(--text-md)] font-medium text-[var(--ink)]">
              Presearch this lead
            </h3>
            <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
              Research {companyName} and write people and the memo back onto the lead.
            </p>
          </div>
        </div>
      )}

      {!run ? (
        <div className="flex flex-col gap-[var(--space-3)]">
          <div className="flex flex-wrap gap-[var(--space-2)]">
            {MEETING_TYPES.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setMeetingType(option.id)}
                className={[
                  'rounded-[var(--radius-pill)] border px-[var(--space-3)] py-1 text-[length:var(--text-xs)] font-medium',
                  option.id === meetingType
                    ? 'border-[var(--ink)] bg-[var(--surface-subtle)] text-[var(--ink)]'
                    : 'border-[var(--stroke)] text-[var(--ink-secondary)]',
                ].join(' ')}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="block">
            <span className="bank-label">Attendees (optional)</span>
            <input
              value={attendees}
              onChange={(event) => setAttendees(event.target.value)}
              placeholder="Who will be in the room"
              className="mt-1 w-full rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            />
          </label>
          <button
            type="button"
            onClick={() => void start()}
            disabled={busy}
            className="w-fit rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-semibold text-white disabled:opacity-60"
          >
            {busy ? 'Starting…' : 'Run presearch'}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-[var(--space-3)]">
          <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
            {run.status}
            {waiting ? ' · waiting on you' : ''}
            {run.costUsd != null ? ` · $${run.costUsd.toFixed(2)}` : ''}
          </p>
          {ACTIVE.has(run.status) && !waiting && pollingStopped !== 'poll' ? (
            <p className="text-[length:var(--text-sm)] text-[var(--ai-deep)]">
              Researching the company and drafting the memo…
            </p>
          ) : null}
          {waiting
            ? questions.map((question: PendingQuestion) => (
                <label key={question.questionId} className="block">
                  <span className="block text-[length:var(--text-sm)] font-medium">
                    {question.text}
                  </span>
                  <textarea
                    value={answers[question.questionId] ?? ''}
                    onChange={(event) =>
                      setAnswers((prev) => ({ ...prev, [question.questionId]: event.target.value }))
                    }
                    rows={3}
                    className="mt-1 w-full rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  />
                </label>
              ))
            : null}
          {waiting ? (
            <button
              type="button"
              onClick={() => void submitAnswers()}
              disabled={busy}
              className="w-fit rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)] font-semibold text-white"
            >
              Resume run
            </button>
          ) : null}
          {run.error ? (
            <p className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">{run.error.message}</p>
          ) : null}
          <div className="flex gap-[var(--space-2)]">
            {ACTIVE.has(run.status) ? (
              <button
                type="button"
                onClick={() =>
                  void cancelPresearch(companyId, run.executionId).then(() =>
                    pollPresearch(companyId, run.executionId).then(handlePoll),
                  )
                }
                className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)]"
              >
                Cancel
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setRun(null);
                  setAnswers({});
                  resetApplyClock();
                }}
                className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)]"
              >
                Run again
              </button>
            )}
          </div>
        </div>
      )}

      {run?.applyFailed === 'terminal' ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          The research finished but could not be applied to the lead. Applying stopped after repeated failures.
        </p>
      ) : pollingStopped ? (
        <div role="alert" className="flex flex-wrap items-center gap-[var(--space-2)]">
          <p className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
            {pollingStopped === 'poll'
              ? 'Unable to check the research status. The run may still be in progress.'
              : 'The research finished but is not applied to the lead yet.'}
          </p>
          <button
            type="button"
            onClick={resetApplyClock}
            className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)]"
          >
            {pollingStopped === 'poll' ? 'Retry checking status' : 'Retry applying'}
          </button>
        </div>
      ) : null}
      {appliedNote ? (
        <p className="text-[length:var(--text-sm)] text-[var(--ink)]">{appliedNote}</p>
      ) : null}
      {latestMemo ? (
        <details className="rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)]">
          <summary className="cursor-pointer text-[length:var(--text-sm)] font-medium">
            Latest presearch memo
          </summary>
          <Markdown className="mt-2 max-h-80 overflow-auto">{latestMemo}</Markdown>
        </details>
      ) : null}
      {error ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {error}
        </p>
      ) : null}
    </Shell>
  );
}
