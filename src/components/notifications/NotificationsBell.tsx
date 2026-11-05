'use client';

import * as React from 'react';
import { Bell } from 'lucide-react';

import { AccessDecideButtons } from '@/components/access/AccessDecideButtons';
import { Popover } from '@/components/overlay';
import { COUNT_BADGE_COLOURS } from '@/components/notifications/NavCountBadge';
import { useAccessInbox } from '@/lib/access/useAccessInbox';
import { NOTIFICATION_EVENT } from '@/lib/constants/notifications';
import { useNotifications, type AppNotification } from '@/lib/notifications/useNotifications';
import { notificationEventLabel } from '@/lib/notifications/eventLabels';
import { storedHrefWithDealCode } from '@/lib/notifications/navBadges';
import { notificationDetail } from '@/lib/notifications/notificationDetail';
import { relativeTime } from '@/lib/notifications/relativeTime';
import { TRY_AGAIN_COPY } from '@/components/deals/DealsUnavailable';

/**
 * NotificationsBell — the shell-wide notification surface (G17). A bell with an
 * unread badge and a dropdown listing the caller's notifications with mark-read.
 * First real surfacing of the compliance notification spine: a CCO seeing the
 * deal_created alerts the Gate 0 create fans out.
 *
 * The panel is the shared Popover (a labelled non-modal panel: Escape and an
 * outside press close it, Escape returns focus to the bell). COMPLIANCE: the
 * payload carries the deal code + code name + actor only — never the target.
 */



function NotificationRow({
  item,
  requestId,
  deciding,
  decideError,
  onMarkRead,
  onDecide,
}: {
  item: AppNotification;
  requestId: string | null;
  deciding: boolean;
  /** A refused Approve or Deny on this row. */
  decideError: string | null;
  onMarkRead: (id: string) => void;
  onDecide: (requestId: string, decision: 'approved' | 'denied') => void;
}) {
  const label = notificationEventLabel(item.event_type);
  const isAccessRequest = item.event_type === NOTIFICATION_EVENT.ACCESS_REQUESTED;
  // Opens the deal by its code, as the nav badges do; the stored link only
  // when no code resolves.
  const href = isAccessRequest ? null : storedHrefWithDealCode(item);
  // The second line: a team inbox refusal or a drift reads its own payload;
  // any other kind names the deal by its codename, never its code (the code is for the link).
  const subject = notificationDetail(item);
  const actor = item.payload?.actor;
  const unread = !item.read_at;
  return (
    <li className="flex items-start gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-2)]">
      <span
        aria-hidden="true"
        className="mt-1.5 size-1.5 shrink-0 rounded-full"
        style={{ background: unread ? 'var(--sync)' : 'transparent' }}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0">
        <span className="flex items-baseline justify-between gap-[var(--space-2)]">
          {href ? (
            <a
              href={href}
              className="line-clamp-2 min-w-0 break-words text-[length:var(--text-sm)] font-medium text-[var(--ink)] underline-offset-4 hover:underline"
            >
              {label}
            </a>
          ) : (
            <span className="line-clamp-2 min-w-0 break-words text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
              {label}
            </span>
          )}
          <span className="shrink-0 font-mono text-[10px] text-[var(--ink-tertiary)]">
            {relativeTime(item.created_at)}
          </span>
        </span>
        <span className="truncate text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          {subject}
          {actor ? ` · ${actor}` : ''}
        </span>
        {decideError ? (
          <span role="alert" className="mt-1 text-[length:var(--text-xs)] text-[var(--negative-deep)]">
            {decideError}
          </span>
        ) : null}
      </span>
      {isAccessRequest && requestId ? (
        <AccessDecideButtons
          busy={deciding}
          onApprove={() => onDecide(requestId, 'approved')}
          onDeny={() => onDecide(requestId, 'denied')}
        />
      ) : unread ? (
        <button
          type="button"
          onClick={() => onMarkRead(item.id)}
          className="shrink-0 text-[length:var(--text-xs)] font-medium text-[var(--accent-dark)] underline underline-offset-4 hover:opacity-80"
        >
          Mark read
        </button>
      ) : null}
    </li>
  );
}

export function NotificationsBell() {
  const { items, unreadCount, markRead, error, loaded, reload } = useNotifications();
  // A failed first read is not an empty feed. A failed refetch keeps
  // the last good items, so it shows them.
  const failed = Boolean(error) && !loaded;
  const inbox = useAccessInbox();

  async function decideAccess(notificationId: string, requestId: string, decision: 'approved' | 'denied') {
    const ok = await inbox.decide(requestId, decision);
    if (ok) await markRead(notificationId);
  }
  const [open, setOpen] = React.useState(false);

  // Nothing to show and nothing unread: keep the bell present but quiet.
  const badge = unreadCount > 9 ? '9+' : String(unreadCount);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Opening reads the feed again, so a notice that arrived while the page stayed open shows (#173 G-04).
        if (next && !open) void reload({ force: true });
        setOpen(next);
      }}
      label="Notifications"
      panelClassName="right-0 top-[calc(100%+6px)] w-[320px] overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] shadow-[var(--shadow-ambient)]"
      trigger={(props) => (
        <button
          type="button"
          {...props}
          aria-label={
            unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'
          }
          className="relative inline-flex size-11 items-center justify-center rounded-full text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <Bell className="size-[18px]" strokeWidth={1.75} />
          {unreadCount > 0 ? (
            <span
              aria-hidden="true"
              className={`absolute right-1 top-1 inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-4 ${COUNT_BADGE_COLOURS}`}
            >
              {badge}
            </span>
          ) : null}
        </button>
      )}
    >
      <div className="flex items-center justify-between border-b border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-2)]">
        <span className="text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
          Notifications
        </span>
        {unreadCount > 0 ? (
          <span className="font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            {unreadCount} unread
          </span>
        ) : null}
      </div>
      {failed ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-5)] text-center"
        >
          <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            Notifications could not be loaded.
          </p>
          <button
            type="button"
            onClick={() => void reload({ force: true })}
            className="text-[length:var(--text-xs)] font-medium text-[var(--accent-dark)] underline underline-offset-4 hover:opacity-80"
          >
            {TRY_AGAIN_COPY}
          </button>
        </div>
      ) : items.length === 0 ? (
        <p className="px-[var(--space-4)] py-[var(--space-5)] text-center text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
          No notifications yet.
        </p>
      ) : (
        <ul className="max-h-[360px] divide-y divide-[var(--stroke)] overflow-y-auto">
          {items.map((item) => {
            const requestIdFromPayload =
              typeof item.payload?.requestId === 'string' ? item.payload.requestId : null;
            const destinationLabel =
              typeof item.payload?.destinationLabel === 'string'
                ? item.payload.destinationLabel
                : null;
            const actor = typeof item.payload?.actor === 'string' ? item.payload.actor : null;
            const matched = inbox.match({
              requestId: requestIdFromPayload,
              destinationLabel,
              actor,
            });
            // Buttons only while the request is still pending. A payload
            // requestId survives after the decision, which is what produced
            // the 409 ("already been decided") on a second click.
            const requestId = matched?.id ?? null;
            return (
              <NotificationRow
                key={item.id}
                item={item}
                requestId={requestId}
                deciding={requestId != null && inbox.busyId === requestId}
                decideError={requestId != null ? (inbox.errors[requestId] ?? null) : null}
                onMarkRead={markRead}
                onDecide={(id, decision) => void decideAccess(item.id, id, decision)}
              />
            );
          })}
        </ul>
      )}
    </Popover>
  );
}

export default NotificationsBell;
