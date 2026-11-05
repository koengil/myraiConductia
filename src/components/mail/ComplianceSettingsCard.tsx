'use client';

import * as React from 'react';

import { Button } from '@/components/atoms';
import { MAX_QUEUED_FROM, MAX_SAMPLED_FROM, type FirmComplianceSettings } from '@/lib/compliance/firmSettings';
import { TRY_AGAIN_COPY } from '@/components/deals/DealsUnavailable';

/**
 * The firm's risk thresholds and send friction (Issue #94, Issue #95; D105),
 * in Settings › Mail for the CCO and admins. Only the CCO may change them
 * (canEdit); an admin sees them read-only. Renders nothing when the API
 * refuses the caller (401 or 403); any other failed read says so with Retry,
 * and a failed reload after a failed save keeps the card and its error on
 * screen.
 */
type Loaded = { settings: FirmComplianceSettings; isDefault: boolean; canEdit?: boolean };

const BAND_LABEL = { routine: 'Routine', sampled: 'Sampled', queued: 'Queued' } as const;
const field =
  'rounded-[var(--radius-button)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[8px] font-mono text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';

export function ComplianceSettingsCard() {
  const [loaded, setLoaded] = React.useState<Loaded | 'refused' | 'failed' | null>(null);
  const [draft, setDraft] = React.useState<FirmComplianceSettings | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  // A seat that cannot edit sees every control disabled; each names why.
  const readOnlyReasonId = React.useId();

  // Also run after a failed server save, so the card shows what is stored.
  const load = React.useCallback(async (isCancelled: () => boolean = () => false) => {
    try {
      const res = await fetch('/api/v1/compliance-settings', { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!res.ok) {
        const outcome = res.status === 401 || res.status === 403 ? 'refused' : 'failed';
        // A failed reload keeps what is on screen; only a first read can fail the card.
        if (!isCancelled()) setLoaded((prev) => (prev && typeof prev === 'object' && outcome === 'failed' ? prev : outcome));
        return;
      }
      const body = (await res.json()) as Loaded;
      if (!isCancelled()) {
        setLoaded(body);
        setDraft(body.settings);
      }
    } catch {
      if (!isCancelled()) setLoaded((prev) => (prev && typeof prev === 'object' ? prev : 'failed'));
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      await load(() => cancelled);
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (loaded === 'failed') {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-[var(--space-2)] rounded-[var(--radius-card)] bg-[var(--surface)] p-[var(--space-5)] font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)] ring-1 ring-inset ring-[var(--stroke)]"
      >
        <p>Compliance settings could not be loaded. Try again.</p>
        <Button
          size="sm"
          variant="secondary"
          aria-label="Try again loading compliance settings"
          onClick={() => {
            setLoaded(null);
            void load();
          }}
        >
          {TRY_AGAIN_COPY}
        </Button>
      </div>
    );
  }
  if (loaded === null || loaded === 'refused' || !draft) return null;

  const valid =
    Number.isInteger(draft.sampledFrom) &&
    Number.isInteger(draft.queuedFrom) &&
    draft.sampledFrom >= 1 &&
    draft.sampledFrom <= MAX_SAMPLED_FROM &&
    draft.queuedFrom <= MAX_QUEUED_FROM &&
    draft.sampledFrom <= draft.queuedFrom;
  const canEdit = loaded.canEdit === true;
  const reasonRef = canEdit ? undefined : readOnlyReasonId;

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/v1/compliance-settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'The settings could not be saved');
        if (res.status >= 500) await load();
        return;
      }
      const body = (await res.json()) as Loaded;
      setLoaded(body);
      setDraft(body.settings);
      setSaved(true);
    } catch {
      setError('The settings could not be saved');
    } finally {
      setBusy(false);
    }
  }

  const number = (key: 'sampledFrom' | 'queuedFrom') => (e: React.ChangeEvent<HTMLInputElement>) => {
    setSaved(false);
    setDraft({ ...draft, [key]: e.target.value === '' ? NaN : Number(e.target.value) });
  };

  return (
    <form
      aria-label="Firm compliance settings"
      className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-card)] bg-[var(--surface)] p-[var(--space-5)] font-sans text-[length:var(--text-sm)] text-[var(--ink)] ring-1 ring-inset ring-[var(--stroke)]"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && canEdit) void save();
      }}
    >
      <div className="flex items-baseline justify-between gap-[var(--space-3)]">
        <h3 className="text-[length:var(--text-md)] font-semibold">Firm compliance settings</h3>
        <span className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          {loaded.isDefault ? 'Conductia defaults' : 'Set by your firm'}
        </span>
      </div>
      <p className="text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-secondary)]">
        Every sent email gets a band from its risk score at send time. Queued emails come to your review queue and
        notify you; Sampled emails feed spot checks. The score itself is never stored.
      </p>

      <div className="grid grid-cols-[auto_1fr] items-center gap-x-[var(--space-3)] gap-y-[var(--space-2)]">
        <label htmlFor="queuedFrom">Queued from score</label>
        <input id="queuedFrom" name="queuedFrom" type="number" min={1} max={MAX_QUEUED_FROM} step={1} className={`${field} w-24`}
          disabled={!canEdit} aria-describedby={reasonRef} value={Number.isNaN(draft.queuedFrom) ? '' : draft.queuedFrom} onChange={number('queuedFrom')} />
        <label htmlFor="sampledFrom">Sampled from score</label>
        <input id="sampledFrom" name="sampledFrom" type="number" min={1} max={MAX_SAMPLED_FROM} step={1} className={`${field} w-24`}
          disabled={!canEdit} aria-describedby={reasonRef} value={Number.isNaN(draft.sampledFrom) ? '' : draft.sampledFrom} onChange={number('sampledFrom')} />
        <label htmlFor="uncheckedFloor">AI check did not run</label>
        <select id="uncheckedFloor" name="uncheckedFloor" className={`${field} w-56`} disabled={!canEdit} aria-describedby={reasonRef} value={draft.uncheckedFloor}
          onChange={(e) => {
            setSaved(false);
            setDraft({ ...draft, uncheckedFloor: e.target.value as FirmComplianceSettings['uncheckedFloor'] });
          }}>
          {(['routine', 'sampled', 'queued'] as const).map((band) => (
            <option key={band} value={band}>
              {band === 'routine' ? 'Band as usual' : `At least ${BAND_LABEL[band]}`}
            </option>
          ))}
        </select>
        <label htmlFor="sendFriction">Before sending</label>
        <select id="sendFriction" name="sendFriction" className={`${field} w-56`} disabled={!canEdit} aria-describedby={reasonRef} value={draft.sendFriction}
          onChange={(e) => {
            setSaved(false);
            setDraft({ ...draft, sendFriction: e.target.value as FirmComplianceSettings['sendFriction'] });
          }}>
          <option value="one_click">One click</option>
          <option value="confirm_external">Confirm external sends</option>
        </select>
      </div>
      <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
        Changes apply from the next send. Bands already given are kept.
      </p>
      {canEdit ? null : (
        <p id={readOnlyReasonId} className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          Only your firm&apos;s CCO can change these settings.
        </p>
      )}
      {canEdit ? (
      <div className="flex flex-wrap items-center gap-[var(--space-2)]">
        <Button type="submit" size="sm" disabled={busy || !valid}>
          Save settings
        </Button>
        {saved ? <span className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">Saved</span> : null}
        {!valid ? (
          <span className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
            Scores are whole numbers. Queued starts at {MAX_QUEUED_FROM} at most, Sampled at {MAX_SAMPLED_FROM} at most and at or below Queued.
          </span>
        ) : null}
      </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-[length:var(--text-xs)] text-[var(--negative,red)]">
          {error}
        </p>
      ) : null}
    </form>
  );
}
