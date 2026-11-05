'use client';

import * as React from 'react';

import { MAIL_WARNING_OUTCOME, type MailWarningKind } from '@/lib/constants/mailWarningOutcomes';

export const WARNING_OUTCOMES_URL = '/api/v1/mail-warning-outcomes';

/**
 * Remembers which warnings a draft met (the Risk Patcher, the recipient
 * review) and, when the email goes out, reports it as sent after a warning,
 * for the anonymous count per firm and day. One report per sent draft. Fire
 * and forget: a failed report never reaches the banker.
 *
 * A draft that is discarded or left is never reported (D80, Storm at the
 * Oct 5 Weekly Build Sync: a record of an email someone was about to send is
 * a legal liability). Closing the composer only forgets the warnings.
 *
 * Only send-time warnings count. The advisory shown while typing is not
 * noted: it comes and goes with half-typed words (Guillermo's review of
 * PR #304).
 */
export function useWarningOutcomes() {
  const shown = React.useRef(new Set<MailWarningKind>());

  const settle = React.useCallback(() => {
    if (shown.current.size === 0) return;
    const body = JSON.stringify({
      outcomes: [...shown.current].map((kind) => ({ kind, outcome: MAIL_WARNING_OUTCOME.SENT_AFTER_WARNING })),
    });
    shown.current = new Set();
    try {
      void fetch(WARNING_OUTCOMES_URL, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch {
      // A count is never worth an error in front of the banker.
    }
  }, []);

  const noteWarning = React.useCallback((kind: MailWarningKind) => {
    shown.current.add(kind);
  }, []);

  /** Forgets the warnings without reporting: a discarded draft leaves no record (D80). */
  const clear = React.useCallback(() => {
    shown.current = new Set();
  }, []);

  return { noteWarning, settle, clear };
}
