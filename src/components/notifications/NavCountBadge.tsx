'use client';

import * as React from 'react';
import Link from 'next/link';

import {
  badgeHref,
  destinationFor,
  type NavBadgeDestination,
} from '@/lib/notifications/navBadges';
import { useNotifications, type AppNotification } from '@/lib/notifications/useNotifications';
import { dealUuidOf, resolveActiveDeal, useDealListSource, useDeals } from '@/lib/deals/useDeals';

/**
 * The open deal, for a per-deal pill (Rails, Team, Mail): its URL segment
 * (the code) and, once the deal list has it, its database id. Notifications
 * name a deal by that id; step events also carry the code.
 */
export type DealBadgeScope = { segment: string; uuid: string | null };

/** The badge colours: ink on the page surface, at least 4.5:1 in every theme. */
export const COUNT_BADGE_COLOURS = 'bg-[var(--ink)] text-[var(--surface)]';

/** The open deal's scope for its per-deal pills; null off a deal. */
export function useDealBadgeScope(projectId: string | null): DealBadgeScope | null {
  const source = useDealListSource();
  const { deals } = useDeals();
  if (!projectId) return null;
  return { segment: projectId, uuid: dealUuidOf(resolveActiveDeal(projectId, deals, source)) };
}

export function inDealScope(n: AppNotification, scope: DealBadgeScope): boolean {
  if (n.deal_id && (n.deal_id === scope.uuid || n.deal_id === scope.segment)) return true;
  return n.payload?.code === scope.segment;
}

/**
 * The newest unread notification that belongs to a nav destination, and how
 * many there are. With a deal scope, only that deal's notifications count.
 */
export function unreadFor(
  items: readonly AppNotification[],
  destination: NavBadgeDestination,
  scope?: DealBadgeScope | null,
): { count: number; latest: AppNotification | null } {
  let count = 0;
  let latest: AppNotification | null = null;
  for (const n of items) {
    if (n.read_at || destinationFor(n.event_type) !== destination) continue;
    if (scope && !inDealScope(n, scope)) continue;
    count += 1;
    if (!latest || n.created_at > latest.created_at) latest = n;
  }
  return { count, latest };
}

/** Accessible name of a badge: the place and the count. */
export function navBadgeLabel(label: string, count: number): string {
  return `${label}: ${count} unread`;
}

/**
 * NavCountBadge — an Apple-style count on a nav item's icon. It is its own
 * link (a sibling of the nav link, never inside it): one press opens the
 * newest unread notification for that place and marks it read, so the count
 * goes down as you work through them. The parent positions it (it is
 * absolutely placed) and must be `relative`. Renders nothing at zero.
 * A per-deal pill passes `scope`, so it counts and opens only that deal's
 * items; Settings is firm-wide and passes none.
 */
export function NavCountBadge({
  destination,
  label,
  scope,
  ring = 'ring-[var(--surface-warm)]',
  className,
}: {
  destination: NavBadgeDestination;
  /** The nav item's name, used in the badge's accessible name. */
  label: string;
  scope?: DealBadgeScope | null;
  /** The ring colour: the surface the badge sits on, so the dot reads cut out. */
  ring?: string;
  /** Position classes (top/left) relative to the parent. */
  className?: string;
}) {
  const { items, markRead } = useNotifications();
  const { count, latest } = unreadFor(items, destination, scope);
  if (!latest || count === 0) return null;

  const name = navBadgeLabel(label, count);
  return (
    <Link
      href={badgeHref(latest)}
      aria-label={name}
      title={name}
      data-nav-badge={destination}
      onClick={() => void markRead(latest.id)}
      className={[
        'absolute z-10 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1',
        'font-sans text-[length:var(--text-xxs)] font-semibold leading-4 tabular-nums ring-2',
        COUNT_BADGE_COLOURS,
        // A larger invisible press area than the 16px dot.
        "before:absolute before:-inset-2 before:content-['']",
        'focus-visible:outline-none focus-visible:ring-[var(--accent)]',
        ring,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {count > 9 ? '9+' : count}
    </Link>
  );
}
