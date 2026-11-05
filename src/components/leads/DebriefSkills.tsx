'use client';

import * as React from 'react';

import {
  answerCompanyRun,
  cancelCompanyRun,
  chatLeadTwin,
  listLeadTwins,
  pollCompanyRun,
  startDebrief,
} from '@/lib/ignatious/client';
import type { PendingQuestion, RunLifecycleStatus, RunStatus } from '@/lib/ignatious/types';

const ACTIVE: ReadonlySet<RunLifecycleStatus> = new Set(['queued', 'running']);

type Twin = { personaId: string; name: string; title: string; organization: string };

export function DebriefSkills({
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
  const [title, setTitle] = React.useState('Lead partner debrief');
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sourceRun, setSourceRun] = React.useState<RunStatus | null>(null);
  const [twinRun, setTwinRun] = React.useState<RunStatus | null>(null);
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [twins, setTwins] = React.useState<Twin[]>([]);
  const [chatId, setChatId] = React.useState<string | null>(null);
  const [chatInput, setChatInput] = React.useState('');
  const [chatLog, setChatLog] = React.useState<{ role: 'user' | 'assistant'; content: string }[]>([]);

  const reloadTwins = React.useCallback(() => {
    void listLeadTwins(companyId)
      .then((body) => setTwins(body.personas ?? []))
      .catch(() => undefined);
  }, [companyId]);

  React.useEffect(() => {
    reloadTwins();
  }, [reloadTwins]);

  useRunPoll(companyId, sourceRun, setSourceRun, () => {
    onApplied?.();
    reloadTwins();
  });
  useRunPoll(companyId, twinRun, setTwinRun, reloadTwins);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const accepted = await startDebrief(companyId, { title, text, runTwins: true });
      setSourceRun(await pollCompanyRun(companyId, accepted.sourceRun.executionId));
      if (accepted.twinRun) {
        setTwinRun(await pollCompanyRun(companyId, accepted.twinRun.executionId));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitAnswers(run: RunStatus) {
    setBusy(true);
    try {
      const payload = (run.pendingQuestions ?? [])
        .filter((question) => answers[question.questionId]?.trim())
        .map((question) => ({
          questionId: question.questionId,
          answer: answers[question.questionId].trim(),
        }));
      await answerCompanyRun(companyId, run.executionId, payload);
      const next = await pollCompanyRun(companyId, run.executionId);
      if (sourceRun?.executionId === run.executionId) setSourceRun(next);
      if (twinRun?.executionId === run.executionId) setTwinRun(next);
      setAnswers({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function sendChat() {
    if (!chatId || !chatInput.trim()) return;
    const message = chatInput.trim();
    setChatInput('');
    setChatLog((prev) => [...prev, { role: 'user', content: message }]);
    setBusy(true);
    try {
      const reply = await chatLeadTwin(companyId, chatId, message, chatLog);
      setChatLog((prev) => [...prev, { role: 'assistant', content: reply.reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const waitingOn = [sourceRun, twinRun].find(
    (run) => run && run.pendingQuestions.length > 0 && run.status === 'running',
  );

  const isDialog = layout === 'dialog';
  const Shell = isDialog ? 'div' : 'section';

  return (
    <Shell
      aria-label={`Source intelligence for ${companyName}`}
      className={
        isDialog
          ? 'flex flex-col gap-[var(--space-3)]'
          : 'flex flex-col gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)]'
      }
    >
      {isDialog ? null : (
        <div>
          <p className="eyebrow">Ignatious</p>
          <h3 className="font-sans text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
            Source intelligence and twins
          </h3>
          <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            Paste a debrief or transcript. Source intelligence updates the maps; the twin builder
            writes personas you can talk to.
          </p>
        </div>
      )}

      <label className="block">
        <span className="bank-label">Document title</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="mt-1 w-full rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        />
      </label>
      <label className="block">
        <span className="bank-label">Debrief</span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={8}
          placeholder="Paste notes from the call, a partner debrief, or a source transcript."
          className="mt-1 w-full rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        />
      </label>
      <button
        type="button"
        onClick={() => void start()}
        disabled={busy || text.trim().length < 40}
        className="inline-flex min-h-[36px] w-fit items-center rounded-[var(--radius-button)] bg-[var(--ai)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--accent-contrast)] transition-colors duration-150 hover:bg-[var(--ai-deep)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:opacity-60"
      >
        {busy && !sourceRun ? 'Starting…' : 'Extract from debrief'}
      </button>

      {sourceRun ? <RunLine label="Source intelligence" run={sourceRun} /> : null}
      {twinRun ? <RunLine label="Digital twin builder" run={twinRun} /> : null}

      {waitingOn
        ? waitingOn.pendingQuestions.map((question: PendingQuestion) => (
            <label key={question.questionId} className="block">
              <span className="block text-[length:var(--text-sm)] font-medium">{question.text}</span>
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
      {waitingOn ? (
        <button
          type="button"
          onClick={() => void submitAnswers(waitingOn)}
          disabled={busy}
          className="inline-flex min-h-[32px] w-fit items-center rounded-[var(--radius-button)] bg-[var(--ai)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)] font-medium text-[var(--accent-contrast)] transition-colors duration-150 hover:bg-[var(--ai-deep)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:opacity-60"
        >
          Resume run
        </button>
      ) : null}

      {sourceRun && ACTIVE.has(sourceRun.status) ? (
        <button
          type="button"
          onClick={() => void cancelCompanyRun(companyId, sourceRun.executionId)}
          className="inline-flex min-h-[32px] w-fit items-center rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] transition-colors duration-150 hover:bg-[var(--surface-raised)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          Cancel source intelligence
        </button>
      ) : null}

      {twins.length > 0 ? (
        <div className="flex flex-col gap-[var(--space-2)]">
          <p className="text-[length:var(--text-sm)] font-medium">Digital twins</p>
          <div className="flex flex-wrap gap-[var(--space-2)]">
            {twins.map((twin) => (
              <button
                key={twin.personaId}
                type="button"
                onClick={() => {
                  setChatId(twin.personaId);
                  setChatLog([]);
                }}
                className={[
                  'inline-flex min-h-[28px] items-center rounded-[var(--radius-pill)] border px-[var(--space-3)] py-1 text-[length:var(--text-xs)] font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2',
                  chatId === twin.personaId
                    ? 'border-[var(--ink)] bg-[var(--surface-subtle)] text-[var(--ink)]'
                    : 'border-[var(--stroke-strong)] bg-[var(--surface)] text-[var(--ink-secondary)] hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]',
                ].join(' ')}
              >
                {twin.name}
                <span className="text-[var(--ink-secondary)]"> · {twin.title}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {chatId ? (
        <div className="flex flex-col gap-[var(--space-2)]">
          <div className="max-h-64 overflow-auto rounded-[var(--radius-input)] border border-[var(--stroke)] bg-[var(--surface-warm)] p-[var(--space-3)]">
            {chatLog.length === 0 ? (
              <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                Ask this twin how they would hear a first call.
              </p>
            ) : (
              chatLog.map((turn, index) => (
                <p key={`${turn.role}-${index}`} className="mb-2 text-[length:var(--text-sm)]">
                  <span className="font-medium">{turn.role === 'user' ? 'You' : 'Twin'}: </span>
                  {turn.content}
                </p>
              ))
            )}
          </div>
          <div className="flex gap-[var(--space-2)]">
            <input
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void sendChat();
              }}
              placeholder="Message the twin"
              className="flex-1 rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            />
            <button
              type="button"
              onClick={() => void sendChat()}
              disabled={busy || !chatInput.trim()}
              className="inline-flex items-center rounded-[var(--radius-button)] bg-[var(--ai)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)] font-medium text-[var(--accent-contrast)] transition-colors duration-150 hover:bg-[var(--ai-deep)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:opacity-60"
            >
              Send
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {error}
        </p>
      ) : null}
    </Shell>
  );
}

function RunLine({ label, run }: { label: string; run: RunStatus }) {
  // Active-run state carries the sanctioned Casey violet (ai-soft chip);
  // settled runs read as quiet mono ink.
  return (
    <p
      className={[
        'w-fit rounded-[var(--radius-pill)] px-[var(--space-3)] py-[var(--space-1)] font-mono text-[length:var(--text-xs)] tnum',
        ACTIVE.has(run.status)
          ? 'bg-[var(--ai-soft)] text-[var(--ai-deep)]'
          : 'bg-[var(--surface-subtle)] text-[var(--ink-secondary)]',
      ].join(' ')}
    >
      {label}: {run.status}
      {run.outcome ? ` · ${run.outcome}` : ''}
      {run.costUsd != null ? ` · $${run.costUsd.toFixed(2)}` : ''}
      {run.error ? ` · ${run.error.message}` : ''}
    </p>
  );
}

function useRunPoll(
  companyId: string,
  run: RunStatus | null,
  setRun: (next: RunStatus) => void,
  onSettled?: () => void,
) {
  React.useEffect(() => {
    if (!run || !ACTIVE.has(run.status)) return;
    const timer = window.setInterval(() => {
      void pollCompanyRun(companyId, run.executionId)
        .then((next) => {
          setRun(next);
          if (next.status === 'completed' || next.status === 'failed') onSettled?.();
        })
        .catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [companyId, onSettled, run, setRun]);
}
