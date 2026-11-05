'use client';

import * as React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  BadgeDollarSign,
  BriefcaseBusiness,
  FolderLock,
  FolderOpen,
  Layers,
  LayoutGrid,
  Mail,
  ScrollText,
  SearchCheck,
  UserPlus,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { initialsFor, useCurrentUser } from '@/lib/auth/useCurrentUser';
import { useProfilePhoto } from '@/lib/auth/useProfilePhoto';
import {
  COUNT_BADGE_COLOURS,
  NavCountBadge,
  unreadFor,
  useDealBadgeScope,
} from '@/components/notifications/NavCountBadge';
import { Menu } from '@/components/overlay';
import type { NavBadgeDestination } from '@/lib/notifications/navBadges';
import { useNotifications } from '@/lib/notifications/useNotifications';
import { NAV_BADGE_FOR } from '@/components/organisms/navigation/perDealNav';
import { useFlag } from '@/lib/flags/FlagsContext';
import {
  navUserFromProfile,
  RAIL_TEMPLATES_HREF,
  RAIL_TEMPLATES_NAV_LABEL,
  showCommandCenterNav,
  showDataRoomNav,
  showDiscoveryNav,
  showLeadsNav,
  showAiCostsNav,
  AI_COSTS_HREF,
  showRailTemplatesNav,
  showRailsNav,
  type NavUser,
} from '@/lib/navigation/navPolicy';
import { projectIdFromPath } from '@/lib/navigation/shellNav';
import {
  canAccessDestination,
  type DestinationId,
  type PerspectiveId,
} from '@/lib/perspective/access';
import { DESTINATION_TITLES } from '@/lib/perspective/destinationTitles';
import {
  SHELL_FADE_DURATION_S,
  SHELL_ITEM_STAGGER_S,
  shellTransition,
} from '@/components/_shared/motion';

/**
 * AppNav — the platform's primary navigation (design spec §10.2 / §10.7).
 *
 * Destinations follow the same off-deal / on-deal split as TopNav and the
 * Sidebar: per-deal rows (Rails, Team, Mail, Deal Folder, Data Room,
 * Audit Trail) appear only once a deal is in the URL. Off a deal the bar shows the
 * global destinations (Conductor Center, Leads, Discovery, AI Costs, Rails
 * configuration) instead of binding those rows to a default project.
 * Settings (Profile, Organization and the rest) closes the bottom bar behind
 * the person's avatar, so it is reachable on a phone in both shells. Senior
 * register: no subtitles; the only extra is the unread count on the icon of
 * Rails, Team, Mail and Settings (NavCountBadge), which opens the newest one. The per-deal destinations are perspective-filtered; Command
 * Center is the always-present home.
 *
 * Two layouts, one component:
 *   - `rail`       → the vertical sidebar variant (the primary desktop nav,
 *                    ≥md). Icon + label rows, an --accent left-edge bar
 *                    on the active destination, always on the navy chrome.
 *   - `bottom-bar` → a fixed bottom navigation bar for mobile (<md). Icon +
 *                    small label, safe-area-aware, on the light workbench
 *                    chrome (hairline top border, field-gray active pill).
 *
 * Active state: the destination whose href is the LONGEST prefix match of
 * the current pathname wins (so `/app/acquirers/...` activates Acquirers, not
 * Mandate, even though both prefixes match `/app`). The active link gets
 * `aria-current="page"` and a field-gray pill with ink text (workbench kit
 * §09 — selection is fill + ink, never a colour accent). The prior pre-G3
 * implementation used `--positive-deep` (compliance-green); compliance-green
 * is now reserved for actual compliance signals only.
 *
 * The bottom bar publishes its measured height as `--app-nav-h` on the root
 * element (labels wrap to two or three lines on a phone), which AppShell's
 * scroll surface reserves so the last rows of a page clear the bar.
 */

/** The root CSS variable AppShell pads its scroll surface with. */
const APP_NAV_HEIGHT_VAR = '--app-nav-h';

/** Keep `--app-nav-h` equal to the bar's rendered height (0 while hidden at md+). */
function usePublishedHeight(ref: React.RefObject<HTMLElement | null>, enabled: boolean) {
  React.useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty(APP_NAV_HEIGHT_VAR, `${el.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty(APP_NAV_HEIGHT_VAR);
    };
  }, [ref, enabled]);
}

/** Nav glyphs are lucide-react (workbench icon contract, HANDOVER §6 /
 *  ICON-GUIDE): 18px, strokeWidth 1.75, label always beside the icon. */

interface DestinationSpec {
  /** Path suffix appended to /projects/[projectId]. '' is the dashboard. */
  suffix: string;
  id: DestinationId;
  label: string;
  Icon: LucideIcon;
}

/** Command Center is the one global (not project-scoped) destination — the
 *  multi-deal home. Every other destination resolves under the active deal. */
type NavDestinationId =
  | DestinationId
  | 'command-center'
  | 'leads'
  | 'discovery'
  | 'ai-costs'
  | 'rail-templates';

interface Destination {
  id: NavDestinationId;
  href: string;
  label: string;
  Icon: LucideIcon;
}

/** The per-deal destinations, in editorial order — mirrors the Sidebar's IA
 *  (2026-07-09 multi-deal reframe): Rails, Deal Folder, Data Room. Titles come
 *  from DESTINATION_TITLES so this registry and the invite perimeter preview
 *  cannot drift apart.
 *  Ask /chat is not in the MVP. The multi-deal Command Center is prepended
 *  in the component as the global home. Each resolves to a path under the
 *  active /projects/[projectId] segment. */
const DESTINATION_SPECS: ReadonlyArray<DestinationSpec> = [
  { id: 'mandate', suffix: '', label: DESTINATION_TITLES.mandate, Icon: BriefcaseBusiness },
  { id: 'rail', suffix: '/rail', label: DESTINATION_TITLES.rail, Icon: Workflow },
  { id: 'team', suffix: '/team', label: DESTINATION_TITLES.team, Icon: Users },
  // The compliance email client — pre-send screening made operational.
  { id: 'mail', suffix: '/mail', label: DESTINATION_TITLES.mail, Icon: Mail },
  // The internal Deal Folder (our work product) then the external Data Room
  // (the client's documents) — two rows since the 2026-07-09 split.
  { id: 'dealFolder', suffix: '/deal-folder', label: DESTINATION_TITLES.dealFolder, Icon: FolderLock },
  { id: 'dataRoom', suffix: '/data-room', label: DESTINATION_TITLES.dataRoom, Icon: FolderOpen },
  { id: 'audit', suffix: '/audit', label: DESTINATION_TITLES.audit, Icon: ScrollText },
];

/** The multi-deal home — the login landing at /projects. Global, not
 *  project-scoped, so it always points at /projects and is never
 *  perspective-filtered. */
const COMMAND_CENTER: Destination = {
  id: 'command-center',
  href: '/projects',
  label: 'Conductor Center',
  Icon: LayoutGrid,
};

const AI_COSTS: Destination = { id: 'ai-costs', href: AI_COSTS_HREF, label: 'AI Costs', Icon: BadgeDollarSign };

/** A per-deal destination — always a real DestinationId (never the global
 *  Command Center), so it stays perspective-filterable. */
type PerDealDestination = {
  id: DestinationId;
  href: string;
  label: string;
  Icon: LucideIcon;
};

/** Build the concrete, project-scoped destinations for a given projectId. */
function destinationsFor(projectId: string): PerDealDestination[] {
  return DESTINATION_SPECS.map(({ id, suffix, label, Icon }) => ({
    id,
    href: `/projects/${projectId}${suffix}`,
    label,
    Icon,
  }));
}

/** Off-deal destinations — the same global set TopNav keeps when no deal
 *  is open. Access is decided on the destination page, not by hiding the row,
 *  except AI Costs, which is permissioned and hidden (showAiCostsNav). */
function globalDestinations(
  navUser: NavUser | null,
  perspective: PerspectiveId,
  discovery: boolean,
): Destination[] {
  const items: Destination[] = [];
  if (showCommandCenterNav(navUser)) items.push(COMMAND_CENTER);
  if (showLeadsNav(navUser)) {
    items.push({ id: 'leads', href: '/leads', label: 'Leads', Icon: UserPlus });
  }
  if (showDiscoveryNav(navUser, perspective, discovery)) {
    items.push({ id: 'discovery', href: '/discovery', label: 'Discovery', Icon: SearchCheck });
  }
  if (showAiCostsNav(navUser)) items.push(AI_COSTS);
  if (showRailTemplatesNav(navUser)) {
    items.push({
      id: 'rail-templates',
      href: RAIL_TEMPLATES_HREF,
      label: RAIL_TEMPLATES_NAV_LABEL,
      Icon: Layers,
    });
  }
  return items;
}

/** The destinations the bottom bar / rail should render for this path.
 *  Per-deal rows bind to the URL deal only — never a sandbox default. */
export function buildAppNavDestinations({
  pathname,
  perspective,
  navUser,
  dataRoomNav,
  discovery = false,
}: {
  pathname: string | null;
  perspective: PerspectiveId;
  navUser: NavUser | null;
  /** deal_data_room_nav: whether internal users keep the Data Room row. */
  dataRoomNav: boolean;
  /** deal_discovery: whether bank-side users get the Discovery row. */
  discovery?: boolean;
}): Destination[] {
  const projectId = projectIdFromPath(pathname);
  if (!projectId) return globalDestinations(navUser, perspective, discovery);
  return [
    COMMAND_CENTER,
    ...destinationsFor(projectId)
      .filter(({ id }) => canAccessDestination(perspective, id))
      // The rail is bank-internal: outside parties get no Rails row.
      .filter(({ id }) => id !== 'rail' || showRailsNav(perspective))
      .filter(({ id }) => id !== 'dataRoom' || showDataRoomNav(dataRoomNav, perspective)),
    // Permissioned and firm-wide, so it stays reachable on a deal, as it does
    // in the desktop nav.
    ...(showAiCostsNav(navUser) ? [AI_COSTS] : []),
  ];
}

/**
 * Resolve the active destination by longest-prefix match. Returns `null` when
 * none matches, so neither layout asserts an active link spuriously.
 */
function resolveActiveHref(
  pathname: string | null,
  destinations: Destination[],
): string | null {
  if (!pathname) return null;
  let bestHref: string | null = null;
  let bestLen = -1;
  for (const { href } of destinations) {
    const matches = pathname === href || pathname.startsWith(href + '/');
    if (matches && href.length > bestLen) {
      bestHref = href;
      bestLen = href.length;
    }
  }
  return bestHref;
}

/** One phone-bar entry: a destination, or Settings (drawn as the avatar). */
type BarEntry = { id: string; href: string; label: string; Icon?: LucideIcon };

const SETTINGS_ENTRY: BarEntry = { id: 'settings', href: '/settings', label: 'Settings' };

/** The phone bar shows at most this many entries; the rest sit under More. */
export const PHONE_BAR_MAX = 5;

/** Phone-bar order: what a phone reaches first, then More. */
const PHONE_ORDER_ON_DEAL = [
  'command-center',
  'rail',
  'team',
  'mail',
  'dealFolder',
  'mandate',
  'dataRoom',
  'audit',
  'ai-costs',
  'settings',
];
const PHONE_ORDER_OFF_DEAL = ['command-center', 'leads', 'discovery', 'rail-templates', 'ai-costs', 'settings'];

/** One-line names for a ~62px cell at 390; the full name stays the accessible name. */
const PHONE_SHORT_LABEL: Readonly<Record<string, string>> = {
  'command-center': 'Conductor',
  'rail-templates': 'Rails setup',
};

/**
 * Order the phone bar's entries and split them: up to PHONE_BAR_MAX in the
 * bar, the rest under More. Five or fewer show without More.
 */
export function splitPhoneBar<T extends { id: string }>(
  entries: readonly T[],
  onDeal: boolean,
): { primary: T[]; more: T[] } {
  const order = onDeal ? PHONE_ORDER_ON_DEAL : PHONE_ORDER_OFF_DEAL;
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? order.length : i;
  };
  const sorted = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry.id) - rank(b.entry.id) || a.index - b.index)
    .map(({ entry }) => entry);
  return { primary: sorted.slice(0, PHONE_BAR_MAX), more: sorted.slice(PHONE_BAR_MAX) };
}

function badgeFor(id: string): NavBadgeDestination | undefined {
  return id === 'settings' ? 'settings' : NAV_BADGE_FOR[id as DestinationId];
}

const PHONE_CELL_CLASS = [
  'group relative flex min-w-0 flex-1 flex-col items-center justify-start',
  'gap-[2px] px-[1px] py-[var(--space-2)]',
  'text-[length:var(--text-xxs)] font-medium tracking-tight',
  'transition-colors duration-150 ease-out',
  'focus-visible:outline-none focus-visible:ring-2',
  'focus-visible:ring-[var(--accent)]',
].join(' ');

const PHONE_LABEL_CLASS = 'relative w-full truncate text-center leading-[1.15]';

/** The More cell's Menu trigger fills the cell, icon on top like the others. */
const MORE_TRIGGER_CLASS = [
  'absolute! inset-0 h-auto! w-auto! items-start! rounded-none! border-0! bg-transparent!',
  'pt-[var(--space-2)] text-[var(--ink-secondary)] hover:bg-transparent! hover:text-[var(--ink)]',
  '[&_svg]:size-[18px]',
].join(' ');

/** Field-gray pill behind the active cell (workbench kit §09), gliding between cells. */
function ActivePill({ active, reduceMotion }: { active: boolean; reduceMotion: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {active ? (
        <motion.span
          aria-hidden="true"
          layoutId="bottom-nav-active-indicator"
          className="pointer-events-none absolute inset-x-[10%] inset-y-[5px] rounded-full"
          style={{ background: 'var(--surface-subtle)' }}
          transition={shellTransition(reduceMotion, SHELL_FADE_DURATION_S)}
        />
      ) : null}
    </AnimatePresence>
  );
}

function AvatarGlyph({ photoUrl, initials }: { photoUrl: string | null; initials: string }) {
  return photoUrl ? (
    <span
      aria-hidden="true"
      className="relative size-[18px] rounded-full bg-cover bg-center"
      style={{ backgroundImage: `url(${photoUrl})` }}
    />
  ) : (
    <span
      aria-hidden="true"
      className="relative inline-flex size-[18px] items-center justify-center rounded-full bg-[var(--surface-subtle)] font-mono text-[8px] font-semibold leading-none text-[var(--ink-secondary)] ring-1 ring-[var(--stroke-strong)]"
    >
      {initials}
    </span>
  );
}

export type AppNavLayout = 'bottom-bar' | 'rail';

export interface AppNavProps {
  /**
   * `rail` = the vertical sidebar (primary desktop nav, ≥md).
   * `bottom-bar` = a fixed bottom navigation bar for mobile (<md). Icons +
   * labels. Safe-area-aware.
   */
  layout?: AppNavLayout;
  /**
   * Rail variant only (2026-05-24): when true, labels are hidden and the rail
   * shows icon-only rows (the collapsed sidebar). The link's accessible name
   * is preserved via aria-label + title.
   */
  collapsed?: boolean;
  perspective?: PerspectiveId;
  className?: string;
}

export function AppNav({
  layout = 'rail',
  collapsed = false,
  perspective = 'storm',
  className,
}: AppNavProps): React.JSX.Element {
  const pathname = usePathname();
  const reduceMotion = useReducedMotion() ?? false;
  const dataRoomNav = useFlag('deal_data_room_nav');
  const discovery = useFlag('deal_discovery');
  const { state } = useCurrentUser();
  const navUser =
    state.status === 'ready'
      ? navUserFromProfile(state.data.user, state.data.company_permissions)
      : null;
  // Same off-deal / on-deal split as TopNav and the Sidebar: per-deal rows
  // only once a deal is in the URL. The prior fallback to the sandbox default
  // made Deal Rail / Deal Folder / Data Room appear on /companies and
  // /projects with no deal selected.
  const DESTINATIONS = buildAppNavDestinations({
    pathname,
    perspective,
    navUser,
    dataRoomNav,
    discovery,
  });
  const activeHref = resolveActiveHref(pathname, DESTINATIONS);
  const { photoUrl } = useProfilePhoto(state.status === 'ready' ? state.data.user.id : null);
  const initials = state.status === 'ready' ? initialsFor(state.data.user) : '';
  const settingsActive = pathname === '/settings';
  const projectId = projectIdFromPath(pathname);
  const badgeScope = useDealBadgeScope(projectId);
  const { items: notifications } = useNotifications();
  const router = useRouter();
  const barRef = React.useRef<HTMLElement | null>(null);
  usePublishedHeight(barRef, layout === 'bottom-bar');

  if (layout === 'bottom-bar') {
    const entries: BarEntry[] = [...DESTINATIONS, SETTINGS_ENTRY];
    const { primary, more } = splitPhoneBar(entries, projectId !== null);
    const isEntryActive = (entry: BarEntry) =>
      entry.id === 'settings' ? settingsActive : entry.href === activeHref;
    // Settings is not a per-deal destination, so its count has no deal scope.
    const scopeFor = (destination: NavBadgeDestination) =>
      destination === 'settings' ? null : badgeScope;
    const moreCounts = more.map((entry) => {
      const destination = badgeFor(entry.id);
      return destination ? unreadFor(notifications, destination, scopeFor(destination)).count : 0;
    });
    const moreTotal = moreCounts.reduce((sum, n) => sum + n, 0);
    const moreActive = more.some(isEntryActive);

    return (
      <nav
        ref={barRef}
        aria-label="Primary navigation"
        className={[
          // Fixed to the viewport bottom, above page content. Safe-area
          // padding is applied as inline style so it composes with the
          // existing rhythm tokens.
          'fixed inset-x-0 bottom-0 z-50',
          'border-t border-[var(--stroke)]',
          'bg-[color-mix(in_srgb,var(--surface)_94%,transparent)]',
          'backdrop-blur-md',
          'text-[var(--ink-secondary)]',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <ul
          className="mx-auto flex w-full max-w-[var(--page-max)] items-stretch justify-around px-[var(--space-2)]"
          style={{ minHeight: 'var(--shell-spine-h)' }}
        >
          {primary.map((entry) => {
            const isActive = isEntryActive(entry);
            const destination = badgeFor(entry.id);
            const short = PHONE_SHORT_LABEL[entry.id] ?? entry.label;
            return (
              <li key={entry.href} className="relative flex min-w-0 flex-1">
                <Link
                  href={entry.href}
                  aria-current={isActive ? 'page' : undefined}
                  aria-label={short === entry.label ? undefined : entry.label}
                  className={[PHONE_CELL_CLASS, isActive ? 'text-[var(--ink)]' : 'text-[var(--ink-secondary)] hover:text-[var(--ink)]'].join(' ')}
                >
                  <ActivePill active={isActive} reduceMotion={reduceMotion} />
                  {entry.id === 'settings' ? (
                    <AvatarGlyph photoUrl={photoUrl} initials={initials} />
                  ) : entry.Icon ? (
                    <entry.Icon size={18} strokeWidth={1.75} aria-hidden="true" className="relative" />
                  ) : null}
                  <span className={PHONE_LABEL_CLASS}>{short}</span>
                </Link>
                {destination ? (
                  <NavCountBadge
                    destination={destination}
                    label={entry.label}
                    scope={scopeFor(destination)}
                    ring="ring-[var(--surface)]"
                    className="left-[calc(50%+2px)] top-[2px]"
                  />
                ) : null}
              </li>
            );
          })}
          {more.length > 0 ? (
            <li className="relative flex min-w-0 flex-1" data-active={moreActive ? 'true' : undefined}>
              <ActivePill active={moreActive} reduceMotion={reduceMotion} />
              {/* The overlay Menu is the cell: its trigger fills it; the label sits on top, click-through. */}
              <Menu
                label={moreTotal > 0 ? `More, ${moreTotal} unread` : 'More'}
                align="end"
                triggerClassName={[MORE_TRIGGER_CLASS, moreActive ? 'text-[var(--ink)]!' : ''].join(' ')}
                items={more.map((entry, i) => ({
                  id: entry.href,
                  label: moreCounts[i] > 0 ? `${entry.label} · ${moreCounts[i]} unread` : entry.label,
                  onSelect: () => router.push(entry.href),
                }))}
              />
              <span
                aria-hidden="true"
                className={[
                  'pointer-events-none absolute inset-x-0 top-[28px] text-center text-[length:var(--text-xxs)] font-medium leading-[1.15] tracking-tight',
                  moreActive ? 'text-[var(--ink)]' : 'text-[var(--ink-secondary)]',
                ].join(' ')}
              >
                More
              </span>
              {moreTotal > 0 ? (
                <span
                  aria-hidden="true"
                  data-nav-badge="more"
                  className={`pointer-events-none absolute left-[calc(50%+2px)] top-[2px] inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-sans text-[length:var(--text-xxs)] font-semibold leading-4 tabular-nums ring-2 ring-[var(--surface)] ${COUNT_BADGE_COLOURS}`}
                >
                  {moreTotal > 9 ? '9+' : moreTotal}
                </span>
              ) : null}
            </li>
          ) : null}
        </ul>
      </nav>
    );
  }

  // Rail (desktop) — the vertical sidebar variant (2026-05-24 AI-native
  // shell). Icon + label rows stacked, an --accent left-edge bar on
  // the active destination. Always on the navy chrome, so on-dark tones.
  return (
    <nav aria-label="Primary navigation" className={className}>
      <ul className="flex flex-col gap-(--space-1)">
        {DESTINATIONS.map(({ href, label, Icon }) => {
          const isActive = href === activeHref;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={isActive ? 'page' : undefined}
                aria-label={collapsed ? label : undefined}
                title={collapsed ? label : undefined}
                className={[
                  'group relative flex items-center gap-(--space-3)',
                  'rounded-[var(--radius-button)] py-(--space-2)',
                  collapsed ? 'justify-center px-(--space-2)' : 'px-(--space-3)',
                  'text-(--text-sm) font-medium tracking-tight',
                  'transition-[color,background-color] duration-150 ease-out',
                  'focus-visible:outline-none focus-visible:ring-2',
                  'focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2',
                  'focus-visible:ring-offset-[var(--shell-rail-bg)]',
                  isActive
                    ? 'bg-[var(--shell-active-bg)] text-[var(--ink-on-dark)]'
                    : 'text-[var(--shell-ink-muted)] hover:bg-[var(--shell-hover-bg)] hover:text-[var(--shell-ink)]',
                ].join(' ')}
              >
                {/* Active left-edge accent bar — the institutional marker,
                    vertical for the rail. Softer hover hint on inactive. */}
                <AnimatePresence initial={false}>
                  {isActive ? (
                    <motion.span
                      aria-hidden="true"
                      layoutId="rail-nav-active-indicator"
                      className="pointer-events-none absolute left-0 top-1/2 h-[60%] w-[2px] -translate-y-1/2 rounded-r-[2px]"
                      style={{ background: 'var(--accent)' }}
                      transition={shellTransition(reduceMotion, SHELL_FADE_DURATION_S)}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute left-0 top-1/2 h-[60%] w-[2px] -translate-y-1/2 rounded-r-[2px] opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-40 group-focus-visible:opacity-60"
                      style={{ background: 'var(--accent)' }}
                    />
                  )}
                </AnimatePresence>
                <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
                <AnimatePresence initial={false}>
                  {!collapsed ? (
                    <motion.span
                      className="leading-none"
                      initial={{ opacity: 0, x: reduceMotion ? 0 : 4 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: reduceMotion ? 0 : -4 }}
                      transition={shellTransition(
                        reduceMotion,
                        SHELL_FADE_DURATION_S + SHELL_ITEM_STAGGER_S,
                      )}
                    >
                      {label}
                    </motion.span>
                  ) : null}
                </AnimatePresence>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default AppNav;
