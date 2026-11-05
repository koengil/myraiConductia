'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  BadgeDollarSign,
  Layers,
  LayoutGrid,
  SearchCheck,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';

import { type DestinationId, type PerspectiveId } from '@/lib/perspective/access';
import { initialsFor, roleLabelFor, useCurrentUser } from '@/lib/auth/useCurrentUser';
import { Wordmark } from '@/components/brand/Wordmark';
import { ComplianceRibbon } from '@/components/compliance/ComplianceRibbon';
import { Menu } from '@/components/overlay';
import {
  NavCountBadge,
  useDealBadgeScope,
  type DealBadgeScope,
} from '@/components/notifications/NavCountBadge';
import { NotificationsBell } from '@/components/notifications/NotificationsBell';
import { ProfileMenu } from '@/components/profile/ProfileMenu';
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
  showOrganizationMenuLink,
} from '@/lib/navigation/navPolicy';
import { isDestinationActive, shellNavState } from '@/lib/navigation/shellNav';
import type { NavBadgeDestination } from '@/lib/notifications/navBadges';
import { NAV_BADGE_FOR, perDealNavItems, withDataRoomHidden } from './perDealNav';
import { TopNavDealSwitcher } from './TopNavDealSwitcher';

/**
 * TopNav — the workbench 56px light top chrome (T4-1, behind the
 * `workbench_top_nav` flag; prototype §09 "Global top nav").
 *
 * Layout (docs/design/workbench/Conductia Workbench.html `shell()`):
 *   [Conduit mark] [deal switcher: codename + code, chevron] |
 *   nav pills (per-deal + global destinations) |
 *   right: compliance instrument · notifications · avatar.
 *
 * Everything here is COMPOSITION of existing pieces — no new data sources:
 *   - brand mark      → Wordmark variant "mark"
 *   - deal switcher   → TopNavDealSwitcher
 *   - nav pills       → the shared per-deal destinations (perDealNav) and the
 *                       shared shell policy (lib/navigation/shellNav), so the
 *                       two chrome variants cannot drift. Accessible names
 *                       FROZEN ('Conductor Center', 'Rails', 'Team',
 *                       'Mail', 'Deal Folder', 'Data Room', 'Audit Trail',
 *                       'History', 'Leads', 'Discovery', 'Setup').
 *                       Organization lives in Settings, opened from the
 *                       avatar menu; it has no pill.
 *   - compliance      → the single [data-compliance-status] ComplianceRibbon
 *                       MOVES here from TopBar when the flag is on (exactly
 *                       one instance in the tree either way)
 *   - avatar/logout   → ProfileMenu (identity, Settings, working sign-out)
 *
 * ⌘K: the prototype shows a search affordance opening a command palette. No
 * command palette exists in the product yet (the old CommandBar intent bar,
 * never a palette, was retired), so per the T4-1 spec nothing is rendered.
 *
 * Register: warm chrome, hairline bottom border, 56px height, field-gray
 * active pills (--surface-subtle) with ink text, 44px touch targets, 2px
 * focus ring. Labels are visible ≥lg (with a deal open, Leads and Discovery
 * from xl and the other global destinations in a More menu until 2xl, since
 * they follow six per-deal pills); below that the pills
 * collapse to icons (accessible names kept via aria-label + title); below md
 * the pill row hides entirely — the mobile AppNav bottom bar owns navigation
 * there.
 */

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  /** Unread notifications for this place show as a count on the icon. */
  badge?: NavBadgeDestination;
  /** The open deal, so a per-deal pill counts only its own items. */
  badgeScope?: DealBadgeScope | null;
};

/** Skills stays out of the top nav until the marketplace ships (Lance,
 *  2026-08-28): skills run from the rail and /skills stays URL-reachable.
 *  The Sidebar keeps its Skills row — this is the only deliberate
 *  destination difference between the two chrome variants. */
const TOP_NAV_HIDDEN_DESTINATIONS: ReadonlySet<DestinationId> = new Set([
  'skills',
  'chat',
]);

/**
 * When a pill shows its name. `lg` off-deal (the global pills are the whole
 * row). With a deal open the global pills follow six per-deal pills: Leads and
 * Discovery keep their names from `xl` (1280px laptops, where bare icons read
 * as unlabelled controls), and the other global
 * destinations sit in a "More" menu until 2xl, where they return as pills.
 */
type LabelFrom = 'lg' | 'xl' | '2xl';

const LABEL_FROM_CLASS: Record<LabelFrom, string> = {
  lg: 'lg:inline',
  xl: 'xl:inline',
  '2xl': '2xl:inline',
};

/** One nav pill: icon always, the name from `labelFrom`; active = field-gray pill + ink. */
function NavPill({
  href,
  label,
  icon: Icon,
  active,
  badge,
  badgeScope,
  labelFrom = 'lg',
  only2xl = false,
}: NavItem & { labelFrom?: LabelFrom; only2xl?: boolean }) {
  return (
    <li className={only2xl ? 'relative hidden shrink-0 2xl:block' : 'relative shrink-0'}>
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        aria-label={label}
        title={label}
        className={[
          'flex min-h-11 items-center gap-1.5 rounded-[var(--radius-control)] px-2 py-2 transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
          active
            ? 'bg-[var(--surface-subtle)] text-[var(--ink)]'
            : 'text-[var(--ink-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)]',
        ].join(' ')}
      >
        <Icon size={18} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        <span
          className={[
            'hidden whitespace-nowrap text-(length:--text-sm) font-medium tracking-tight',
            LABEL_FROM_CLASS[labelFrom],
          ].join(' ')}
        >
          {label}
        </span>
      </Link>
      {badge ? (
        <NavCountBadge destination={badge} label={label} scope={badgeScope} className="left-[14px] top-[5px]" />
      ) : null}
    </li>
  );
}

/** Global pills that keep their names beside a deal's pills (from xl). */
const NAMED_ON_DEAL: ReadonlySet<string> = new Set(['/leads', '/discovery']);

/** The More trigger, styled as a nav pill rather than the default bordered button. */
const MORE_TRIGGER_CLASS =
  'h-11! min-h-11 border-transparent! bg-transparent! text-[var(--ink-secondary)] hover:bg-[var(--surface-subtle)]! hover:text-[var(--ink)]';

export interface TopNavProps {
  perspective?: PerspectiveId;
  className?: string;
}

export function TopNav({ perspective = 'storm', className }: TopNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const discoveryEnabled = useFlag('deal_discovery');
  const dataRoomNavEnabled = useFlag('deal_data_room_nav');
  const { state } = useCurrentUser();
  const navUser =
    state.status === 'ready'
      ? navUserFromProfile(state.data.user, state.data.company_permissions)
      : null;
  const nav = shellNavState({ pathname, navUser, perspective });
  const badgeScope = useDealBadgeScope(nav.inProject ? nav.projectId : null);

  // Per-deal pills — only once a deal is open in the URL, same as the Sidebar.
  const perDealItems: NavItem[] = nav.inProject
    ? perDealNavItems(
        perspective,
        withDataRoomHidden(
          TOP_NAV_HIDDEN_DESTINATIONS,
          showDataRoomNav(dataRoomNavEnabled, perspective),
        ),
      ).map(({ id, suffix, label, icon }) => ({
        href: `/projects/${nav.projectId}${suffix}`,
        label,
        icon,
        active: isDestinationActive(pathname, nav.projectId, suffix),
        badge: NAV_BADGE_FOR[id],
        badgeScope,
      }))
    : [];

  // Global pills — same visibility policy as the Sidebar rows.
  const globalItems: NavItem[] = [
    navUser && showCommandCenterNav(navUser)
      ? {
          href: '/projects',
          label: 'Conductor Center',
          icon: LayoutGrid,
          active: nav.commandCenterActive,
        }
      : null,
    navUser && showLeadsNav(navUser)
      ? { href: '/leads', label: 'Leads', icon: UserPlus, active: nav.leadsActive }
      : null,
    showDiscoveryNav(navUser, perspective, discoveryEnabled)
      ? { href: '/discovery', label: 'Discovery', icon: SearchCheck, active: nav.discoveryActive }
      : null,
    navUser && showAiCostsNav(navUser)
      ? { href: AI_COSTS_HREF, label: 'AI Costs', icon: BadgeDollarSign, active: nav.aiCostsActive }
      : null,
    navUser && showRailTemplatesNav(navUser)
      ? {
          href: RAIL_TEMPLATES_HREF,
          label: RAIL_TEMPLATES_NAV_LABEL,
          icon: Layers,
          active: nav.railTemplatesActive,
        }
      : null,
  ].filter((item): item is NavItem => item !== null);

  // With a deal open, below 2xl, the global destinations other than Leads and
  // Discovery fold into the More menu so the named pills fit a laptop row.
  const onDeal = perDealItems.length > 0;
  const foldedItems = onDeal ? globalItems.filter((item) => !NAMED_ON_DEAL.has(item.href)) : [];
  const foldedActive = foldedItems.some((item) => item.active);

  const profile =
    state.status === 'ready'
      ? {
          name: state.data.user.display_name || state.data.user.full_name,
          roleLabel: roleLabelFor(state.data.user),
          initials: initialsFor(state.data.user),
        }
      : null;

  return (
    <header
      className={[
        'sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-[var(--stroke)] px-4',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ background: 'var(--surface-warm)' }}
    >
      {/* Brand mark — the Conduit glyph (single-color ink discipline). A link
          home: the bug bash tester could not find a way back to /projects. */}
      <Link
        href="/projects"
        aria-label="Conductia home"
        className="flex shrink-0 items-center rounded-[var(--radius-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <Wordmark variant="mark" size={24} title="" className="shrink-0 text-[var(--ink)]" />
      </Link>

      {nav.showDealPicker ? (
        <TopNavDealSwitcher projectId={nav.projectId} showNewDeal={nav.showNewDeal} />
      ) : null}

      {/* Nav pills — per-deal destinations (when a deal is open), then the
          global destinations. Hidden below md: the AppNav bottom bar owns
          mobile navigation. */}
      <nav
        aria-label="Primary navigation"
        className="hidden min-w-0 flex-1 overflow-x-auto md:block [scrollbar-width:none]"
      >
        <ul className="flex items-center gap-0.5">
          {perDealItems.map((item) => (
            <NavPill key={item.label} {...item} />
          ))}
          {onDeal && globalItems.length > 0 ? (
            <li aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-[var(--stroke)]" />
          ) : null}
          {onDeal
            ? globalItems.map((item) =>
                NAMED_ON_DEAL.has(item.href) ? (
                  <NavPill key={item.label} {...item} labelFrom="xl" />
                ) : (
                  <NavPill key={item.label} {...item} labelFrom="2xl" only2xl />
                ),
              )
            : globalItems.map((item) => <NavPill key={item.label} {...item} />)}
          {onDeal && foldedItems.length > 0 ? (
            <li className="shrink-0 2xl:hidden" data-active={foldedActive ? 'true' : undefined}>
              <Menu
                label="More"
                align="end"
                triggerClassName={
                  foldedActive ? `${MORE_TRIGGER_CLASS} bg-[var(--surface-subtle)]! text-[var(--ink)]!` : MORE_TRIGGER_CLASS
                }
                items={foldedItems.map((item) => ({
                  id: item.href,
                  label: item.label,
                  onSelect: () => router.push(item.href),
                }))}
              />
            </li>
          ) : null}
        </ul>
      </nav>

      {/* Right cluster — compliance instrument (project routes; the single
          [data-compliance-status] element), notifications, avatar. No ⌘K:
          no command palette exists in the product yet (see header comment). */}
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {nav.inProject ? <ComplianceRibbon /> : null}
        <NotificationsBell />
        {profile ? (
          <div className="relative">
            <ProfileMenu
              name={profile.name}
              roleLabel={profile.roleLabel}
              initials={profile.initials}
              tone="on-light"
              compact
              showOrganization={showOrganizationMenuLink(navUser)}
            />
            {/* Settings has no pill here: its count sits on the avatar that opens it. */}
            <NavCountBadge destination="settings" label="Settings" className="right-0 top-0" />
          </div>
        ) : null}
      </div>
    </header>
  );
}

export default TopNav;
