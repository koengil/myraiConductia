'use client';

import * as React from 'react';
import { useReducedMotion } from 'framer-motion';

/**
 * Inline screening overlay for the message composer. Renders a small
 * rotating-phase status surface while a message is being screened by the
 * compliance engine.
 *
 * Ported pattern from intelibank-sandbox/components/scenes/GatewayStream.tsx
 * (Phase E of the sandbox merge, 2026-05-20). The sandbox version sat
 * outside the chat column as a centred floating overlay with a 6-second
 * artificial floor; this version sits inline next to the composer with a
 * ~1.5-second floor. The point is the same: make compliance visceral
 * (something is being read; the verdict has weight). The pattern teaches
 * the moat without being hostile.
 *
 * Reduced-motion: the phase rotation collapses to no rotation; a single
 * static label reads "Screening for MNPI and promissory language" so the
 * surface still communicates that screening is happening without scheduled
 * frames or moving content.
 *
 * Single mounted [data-compliance-status] contract: this overlay does NOT
 * carry a data-compliance-status attribute. The ribbon in the chrome owns
 * that contract. This overlay is local context for the active scan.
 */

/** The four cycling phase labels. Each implies a real compliance check. */
const THINKING_PHASES = [
  'Parsing message',
  'Scanning for MNPI markers',
  'Checking promissory language',
  'Finalizing verdict',
] as const;

/** How long each phase label is visible before rotating to the next. */
const PHASE_INTERVAL_MS = 375;

const PREVIEW_MAX_LEN = 110;

export type ScreeningOverlayProps = {
  /** Optional preview of the message being screened; truncated if long. */
  messagePreview?: string;
};

export function ScreeningOverlay({ messagePreview }: ScreeningOverlayProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const [phaseIdx, setPhaseIdx] = React.useState(0);

  React.useEffect(() => {
    if (reduceMotion) return;
    const i = setInterval(() => {
      setPhaseIdx((p) => (p + 1) % THINKING_PHASES.length);
    }, PHASE_INTERVAL_MS);
    return () => clearInterval(i);
  }, [reduceMotion]);

  // Reduced-motion: keep the surface readable without scheduling frames. A
  // single static line communicates the screening is happening; the verdict
  // snaps when the engine resolves.
  const phaseLabel = reduceMotion
    ? 'Screening for MNPI and promissory language'
    : THINKING_PHASES[phaseIdx];

  const preview =
    messagePreview && messagePreview.length > PREVIEW_MAX_LEN
      ? `${messagePreview.slice(0, PREVIEW_MAX_LEN).trim()}…`
      : messagePreview;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Compliance screening"
      className="flex flex-col gap-[var(--space-2)] rounded-[var(--radius-card)] border border-[color-mix(in_srgb,var(--hold)_30%,transparent)] bg-[color-mix(in_srgb,var(--hold)_5%,var(--surface))] px-[var(--space-5)] py-[var(--space-3)]"
    >
      <div className="flex items-center gap-[var(--space-3)]">
        <span
          aria-hidden="true"
          className="inline-flex items-center gap-[3px]"
        >
          <span
            className="inline-block h-[5px] w-[5px] rounded-full"
            style={{ background: 'var(--hold-deep)' }}
          />
          <span
            className="inline-block h-[5px] w-[5px] rounded-full"
            style={{ background: 'var(--hold-deep)', opacity: 0.6 }}
          />
          <span
            className="inline-block h-[5px] w-[5px] rounded-full"
            style={{ background: 'var(--hold-deep)', opacity: 0.3 }}
          />
        </span>
        <span className="font-sans text-[length:var(--text-sm)] font-medium text-[var(--hold-deep)]">
          {phaseLabel}
        </span>
      </div>
      {preview ? (
        <p className="font-mono text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-secondary)]">
          &ldquo;{preview}&rdquo;
        </p>
      ) : null}
      <p className="font-sans text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
        Compliance gateway · screening MNPI and promissory language
      </p>
    </div>
  );
}

export default ScreeningOverlay;
