'use client';

import * as React from 'react';

import { Button } from '@/components/atoms';
import { formatUsd } from '@/components/audit/AiSpendPanel';

/**
 * The firm's monthly AI budget per banker (D83), on the AI Costs page. Every
 * reader of the page sees the limit; a CCO or admin also gets the form. The
 * card renders nothing when the API refuses the caller, like the spend panel.
 */
type Budget = { monthlyLimitUsd: number | null; canEdit: boolean };

export function AiBudgetCard() {
  const [budget, setBudget] = React.useState<Budget | 'unavailable' | null>(null);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reads the stored limit. Also run after a failed save: the API can answer an
  // error after the limit was written (its audit row failed), and the card must
  // show what is stored, not what was typed.
  const load = React.useCallback(async (isCancelled: () => boolean = () => false) => {
    try {
      const res = await fetch('/api/v1/ai-budget', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        if (!isCancelled()) setBudget('unavailable');
        return;
      }
      const body = (await res.json()) as Budget;
      if (!isCancelled()) {
        setBudget(body);
        setDraft(body.monthlyLimitUsd == null ? '' : String(body.monthlyLimitUsd));
      }
    } catch {
      if (!isCancelled()) setBudget('unavailable');
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

  if (budget === null || budget === 'unavailable') return null;

  async function save(monthlyLimitUsd: number | null) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/ai-budget', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ monthlyLimitUsd }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'The budget could not be saved');
        if (res.status >= 500) await load();
        return;
      }
      const body = (await res.json()) as Budget;
      setBudget(body);
      setDraft(body.monthlyLimitUsd == null ? '' : String(body.monthlyLimitUsd));
    } catch {
      setError('The budget could not be saved');
    } finally {
      setBusy(false);
    }
  }

  const parsed = draft.trim() === '' ? NaN : Number(draft);
  const valid = Number.isFinite(parsed) && parsed > 0;
  const limit = budget.monthlyLimitUsd;

  return (
    <section
      aria-label="Monthly AI budget per banker"
      className="mt-[var(--space-4)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-4)] py-[var(--space-3)]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--space-3)] font-sans text-[length:var(--text-sm)] text-[var(--ink)]">
        <span className="bank-label">Monthly AI budget per banker</span>
        <span className="font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          {limit == null ? 'No budget set' : formatUsd(limit)}
        </span>
      </div>
      <p className="mt-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        Each banker and the firm&apos;s CCO and admins are alerted when a banker reaches 80% and 100% of it in a calendar
        month (UTC). AI keeps working past the limit.
      </p>
      {budget.canEdit ? (
        <form
          className="mt-[var(--space-3)] flex flex-wrap items-center gap-[var(--space-2)]"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void save(parsed);
          }}
        >
          <label htmlFor="aiBudgetLimit" className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            Limit in USD
          </label>
          <input
            id="aiBudgetLimit"
            name="monthlyLimitUsd"
            type="number"
            min={0.01}
            step={0.01}
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-32 rounded-[var(--radius-button)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[8px] font-mono text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          />
          <Button type="submit" size="sm" disabled={busy || !valid}>
            Save budget
          </Button>
          {limit != null ? (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void save(null)}>
              Remove budget
            </Button>
          ) : null}
          {error ? (
            <p role="alert" className="basis-full text-[length:var(--text-xs)] text-[var(--negative,red)]">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
