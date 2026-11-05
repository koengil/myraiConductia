'use client';

import * as React from 'react';

import type { SkillInputField } from '@/lib/skillRun/inputs';
import type { SkillReference } from '@/lib/skillRun/types';
import type { VersionOption } from '@/lib/skillRun/versions';
import { formatDate } from '@/lib/format/date';

export type LoadedStepVersions = {
  current: SkillReference | null;
  project: VersionOption[];
  projectUnavailableReason: string | null;
  catalog: VersionOption[];
};

export type StepVersionControlProps = {
  projectId: string;
  stepId: string;
  hasRuns: boolean;
  onEnhance: (runId: string | null) => void;
  onSelectionChange: (reference: SkillReference | null, fields: SkillInputField[]) => void;
  onVersionsLoaded: (options: VersionOption[]) => void;
};

function fieldsFor(versions: LoadedStepVersions, reference: SkillReference | null): SkillInputField[] {
  if (!reference) return [];
  const key = referenceKey(reference);
  const option = [...versions.project, ...versions.catalog].find(
    (candidate) => referenceKey(candidate.reference) === key,
  );
  return option ? option.inputs : [];
}

function versionsPath(projectId: string, stepId: string): string {
  return `/api/v1/deals/${encodeURIComponent(projectId)}/steps/${encodeURIComponent(stepId)}/skill-versions`;
}

function bindingPath(projectId: string, stepId: string): string {
  return `/api/v1/deals/${encodeURIComponent(projectId)}/steps/${encodeURIComponent(stepId)}/skill-binding`;
}

export function referenceKey(reference: SkillReference): string {
  return reference.kind === 'publication'
    ? `publication:${reference.versionId}:${reference.digest}`
    : `mount:${reference.name}:${reference.version}:${reference.digest}`;
}

function referencesEqual(a: SkillReference | null, b: SkillReference | null): boolean {
  if (!a || !b) return a === b;
  return referenceKey(a) === referenceKey(b);
}

function dateLabel(createdAt: string | null): string {
  if (!createdAt) return 'date unknown';
  return formatDate(createdAt) || 'date unknown';
}

function optionLabel(option: VersionOption): string {
  const base = `${option.label} · ${option.authorName ?? 'unknown'} · ${dateLabel(option.createdAt)}`;
  return option.available ? base : `${base} · ${option.unavailableReason ?? 'Unavailable'}`;
}

async function fetchStepVersions(
  projectId: string,
  stepId: string,
): Promise<LoadedStepVersions | null> {
  const response = await fetch(versionsPath(projectId, stepId), { credentials: 'include' });
  if (!response.ok) return null;
  return parseLoadedVersions(await response.json().catch(() => null));
}

function parseLoadedVersions(data: unknown): LoadedStepVersions | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.project) || !Array.isArray(record.catalog)) return null;
  return {
    current: (record.current as SkillReference | null | undefined) ?? null,
    project: record.project as VersionOption[],
    projectUnavailableReason: (record.projectUnavailableReason as string | null | undefined) ?? null,
    catalog: record.catalog as VersionOption[],
  };
}

function VersionOptions({ options }: { options: VersionOption[] }) {
  return (
    <>
      {options.map((option) => (
        <option
          key={referenceKey(option.reference)}
          value={referenceKey(option.reference)}
          disabled={!option.available}
        >
          {optionLabel(option)}
        </option>
      ))}
    </>
  );
}

const VERSIONS_UNAVAILABLE_TEXT = 'Skill versions are unavailable right now.';
const UNLISTED_CURRENT_LABEL = 'Bound version, no longer listed';
const UNLISTED_CURRENT_TEXT =
  'This step is bound to a version the list no longer offers. Choose a listed version to run.';
const REBIND_FAILED_TEXT = 'That version could not be set on this step.';

export function StepVersionControl({
  projectId,
  stepId,
  hasRuns,
  onEnhance,
  onSelectionChange,
  onVersionsLoaded,
}: StepVersionControlProps) {
  const [versions, setVersions] = React.useState<LoadedStepVersions | null>(null);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [selected, setSelected] = React.useState<SkillReference | null>(null);
  const [rebinding, setRebinding] = React.useState(false);
  const [rebindError, setRebindError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    fetchStepVersions(projectId, stepId)
      .then((data) => {
        if (!alive) return;
        if (!data) {
          setStatus('error');
          return;
        }
        setVersions(data);
        setSelected(data.current);
        onVersionsLoaded([...data.project, ...data.catalog]);
        onSelectionChange(data.current, fieldsFor(data, data.current));
        setStatus('ready');
      })
      .catch(() => {
        if (alive) setStatus('error');
      });
    return () => {
      alive = false;
    };
  }, [projectId, stepId, onSelectionChange, onVersionsLoaded]);

  if (status === 'error') {
    return (
      <p className="text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
        {VERSIONS_UNAVAILABLE_TEXT}
      </p>
    );
  }

  if (!versions) return null;

  const allOptions = [...versions.project, ...versions.catalog];
  const optionByKey = new Map(allOptions.map((option) => [referenceKey(option.reference), option]));
  const currentKey = versions.current ? referenceKey(versions.current) : '';
  const currentUnlisted = currentKey !== '' && !optionByKey.has(currentKey);

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const option = optionByKey.get(event.target.value);
    const next = option ? option.reference : (versions?.current ?? null);
    setSelected(next);
    onSelectionChange(next, versions ? fieldsFor(versions, next) : []);
  }

  async function applyToStep() {
    if (!selected) return;
    setRebinding(true);
    setRebindError(null);
    try {
      const response = await fetch(bindingPath(projectId, stepId), {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference: selected }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        setRebindError(typeof body?.error === 'string' ? body.error : REBIND_FAILED_TEXT);
        return;
      }
      const data = await fetchStepVersions(projectId, stepId);
      if (data) {
        setVersions(data);
        setSelected(data.current);
        onVersionsLoaded([...data.project, ...data.catalog]);
        onSelectionChange(data.current, fieldsFor(data, data.current));
      } else {
        setStatus('error');
      }
    } finally {
      setRebinding(false);
    }
  }

  const selectedKey = selected ? referenceKey(selected) : '';
  const differsFromBound = !referencesEqual(selected, versions.current);

  return (
    <div className="space-y-[var(--space-2)]">
      <label className="flex flex-col gap-1">
        <span className="bank-label">Skill version</span>
        <select
          value={selectedKey}
          onChange={handleChange}
          className="rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {currentUnlisted ? <option value={currentKey}>{UNLISTED_CURRENT_LABEL}</option> : null}
          {versions.project.length > 0 ? (
            <optgroup label="This project">
              <VersionOptions options={versions.project} />
            </optgroup>
          ) : null}
          <optgroup label="Firm catalog">
            <VersionOptions options={versions.catalog} />
          </optgroup>
        </select>
      </label>

      {currentUnlisted ? (
        <p className="text-[length:var(--text-xs)] text-[var(--negative-deep)]">
          {UNLISTED_CURRENT_TEXT}
        </p>
      ) : null}

      {versions.projectUnavailableReason ? (
        <p className="text-[length:var(--text-xs)] text-[var(--negative-deep)]">
          {versions.projectUnavailableReason}
        </p>
      ) : null}

      {rebindError ? (
        <p role="alert" className="text-[length:var(--text-xs)] text-[var(--negative-deep)]">
          {rebindError}
        </p>
      ) : null}

      {differsFromBound ? (
        <div className="flex items-center gap-[var(--space-3)]">
          <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
            This choice runs the next attempt only. The step stays bound to its current version.
          </p>
          <button
            type="button"
            onClick={() => void applyToStep()}
            disabled={rebinding}
            className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-xs)] font-medium text-[var(--ink)] hover:border-[var(--ink-tertiary)] disabled:opacity-50"
          >
            Use on this step
          </button>
        </div>
      ) : null}

      {!hasRuns ? (
        <button
          type="button"
          onClick={() => onEnhance(null)}
          className="text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] underline"
        >
          Improve this skill
        </button>
      ) : null}
    </div>
  );
}

export default StepVersionControl;
