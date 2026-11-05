import {
  FolderLock,
  FolderOpen,
  Mail,
  ScrollText,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

import {
  canAccessDestination,
  type DestinationId,
  type PerspectiveId,
} from '@/lib/perspective/access';
import { DESTINATION_TITLES } from '@/lib/perspective/destinationTitles';
import { showRailsNav } from '@/lib/navigation/navPolicy';
import type { NavBadgeDestination } from '@/lib/notifications/navBadges';

/** A per-deal destination that resolves to the active deal id. */
export type PerDealItem = {
  id: DestinationId;
  suffix: string;
  label: string;
  icon: LucideIcon;
};

/** Rails is first, the execution surface at /rail. Bank side only (showRailsNav). */
export const RAILS_NAV_ITEM: PerDealItem = {
  id: 'rail',
  suffix: '/rail',
  label: DESTINATION_TITLES.rail,
  icon: Workflow,
};

/** The per-deal destinations that live in the shell nav (they resolve to
 *  whichever deal is open). Ask /chat is not in the MVP.
 *
 *  2026-07-09 refinements:
 *    - General company research lives on the global "Companies" search — it is
 *      not deal-scoped.
 *    - Deal Folder (internal work product) and Data Room (client documents) are
 *      distinct rows at the same level as the other per-deal destinations. */
export const PER_DEAL_NAV_REST: ReadonlyArray<PerDealItem> = [
  { id: 'team', suffix: '/team', label: DESTINATION_TITLES.team, icon: Users },
  // The compliance email client — pre-send screening made operational.
  { id: 'mail', suffix: '/mail', label: DESTINATION_TITLES.mail, icon: Mail },
  { id: 'dealFolder', suffix: '/deal-folder', label: DESTINATION_TITLES.dealFolder, icon: FolderLock },
  { id: 'dataRoom', suffix: '/data-room', label: DESTINATION_TITLES.dataRoom, icon: FolderOpen },
  { id: 'audit', suffix: '/audit', label: DESTINATION_TITLES.audit, icon: ScrollText },
];

/** Per-deal nav items that carry a notification count badge (nav badges map). */
export const NAV_BADGE_FOR: Partial<Record<DestinationId, NavBadgeDestination>> = {
  rail: 'rails',
  team: 'team',
  mail: 'mail',
};

const NONE: ReadonlySet<DestinationId> = new Set();

/** Hidden set that drops the Data Room row (deal_data_room_nav off). */
export const DATA_ROOM_HIDDEN: ReadonlySet<DestinationId> = new Set<DestinationId>(['dataRoom']);

/**
 * Merge the Data Room omission into a caller's own hidden set. Returns `base`
 * unchanged when the row should show, so the common path allocates nothing.
 */
export function withDataRoomHidden(
  base: ReadonlySet<DestinationId>,
  showDataRoom: boolean,
): ReadonlySet<DestinationId> {
  return showDataRoom ? base : new Set<DestinationId>([...base, ...DATA_ROOM_HIDDEN]);
}

export function perDealNavItems(
  perspective: PerspectiveId,
  hidden: ReadonlySet<DestinationId> = NONE,
): PerDealItem[] {
  return [
    ...(showRailsNav(perspective) ? [RAILS_NAV_ITEM] : []),
    ...PER_DEAL_NAV_REST.filter(
      ({ id }) => canAccessDestination(perspective, id) && !hidden.has(id),
    ),
  ];
}
