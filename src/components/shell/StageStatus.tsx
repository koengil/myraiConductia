'use client';

import * as React from 'react';

/**
 * StageStatus — the one designed treatment for a stage's loading / error
 * moment (design spec §6 "Shell": one designed StageStatus for loading/error).
 *
 * This is a PURE PRESENTATIONAL WRAPPER. It owns the *look* of a stage's
 * transient states — a centered, art-directed editorial frame on the warm
 * working surface, never a bare gray line — but it owns NONE of the copy.
 *
 * The stage components own their status STRINGS and ARIA roles verbatim
 * (`Loading session…`, `The session could not be loaded in the sandbox.`,
 * `Scoring acquirers…`, etc. — preserved by the ledger §3.2 contract). They
 * pass that asserted node in as `children`; StageStatus only frames it. It
 * adds no role/aria of its own that could collide with the caller's
 * `role="status"` / `aria-live` — the caller still renders those on the text.
 *
 * Phase B: this component is CREATED ONLY. Stage components adopt it in
 * Phase C; nothing imports it yet in this phase, by design.
 */

export type StageStatusKind = 'loading' | 'error';

export interface StageStatusProps {
  /** Drives the accent treatment (calm for loading, negative for error). */
  kind?: StageStatusKind;
  /**
   * A short, optional eyebrow above the message (e.g. the stage name).
   * Purely decorative framing — never an asserted string.
   */
  eyebrow?: string;
  /**
   * The caller's status node — owns the asserted string + its role/aria
   * (e.g. `<p role="status">The session could not be loaded…</p>`).
   */
  children: React.ReactNode;
  className?: string;
}

export function StageStatus({
  kind = 'loading',
  eyebrow,
  children,
  className,
}: StageStatusProps) {
  const isError = kind === 'error';

  return (
    <section
      aria-hidden={false}
      className={[
        'flex min-h-[60vh] w-full flex-1 items-center justify-center',
        'px-[var(--page-pad)] py-[var(--space-12)]',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex w-full max-w-[420px] flex-col items-center gap-[var(--space-6)] text-center">
        {/* The state marker: a calm pulsing dot while loading, a steady
            negative ring on error. Decorative — the caller's text carries
            the semantics. */}
        <span
          aria-hidden="true"
          className="relative inline-flex h-10 w-10 items-center justify-center"
        >
          <span
            className={[
              'absolute inset-0 rounded-full',
              isError ? '' : 'motion-safe:animate-pulse',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{
              background: isError
                ? 'color-mix(in srgb, var(--negative) 8%, transparent)'
                : 'var(--surface-subtle)',
            }}
          />
          <span
            className={[
              'relative inline-block h-[9px] w-[9px] rounded-full',
              isError ? '' : 'motion-safe:animate-pulse',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{
              background: isError
                ? 'var(--negative-deep)'
                : 'var(--ink-quiet)',
            }}
          />
        </span>

        <div className="flex flex-col gap-[var(--space-2)]">
          {eyebrow ? (
            <span className="eyebrow" aria-hidden="true">
              {eyebrow}
            </span>
          ) : null}
          {/* The caller's asserted status node, unmodified. */}
          <div
            className="font-mono text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]"
            style={isError ? { color: 'var(--negative-deep)' } : undefined}
          >
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}

export default StageStatus;
