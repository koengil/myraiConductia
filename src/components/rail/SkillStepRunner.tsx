'use client';

import * as React from 'react';

import { Markdown } from '@/components/atoms';
import { elapsedLabel, patchStep, readStepState } from '@/lib/ignatious/benchSession';
import { readBenchEvents } from '@/lib/ignatious/client';
import {
  benchErrorCodeMessage,
  IgnatiousClientError,
  skillRunFailureMessage,
} from '@/lib/ignatious/failure';
import { BENCH_MODEL_ALIASES, type BenchModelAlias } from '@/lib/ignatious/processTag';
import { stepSkillCopy } from '@/lib/ignatious/stepSkillIo';
import { useFlag } from '@/lib/flags/FlagsContext';
import { skillBindingForStep, stepTitle, type ProjectRailStep } from '@/lib/rail/projectRail';
import {
  collectRunInputs,
  missingRequired,
  parseInputProblems,
  parseInputValues,
  type SkillInputField,
  type SkillInputValue,
  type SkillInputValues,
} from '@/lib/skillRun/inputs';
import { normalizeRun } from '@/lib/skillRun/revisionView';
import type { SkillReference, SkillRunSummary } from '@/lib/skillRun/types';
import type { VersionOption } from '@/lib/skillRun/versions';
import { RunOutput } from './review/RunOutput';
import { fetchResolvedSkillReference, runsPath, type ResolvedSkill } from './useStepSkillResolution';
import { SkillInputFields } from './SkillInputFields';
import { referenceKey, StepVersionControl } from './StepVersionControl';
import { NO_SKILL_YET, draftActionLabel, draftPlainLine } from './stepActionCopy';
import { formatDateTime } from '@/lib/format/date';

export const INSTRUCTIONS_LABEL = 'Additional instructions';

export const CANCELLED_MESSAGE = 'Cancelled. Nothing was recorded.';
/** The same sentence the step view shows: one line for "no skill", everywhere. */
export const NO_SKILL_MESSAGE = NO_SKILL_YET;
export const REMOVED_MESSAGE = 'This step was removed. Its runs are kept for reference.';
export const NOT_RECORDED_MESSAGE =
  'This run could not be recorded. The result below is on screen only.';
export const RESOLVING_SKILL_MESSAGE = 'Checking this step for an attached skill.';
export const SKILL_UNREADABLE_MESSAGE =
  'The skill on this step could not be read right now. Its runs are still listed below.';


async function benchFailureDetail(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const envelope = body?.error;
  if (!envelope || typeof envelope !== 'object') return null;
  return benchErrorCodeMessage((envelope as { code?: unknown }).code);
}

function outcomeLabel(run: SkillRunSummary): string {
  return run.outcome === 'succeeded' ? 'succeeded' : 'failed';
}

function RunHistoryList({
  runs,
  selectedId,
  onSelect,
  onEnhance,
}: {
  runs: SkillRunSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEnhance: (runId: string | null) => void;
}) {
  return (
    <ul className="space-y-[var(--space-1)]" aria-label="Run history">
      {runs.map((run) => (
        <li key={run.id} className="flex items-center gap-[var(--space-3)]">
          <button
            type="button"
            onClick={() => onSelect(run.id)}
            aria-current={run.id === selectedId ? 'true' : undefined}
            className="text-left text-[length:var(--text-xs)] text-[var(--ink-secondary)] underline"
          >
            {run.actorName} · {formatDateTime(run.createdAt)} · {outcomeLabel(run)}
          </button>
          <button
            type="button"
            onClick={() => onEnhance(run.id)}
            className="text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] underline"
          >
            Improve this skill
          </button>
        </li>
      ))}
    </ul>
  );
}

function modelLabel(alias: string): string {
  return alias.charAt(0).toUpperCase() + alias.slice(1);
}

function clampNotice(clampedFrom: string, ran: string | null): string {
  const asked = `${modelLabel(clampedFrom)} is above this skill's ceiling.`;
  return ran === null ? asked : `${asked} The run used ${modelLabel(ran)}.`;
}

function RunResult({
  text,
  documents,
}: {
  text: string;
  documents: SkillRunSummary['documents'];
}) {
  return (
    <div className="space-y-[var(--space-2)]">
      <Markdown className="max-h-72 overflow-auto rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)]">
        {text}
      </Markdown>
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
    </div>
  );
}

function fieldsForRun(run: SkillRunSummary, options: VersionOption[]): SkillInputField[] {
  if (!run.binding) return [];
  const key = referenceKey(run.binding);
  const option = options.find((candidate) => referenceKey(candidate.reference) === key);
  return option ? option.inputs : [];
}

function orderedRunInputEntries(
  run: SkillRunSummary,
  runFields: SkillInputField[],
): [string, SkillInputValue][] {
  const declared: [string, SkillInputValue][] = [];
  const seen = new Set<string>();
  for (const field of runFields) {
    if (field.name in run.inputs) {
      declared.push([field.name, run.inputs[field.name]]);
      seen.add(field.name);
    }
  }
  const remaining = Object.entries(run.inputs).filter(([name]) => !seen.has(name));
  return [...declared, ...remaining];
}

function RunInputsSummary({
  run,
  options,
}: {
  run: SkillRunSummary;
  options: VersionOption[];
}) {
  const entries = Object.entries(run.inputs);
  if (entries.length === 0 && !run.input) return null;
  const runFields = fieldsForRun(run, options);
  const labelFor = (name: string) => runFields.find((field) => field.name === name)?.label ?? name;
  const orderedEntries = orderedRunInputEntries(run, runFields);
  return (
    <dl
      className="grid grid-cols-[auto_1fr] gap-x-[var(--space-3)] gap-y-[var(--space-1)] text-[length:var(--text-xs)]"
      aria-label="Run inputs"
    >
      {orderedEntries.map(([name, value]) => (
        <React.Fragment key={name}>
          <dt className="text-[var(--ink-secondary)]">{labelFor(name)}</dt>
          <dd className="text-[var(--ink)]">{String(value)}</dd>
        </React.Fragment>
      ))}
      {run.input ? (
        <>
          <dt className="text-[var(--ink-secondary)]">{INSTRUCTIONS_LABEL}</dt>
          <dd className="whitespace-pre-wrap text-[var(--ink)]">{run.input}</dd>
        </>
      ) : null}
    </dl>
  );
}

export function SkillStepRunner({
  projectId,
  step,
  onEnhance,
  canTeach,
  builderChanges,
}: {
  projectId: string;
  step: ProjectRailStep;
  onEnhance?: (runId: string | null, teach?: boolean) => void;
  canTeach?: boolean;
  builderChanges?: number;
}) {
  const binding = skillBindingForStep(step);
  const definition =
    step.definition && 'inputs' in step.definition ? step.definition : null;
  const removed = step.removedAt !== null;
  const handleEnhance = onEnhance ?? (() => undefined);

  const needsAsyncSkillResolution = step.definition === null;
  const [catalogReference, setCatalogReference] = React.useState<ResolvedSkill | 'resolving'>(
    needsAsyncSkillResolution ? 'resolving' : 'none',
  );

  const [instructions, setInstructions] = React.useState('');
  const [values, setValues] = React.useState<SkillInputValues>({});
  const [fields, setFields] = React.useState<SkillInputField[]>([]);
  const [listedOptions, setListedOptions] = React.useState<VersionOption[]>([]);
  const [problems, setProblems] = React.useState<Record<string, string>>({});
  const [looseProblems, setLooseProblems] = React.useState<{ name: string | null; message: string }[]>([]);
  const [saving, setSaving] = React.useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [runs, setRuns] = React.useState<SkillRunSummary[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [streamed, setStreamed] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [elapsed, setElapsed] = React.useState(0);
  const [selectedVersion, setSelectedVersion] = React.useState<SkillReference | null>(null);
  const [model, setModel] = React.useState<BenchModelAlias | ''>('');
  const revisionsOn = useFlag('skill_output_revisions');
  const abort = React.useRef<AbortController | null>(null);
  const cancelled = React.useRef(false);
  const unmounting = React.useRef(false);

  const lacking = missingRequired(fields, values);

  const path = runsPath(projectId, step.stepId);

  React.useEffect(() => {
    if (!needsAsyncSkillResolution) return;
    let live = true;
    void fetchResolvedSkillReference(projectId, step.stepId)
      .then((reference) => {
        if (live) setCatalogReference(reference);
      })
      .catch(() => {
        if (live) setCatalogReference('unavailable');
      });
    return () => {
      live = false;
    };
  }, [needsAsyncSkillResolution, projectId, step.stepId]);

  const loadRuns = React.useCallback(async (): Promise<SkillRunSummary[]> => {
    const response = await fetch(path, { credentials: 'include' });
    if (!response.ok) return [];
    const body = (await response.json()) as { runs?: SkillRunSummary[] };
    return (body.runs ?? []).map(normalizeRun);
  }, [path]);

  React.useEffect(() => {
    let live = true;
    if (!removed) {
      void readStepState(projectId, step.stepId).then((state) => {
        if (!live) return;
        if (typeof state.work.primary === 'string') setInstructions(state.work.primary);
        setValues(parseInputValues(state.work.inputs) ?? {});
      }, () => undefined);
    }
    void loadRuns()
      .then((loaded) => {
        if (!live) return;
        setRuns(loaded);
        setSelectedId(loaded[0]?.id ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, step.stepId, removed, loadRuns]);

  React.useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);

  React.useEffect(
    () => () => {
      unmounting.current = true;
      abort.current?.abort();
    },
    [],
  );

  const handleSelection = React.useCallback(
    (reference: SkillReference | null, next: SkillInputField[]) => {
      setSelectedVersion(reference);
      setFields(next);
      setProblems({});
      setLooseProblems([]);
    },
    [],
  );

  const handleVersionsLoaded = React.useCallback((options: VersionOption[]) => {
    setListedOptions(options);
  }, []);

  const latestReload = React.useRef(0);
  const reloadRuns = React.useCallback(async (): Promise<SkillRunSummary[]> => {
    const reload = ++latestReload.current;
    const loaded = await loadRuns().catch(() => []);
    if (loaded.length === 0) return [];
    if (reload === latestReload.current) setRuns(loaded);
    return loaded;
  }, [loadRuns]);

  const seenChanges = React.useRef(builderChanges);
  React.useEffect(() => {
    if (seenChanges.current === builderChanges) return;
    seenChanges.current = builderChanges;
    void reloadRuns();
  }, [builderChanges, reloadRuns]);

  // Report the PATCH outcome truthfully: a refused or failed save shows
  // "Not saved" rather than "Saved" (#250).
  function persist(work: Record<string, unknown>) {
    setSaving('saving');
    return patchStep(projectId, step.stepId, { work })
      .catch(() => false)
      .then((ok) => setSaving(ok ? 'saved' : 'failed'));
  }

  function saveValues(next: SkillInputValues) {
    void persist({ inputs: next });
  }

  function selectRun(id: string) {
    setSelectedId(id);
    if (revisionsOn) void reloadRuns();
  }

  async function refresh() {
    const loaded = await loadRuns().catch(() => []);
    setRuns(loaded);
    setSelectedId(loaded[0]?.id ?? null);
  }

  async function record(body: Record<string, unknown>) {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(NOT_RECORDED_MESSAGE);
  }

  async function run() {
    if (pending || lacking) return;
    setError(null);
    setProblems({});
    setLooseProblems([]);
    setStreamed('');
    setPending(true);
    setElapsed(0);
    cancelled.current = false;
    const controller = new AbortController();
    abort.current = controller;
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    let text = '';
    let providerRunId: string | null = null;
    let ranModel: string | null = model === '' ? null : model;
    let clampedFrom: string | null = null;
    const runInputs = collectRunInputs(fields, values);
    const runInstructions = instructions.trim() === '' ? null : instructions.trim();

    try {
      await persist({ primary: instructions, inputs: values });

      const streamRequest: {
        runId: string;
        version?: SkillReference;
        model?: BenchModelAlias;
        inputs: SkillInputValues;
        instructions: string | null;
      } = {
        runId,
        inputs: runInputs,
        instructions: runInstructions,
      };
      if (selectedVersion) streamRequest.version = selectedVersion;
      if (model) streamRequest.model = model;

      const response = await fetch(`${path}/stream`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(streamRequest),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        if (response.status === 422) {
          const found = parseInputProblems(await response.clone().json().catch(() => null));
          if (found && found.length > 0) {
            const byField: Record<string, string> = {};
            const loose: { name: string | null; message: string }[] = [];
            for (const problem of found) {
              if (problem.name && fields.some((field) => field.name === problem.name)) {
                byField[problem.name] = problem.message;
              } else {
                loose.push(problem);
              }
            }
            setProblems(byField);
            setLooseProblems(loose);
            setStreamed(null);
            setPending(false);
            if (revisionsOn) void reloadRuns();
            return;
          }
        }
        throw new IgnatiousClientError(
          response.status,
          `The skill bench answered ${String(response.status)}.`,
          await benchFailureDetail(response),
        );
      }

      for await (const event of readBenchEvents(response.body)) {
        if (event.type === 'run' && typeof event.runId === 'string') {
          providerRunId = event.runId;
        }
        if (event.type === 'text' && typeof event.text === 'string') {
          text += (text === '' ? '' : '\n\n') + event.text;
          setStreamed(text);
        }
        if (event.type === 'done') {
          if (typeof event.model === 'string') ranModel = event.model;
          if (typeof event.clampedFrom === 'string') clampedFrom = event.clampedFrom;
        }
        if (event.type === 'error' && typeof event.message === 'string') {
          throw new Error(event.message);
        }
      }
      if (text.trim() === '') throw new Error('The skill returned an empty reply.');

      try {
        await record({
          runId,
          outcome: 'succeeded',
          resultText: text,
          providerRunId,
          startedAt,
          reference: selectedVersion,
          model: ranModel,
          clampedFrom,
          inputs: runInputs,
          instructions: runInstructions,
        });
      } catch {
        setError(NOT_RECORDED_MESSAGE);
        return;
      }
      setStreamed(null);
      await refresh();
    } catch (caught) {
      if (unmounting.current) return;
      setStreamed(null);
      if (cancelled.current) {
        setError(CANCELLED_MESSAGE);
        if (revisionsOn) void reloadRuns();
        return;
      }
      const message = skillRunFailureMessage(caught);
      setError(message);
      await record({
        runId,
        outcome: 'failed',
        errorMessage: message,
        providerRunId,
        startedAt,
        reference: selectedVersion,
        model: ranModel,
        clampedFrom,
        inputs: runInputs,
        instructions: runInstructions,
      }).catch(() => undefined);
      await refresh();
    } finally {
      abort.current = null;
      setPending(false);
    }
  }

  const hasCustomSkill = binding !== null && definition !== null;
  const hasCatalogSkill =
    needsAsyncSkillResolution && typeof catalogReference === 'object' && catalogReference !== null;

  const selected = runs.find((entry) => entry.id === selectedId) ?? null;
  const shownText = streamed !== null ? streamed : (selected?.headText ?? null);
  const reviewed =
    revisionsOn && streamed === null && selected?.outcome === 'succeeded' && selected.headText !== null
      ? selected
      : null;
  const shownDocuments = streamed !== null ? [] : (selected?.documents ?? []);
  const clampLine = selected?.clampedFrom
    ? clampNotice(selected.clampedFrom, selected.model)
    : null;

  if (needsAsyncSkillResolution && catalogReference === 'resolving') {
    return (
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {RESOLVING_SKILL_MESSAGE}
      </p>
    );
  }

  if (removed || (!hasCustomSkill && !hasCatalogSkill)) {
    const notice = removed
      ? REMOVED_MESSAGE
      : catalogReference === 'unavailable'
        ? SKILL_UNREADABLE_MESSAGE
        : NO_SKILL_MESSAGE;
    return (
      <section className="space-y-[var(--space-3)]" aria-label="Skill run">
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{notice}</p>
        {/* A revision runs on the run's own recorded skill, not the step's
            current one, so a completed run stays revisable here. A
            removed step's runs are reference only. */}
        {reviewed && !removed ? (
          <RunOutput
            key={reviewed.id}
            runsPath={path}
            run={reviewed}
            documents={shownDocuments}
            reload={reloadRuns}
          />
        ) : shownText ? (
          <RunResult text={shownText} documents={shownDocuments} />
        ) : null}
        {runs.length > 0 ? (
          <RunHistoryList
            runs={runs}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onEnhance={handleEnhance}
          />
        ) : null}
      </section>
    );
  }

  const title = stepTitle(step);
  return (
    <section className="space-y-[var(--space-4)]" aria-label="Skill run">
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {draftPlainLine(step.stepId, title)}
      </p>
      <StepVersionControl
        projectId={projectId}
        stepId={step.stepId}
        hasRuns={runs.length > 0}
        onEnhance={handleEnhance}
        onSelectionChange={handleSelection}
        onVersionsLoaded={handleVersionsLoaded}
      />

      <label className="flex flex-col gap-1">
        <span className="bank-label">Model</span>
        <select
          value={model}
          onChange={(event) => setModel(event.target.value as BenchModelAlias | '')}
          className="rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <option value="">Skill default</option>
          {BENCH_MODEL_ALIASES.map((alias) => (
            <option key={alias} value={alias}>
              {modelLabel(alias)}
            </option>
          ))}
        </select>
      </label>

      {clampLine ? (
        <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">{clampLine}</p>
      ) : null}

      <SkillInputFields
        fields={fields}
        values={values}
        problems={problems}
        missing={lacking?.name ?? null}
        disabled={pending}
        onChange={setValues}
        onCommit={saveValues}
      />

      <div className="space-y-[var(--space-2)]">
        <label
          htmlFor="skill-step-instructions"
          className="block text-[length:var(--text-sm)] font-medium text-[var(--ink)]"
        >
          {INSTRUCTIONS_LABEL}
        </label>
        <textarea
          id="skill-step-instructions"
          value={instructions}
          rows={4}
          disabled={pending}
          onChange={(event) => setInstructions(event.target.value)}
          onBlur={() => void persist({ primary: instructions })}
          className="w-full rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)] text-[length:var(--text-sm)]"
        />
        <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          {fields.length === 0
            ? definition
              ? definition.inputs[0].helperText
              : stepSkillCopy(step.stepId, title).uses
            : 'Optional.'}
          {saving === 'saving'
            ? ' · Saving'
            : saving === 'saved'
              ? ' · Saved'
              : saving === 'failed'
                ? ' · Not saved'
                : ''}
        </p>
      </div>

      {looseProblems.length > 0 ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {looseProblems
            .map((problem) => (problem.name ? `${problem.name}: ${problem.message}` : problem.message))
            .join(' ')}
        </p>
      ) : null}

      <div className="flex items-center gap-[var(--space-3)]">
        <button
          type="button"
          onClick={() => void run()}
          disabled={pending || lacking !== null}
          className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--ink-tertiary)] disabled:opacity-50"
        >
          {draftActionLabel(step.stepId, title)}
        </button>
        {pending ? (
          <>
            <span className="font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              running {elapsedLabel(elapsed)}
            </span>
            <button
              type="button"
              onClick={() => {
                cancelled.current = true;
                abort.current?.abort();
              }}
              className="text-[length:var(--text-xs)] underline"
            >
              Cancel
            </button>
          </>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {error}
        </p>
      ) : null}

      {streamed === null && selected ? (
        <RunInputsSummary run={selected} options={listedOptions} />
      ) : null}

      {reviewed ? (
        <RunOutput
          key={reviewed.id}
          runsPath={path}
          run={reviewed}
          documents={shownDocuments}
          reload={reloadRuns}
          onTeach={onEnhance && canTeach ? () => handleEnhance(reviewed.id, true) : undefined}
        />
      ) : shownText ? (
        <RunResult text={shownText} documents={shownDocuments} />
      ) : null}

      {runs.length > 0 ? (
        <RunHistoryList
          runs={runs}
          selectedId={selectedId}
          onSelect={selectRun}
          onEnhance={handleEnhance}
        />
      ) : null}
    </section>
  );
}

export default SkillStepRunner;
