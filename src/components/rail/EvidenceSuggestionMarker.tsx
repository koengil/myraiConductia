'use client';

import * as React from 'react';
import { AnimatePresence } from 'framer-motion';

import { Button } from '@/components/atoms/Button';
import type { EvidenceSuggestion } from '@/lib/deals/evidenceSuggestion';
import { Dialog } from '@/components/overlay';

/**
 * The rail's evidence marker (design R9): "Evidence suggests Step 47 ·
 * Signing / Announcement Prep", with the templated reason and two actions. The
 * MD accepts it through the rail's own progress route, or dismisses it with a
 * reason; a newer assessment shows it again. Nothing here moves the rail by
 * itself. It imports only the shared type, so the rail page's import closure
 * stays clear of src/lib/discovery/ (tests/agent-surfaces.test.ts).
 *
 * The Move button shows only when the server's origin is exactly 'rules'. On a deal the model found (origin
 * 'model_proposal', G-02b R10), and whenever the origin is missing, unknown or unread, the marker keeps the suggestion
 * and Dismiss but has no Move button: adopting a machine's station there needs a confirmation (slice 6 adds the
 * dialog). The MD can still move the rail by hand, which the rail's own controls do.
 */

export type MarkerStep = { stepId: string; seq: number | null; title: string; removed: boolean };

/**
 * Whether the server said the rules or the model found the deal. Spelled here, not imported, to keep the rail's import
 * closure clear of discovery. `null` is "the server did not say" (no answer, a failed read, a value this file does not
 * know): it is never read as `rules`, because only an explicit `rules` earns the one-click Move.
 */
type DealOrigin = 'model_proposal' | 'rules' | null;

type Loaded = { dealCode: string; suggestion: EvidenceSuggestion | null; origin: DealOrigin };

/** GET /api/v1/discovery/suggestions?deal=<code>; refetched when `reloads` changes. Fails closed: origin is null unless the server sent a known word. */
function useSuggestion(dealCode: string, reloads: number): { suggestion: EvidenceSuggestion | null; origin: DealOrigin } {
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/discovery/suggestions?deal=${encodeURIComponent(dealCode)}`, { headers: { Accept: 'application/json' } })
      .then(async (res): Promise<{ suggestion: EvidenceSuggestion | null; origin: DealOrigin }> => {
        if (!res.ok) return { suggestion: null, origin: null };
        const body = (await res.json()) as { suggestion?: EvidenceSuggestion | null; origin?: unknown };
        const origin: DealOrigin = body.origin === 'rules' || body.origin === 'model_proposal' ? body.origin : null;
        return { suggestion: body.suggestion ?? null, origin };
      })
      .catch((): { suggestion: EvidenceSuggestion | null; origin: DealOrigin } => ({ suggestion: null, origin: null }))
      .then(({ suggestion, origin }) => {
        if (!cancelled) setLoaded({ dealCode, suggestion, origin });
      });
    return () => {
      cancelled = true;
    };
  }, [dealCode, reloads]);
  return loaded?.dealCode === dealCode
    ? { suggestion: loaded.suggestion, origin: loaded.origin }
    : { suggestion: null, origin: null };
}

export function EvidenceSuggestionMarker({
  dealCode,
  steps,
  currentStepId,
  canDismiss,
  onMoved,
}: {
  dealCode: string;
  steps: ReadonlyArray<MarkerStep>;
  /** The step id (for example p4-s48) the rail's cursor is on, not a row id. */
  currentStepId: string | null;
  canDismiss: boolean;
  onMoved: () => void;
}) {
  const [reloads, setReloads] = React.useState(0);
  const { suggestion, origin } = useSuggestion(dealCode, reloads);
  const [error, setError] = React.useState<string | null>(null);
  const [moving, setMoving] = React.useState(false);
  const [dismissing, setDismissing] = React.useState(false);

  const active = steps.filter((s) => !s.removed);
  const idx = suggestion ? active.findIndex((s) => s.stepId === suggestion.stepId) : -1;
  // Compared by step id, never by step number: this deal's rail may have removed steps.
  if (
    !suggestion ||
    suggestion.dismissed ||
    idx < 0 ||
    suggestion.stepId === currentStepId ||
    suggestion.flags.includes('station_removed')
  ) {
    return null;
  }
  const target = active[idx];
  const nn = String(idx + 1).padStart(2, '0');
  // One-click Move only when the server explicitly said the rules found the deal. A model-origin deal has no one-click
  // adoption of a machine's station (R10; slice 6 adds a confirmation), and an origin the server did not give is treated
  // the same way: this guard fails closed.
  const offerMove = origin === 'rules';

  const move = async () => {
    if (target.seq === null || moving) return;
    setMoving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/deals/${encodeURIComponent(dealCode)}/progress`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentStepSeq: target.seq }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'The rail could not be moved');
        return;
      }
      onMoved();
      setReloads((n) => n + 1);
    } catch {
      setError('The rail could not be moved');
    } finally {
      setMoving(false);
    }
  };

  return (
    <>
      <section
        role="status"
        aria-label="Evidence suggestion"
        className="mb-[var(--space-4)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface-raised)] px-[var(--space-4)] py-[var(--space-3)]"
      >
        <p className="bank-heading text-[var(--ink)]">
          Evidence suggests Step {nn} · {target.title}
        </p>
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{suggestion.reason}</p>
        {offerMove || canDismiss ? (
          <div className="mt-[var(--space-2)] flex flex-wrap items-center gap-[var(--space-2)]">
            {offerMove ? (
              <Button size="sm" disabled={moving || target.seq === null} onClick={move}>
                Move rail to step {nn}
              </Button>
            ) : null}
            {canDismiss ? (
              <Button size="sm" variant="secondary" onClick={() => setDismissing(true)}>
                Dismiss with reason
              </Button>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--negative-deep)]">
            {error}
          </p>
        ) : null}
      </section>
      <AnimatePresence>
      {dismissing ? (
        <DismissDialog
          key="dismiss"
          dealCode={dealCode}
          assessmentId={suggestion.assessmentId}
          onClose={() => setDismissing(false)}
          onDone={() => {
            setDismissing(false);
            setReloads((n) => n + 1);
          }}
        />
      ) : null}
      </AnimatePresence>
    </>
  );
}

function DismissDialog({
  dealCode,
  assessmentId,
  onClose,
  onDone,
}: {
  dealCode: string;
  assessmentId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const submit = async () => {
    if (submitting || reason.trim().length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/discovery/suggestions/dismiss', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ dealCode, assessmentId, reason: reason.trim() }),
      });
      if (res.ok) {
        onDone();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'The suggestion could not be dismissed');
    } catch {
      setError('The suggestion could not be dismissed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow="Dismiss · logged"
      title="Dismiss this suggestion"
      description="The marker stays hidden until newer evidence arrives. The reason is kept with who dismissed it and when."
      dismissOnScrim={false}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={submitting || reason.trim().length === 0} onClick={submit}>
            Dismiss
          </Button>
        </>
      }
    >
      <label className="block">
        <span className="bank-label">Reason</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="What you know that the mail does not show."
          className="mt-1 w-full resize-none rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        />
      </label>
      {error ? (
        <p role="alert" className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

export default EvidenceSuggestionMarker;
