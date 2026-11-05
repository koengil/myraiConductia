'use client';

import * as React from 'react';
import Link from 'next/link';

import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import { useFlag } from '@/lib/flags/FlagsContext';
import { navUserFromProfile, showDiscoveryNav } from '@/lib/navigation/navPolicy';
import type { PerspectiveId } from '@/lib/perspective/access';
import { settingsHref } from '@/lib/settings/href';

// The fields this banner reads from /api/v1/discovery/mailbox-consent and /api/v1/discovery/google-mailbox.
// Declared here, like the Settings › Mail card: a component imports nothing from src/lib/discovery.
type ConsentStatus = { eligible?: boolean; consented?: boolean };
type GoogleStatus = { connected: boolean; delegationRefused?: boolean; state?: string | null };
type Nudge = 'connect' | 'refused' | null;

async function readJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url);
  return res.ok ? ((await res.json()) as T) : null;
}

/**
 * Which nudge, if any. The opt-in on Settings › Mail is the connect step, so a banker the card would not offer it to
 * (not eligible, or already consented, on any provider) is never asked to connect. Only a consented banker's
 * Google source can carry a refusal; a switch-off or halt beats a lingering delegation error, as on the card,
 * since the member's step is done and the card names the firm admin's.
 */
async function readNudge(): Promise<Nudge> {
  const consent = await readJson<ConsentStatus>('/api/v1/discovery/mailbox-consent');
  if (!consent) return null;
  if (consent.consented !== true) return consent.eligible === true ? 'connect' : null;
  const google = await readJson<GoogleStatus>('/api/v1/discovery/google-mailbox');
  if (google?.connected !== true) return null;
  const readerOff = google.state === 'switched_off' || google.state === 'halted';
  const refused = google.state === 'delegation_broken' || (google.delegationRefused === true && !readerOff);
  return refused ? 'refused' : null;
}

// The Deal discovery card on Settings › Mail carries the id.
export const CONNECT_GMAIL_HREF = `${settingsHref('mail')}#deal-discovery`;

const COPY = {
  title: 'Connect your work email',
  connect: 'Conductia finds your deals in your mailbox. Connect it to start the first sync.',
  refused: "Your firm's IT admin has not granted access to your mailbox.",
  action: 'Connect work email',
  // The member has consented; the card names the admin's step, so the button opens it rather than promising a connect.
  refusedAction: 'See what to do',
};

/**
 * Project picker nudge (#341): an eligible bank-side banker who has not opted in, or whose firm's Google admin
 * refused the delegation, is pointed at the Deal discovery card on Settings › Mail. Same visibility as the Discovery
 * nav row. Nothing renders while the status loads or when it cannot be read, so a connected banker sees no flash.
 */
export function ConnectGmailBanner({ perspective, className }: { perspective: PerspectiveId; className?: string }) {
  const { state } = useCurrentUser();
  const enabled = useFlag('deal_discovery');
  const navUser = state.status === 'ready' ? navUserFromProfile(state.data.user) : null;
  const visible = showDiscoveryNav(navUser, perspective, enabled);
  const [nudge, setNudge] = React.useState<Nudge>(null);

  React.useEffect(() => {
    if (!visible) return;
    let live = true;
    void (async () => {
      try {
        const next = await readNudge();
        if (live) setNudge(next);
      } catch {
        // No banner is the safe reading of a status that cannot be loaded.
      }
    })();
    return () => {
      live = false;
    };
  }, [visible]);

  if (!visible || !nudge) return null;

  return (
    <div
      role="status"
      aria-label={COPY.title}
      className={`flex flex-wrap items-center justify-between gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface-raised)] px-[var(--space-4)] py-[var(--space-3)] ${className ?? ''}`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">{COPY.title}</p>
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          {nudge === 'refused' ? COPY.refused : COPY.connect}
        </p>
      </div>
      <Link
        href={CONNECT_GMAIL_HREF}
        className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors duration-150 hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
      >
        {nudge === 'refused' ? COPY.refusedAction : COPY.action}
      </Link>
    </div>
  );
}
