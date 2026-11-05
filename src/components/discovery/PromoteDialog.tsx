'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { EntryStepSelect } from '@/components/deals/EntryStepSelect';
import type { CandidateParty } from '@/lib/discovery/api';
import type { Origin } from '@/lib/discovery/origin';
import { stashGate0Receipt } from '@/lib/deals/gate0Receipt';
import { DEALS_EVENT } from '@/lib/rail/deals';
import { MVP_DEAL_RAIL, orderedSteps } from '@/lib/rail/dealRail';
import { Dialog } from '@/components/overlay';

import { FIELD_CLASS } from './CorrectionDialog';

/**
 * T11 (b), owner decision 2026-10-22: the code name and the target start
 * pre-filled from discovery's guesses, and stay editable. The MD's submit is the
 * explicit pick that makes them banker-entered. Setting this to false returns
 * to typed fields, with the guesses shown beside them and never copied in.
 */
export const PREFILL_PROMOTION_FROM_CANDIDATE = true;

/** Local calendar date as YYYY-MM-DD (never UTC, so a morning east of UTC is not yesterday). */
function localDateIso(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type PromoteResponse = {
  deal?: { code?: string };
  notified?: Array<{ userId: string; at: string }>;
  screening?: { verdict?: 'compliant' | 'hold' | 'blocked' };
  error?: string;
};

/**
 * Promote a proposed deal into a mandate. It posts to the Gate 0 route, which
 * runs the same mask, conflicts attestation and MNPI screen as the wizard, so
 * the dialog asks for the same things: a code name, the target, the step the
 * mandate enters at, and who approved conflicts and when. No member picker: the
 * MD is seated by Gate 0 and members join through Team afterwards.
 */
export function PromoteDialog({
  candidateId,
  guessedName,
  guessedCodename,
  parties,
  defaultStepId,
  origin,
  onClose,
}: {
  candidateId: string;
  /** The candidate's proposed name, shown as what discovery suggests. */
  guessedName: string;
  guessedCodename: string | null;
  parties: CandidateParty[];
  /**
   * Where the step select starts. On a rules-found deal: the MD's override, else the evidence's suggestion, else the
   * first step. On a model-origin deal (G-02b R10): only the MD's own override, else nothing, so the select starts
   * unpicked and the MD chooses the starting step. The caller never passes a machine step for a model-origin deal.
   */
  defaultStepId: string | null;
  /**
   * Whether the model found this deal. Only an explicit 'rules' starts at a machine step; 'model_proposal' and an
   * absent origin both start at the MD's own override or unpicked (fail closed).
   */
  origin?: Origin;
  onClose: () => void;
}) {
  const router = useRouter();
  // Seq 0 is Gate 0's own notice step, which the promotion performs itself: it is never an entry step.
  const steps = React.useMemo(() => orderedSteps(MVP_DEAL_RAIL).filter((s) => s.seq >= 1), []);
  const modelOrigin = origin !== 'rules';
  const initialSeq: number | null =
    steps.find((s) => s.id === defaultStepId)?.seq ?? (modelOrigin ? null : (steps[0]?.seq ?? 1));
  const [codename, setCodename] = React.useState(PREFILL_PROMOTION_FROM_CANDIDATE ? (guessedCodename ?? guessedName) : '');
  const [targetName, setTargetName] = React.useState(
    PREFILL_PROMOTION_FROM_CANDIDATE ? (parties[0]?.name ?? '') : '',
  );
  const [entrySeq, setEntrySeq] = React.useState<number | null>(initialSeq);
  const [approver, setApprover] = React.useState('');
  const [approvedOn, setApprovedOn] = React.useState(() => localDateIso());
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const submittingRef = React.useRef(false);

  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(approvedOn) && approvedOn <= localDateIso();
  const canSubmit =
    entrySeq !== null &&
    codename.trim().length > 0 &&
    targetName.trim().length > 0 &&
    approver.trim().length > 0 &&
    dateValid &&
    !submitting;

  const submit = React.useCallback(async () => {
    if (submittingRef.current || !canSubmit) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/deals/from-discovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          candidateId,
          codename: codename.trim(),
          targetName: targetName.trim(),
          entryStepSeq: entrySeq,
          conflictsAttestation: { approvedBy: approver.trim(), approvedOn },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as PromoteResponse;
      if (!res.ok || !data.deal?.code) {
        setError(data.error ?? 'The mandate could not be opened');
        return;
      }
      // The same honest receipt Gate 0 leaves, read once on the rail landing.
      stashGate0Receipt(data.deal.code, {
        verdict: data.screening?.verdict ?? 'compliant',
        recipients: data.notified?.length ?? 0,
        at: data.notified?.[0]?.at ?? null,
        origin: 'discovery',
      });
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(DEALS_EVENT));
      router.push(`/projects/${encodeURIComponent(data.deal.code)}/rail?new=1`);
    } catch {
      setError('The mandate could not be opened');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [approvedOn, approver, candidateId, canSubmit, codename, entrySeq, router, targetName]);

  const suggests = [guessedCodename ?? guessedName, ...parties.map((p) => p.name)].filter(Boolean);

  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow="Promote to mandate · Gate 0"
      title="Open the mandate"
      description="The same controls as a new mandate: code name check, conflicts approval and the compliance screen. The rail opens at the step you choose."
      dismissOnScrim={false}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--ink-tertiary)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Open mandate
          </button>
        </>
      }
    >
      {suggests.length > 0 ? (
        <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          Discovery suggests {suggests.join(', ')}.
        </p>
      ) : null}

      <label className="mt-[var(--space-3)] block">
        <span className="bank-label">Code name</span>
        <input
          aria-label="Code name"
          value={codename}
          onChange={(e) => setCodename(e.target.value)}
          maxLength={120}
          className={FIELD_CLASS}
        />
      </label>
      <label className="mt-[var(--space-3)] block">
        <span className="bank-label">Target name</span>
        <input
          aria-label="Target name"
          value={targetName}
          onChange={(e) => setTargetName(e.target.value)}
          maxLength={120}
          className={FIELD_CLASS}
        />
      </label>
      <div className="mt-[var(--space-3)]">
        <EntryStepSelect
          steps={steps}
          value={entrySeq}
          onChange={setEntrySeq}
          placeholder={modelOrigin ? 'Choose a step' : undefined}
        />
      </div>
      <div className="mt-[var(--space-3)] grid grid-cols-[1fr_auto] gap-[var(--space-3)]">
        <label className="block">
          <span className="bank-label">Conflicts approved by</span>
          <input
            aria-label="Conflicts approved by"
            value={approver}
            onChange={(e) => setApprover(e.target.value)}
            maxLength={120}
            className={FIELD_CLASS}
          />
        </label>
        <label className="block">
          <span className="bank-label">Approved on</span>
          <input
            aria-label="Approved on"
            type="date"
            value={approvedOn}
            max={localDateIso()}
            onChange={(e) => setApprovedOn(e.target.value)}
            className={FIELD_CLASS}
          />
        </label>
      </div>

      {error ? (
        <p role="alert" className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

export default PromoteDialog;
