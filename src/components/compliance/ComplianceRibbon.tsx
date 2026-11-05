'use client';

import * as React from 'react';
import { motion, useReducedMotion, type Transition } from 'framer-motion';
import { useSession } from '../../lib/session/store';
import type { ComplianceStatus } from '../../lib/api/types';

/*
 * THE COMPLIANCE INSTRUMENT (design spec §4 "The Compliance Instrument").
 *
 * The ribbon is no longer a gray browser bar — it is a precise, live status
 * instrument integrated INTO the AppHeader chrome: a state "crystal" (color +
 * glyph per state) + FINRA / MNPI / KYC micro-indicators + the scanning
 * sweep. The Skill-Transform Stream visibly terminates here. Compliance is
 * the architecture, felt (strategy-and-moat.md §1; product-principles.md §3).
 *
 * Compliance Pulse motion (docs/04-brand/motion-language.md §1, ledger §3.3)
 * — timings FROZEN, only the visual is elevated:
 *   - idle pulse:            2000ms loop, ease-in-out  (slow breathe)
 *   - scanning sweep:        800ms,       linear       (mechanical urgency)
 *   - clear / blocked snap:  300ms,       ease-out     (decisive snap)
 * `blocked` snaps red and HOLDS; it does not fade out (motion-language.md
 * line 39). prefers-reduced-motion collapses all durations to 0 and stops
 * the looping idle/scanning animations.
 *
 * STRUCTURAL-STABILITY NOTE (golden-path timing): the wrapper is ALWAYS the
 * SAME single `motion.div` element type across every status — animation
 * *values* (animate / transition) are gated on status + reduced-motion, the
 * element type is NEVER swapped. A status change therefore RECONCILES (it
 * never remounts the instrument subtree). This mirrors the prior
 * implementation's structure exactly, so the golden-path Intent boot — whose
 * `setTimeout(…,0)` clear+NEXT races a boot-list assertion and is sensitive
 * to any extra remount/scheduling on the shared render path — keeps its
 * timing margin byte-for-byte.
 *
 * CONTRACT (ledger §3.2 / §3.3 — byte-identical for the four original states;
 * a fifth state 'hold' was added in Phase B of the sandbox merge per ADR-0003;
 * the logged lockstep edit is recorded in the sandbox-merge ledger):
 *   - the element carrying data-compliance-status has role="status",
 *     aria-live="polite", aria-label `Compliance status: ${label}`
 *   - data-compliance-status ∈ idle|scanning|clear|hold|blocked
 *   - labels VERBATIM:
 *       'Compliance monitoring active'     (idle)
 *       'Checking compliance…'             (scanning)
 *       'Compliant'                        (clear)
 *       'Hold for review'                  (hold — added Phase B / ADR-0003)
 *       'Blocked, not compliant'           (blocked)
 *   - scanning REPLACES idle (idle not in DOM while scanning)
 *   - PURE projection of state.complianceStatus — never self-dispatches
 *   - exactly ONE [data-compliance-status] element in the tree
 */
const IDLE_LOOP_S = 2; // 2000ms breathe loop
const SCAN_SWEEP_S = 0.8; // 800ms left→right sweep
const RESOLVE_S = 0.3; // 300ms decisive snap (≤400ms budget)

const RESOLVE_TRANSITION: Transition = { duration: RESOLVE_S, ease: 'easeOut' };

type StateView = {
  label: string;
  tint: string;
  fill: string;
  ring: string;
  /** Prebuilt glyph node — like the prior implementation, the icon is a
   *  hoisted ReactNode (NOT a per-render component call) so the per-render
   *  reconciliation node count matches the prior ribbon exactly and the
   *  golden-path Intent-boot timing margin is preserved. */
  icon: React.ReactNode;
};

const DOT_ICON = (color: string) => (
  <span
    aria-hidden="true"
    className="inline-block h-[6px] w-[6px] rounded-full"
    style={{ background: color }}
  />
);

// Phase G of the sandbox merge (2026-05-20). The idle dot carries a
// pulse-halo "compliance is alive" heartbeat — port of sandbox
// app-pill-dot. Implemented via the .compliance-idle-dot CSS class in
// globals.css (keyframes + reduced-motion media query); hoisted as a
// ReactNode like the other icons so the per-render reconciliation node
// count stays uniform.
const IDLE_DOT_ICON = (
  <span
    aria-hidden="true"
    className="compliance-idle-dot inline-block h-[6px] w-[6px] rounded-full"
  />
);

// Workbench register (kit §08): every state reads as dot + label — the
// dot-pill grammar. Hoisted ReactNodes (same pattern as before) so the
// per-render reconciliation node count stays uniform.
const SCAN_DOT_ICON = DOT_ICON('var(--sync)');
const CLEAR_DOT_ICON = DOT_ICON('var(--positive)');
const HOLD_DOT_ICON = DOT_ICON('var(--hold)');
const BLOCKED_DOT_ICON = DOT_ICON('var(--negative)');

// Workbench light chrome (kit §08): idle is a quiet white pill on a hairline;
// verdict states take SOLID pastel fills with deep-tone labels.
const VIEWS: Record<ComplianceStatus, StateView> = {
  idle: {
    label: 'Compliance monitoring active',
    tint: 'var(--ink-secondary)',
    fill: 'var(--surface)',
    ring: 'var(--stroke-strong)',
    icon: IDLE_DOT_ICON,
  },
  scanning: {
    label: 'Checking compliance…',
    tint: 'var(--ink-secondary)',
    fill: 'var(--surface-subtle)',
    ring: 'transparent',
    icon: SCAN_DOT_ICON,
  },
  clear: {
    label: 'Compliant',
    tint: 'var(--positive-deep)',
    fill: 'var(--positive-fill)',
    ring: 'transparent',
    icon: CLEAR_DOT_ICON,
  },
  hold: {
    // Added Phase B of the sandbox merge (ADR-0003). Terminal state — the
    // ribbon settles into amber, does NOT loop.
    label: 'Hold for review',
    tint: 'var(--hold-deep)',
    fill: 'var(--hold-fill)',
    ring: 'transparent',
    icon: HOLD_DOT_ICON,
  },
  blocked: {
    label: 'Blocked, not compliant',
    tint: 'var(--negative-deep)',
    fill: 'var(--negative-fill)',
    ring: 'transparent',
    icon: BLOCKED_DOT_ICON,
  },
};

// The three regulatory disciplines that are always on (experience-spine.md
// step 2; matrices.md §1). Decorative micro-indicators on the instrument —
// a single static element (hoisted; zero per-render allocation) so it never
// adds reconciliation cost on the golden-path boot render path.
const DISCIPLINE_INDICATORS = (
  <span
    aria-hidden="true"
    className="relative z-10 ml-[var(--space-1)] hidden items-center gap-[var(--space-2)] border-l border-[var(--stroke)] pl-[var(--space-2)] font-mono text-[10px] font-medium tracking-[0.08em] text-[var(--ink-tertiary)] sm:inline-flex"
  >
    <span>FINRA</span>
    <span>MNPI</span>
    <span>KYC</span>
  </span>
);

export function ComplianceRibbon() {
  const { state } = useSession();
  const status: ComplianceStatus = state.complianceStatus;
  const reduceMotion = useReducedMotion();
  const view = VIEWS[status];

  // Idle "slow breathe" — opacity loop, ease-in-out, 2000ms. Scanning is
  // driven by the sweep + crystal pulse, so the wrapper holds steady there.
  // Element TYPE never changes — only these values do (see stability note).
  const wrapperAnimate =
    !reduceMotion && status === 'idle'
      ? { opacity: [0.78, 1, 0.78] }
      : { opacity: 1 };

  const wrapperTransition: Transition =
    !reduceMotion && status === 'idle'
      ? { duration: IDLE_LOOP_S, ease: 'easeInOut', repeat: Infinity }
      : reduceMotion
        ? { duration: 0 }
        : RESOLVE_TRANSITION;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Compliance status: ${view.label}`}
      title={status === 'idle' ? view.label : undefined}
      data-compliance-status={status}
      className="inline-flex items-center"
    >
      <motion.div
        className="relative flex min-h-[30px] items-center gap-[var(--space-2)] overflow-hidden rounded-full px-[var(--space-3)] py-[var(--space-1)] font-sans"
        style={{
          background: view.fill,
          boxShadow: `inset 0 0 0 1px ${view.ring}`,
        }}
        animate={wrapperAnimate}
        transition={wrapperTransition}
      >
        {/* Scanning sweep: mechanical linear band, left → right (800ms loop)
            — where the Skill-Transform Stream visibly terminates. Mirrors
            the prior implementation's conditional exactly. */}
        {status === 'scanning' && !reduceMotion ? (
          <motion.span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 w-1/2"
            style={{
              background:
                'linear-gradient(90deg, transparent, color-mix(in srgb, var(--sync) 22%, transparent), transparent)',
            }}
            initial={{ left: '-50%' }}
            animate={{ left: '100%' }}
            transition={{
              duration: SCAN_SWEEP_S,
              ease: 'linear',
              repeat: Infinity,
            }}
          />
        ) : null}

        {/* The state crystal — the per-state dot (workbench dot-pill grammar).
            The container is transparent chrome now; it stays in the tree so the
            reconciliation node count is unchanged (golden-path timing note),
            and the idle pulse-halo keeps its breathing room. */}
        <span
          aria-hidden="true"
          className="relative z-10 inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full"
          style={{ background: 'transparent' }}
        >
          {view.icon}
        </span>

        {/* Active-state label — idle copy lives in the hover title only. */}
        {status !== 'idle' ? (
          <span
            className="relative z-10 whitespace-nowrap text-[length:var(--text-sm)] font-medium tracking-tight"
            style={{ color: view.tint }}
          >
            {view.label}
          </span>
        ) : null}

        {/* FINRA / MNPI / KYC — the disciplines, always on. Static element
            (hoisted); hidden on the tightest viewports so the label never
            truncates. */}
        {DISCIPLINE_INDICATORS}
      </motion.div>
    </div>
  );
}

export default ComplianceRibbon;
