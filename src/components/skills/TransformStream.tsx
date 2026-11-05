'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';

/**
 * TransformStream — the cinematic visual of the Skill-Transform Stream
 * (docs/04-brand/motion-language.md §2), extracted from Canvas so the wow
 * beat gets dedicated, art-directed effort while Canvas keeps the (byte-exact)
 * dispatch/seam contract.
 *
 * The named-motion sequence (motion-language §2):
 *   1. (skill lift — owned by SkillCard, 150ms ease-out)
 *   2. On drop: a stream of strands flows from the canvas toward the panel
 *      render zone (~700ms, ease-in-out). Data in transit.
 *   3. The stream curves UPWARD and visibly terminates off the top edge of
 *      the canvas toward the Compliance Instrument (the sticky header band —
 *      shell-owned; Canvas dispatches the `scanning` pulse, this only draws
 *      the transit). The strands converge to a single conduit at the top.
 *   4. Compliance resolves (`clear`); the stream fades.
 *   5. The panel renders (Canvas owns the 250ms fade).
 *
 * Timing contract (FROZEN — master ledger §3.3): the stream strands run
 * `STREAM_DURATION_S` at ease-in-out; the overlay container fades `0.15s`
 * ease-out with `delay: i * 0.05`. These constants live in Canvas (the single
 * source of truth that also drives the stream gate floor) and are passed in,
 * so the motion and the gate can never drift apart.
 *
 * Reduced-motion: Canvas never mounts this component on the reduced path
 * (the contract: no stream SVG, the gate collapses to `Promise.resolve()`).
 * Purely decorative — `aria-hidden`, `pointer-events-none`; it surfaces no
 * asserted string and never dispatches.
 */

export type TransformStreamProps = {
  /** Mounts the stream while a transform is mid-flight (animated path only). */
  active: boolean;
  /** FROZEN stream duration (s) — passed from Canvas (ledger §3.3). */
  durationS: number;
  /** FROZEN stream easing — passed from Canvas (ledger §3.3). */
  ease: 'easeInOut';
};

// The strands originate spread across the working area, then converge and
// curve up through the top edge toward the Compliance Instrument. Staggered
// so it reads as a stream of intelligence in transit, not a single wire.
const STRANDS = [16, 32, 50, 68, 84] as const;
const CONTAINER_FADE_S = 0.15; // overlay container fade (ledger §3.3)
const STRAND_STAGGER_S = 0.05; // per-strand delay (ledger §3.3)

export function TransformStream({
  active,
  durationS,
  ease,
}: TransformStreamProps) {
  return (
    <AnimatePresence>
      {active ? (
        <motion.div
          key="skill-transform-stream"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[2] overflow-visible"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: CONTAINER_FADE_S, ease: 'easeOut' }}
        >
          <div
            className="absolute inset-x-0 top-0 h-2/3"
            style={{
              background:
                'radial-gradient(60% 80% at 50% 0%, color-mix(in srgb, var(--accent) 16%, transparent) 0%, transparent 70%)',
            }}
          />

          <svg
            className="absolute inset-0 h-full w-full overflow-visible"
            preserveAspectRatio="none"
            viewBox="0 0 100 100"
          >
            <defs>
              <linearGradient
                id="ib-stream-strand"
                x1="0"
                y1="1"
                x2="0"
                y2="0"
              >
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.15" />
                <stop offset="55%" stopColor="var(--accent)" stopOpacity="0.9" />
                <stop offset="100%" stopColor="var(--positive)" stopOpacity="1" />
              </linearGradient>
            </defs>

            {STRANDS.map((x, i) => (
              <motion.path
                key={x}
                d={`M ${x} 86 C ${x} 54, 50 44, 50 -18`}
                fill="none"
                stroke="url(#ib-stream-strand)"
                strokeWidth={0.9}
                strokeLinecap="round"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: [0, 0.95, 0] }}
                transition={{
                  duration: durationS,
                  ease,
                  delay: i * STRAND_STAGGER_S,
                }}
              />
            ))}

            <motion.circle
              cx={50}
              cy={1}
              r={1.6}
              fill="var(--positive)"
              initial={{ opacity: 0, scale: 0 }}
              animate={{ opacity: [0, 1, 0.4], scale: [0, 1.2, 1] }}
              transition={{
                duration: durationS,
                ease,
                delay: STRANDS.length * STRAND_STAGGER_S,
              }}
              style={{ transformOrigin: '50px 1px' }}
            />
          </svg>

          <span className="absolute inset-x-0 top-[var(--space-4)] text-center font-sans text-[length:var(--text-xs)] font-medium text-[var(--positive-deep)]">
            Routing through compliance
          </span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export default TransformStream;
