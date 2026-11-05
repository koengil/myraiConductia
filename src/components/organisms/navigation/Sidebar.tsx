'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  BadgeDollarSign,
  Layers,
  LayoutGrid,
  LogOut,
  PanelLeft,
  SearchCheck,
  Settings,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { type PerspectiveId } from '@/lib/perspective/access';
import { initialsFor, initialsFromEmail, useCurrentUser } from '@/lib/auth/useCurrentUser';
import { useProfilePhoto } from '@/lib/auth/useProfilePhoto';
import { useSignOut } from '@/lib/auth/useSignOut';
import { dealUuidOf, useDealListSource, useDeals, resolveListedDeal } from '@/lib/deals/useDeals';
import { retryDealReads } from '@/lib/rail/railLoadStage';
import { SidebarDealSelect } from '@/components/deals/DealSelect';
import { openNewMandateDialog } from '@/lib/leads/leadCatalog';
import { NewMandateDialog } from '@/components/wizard/NewMandateDialog';
import { useFlag } from '@/lib/flags/FlagsContext';
import { Wordmark } from '@/components/brand/Wordmark';
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
} from '@/lib/navigation/navPolicy';
import { isDestinationActive, shellNavState } from '@/lib/navigation/shellNav';
import { NavCountBadge, type DealBadgeScope } from '@/components/notifications/NavCountBadge';
import type { NavBadgeDestination } from '@/lib/notifications/navBadges';
import { NAV_BADGE_FOR, perDealNavItems, withDataRoomHidden, type PerDealItem } from './perDealNav';

export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  perspective?: PerspectiveId;
  className?: string;
}

/**
 * The correct multi-deal IA (2026-07-09). The rail is a single, continuous
 * panel — wordmark → New Chat → nav → footer — with no detached/overlay
 * groupings. Its structure follows the MD's mental model:
 *
 *   Command Center   the multi-deal home (login landing, /projects). Every
 *                    task across every live deal — the morning view. Global.
 *   Deals            each deal by CODE NAME. Clicking a deal opens THAT deal's
 *                    Deal Rail (/projects/[id]/rail) — not a per-deal home.
 *   Data             the per-deal destinations that resolve to the active deal.
 *                    Ask /chat is not in the MVP.
 *
 * Every item routes somewhere real — no dead "Weekly update", no dead Help /
 * Settings. The compliance ribbon lives inline in the TopBar, not here.
 */

/** The per-deal destinations that live in the global nav (they resolve to
 *  whichever deal is open). Ask /chat is not in the MVP.
 *
 *  2026-07-09 refinements:
 *    - Deal Folder (internal work product) and Data Room (client documents) are
 *      distinct rows at the same level as the other per-deal destinations. */
/** A primary nav row (Command Center, Skills, Data Room) — icon + label, an
 *  active pill. Collapses to icon-only. */
function NavRow({
  href,
  label,
  icon: Icon,
  active,
  collapsed,
  badge,
  badgeScope,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  collapsed: boolean;
  /** Unread notifications for this place show as a count on the icon. */
  badge?: NavBadgeDestination;
  /** The open deal, so a per-deal row counts only its own items. */
  badgeScope?: DealBadgeScope | null;
}) {
  return (
    <li className="relative">
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        aria-label={label}
        title={label}
        className={[
          'group flex min-h-11 items-center rounded-[var(--radius-control)] px-3 py-2 transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          collapsed ? 'justify-center' : 'gap-3',
          active
            ? 'bg-(--sidebar-item-active-bg) text-(--sidebar-item-active-text)'
            : 'text-(--sidebar-item) hover:bg-(--sidebar-item-hover-bg) hover:text-(--sidebar-item-hover-text)',
        ].join(' ')}
      >
        <Icon size={18} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        {collapsed ? null : (
          <span className="text-[length:var(--text-md)] font-medium tracking-tight">{label}</span>
        )}
      </Link>
      {badge ? (
        <NavCountBadge
          destination={badge}
          label={label}
          scope={badgeScope}
          ring="ring-(--sidebar-bg)"
          className={collapsed ? 'left-[27px] top-[6px]' : 'left-[22px] top-[6px]'}
        />
      ) : null}
    </li>
  );
}

export function Sidebar({
  collapsed,
  onToggle,
  perspective = 'storm',
  className,
}: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { state } = useCurrentUser();
  const navUser =
    state.status === 'ready'
      ? navUserFromProfile(state.data.user, state.data.company_permissions)
      : null;
  const { photoUrl } = useProfilePhoto(state.status === 'ready' ? state.data.user.id : null);
  const nav = shellNavState({ pathname, navUser, perspective });
  const projectId = nav.projectId;
  const discoveryEnabled = useFlag('deal_discovery');
  const dataRoomNavEnabled = useFlag('deal_data_room_nav');

  // Sign-out: on failure the button re-enables (the sidebar has no message
  // surface; a retry is the recovery path).
  const { signOut, signingOut } = useSignOut();
  const [newDealOpen, setNewDealOpen] = React.useState(false);
  // The Deals list is every deal the MD is on — real deals from the platform
  // spine when the flag is on, else the seeded + localStorage fixture set.
  // useDeals mirrors useCurrentUser (API-first, fixture fallback) and refetches
  // on DEALS_EVENT, so a created deal appears the same first-class way as a
  // seeded one, without a page reload.
  const dealSource = useDealListSource();
  const { deals, error: dealsError } = useDeals();
  const selectedDeal =
    projectId != null ? resolveListedDeal(projectId, deals, dealSource) : null;
  const badgeScope: DealBadgeScope | null =
    projectId != null ? { segment: projectId, uuid: dealUuidOf(selectedDeal) } : null;

  const perDealNav: PerDealItem[] = perDealNavItems(
    perspective,
    withDataRoomHidden(new Set(), showDataRoomNav(dataRoomNavEnabled, perspective)),
  );
  const {
    showDealPicker,
    showNewDeal,
    commandCenterActive,
    leadsActive,
    discoveryActive,
    aiCostsActive,
    railTemplatesActive,
  } = nav;
  // Per-deal destinations only appear once a deal is open in the URL — on the
  // Command Center (/projects) or other global routes they stay hidden.
  const showPerDealNav = nav.inProject && perDealNav.length > 0;
  const settingsActive = pathname === '/settings';
  const isDestActive = (suffix: string) => isDestinationActive(pathname, projectId, suffix);

  const profileName =
    state.status === 'ready'
      ? state.data.user.display_name || state.data.user.full_name
      : state.email ?? 'Profile';
  const profileInitials =
    state.status === 'ready'
      ? initialsFor(state.data.user)
      : state.email
        ? initialsFromEmail(state.email)
        : '';

  const navClass = [
    'hidden md:flex h-dvh shrink-0 flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)] px-3 py-4',
    collapsed ? 'w-[76px]' : 'w-[264px]',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <aside className={navClass}>
      {/* Wordmark + collapse (reference: left wordmark, collapse right) */}
      <div className={collapsed ? 'flex justify-center pb-4' : 'flex items-center justify-between pb-4 pl-1'}>
        {!collapsed && (
          <Wordmark size={22} className="text-(--sidebar-title)" />
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] text-(--sidebar-item) transition-colors hover:bg-(--sidebar-item-hover-bg) hover:text-(--sidebar-item-hover-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <PanelLeft size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>


      {/* The icon rail is too narrow for a scrollbar: it still scrolls, without showing one. */}
      <div
        className={[
          'flex-1 min-h-0 overflow-y-auto',
          collapsed ? '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden' : '',
        ].join(' ')}
      >
        <nav aria-label="Primary navigation">
          {/* Global home — spans all deals. Command Center (the multi-deal
              morning view). Ask and the per-deal destinations live below,
              only once a deal is open. */}
          <ul className="space-y-1">
            {showCommandCenterNav(navUser) ? (
              <NavRow
                href="/projects"
                label="Conductor Center"
                icon={LayoutGrid}
                active={commandCenterActive}
                collapsed={collapsed}
              />
            ) : null}
            {showLeadsNav(navUser) ? (
              <NavRow
                href="/leads"
                label="Leads"
                icon={UserPlus}
                active={leadsActive}
                collapsed={collapsed}
              />
            ) : null}
            {showDiscoveryNav(navUser, perspective, discoveryEnabled) ? (
              <NavRow
                href="/discovery"
                label="Discovery"
                icon={SearchCheck}
                active={discoveryActive}
                collapsed={collapsed}
              />
            ) : null}
            {showAiCostsNav(navUser) ? (
              <NavRow
                href={AI_COSTS_HREF}
                label="AI Costs"
                icon={BadgeDollarSign}
                active={aiCostsActive}
                collapsed={collapsed}
              />
            ) : null}
            {showRailTemplatesNav(navUser) ? (
              <NavRow
                href={RAIL_TEMPLATES_HREF}
                label={RAIL_TEMPLATES_NAV_LABEL}
                icon={Layers}
                active={railTemplatesActive}
                collapsed={collapsed}
              />
            ) : null}
          </ul>

          {/* Deals — the expanded rail's labelled group. The compact
              (collapsed) rail stays primary-nav + footer only. */}
          {!collapsed ? (
            <>
              {showDealPicker ? (
                <SidebarDealSelect
                  deals={deals}
                  activeId={projectId}
                  activeDeal={selectedDeal}
                  unavailable={dealsError ? { onRetry: () => retryDealReads(projectId) } : null}
                  onSelect={(id) => router.push(`/projects/${id}/rail`)}
                  menuFooter={{
                    showNewDeal,
                    onNewDeal: () => openNewMandateDialog(setNewDealOpen),
                  }}
                />
              ) : null}
              {showNewDeal ? (
                <NewMandateDialog open={newDealOpen} onClose={() => setNewDealOpen(false)} />
              ) : null}
            </>
          ) : null}

          {/* Per-deal destinations — nested under the active deal picker. */}
          {showPerDealNav ? (
            <ul
              className={
                collapsed
                  ? 'mt-2 space-y-1'
                  : 'mt-1 ml-3 space-y-0.5 border-l border-(--sidebar-border) pl-2'
              }
            >
              {perDealNav.map(({ id, suffix, label, icon }) => (
                <NavRow
                  key={label}
                  badge={NAV_BADGE_FOR[id]}
                  badgeScope={badgeScope}
                  href={`/projects/${projectId}${suffix}`}
                  label={label}
                  icon={icon}
                  active={isDestActive(suffix)}
                  collapsed={collapsed}
                />
              ))}
            </ul>
          ) : null}
        </nav>
      </div>

      {/* Footer — who is signed in, then Settings and Logout: the avatar
          menu's items in the TopNav shell. The identity row is not a link;
          Settings (whose first section is the profile) is the one way in. */}
      <div className="mt-auto border-t border-(--sidebar-border) pt-3">
        <div
          title={collapsed ? profileName : undefined}
          className={[
            'min-h-11 px-2 py-1.5',
            collapsed ? 'flex items-center justify-center' : 'flex items-center gap-3',
          ].join(' ')}
        >
          {photoUrl ? (
            <span
              className="h-9 w-9 rounded-full bg-cover bg-center ring-2 ring-(--sidebar-avatar-ring)"
              style={{ backgroundImage: `url(${photoUrl})` }}
            />
          ) : (
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-(--sidebar-item-active-bg) font-mono text-(length:--text-xs) font-semibold text-(--sidebar-title) ring-2 ring-(--sidebar-avatar-ring)">
              {profileInitials}
            </span>
          )}
          {collapsed ? null : (
            <span className="truncate text-(--sidebar-title) text-[length:var(--text-md)] font-medium tracking-tight">
              {profileName}
            </span>
          )}
        </div>

        <div className="relative">
          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
            aria-current={settingsActive ? 'page' : undefined}
            className={[
              'mt-1 group flex min-h-11 w-full items-center rounded-[var(--radius-control)] px-3 py-2 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              collapsed ? 'justify-center' : 'gap-3',
              settingsActive
                ? 'bg-(--sidebar-item-active-bg) text-(--sidebar-item-active-text)'
                : 'text-(--sidebar-item) hover:bg-(--sidebar-item-hover-bg) hover:text-(--sidebar-item-hover-text)',
            ].join(' ')}
          >
            <Settings size={18} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
            {collapsed ? null : (
              <span className="text-[length:var(--text-md)] font-medium tracking-tight">Settings</span>
            )}
          </Link>
          <NavCountBadge
            destination="settings"
            label="Settings"
            ring="ring-(--sidebar-bg)"
            className={collapsed ? 'left-[27px] top-[10px]' : 'left-[22px] top-[10px]'}
          />
        </div>

        <button
          type="button"
          aria-label="Logout"
          title="Logout"
          disabled={signingOut}
          onClick={() => void signOut()}
          className={[
            'mt-1 group flex min-h-11 w-full items-center rounded-[var(--radius-control)] px-3 py-2 text-(--sidebar-item) transition-colors hover:bg-(--sidebar-item-hover-bg) hover:text-(--sidebar-item-hover-text)',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            collapsed ? 'justify-center' : 'gap-3',
            signingOut ? 'opacity-60' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <LogOut size={18} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
          {collapsed ? null : (
            <span className="text-[length:var(--text-md)] font-medium tracking-tight">
              {signingOut ? 'Signing out…' : 'Logout'}
            </span>
          )}
        </button>
      </div>
    </aside>
  );
}

export default Sidebar;
