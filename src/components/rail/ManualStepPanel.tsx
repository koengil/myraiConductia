'use client';

import * as React from 'react';

import { useFlag } from '@/lib/flags/FlagsContext';
import { logAudit } from '@/lib/audit/store';
import { useActiveDeal } from '@/lib/deals/useDeals';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import {
  manualStepDef,
  optionLabel,
  optionValue,
  type ManualFieldDef,
} from '@/lib/rail/manualStepDefs';
import { STEP_WORK_EVENT } from '@/lib/ignatious/stepSkillIo';
import { catalogFor } from '@/lib/rail/projectRail';
import { StepOwnerControl } from './StepOwnerControl';
import {
  COMPLETE_CURRENT_FIRST,
  SEAT_CANNOT_ACT,
  SEAT_CANNOT_SAVE,
  assignedElsewhereCopy,
} from './stepActionCopy';
import { PersonCombobox } from '@/components/people/PersonCombobox';
import {
  appendFilingDestination,
  DealFolderDestinationSelect,
  DEFAULT_DESTINATION_KEY,
} from '@/components/dataroom/DealFolderDestinationSelect';

type StepPermissions = {
  isMd: boolean;
  canAssign: boolean;
  canComplete: boolean;
  canEditWork: boolean;
};

type StepState = {
  stepId: string;
  status: string;
  assignedTo: string | null;
  assignedToName: string | null;
  work: Record<string, unknown>;
  /** The row version this panel's work is based on (#200); undefined when unknown. */
  updatedAt?: string;
};

export interface ManualStepPanelProps {
  dealId: string;
  stepId: string;
  /** The step's name, for the Assign dialog. */
  stepTitle?: string;
  /** Parent marks the rail cursor complete after server completion. */
  onCompleted?: (currentStepId: string | null) => void;
  /** After an assignment: the board's own owner read refreshes from here. */
  onAssigned?: () => void;
  /** The id of the visible reason Mark step complete gives, so the parent's Skip can point at it. */
  completeReasonId?: string;
  /**
   * True while that reason shows: the seat cannot complete (and so cannot
   * skip; the server refuses both on the same capability). False otherwise.
   */
  onCompleteBlockedChange?: (blocked: boolean) => void;
}

/**
 * ManualStepPanel — assignable, auditable manual work surface for rail steps
 * 9–17 (and extensible to others). Persists via PATCH /api/v1/deals/.../steps/...
 */
export function ManualStepPanel({
  dealId,
  stepId,
  stepTitle,
  onCompleted,
  onAssigned,
  completeReasonId: sharedCompleteReasonId,
  onCompleteBlockedChange,
}: ManualStepPanelProps) {
  const def = manualStepDef(stepId);
  const deal = useActiveDeal(dealId);
  const apiEnabled = useFlag('gate0_api_create');

  const [loading, setLoading] = React.useState(apiEnabled);
  const [error, setError] = React.useState<string | null>(null);
  const [permissions, setPermissions] = React.useState<StepPermissions | null>(null);
  const [step, setStep] = React.useState<StepState | null>(null);
  const [work, setWork] = React.useState<Record<string, unknown>>({});
  const [saving, setSaving] = React.useState(false);
  const [completing, setCompleting] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [destination, setDestination] = React.useState(DEFAULT_DESTINATION_KEY);
  const ownCompleteReasonId = React.useId();
  const completeReasonId = sharedCompleteReasonId ?? ownCompleteReasonId;
  const { state: userState } = useCurrentUser();
  const meId = userState.status === 'ready' ? (userState.data.user?.id ?? null) : null;
  const saveReasonId = React.useId();
  const doneLineId = React.useId();
  // Mark step complete's reason renders for an open step this seat cannot
  // complete; the parent's Skip follows it.
  const completeBlocked =
    Boolean(def) &&
    apiEnabled &&
    !loading &&
    permissions !== null &&
    !permissions.canComplete &&
    step !== null &&
    step.status !== 'complete';
  React.useEffect(() => {
    onCompleteBlockedChange?.(completeBlocked);
  }, [completeBlocked, onCompleteBlockedChange]);

  // After an assignment: re-read the owner and the row version quietly. The
  // checklist keeps what the banker typed; only the assignment changed.
  const reloadOwner = React.useCallback(async () => {
    if (!apiEnabled) return;
    try {
      const res = await fetch(`/api/v1/deals/${encodeURIComponent(dealId)}/steps/${stepId}`, {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`step: ${res.status}`);
      const body = (await res.json()) as { step: StepState; permissions: StepPermissions };
      setStep(body.step);
      setPermissions(body.permissions ?? null);
    } catch {
      setError('The new owner could not be read. Reload to see it.');
    }
  }, [apiEnabled, dealId, stepId]);

  React.useEffect(() => {
    if (!apiEnabled) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/v1/deals/${encodeURIComponent(dealId)}/steps/${stepId}`, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`step: ${res.status}`);
        const body = (await res.json()) as {
          step: StepState;
            permissions: StepPermissions;
        };
        if (cancelled) return;
        setStep(body.step);
        setWork(body.step.work ?? {});
        setPermissions(body.permissions ?? null);
      } catch {
        if (!cancelled) setError('Could not load this step. Try again shortly.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiEnabled, dealId, stepId]);

  React.useEffect(() => {
    window.dispatchEvent(
      new CustomEvent(STEP_WORK_EVENT, { detail: { dealId, stepId, work } }),
    );
  }, [dealId, stepId, work]);

  React.useEffect(() => {
    function onSkillWork(event: Event) {
      const detail = (
        event as CustomEvent<{
          dealId: string;
          stepId: string;
          work: Record<string, unknown>;
          applied?: boolean;
        }>
      ).detail;
      if (detail?.dealId !== dealId || detail.stepId !== stepId || !detail.applied) return;
      setWork(detail.work ?? {});
      // A skill run saved this work server-side at a version the panel never
      // read, so stop claiming the old one; the route falls back to its own.
      setStep((prev) => (prev ? { ...prev, updatedAt: undefined } : prev));
    }
    window.addEventListener(STEP_WORK_EVENT, onSkillWork);
    return () => window.removeEventListener(STEP_WORK_EVENT, onSkillWork);
  }, [dealId, stepId]);

  async function patchStep(body: Record<string, unknown>) {
    const res = await fetch(`/api/v1/deals/${encodeURIComponent(dealId)}/steps/${stepId}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      throw Object.assign(new Error(payload?.error ?? 'Step update failed'), { status: res.status });
    }
    const payload = (await res.json()) as { step: StepState; currentStepId: string | null };
    setStep(payload.step);
    setWork(payload.step.work ?? {});
    return payload;
  }

  async function handleSaveWork() {
    setSaving(true);
    setError(null);
    try {
      await patchStep({ work, expectedUpdatedAt: step?.updatedAt });
      logAudit('step', 'Saved step work', stepId, { deal: deal.codename });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleComplete() {
    setCompleting(true);
    setError(null);
    try {
      const saved = await patchStep({ work, complete: true, expectedUpdatedAt: step?.updatedAt });
      logAudit('step', 'Completed step', stepId, { deal: deal.codename });
      onCompleted?.(saved.currentStepId);
    } catch (err) {
      // A refusal for this seat says so plainly.
      const status = (err as { status?: number } | null)?.status;
      setError(status === 403 ? SEAT_CANNOT_ACT : err instanceof Error ? err.message : 'Complete failed');
    } finally {
      setCompleting(false);
    }
  }

  async function handleUpload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('name', file.name);
      appendFilingDestination(form, destination);
      const res = await fetch(
        `/api/v1/deals/${encodeURIComponent(dealId)}/steps/${stepId}/dataroom/upload`,
        { method: 'POST', credentials: 'include', body: form },
      );
      if (!res.ok) throw new Error('Upload failed');
      logAudit('step', 'Uploaded step artifact', file.name, {
        deal: deal.codename,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  if (!def) return null;

  if (!apiEnabled) {
    return (
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        Enable the platform API to assign, save, and complete this step on the deal record.
      </p>
    );
  }

  if (loading) {
    return (
      <p role="status" className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        Loading step…
      </p>
    );
  }

  if (error && !step) {
    return (
      <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
        {error}
      </p>
    );
  }

  const isComplete = step?.status === 'complete';
  // A colleague owns the step: that is why, not the seat.
  const saveBlockedReason =
    step?.assignedTo && step.assignedToName && step.assignedTo !== meId && !permissions?.isMd
      ? assignedElsewhereCopy(step.assignedToName)
      : SEAT_CANNOT_SAVE;
  const title = stepTitle ?? catalogFor(stepId)?.title;

  return (
    <div className="flex flex-col gap-[var(--space-4)]">
      <StepOwnerControl
        dealId={dealId}
        stepId={stepId}
        title={title ?? stepId}
        assignedToName={step?.assignedToName ?? null}
        canAssign={permissions?.canAssign === true}
        disabled={isComplete}
        onAssigned={(assigned) => {
          logAudit('step', 'Assigned step', stepId, { deal: deal.codename });
          onAssigned?.();
          // Take the owner and row version the PATCH returned, so the next
          // Save work is based on the current version; the typed checklist
          // (`work`) is left as it is. With no row returned, re-read it.
          // An owner id with no name to show is re-read, never shown as "Unassigned".
          const named = !assigned?.assignedTo || Boolean(assigned.assignedToName);
          if (assigned?.updatedAt && named) {
            setStep((prev) =>
              prev
                ? {
                    ...prev,
                    assignedTo: assigned.assignedTo,
                    assignedToName: assigned.assignedToName,
                    updatedAt: assigned.updatedAt,
                  }
                : prev,
            );
          } else {
            void reloadOwner();
          }
        }}
      />

      {/* A disabled checklist names its reason: the done line on a completed
          step, else the save reason the seat or owner gives. */}
      <fieldset
        disabled={isComplete || !permissions?.canEditWork}
        aria-describedby={isComplete ? doneLineId : permissions?.canEditWork ? undefined : saveReasonId}
        className="flex flex-col gap-[var(--space-3)] border-0 p-0"
      >
        <legend className="bank-label mb-[var(--space-2)]">Manual checklist</legend>
        {def.fields.map((field) => (
          <ManualField
            key={field.id}
            field={field}
            dealId={dealId}
            value={work[field.id]}
            onChange={(value) => setWork((prev) => ({ ...prev, [field.id]: value }))}
          />
        ))}
      </fieldset>

      {def.requiresUpload ? (
        <div className="flex flex-col gap-[var(--space-2)]">
          <span className="bank-label">{def.uploadLabel ?? 'Upload artifact'}</span>
          {def.uploadRequired ? (
            <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              Required before this step can be marked complete.
            </p>
          ) : null}
          <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            Choose where this file is filed in the Deal Folder. It stays there.
          </p>
          <DealFolderDestinationSelect
            value={destination}
            onChange={setDestination}
            disabled={isComplete || uploading}
          />
          <input
            type="file"
            aria-label={def.uploadLabel ?? 'Upload artifact'}
            disabled={isComplete || uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
            }}
            className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
          />
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {error}
        </p>
      ) : null}

      {isComplete ? (
        <p id={doneLineId} className="text-[length:var(--text-sm)] text-[var(--positive-deep)]">
          Complete on the deal record.
        </p>
      ) : (
        <div className="flex flex-wrap gap-[var(--space-2)] border-t border-[var(--stroke)] pt-[var(--space-3)]">
          <button
            type="button"
            disabled={!permissions?.canEditWork || saving}
            aria-describedby={permissions?.canEditWork ? undefined : saveReasonId}
            onClick={() => void handleSaveWork()}
            className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--ink)] disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save progress'}
          </button>
          <button
            type="button"
            disabled={!permissions?.canComplete || completing}
            aria-describedby={permissions?.canComplete ? undefined : completeReasonId}
            onClick={() => void handleComplete()}
            className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-semibold text-[var(--ink-on-dark)] disabled:opacity-50"
          >
            {completing ? 'Completing…' : 'Mark step complete'}
          </button>
          {permissions?.canEditWork ? null : (
            <p id={saveReasonId} className="w-full text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
              {saveBlockedReason}
            </p>
          )}
          {permissions?.canComplete ? null : (
            <p id={completeReasonId} className="w-full text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
              {step?.status === 'current' ? SEAT_CANNOT_ACT : COMPLETE_CURRENT_FIRST}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ManualField({
  field,
  dealId,
  value,
  onChange,
}: {
  field: ManualFieldDef;
  dealId: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (field.type === 'checkbox') {
    return (
      <label className="flex items-center gap-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)]">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="size-4 rounded border-[var(--stroke)]"
        />
        {field.label}
      </label>
    );
  }

  if (field.type === 'select') {
    const options = field.options ?? [];
    return (
      <label className="flex flex-col gap-1">
        <span className="bank-label">{field.label}</span>
        <select
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          className="rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {/* The empty option keeps the display honest: the select never shows a
              value the saved work does not hold (a rendered options[0] passed for
              chosen while validation refused the step). */}
          <option value="" disabled>
            Select…
          </option>
          {options.map((opt) => (
            <option key={optionValue(opt)} value={optionValue(opt)}>
              {optionLabel(opt)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.type === 'textarea') {
    return (
      <label className="flex flex-col gap-1">
        <span className="bank-label">{field.label}</span>
        <textarea
          rows={3}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        />
      </label>
    );
  }

  if (field.type === 'text' && field.suggest) {
    return (
      <label className="flex flex-col gap-1">
        <span className="bank-label">{field.label}</span>
        <PersonCombobox
          value={typeof value === 'string' ? value : ''}
          onChange={(next) => onChange(next)}
          mode={field.suggest}
          dealId={dealId}
          placeholder={field.placeholder}
        />
      </label>
    );
  }

  return (
    <label className="flex flex-col gap-1">
      <span className="bank-label">{field.label}</span>
      <input
        type="text"
        value={typeof value === 'string' ? value : ''}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      />
    </label>
  );
}

export default ManualStepPanel;
