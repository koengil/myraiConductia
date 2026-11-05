'use client';

import * as React from 'react';
import { UserPlus } from 'lucide-react';

import {
  canOpenInvite,
  resendInviteRequest,
  viewerFromMe,
  type InviteScope,
  type MeBody,
  type Viewer,
} from '@/lib/team/inviteAccess';
import type { LiveRoster } from '@/lib/team/roster';
import { TRY_AGAIN_COPY } from '@/components/deals/DealsUnavailable';
import { InviteModal } from './InviteModal';

/**
 * DealInvite: the invite button plus its form, for any surface that only
 * needs to bring someone onto the deal.
 *
 * - `mode="internal"`: "Invite to deal", colleagues at your firm (Team).
 * - `mode="data-room"`: "Give data room access", people at an outside party,
 *   on the existing external seat and the same `POST /api/v1/invites` (the
 *   Data Room mounts this). No permission changes: the button shows only when
 *   the server would accept the invite, and the server checks again.
 *
 * It reads what it needs itself (GET /deals/{id}/members, /me, and the invite
 * list's answer for the permission) and renders nothing until the viewer may
 * use it. Team already holds those reads, so it uses `DealInviteButton` and
 * `InviteModal` directly instead.
 */

export const DEAL_INVITE_LABEL: Record<InviteScope, string> = {
  internal: 'Invite to deal',
  'data-room': 'Give data room access',
};

export function DealInviteButton({
  mode,
  onClick,
}: {
  mode: InviteScope;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-[6px] rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-3)] py-[7px] text-[length:var(--text-xs)] font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
    >
      <UserPlus size={14} strokeWidth={1.75} aria-hidden />
      {DEAL_INVITE_LABEL[mode]}
    </button>
  );
}

export type DealInviteProps = {
  /** The deal's code or id, as in the project URL. */
  dealId: string;
  mode: InviteScope;
  /** Called after an invite is sent or a seat granted, to refresh the host's lists. */
  onCreated?: () => void;
  /** Mail's "Give {email} data room access": opens the form in recipient mode (deal relationship required, sent as recipientAffiliation). */
  recipientEmail?: string;
  /**
   * The Mail handoff was used: the form opened with its address, or the invite
   * went out. The host clears the handoff only then, so a failed read never
   * drops it.
   */
  onRecipientConsumed?: () => void;
};

/** One of the three reads this form needs, and whether it failed. */
type ReadFailures = { members: boolean; invites: boolean; me: boolean };
const NO_FAILURES: ReadFailures = { members: false, invites: false, me: false };

export function DealInvite({ dealId, mode, onCreated, recipientEmail, onRecipientConsumed }: DealInviteProps) {
  const [roster, setRoster] = React.useState<LiveRoster | null>(null);
  const [viewer, setViewer] = React.useState<Viewer | null>(null);
  const [inviteListAllowed, setInviteListAllowed] = React.useState<boolean | null>(null);
  const [open, setOpen] = React.useState(Boolean(recipientEmail));
  const [prefill, setPrefill] = React.useState(recipientEmail);
  const [failed, setFailed] = React.useState<ReadFailures>(NO_FAILURES);
  const [attempt, setAttempt] = React.useState(0);
  const markFailed = React.useCallback(
    (read: keyof ReadFailures, value: boolean) => setFailed((prev) => (prev[read] === value ? prev : { ...prev, [read]: value })),
    [],
  );

  const loadRoster = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/deals/${dealId}/members`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        markFailed('members', true);
        return;
      }
      setRoster((await res.json()) as LiveRoster);
      markFailed('members', false);
    } catch {
      // No roster, no button: the form needs the deal's firms.
      markFailed('members', true);
    }
  }, [dealId, markFailed]);

  // /me first: the roster and the invite list are read only once the viewer
  // is known, and never for an outside viewer in data-room mode, who gets no
  // form. The roster API still returns every seat to outside
  // parties (handoff E25); this keeps the Data Room from asking for it.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      let known: Viewer | null = null;
      try {
        const res = await fetch('/api/v1/me', { headers: { Accept: 'application/json' } });
        if (!res.ok) {
          if (!cancelled) markFailed('me', true);
          return;
        }
        const body = (await res.json()) as MeBody;
        if (cancelled) return;
        known = viewerFromMe(body, dealId);
        setViewer(known);
        markFailed('me', false);
      } catch {
        // No viewer, no button, and no further reads (fails closed).
        if (!cancelled) markFailed('me', true);
        return;
      }
      if (cancelled || !known || (mode === 'data-room' && known.isExternal)) return;
      void loadRoster();
      try {
        const res = await fetch(`/api/v1/invites?dealId=${dealId}`, {
          headers: { Accept: 'application/json' },
        });
        // Only a 403 means "not allowed"; any other failure stays undecided.
        if (cancelled) return;
        setInviteListAllowed(res.ok ? true : res.status === 403 ? false : null);
        markFailed('invites', !res.ok && res.status !== 403);
      } catch {
        // Undecided: the button stays hidden.
        if (!cancelled) markFailed('invites', true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dealId, mode, loadRoster, markFailed, attempt]);

  const formShown = open && roster !== null && canOpenInvite(viewer, inviteListAllowed, mode);
  // An outside viewer never gets the data-room form, roster or not.
  const outsideDataRoom = mode === 'data-room' && viewer?.isExternal === true;
  // A Mail handoff this viewer cannot use: the line below says who acts on it.
  const managerLine =
    Boolean(recipientEmail) &&
    !canOpenInvite(viewer, inviteListAllowed, mode) &&
    viewer !== null &&
    (outsideDataRoom || (roster !== null && (viewer.isExternal || inviteListAllowed !== null)));
  // The handoff is spent once its form is on screen, or once the line says a
  // deal manager must act on it, never before.
  React.useEffect(() => {
    if ((formShown && prefill) || managerLine) onRecipientConsumed?.();
  }, [formShown, prefill, managerLine, onRecipientConsumed]);

  // A Mail handoff must not vanish because a read failed: say so,
  // and Retry runs the reads again with the address still in hand.
  if (recipientEmail && (failed.members || failed.invites || failed.me)) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        <span>The invite form could not be loaded.</span>
        <button
          type="button"
          onClick={() => {
            setFailed(NO_FAILURES);
            setAttempt((n) => n + 1);
          }}
          className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[5px] text-[length:var(--text-xs)] font-medium text-[var(--ink)] hover:bg-[var(--surface-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {TRY_AGAIN_COPY}
        </button>
      </div>
    );
  }

  // A Mail handoff that cannot open the form says why, as Team's does.
  if (managerLine) {
    return (
      <p role="status" className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        A deal manager must add this recipient to the deal.
      </p>
    );
  }
  if (outsideDataRoom || !roster || !canOpenInvite(viewer, inviteListAllowed, mode)) return null;

  return (
    <>
      <DealInviteButton mode={mode} onClick={() => setOpen(true)} />
      {open ? (
        <InviteModal
          dealId={dealId}
          roster={roster}
          viewer={viewer}
          scope={mode}
          initialRecipientEmail={prefill}
          onClose={() => {
            setOpen(false);
            setPrefill(undefined);
          }}
          onCreated={() => {
            if (prefill) onRecipientConsumed?.();
            void loadRoster();
            onCreated?.();
          }}
          onResend={resendInviteRequest}
        />
      ) : null}
    </>
  );
}

export default DealInvite;
