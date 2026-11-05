import { canAccessDestination, type PerspectiveId } from '@/lib/perspective/access';
import { GATE0_MODAL_ENTRY_ENABLED } from '@/lib/rail/gate0';
import {
  AI_COSTS_HREF,
  showDealSelector,
  showNewDealNav,
  type NavUser,
} from './navPolicy';

/** The active deal id carried by the URL. Off-deal routes (Command Center,
 *  Leads, Settings, Profile) have no active deal — the per-deal
 *  destinations stay hidden rather than binding to a default. */
export function projectIdFromPath(pathname: string | null): string | null {
  if (!pathname) return null;
  const match = pathname.match(/^\/projects\/([^/]+)/);
  if (match) return match[1];
  return null;
}

export function isDestinationActive(
  pathname: string | null,
  projectId: string | null,
  suffix: string,
): boolean {
  if (pathname == null || projectId == null) return false;
  if (suffix === '') {
    return pathname === `/projects/${projectId}` || pathname === `/projects/${projectId}/`;
  }
  return (
    pathname === `/projects/${projectId}${suffix}` ||
    pathname.startsWith(`/projects/${projectId}${suffix}/`)
  );
}

export type ShellNavState = {
  projectId: string | null;
  inProject: boolean;
  showDealPicker: boolean;
  showNewDeal: boolean;
  commandCenterActive: boolean;
  leadsActive: boolean;
  discoveryActive: boolean;
  aiCostsActive: boolean;
  railTemplatesActive: boolean;
};

/** The shell navigation policy both chrome variants render — the Sidebar
 *  rail and the workbench TopNav. Rendering differs; the policy does not. */
export function shellNavState({
  pathname,
  navUser,
  perspective,
}: {
  pathname: string | null;
  navUser: NavUser | null;
  perspective: PerspectiveId;
}): ShellNavState {
  const projectId = projectIdFromPath(pathname);
  const showDeals = canAccessDestination(perspective, 'rail');

  return {
    projectId,
    inProject: projectId != null,
    showDealPicker: navUser ? showDealSelector(navUser, perspective) : showDeals,
    showNewDeal: Boolean(navUser && showNewDealNav(navUser) && GATE0_MODAL_ENTRY_ENABLED),
    commandCenterActive: pathname === '/projects',
    leadsActive: pathname === '/leads',
    discoveryActive:
      pathname === '/discovery' || (pathname?.startsWith('/discovery/') ?? false),
    aiCostsActive: pathname === AI_COSTS_HREF,
    railTemplatesActive:
      pathname === '/rail-templates' || (pathname?.startsWith('/rail-templates/') ?? false),
  };
}
