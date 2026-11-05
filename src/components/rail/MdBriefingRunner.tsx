'use client';

import * as React from 'react';

import { ArtifactPreview, pickPreviewArtifact } from '@/components/rail/ArtifactPreview';
import {
  answerMdBriefing,
  artifactUrl,
  cancelMdBriefing,
  latestMdBriefing,
  pollMdBriefing,
  startMdBriefing,
} from '@/lib/ignatious/client';
import type {
  BriefDepth,
  MeetingType,
  PendingQuestion,
  RunLifecycleStatus,
  RunStatus,
} from '@/lib/ignatious/types';
import { RUN_FAILED_MESSAGE, runFailureMessage } from '@/lib/ignatious/failure';
import { draftActionLabel, draftPlainLine } from './stepActionCopy';
import { MD_BRIEFING_STEP_ID } from '@/lib/rail/dealRail';
import { useSession } from '@/lib/session/store';

const MEETING_TYPES: { id: MeetingType; label: string; caption: string }[] = [
  { id: 'first_call', label: 'First call', caption: 'Qualify and win the room.' },
  { id: 'working_session', label: 'Working session', caption: 'Prep a follow-on working meeting.' },
  { id: 'closing', label: 'Closing', caption: 'Restore belief and run the close.' },
];

const DEPTHS: { id: BriefDepth; label: string }[] = [
  { id: 'one_pager', label: 'One-pager' },
  { id: 'full_memo', label: 'Full memo' },
];

const ACTIVE: ReadonlySet<RunLifecycleStatus> = new Set(['queued', 'running']);

export function MdBriefingRunner({
  dealId,
  onOutcome,
  onSignedOff,
}: {
  dealId: string;
  onOutcome?: (outcome: {
    verdict: 'compliant' | 'hold' | 'blocked';
    seconds: number;
    tokens: number;
  }) => void;
  onSignedOff?: () => void;
}) {
  const { dispatch } = useSession();
  const [meetingType, setMeetingType] = React.useState<MeetingType>('first_call');
  const [depth, setDepth] = React.useState<BriefDepth>('one_pager');
  const [attendees, setAttendees] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [run, setRun] = React.useState<RunStatus | null>(null);
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const startedAt = React.useRef(0);
  const outcomeFired = React.useRef(false);
  // True once the banker acted in this panel (Run, or a run already shown):
  // the mount-time lookup must not overwrite a run started meanwhile.
  const engaged = React.useRef(false);

  React.useEffect(() => {
    return () => dispatch({ type: 'SET_COMPLIANCE', status: 'idle' });
  }, [dispatch]);

  // A run that is still queued, running or waiting on answers survives the
  // panel: leaving the step and coming back picks it up where it was
  // (Finding 3). A finished run is not re-shown; the panel opens fresh.
  React.useEffect(() => {
    let cancelled = false;
    void latestMdBriefing(dealId)
      .then((status) => {
        if (cancelled || engaged.current || !status || !ACTIVE.has(status.status)) return;
        engaged.current = true;
        startedAt.current = status.startedAt ? Date.parse(status.startedAt) : Date.now();
        outcomeFired.current = false;
        setRun(status);
        dispatch({ type: 'SET_COMPLIANCE', status: 'scanning' });
      })
      .catch(() => {
        // No handle to resume: the step opens on the run form as before.
      });
    return () => {
      cancelled = true;
    };
  }, [dealId, dispatch]);

  React.useEffect(() => {
    if (!run || !ACTIVE.has(run.status) || failure) return;
    const timer = window.setInterval(() => {
      void pollMdBriefing(dealId, run.executionId)
        .then(setRun)
        .catch((err: unknown) => {
          setFailure(runFailureMessage(err));
          dispatch({ type: 'SET_COMPLIANCE', status: 'idle' });
        });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [dealId, dispatch, failure, run]);

  React.useEffect(() => {
    if (!run || outcomeFired.current) return;
    if (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') {
      return;
    }
    outcomeFired.current = true;
    dispatch({
      type: 'SET_COMPLIANCE',
      status: run.status === 'completed' ? 'clear' : 'hold',
    });
    onOutcome?.({
      verdict: run.status === 'completed' ? 'compliant' : 'hold',
      seconds: Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)),
      tokens: 0,
    });
  }, [dispatch, onOutcome, run]);

  async function start() {
    engaged.current = true;
    setBusy(true);
    setFailure(null);
    startedAt.current = Date.now();
    outcomeFired.current = false;
    dispatch({ type: 'SET_COMPLIANCE', status: 'scanning' });
    try {
      const accepted = await startMdBriefing(dealId, {
        meetingType,
        depth,
        attendees: attendees.trim() || undefined,
      });
      const status = await pollMdBriefing(dealId, accepted.executionId);
      setRun(status);
    } catch (err) {
      setFailure(runFailureMessage(err));
      dispatch({ type: 'SET_COMPLIANCE', status: 'idle' });
    } finally {
      setBusy(false);
    }
  }

  async function submitAnswers() {
    if (!run) return;
    setBusy(true);
    setFailure(null);
    try {
      const payload = (run.pendingQuestions ?? [])
        .filter((q) => answers[q.questionId]?.trim())
        .map((q) => ({ questionId: q.questionId, answer: answers[q.questionId].trim() }));
      await answerMdBriefing(dealId, run.executionId, payload);
      const next = await pollMdBriefing(dealId, run.executionId);
      setRun(next);
      setAnswers({});
    } catch (err) {
      setFailure(runFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!run) return;
    setBusy(true);
    try {
      await cancelMdBriefing(dealId, run.executionId);
      const next = await pollMdBriefing(dealId, run.executionId);
      setRun(next);
    } catch (err) {
      setFailure(runFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setRun(null);
    setAnswers({});
    setFailure(null);
    outcomeFired.current = false;
    dispatch({ type: 'SET_COMPLIANCE', status: 'idle' });
  }

  function retry() {
    reset();
    void start();
  }

  const questions = run?.pendingQuestions ?? [];
  const artifacts = run?.artifacts ?? [];
  const previewArtifact = pickPreviewArtifact(artifacts);
  const filings = run?.filings ?? [];
  const failureMessage =
    failure ?? (run?.status === 'failed' || run?.error ? RUN_FAILED_MESSAGE : null);
  const waiting = questions.length > 0 && run?.status === 'running' && !failureMessage;
  const inFlight = Boolean(run && ACTIVE.has(run.status)) && !failureMessage;

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-5)] text-[var(--ink)]">
      <p className="text-[length:var(--text-sm)] text-[var(--ink)]">
        {draftPlainLine(MD_BRIEFING_STEP_ID, 'MD Briefing')}
      </p>

      {!run ? (
        <div className="mt-[var(--space-4)] space-y-[var(--space-4)]">
          <div className="grid gap-[var(--space-2)] sm:grid-cols-3">
            {MEETING_TYPES.map((option) => {
              const active = option.id === meetingType;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setMeetingType(option.id)}
                  className={[
                    'rounded-[var(--radius-button)] border p-[var(--space-3)] text-left transition-colors',
                    active
                      ? 'border-[var(--ink)] bg-[var(--surface-subtle)]'
                      : 'border-[var(--stroke)] hover:border-[var(--stroke-strong)]',
                  ].join(' ')}
                >
                  <span className="block text-[length:var(--text-sm)] font-semibold">
                    {option.label}
                  </span>
                  <span className="mt-1 block text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                    {option.caption}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-[var(--space-2)]">
            {DEPTHS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setDepth(option.id)}
                className={[
                  'rounded-[var(--radius-pill)] border px-[var(--space-3)] py-1 text-[length:var(--text-xs)] font-medium',
                  option.id === depth
                    ? 'border-[var(--ink)] bg-[var(--surface-subtle)]'
                    : 'border-[var(--stroke)]',
                ].join(' ')}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="block">
            <span className="font-mono text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">
              Attendees (optional)
            </span>
            <input
              value={attendees}
              onChange={(event) => setAttendees(event.target.value)}
              placeholder="Names in the room"
              className="mt-1 w-full rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            />
          </label>
          <button
            type="button"
            onClick={() => void start()}
            disabled={busy}
            className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-semibold text-[var(--ink-on-dark)] transition-colors hover:bg-[var(--accent-dark)] disabled:opacity-60"
          >
            {busy ? 'Starting…' : draftActionLabel(MD_BRIEFING_STEP_ID, 'MD Briefing')}
          </button>
        </div>
      ) : (
        <div className="mt-[var(--space-4)] space-y-[var(--space-4)]">
          <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            {failure ? 'stopped' : run.status}
            {waiting ? ' · waiting on you' : ''}
            {run.outcome ? ` · ${run.outcome}` : ''}
            {run.costUsd != null ? ` · $${run.costUsd.toFixed(2)}` : ''}
          </p>

          {inFlight && !waiting ? (
            <p className="flex items-center gap-[var(--space-2)] text-[length:var(--text-sm)]">
              <span className="size-3 animate-spin rounded-full border-2 border-[var(--ai-soft)] border-t-[var(--ai)]" />
              Researching the company and drafting the brief…
            </p>
          ) : null}

          {waiting ? (
            <QuestionsPanel
              questions={questions}
              answers={answers}
              onChange={(questionId, value) =>
                setAnswers((prev) => ({ ...prev, [questionId]: value }))
              }
              onSubmit={() => void submitAnswers()}
              busy={busy}
            />
          ) : null}

          {artifacts.length ? (
            <div>
              <p className="font-mono text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">
                Artifacts
              </p>
              <ul className="mt-2 space-y-1">
                {artifacts.map((artifact, index) => (
                  <li key={artifact.path}>
                    <a
                      href={artifactUrl(dealId, run.executionId, index)}
                      className="text-[length:var(--text-sm)] text-[var(--ink)] underline underline-offset-4 hover:text-[var(--ink-secondary)]"
                    >
                      {artifact.path}
                      {artifact.primary ? ' · primary' : ''}
                    </a>
                    {previewArtifact?.path === artifact.path ? (
                      <ArtifactPreview
                        key={`${run.executionId}:${artifact.path}`}
                        dealId={dealId}
                        executionId={run.executionId}
                        artifactIndex={index}
                        artifact={artifact}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {filings.length ? (
            <div>
              <p className="font-mono text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">
                Filed on the lead
              </p>
              <ul className="mt-2 space-y-1 text-[length:var(--text-sm)]">
                {filings.map((filing) => (
                  <li key={filing.documentId}>
                    {filing.title} · {filing.filename ?? filing.documentType} · {filing.outcome}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-[var(--space-2)] border-t border-[var(--stroke)] pt-[var(--space-3)]">
            {inFlight ? (
              <button
                type="button"
                onClick={() => void cancel()}
                disabled={busy}
                className="rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)] font-medium text-[var(--ink)] disabled:opacity-60"
              >
                Cancel run
              </button>
            ) : (
              <button
                type="button"
                onClick={reset}
                className="rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)] font-medium text-[var(--ink)]"
              >
                Run again
              </button>
            )}
            {run.status === 'completed' ? (
              <button
                type="button"
                onClick={() => onSignedOff?.()}
                className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)] font-semibold text-[var(--ink-on-dark)]"
              >
                Approve · log as version
              </button>
            ) : null}
          </div>
        </div>
      )}

      {failureMessage ? (
        <div
          role="alert"
          className="mt-[var(--space-4)] rounded-[var(--radius-card)] border border-[var(--negative)] bg-[var(--surface-subtle)] p-[var(--space-3)]"
        >
          <p className="eyebrow text-[var(--negative-deep)]">Run failed</p>
          <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink)]">{failureMessage}</p>
          <button
            type="button"
            onClick={retry}
            disabled={busy}
            className="mt-[var(--space-3)] rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)] font-semibold text-[var(--ink)] disabled:opacity-60"
          >
            Retry run
          </button>
        </div>
      ) : null}
    </div>
  );
}

function QuestionsPanel({
  questions,
  answers,
  onChange,
  onSubmit,
  busy,
}: {
  questions: PendingQuestion[];
  answers: Record<string, string>;
  onChange: (questionId: string, value: string) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-[var(--space-3)]">
      <p className="text-[length:var(--text-sm)]">The run needs an answer before it continues.</p>
      {questions.map((question) => (
        <label key={question.questionId} className="block">
          <span className="block text-[length:var(--text-sm)] font-medium">
            {question.text}
            {question.blocking ? '' : ' · optional'}
          </span>
          {question.options?.length ? (
            <select
              value={answers[question.questionId] ?? ''}
              onChange={(event) => onChange(question.questionId, event.target.value)}
              className="mt-1 w-full rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <option value="">Choose…</option>
              {question.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <textarea
              value={answers[question.questionId] ?? ''}
              onChange={(event) => onChange(question.questionId, event.target.value)}
              rows={3}
              className="mt-1 w-full rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            />
          )}
        </label>
      ))}
      <button
        type="button"
        onClick={onSubmit}
        disabled={busy}
        className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-semibold text-[var(--ink-on-dark)] disabled:opacity-60"
      >
        {busy ? 'Sending…' : 'Resume run'}
      </button>
    </div>
  );
}

export default MdBriefingRunner;
