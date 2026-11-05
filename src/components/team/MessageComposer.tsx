'use client';

import * as React from 'react';
import { motion, useReducedMotion, type Transition } from 'framer-motion';

import { getApi } from '@/lib/api';
import { useSession } from '@/lib/session/store';
import { Button, Badge } from '@/components/atoms';
import { CheckIcon, ShieldIcon } from '@/components/brand/icons';
import { ScreeningOverlay } from '@/components/compliance/ScreeningOverlay';

/**
 * Message composer — the compliance-theatre destination (/team), per
 * design spec §6 ComplianceTheatre. The composer is a sending instrument;
 * delivered messages settle into a real thread; non-compliant sends are
 * stopped at the gate with the live verdict reason and rewrite suggestion
 * given full weight as the moat made visible (strategy-and-moat.md §1).
 *
 * Three scripted outcomes after the Phase B sandbox merge (ADR-0003), driven
 * by getApi().sendMessage → { delivered, compliance }:
 *
 *   Clean    "Financials attached for your review."
 *            → verdict 'compliant', delivered, joins thread, ribbon 'clear'.
 *   Held     "Our internal model floors this at $510M, keep it here."
 *            → verdict 'hold' (MNPI signal), NOT delivered, NOT in thread,
 *              ribbon snaps 'hold' (ochre). The composer surfaces a hold
 *              card with the verdict reason.
 *   Risky    "I guarantee the board seat stays with the founder."
 *            → verdict 'blocked' (promissory pattern), NOT delivered, NOT in
 *              thread, ribbon snaps 'blocked' (red). The composer surfaces a
 *              blocked card with the verdict reason AND the live rewrite
 *              suggestion + an "Edit message" affordance that dismisses
 *              the verdict notice and returns compliance to idle so the
 *              MD can revise the body manually using the hint as guidance.
 *
 * Per-recipient thread persistence: the thread is OWNED by the page (a
 * recipientId → Message[] map held at /team page level so it survives
 * recipient switches). This composer is the thread's controlled view: it
 * receives the active recipient's `thread` and an `onDelivered` callback. A
 * compliant send calls `onDelivered(text)` — only delivered messages ever
 * leave the gate and join the page-owned thread. Hold/blocked verdicts are
 * stopped here, inline, and never reach `onDelivered`. The composer keys on
 * recipient id at the page, so transient per-recipient UI (in-flight body,
 * verdict notice, sending flag) resets on switch while the durable thread
 * persists in the page map.
 *
 * Why the verdict reason is inline (not on the ribbon): the frozen session
 * store carries only `complianceStatus` — no reason string. The ribbon reads
 * `state.complianceStatus` alone. Surfacing the live verdict reason here,
 * from the sendMessage result, satisfies the moat-visible contract without
 * extending the store; the reason text is never hardcoded, always
 * `compliance.reasons[0]`.
 *
 * Send is a crash/hang-proof async state machine (the Phase-4 Canvas
 * hardening lesson): SET_COMPLIANCE 'scanning' → brief Compliance-Pulse beat
 * → try (compliant → 'clear' + append; hold → 'hold' + hold card; blocked →
 * 'blocked' + blocked card) → catch (console.error, return to 'idle',
 * non-hanging notice, no rethrow) → finally (clear the sending flag so the
 * composer is never permanently disabled). Compliance is never left stuck in
 * 'scanning'.
 *
 * prefers-reduced-motion collapses the scanning beat to instant — the
 * compliance round-trip still happens, just with no transit frames.
 */

// Phase E of the sandbox merge (2026-05-20). Extended from 320ms to 1500ms
// to give the new inline ScreeningOverlay time to cycle through its four
// phase labels (4 × 375ms = 1500ms — exactly one full cycle). The sandbox
// version had a 6-second artificial floor; ledger disposition trimmed to
// ~1.5s to keep the visceral weight without being hostile. Reduced-motion
// collapses the wait entirely (the overlay shows a static label and the
// verdict snaps immediately).
const SCAN_BEAT_MS = 1500;

export type SentMessage = { id: number; body: string };

// The live verdict notice from the last hold/blocked send. Compliant sends
// clear the notice; hold/blocked sends populate it with verdict, reason
// (always compliance.reasons[0]), and optional rewrite suggestion (only
// present on promissory-pattern matches; MNPI hold has reason but no
// rewrite).
type VerdictNotice = {
  verdict: 'hold' | 'blocked';
  reason: string;
  rewrite?: string;
};

export type MessageComposerProps = {
  toId: string;
  toName?: string;
  /**
   * The active recipient's thread, owned by the /team page so it survives
   * recipient switches. Only delivered (compliant) messages ever appear here.
   */
  thread: SentMessage[];
  /**
   * Called with the cleared message body when a send passes compliance and is
   * delivered. The page appends it to this recipient's thread in the
   * page-owned map. Hold/blocked verdicts are stopped inline and never call
   * this — a non-compliant message never joins the thread.
   */
  onDelivered: (body: string) => void;
};

/**
 * Demo-insert samples — the one-click way to exercise compliance screening in
 * a live walkthrough: the clean message clears (green); the risky message is
 * held with a rewrite suggestion. FROZEN affordances (ledger §3.2): the moat
 * is the pitch, and these make it demonstrable in one click.
 */
const SAMPLE_CLEAN = 'Financials attached for your review.';
const SAMPLE_RISKY = 'I guarantee the board seat stays with the founder.';

export function MessageComposer({
  toId,
  toName,
  thread,
  onDelivered,
}: MessageComposerProps) {
  const { dispatch } = useSession();
  const reduceMotion = useReducedMotion() ?? false;

  const [body, setBody] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [verdictNotice, setVerdictNotice] =
    React.useState<VerdictNotice | null>(null);
  // A non-hanging notice if the send itself errored (system fault, NOT a
  // compliance verdict — it must never read as "blocked" or "hold").
  const [errorNotice, setErrorNotice] = React.useState(false);

  // Unmount-safe: a send in flight must not setState after teardown.
  const activeRef = React.useRef(true);
  React.useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const pulseTransition: Transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.2, ease: 'linear' };

  const handleSend = React.useCallback(async () => {
    const text = body.trim();
    if (sending || text.length === 0) return;

    setSending(true);
    setErrorNotice(false);
    setVerdictNotice(null);

    // idle → scanning. The ribbon owns the Compliance Pulse from this
    // dispatch (motion-language.md §1).
    dispatch({ type: 'SET_COMPLIANCE', status: 'scanning' });

    // Brief Compliance-Pulse beat so the scanning state is felt before the
    // verdict snaps. Reduced-motion collapses it to instant.
    if (!reduceMotion) {
      await new Promise<void>((r) => setTimeout(r, SCAN_BEAT_MS));
    }

    try {
      const { delivered, compliance } = await getApi().sendMessage({
        fromId: 'md',
        toId,
        body: text,
      });
      if (!activeRef.current) return;

      if (delivered) {
        // Compliant: ribbon ticks green, the message joins the page-owned
        // thread for this recipient, body clears. Only delivered messages
        // ever leave the gate — the page is the single owner of the thread.
        dispatch({ type: 'SET_COMPLIANCE', status: 'clear' });
        onDelivered(text);
        setBody('');
      } else if (compliance.verdict === 'hold') {
        // Held for supervisory review (MNPI signal). NOT delivered, NOT in
        // thread, body PRESERVED so the user can revise. Ribbon snaps
        // ochre. Hold rarely carries a rewrite — the verdict is "human
        // judgment required," not "say it differently."
        dispatch({ type: 'SET_COMPLIANCE', status: 'hold' });
        setVerdictNotice({
          verdict: 'hold',
          reason:
            compliance.reasons[0] ??
            'Held for supervisory review. This message contains MNPI signals and is routed to the queue, not blocked outright.',
          rewrite: compliance.rewrite,
        });
      } else {
        // Blocked, not sent, flagged. The reason and rewrite are LIVE from
        // the seam, never hardcoded. The message does NOT join the thread;
        // body PRESERVED so the user can revise or accept the rewrite.
        dispatch({ type: 'SET_COMPLIANCE', status: 'blocked' });
        setVerdictNotice({
          verdict: 'blocked',
          reason:
            compliance.reasons[0] ??
            'Blocked: this message violates communications standards. Message not sent.',
          rewrite: compliance.rewrite,
        });
      }
    } catch (err) {
      // A send fault is NOT a compliance verdict — never show 'blocked'.
      // Stand compliance back down to idle and surface a quiet, non-hanging
      // notice. Do not rethrow; the demo continues.
      console.error('[MessageComposer] sendMessage failed', { toId, err });
      if (!activeRef.current) return;
      dispatch({ type: 'SET_COMPLIANCE', status: 'idle' });
      setErrorNotice(true);
    } finally {
      // Single source of truth for the post-send reset — every path
      // (delivered, blocked, error) clears the sending flag here, exactly
      // once, so the composer is never permanently disabled and compliance is
      // never left stuck in 'scanning'.
      if (activeRef.current) setSending(false);
    }
  }, [body, sending, reduceMotion, dispatch, toId, onDelivered]);

  const recipientLabel = toName ?? 'teammate';

  return (
    <section
      aria-label={`Message ${recipientLabel}`}
      className="flex flex-col gap-[var(--space-5)]"
    >
      {/* Thread header — names the open conversation, the way a native chat
          titles the active thread. */}
      <div className="flex items-baseline justify-between gap-[var(--space-4)] border-b border-[var(--stroke)] pb-[var(--space-3)]">
        <div className="flex flex-col gap-[2px]">
          <span className="eyebrow">Conversation</span>
          <span className="font-sans text-[length:var(--text-lg)] font-semibold tracking-tight text-[var(--ink)]">
            {recipientLabel}
          </span>
        </div>
        <span className="inline-flex shrink-0 items-center gap-[var(--space-2)] rounded-[6px] bg-[var(--positive-fill)] px-[var(--space-2)] py-[var(--space-1)] text-[var(--positive-deep)]">
          <ShieldIcon size={14} className="text-[var(--positive-deep)]" />
          <span className="font-sans text-[length:var(--text-xs)] font-medium">
            Screened
          </span>
        </span>
      </div>

      {/* Thread — only delivered (compliant) messages ever appear here. */}
      {thread.length > 0 ? (
        <ul
          aria-label="Message thread"
          className="flex flex-col gap-[var(--space-3)]"
        >
          {thread.map((m) => (
            <li
              key={m.id}
              className="flex max-w-[88%] flex-col gap-[var(--space-2)] self-end rounded-[var(--radius-card)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-5)] py-[var(--space-4)]"
            >
              <p className="font-sans text-[length:var(--text-base)] leading-relaxed text-[var(--ink)]">
                {m.body}
              </p>
              <span className="flex items-center gap-[var(--space-2)] self-end">
                <CheckIcon size={14} className="text-[var(--positive)]" />
                <Badge tone="positive">Delivered</Badge>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p
          role="status"
          className="rounded-[var(--radius-card)] border border-dashed border-[var(--stroke)] bg-[var(--surface-subtle)] px-[var(--space-5)] py-[var(--space-5)] text-center font-sans text-[length:var(--text-sm)] text-[var(--ink-tertiary)]"
        >
          No messages to {recipientLabel} yet.
        </p>
      )}

      {/* Verdict card — the headline compliance proof (strategy-and-moat §1).
          One card, two visual treatments (hold = ochre, blocked = red). The
          reason and the rewrite (when present) are LIVE from the seam, never
          hardcoded. The message is never in the thread above. Given full
          editorial weight: this is the moat, visible. */}
      {verdictNotice ? (
        (() => {
          // Two visual treatments share one structure (hold = ochre,
          // blocked = red). Resolve the tone-specific class fragments once so
          // the markup below reads as a single card, not a stack of ternaries.
          const isHold = verdictNotice.verdict === 'hold';
          const v = isHold
            ? {
                ariaLabel: 'Message held for review',
                card: 'overflow-hidden rounded-[var(--radius-card)] border border-[var(--hold-fill)] bg-[var(--hold-tint)]',
                header:
                  'flex items-center gap-[var(--space-3)] border-b border-[var(--hold-fill)] px-[var(--space-5)] py-[var(--space-3)]',
                iconClass: 'shrink-0 text-[var(--hold-deep)]',
                badgeTone: 'hold' as const,
                badgeLabel: 'Hold',
                statusClass:
                  'font-sans text-[length:var(--text-xs)] font-medium text-[var(--hold-deep)]',
                statusLabel: 'Routed to supervisory review',
              }
            : {
                ariaLabel: 'Message blocked',
                card: 'overflow-hidden rounded-[var(--radius-card)] border border-[var(--negative-fill)] bg-[color-mix(in_srgb,var(--negative-fill)_30%,var(--surface))]',
                header:
                  'flex items-center gap-[var(--space-3)] border-b border-[var(--negative-fill)] px-[var(--space-5)] py-[var(--space-3)]',
                iconClass: 'shrink-0 text-[var(--negative-deep)]',
                badgeTone: 'negative' as const,
                badgeLabel: 'Blocked',
                statusClass:
                  'font-sans text-[length:var(--text-xs)] font-medium text-[var(--negative-deep)]',
                statusLabel: 'Stopped at the gate. Not sent.',
              };

          return (
            <motion.div
              role="alert"
              aria-label={v.ariaLabel}
              className={v.card}
              initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={pulseTransition}
            >
              <div className={v.header}>
                <ShieldIcon size={18} className={v.iconClass} />
                <Badge tone={v.badgeTone}>{v.badgeLabel}</Badge>
                <span className={v.statusClass}>{v.statusLabel}</span>
              </div>
              <p className="px-[var(--space-5)] py-[var(--space-3)] font-mono text-[length:var(--text-sm)] leading-snug text-[var(--ink)]">
                {verdictNotice.reason}
              </p>
              {verdictNotice.rewrite ? (
                <div className="flex flex-col gap-[var(--space-2)] border-t border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-5)] py-[var(--space-3)]">
                  <span className="font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink-tertiary)]">
                    Suggested rewrite
                  </span>
                  <p className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink)]">
                    {verdictNotice.rewrite}
                  </p>
                  <span className="self-start">
                    {/* The rewrite field carries an ACTIONABLE HINT (e.g.
                        "Replace 'guarantee' with..."), not a literal
                        replacement string. Pasting it verbatim as the message
                        body was misleading (a previous version did exactly
                        that). Instead: dismiss the verdict notice and bring
                        compliance back to idle so the MD can edit the body
                        manually with the rewrite hint visible above. */}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setVerdictNotice(null);
                        dispatch({ type: 'SET_COMPLIANCE', status: 'idle' });
                      }}
                    >
                      Edit message
                    </Button>
                  </span>
                </div>
              ) : null}
            </motion.div>
          );
        })()
      ) : null}

      {/* Send fault — distinct from a compliance verdict, non-hanging. */}
      {errorNotice ? (
        <p
          role="status"
          className="rounded-[var(--radius-input)] border border-[var(--stroke)] bg-[var(--surface-subtle)] px-[var(--space-4)] py-[var(--space-3)] font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
        >
          That message could not be sent: try again.
        </p>
      ) : null}

      {/* Inline screening overlay — Phase E sandbox merge (2026-05-20).
          Visible only while a message is in flight through the compliance
          engine. Cycles through the four screening phases at 375ms each;
          reduced-motion collapses to a static label. The ribbon in the
          chrome still owns the [data-compliance-status] contract; this
          overlay is local context for the active scan. */}
      {sending ? <ScreeningOverlay messagePreview={body.trim()} /> : null}

      <div className="flex flex-col gap-[var(--space-4)] rounded-[var(--radius-composer)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-5)] shadow-[var(--shadow-ambient)]">
        <label htmlFor="message-body" className="sr-only">
          Message body
        </label>
        <textarea
          id="message-body"
          name="message-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={sending}
          rows={3}
          aria-label="Message body"
          placeholder="Write a message…"
          className="w-full resize-none rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] font-sans text-[length:var(--text-base)] leading-relaxed text-[var(--ink)] outline-none transition-colors duration-150 placeholder:text-[var(--ink-quiet)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60"
        />

        <div className="flex flex-wrap items-center gap-[var(--space-3)] border-t border-[var(--stroke)] pt-[var(--space-4)]">
          {/* One-click demo inserts — load a clean or a risky sample so the
              compliance screening is demonstrable live without typing. The
              risky sample is the one that gets held/rewritten. */}
          <Button
            variant="ghost"
            size="sm"
            disabled={sending}
            onClick={() => setBody(SAMPLE_CLEAN)}
          >
            Clean message
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={sending}
            onClick={() => setBody(SAMPLE_RISKY)}
          >
            Risky message
          </Button>
          <span className="ml-auto">
            <Button
              variant="primary"
              size="md"
              disabled={sending || body.trim().length === 0}
              onClick={handleSend}
            >
              {sending ? (
                'Checking compliance…'
              ) : (
                <span className="inline-flex items-center gap-[var(--space-1)]">
                  <span>Send</span>
                  <span aria-hidden="true">→</span>
                </span>
              )}
            </Button>
          </span>
        </div>
      </div>
    </section>
  );
}

export default MessageComposer;
