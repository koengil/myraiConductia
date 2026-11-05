'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';

import { AppNav } from './AppNav';
import { Sidebar, TopBar, TopNav } from '@/components/organisms/navigation';
import type { PerspectiveId } from '@/components/organisms/navigation';
import { useFlag } from '@/lib/flags/FlagsContext';
import { isOrganizationPath } from '@/lib/navigation/navPolicy';
import {
  canAccessDestination,
  destinationFromPathname,
} from '@/lib/perspective/access';

/**
 * AppShell — the AI-native shell (2026-05-24; routing reframe 2026-06-05).
 *
 * The rail is now ALWAYS mounted for authenticated routes (auth is enforced
 * upstream in middleware): the project picker at `/projects` renders inside the shell
 * so its sign-out is reachable before a project is open. A FIXED-VIEWPORT
 * layout: the collapsible left rail (full height, never scrolls) + a single
 * scrollable content column.
 *
 * The single [data-compliance-status] instrument is the top bar's
 * ComplianceRibbon, shown on PROJECT routes (/projects/[projectId]/...). The
 * floating command console that once carried it was retired (CommandBar,
 * 2026-10-25). Below md every route reserves the phone bar's height
 * (MAIN_CLASS).
 *
 * Fixed viewport: the shell is h-dvh + overflow-hidden, so the page never
 * scrolls like a website. Only <main> scrolls. The rail and the console stay
 * put; the viewport is clean top and bottom. The rail's dot is decorative.
 */

const COLLAPSE_KEY = 'ib-rail-collapsed';

/**
 * The one scroll surface. Below md the AppNav bottom bar is fixed over the
 * viewport foot, so <main> reserves its height: the bar publishes it as
 * --app-nav-h (labels wrap on a phone, and it includes the safe area); the
 * fallback covers the first paint. Otherwise the last rows of a long page sit
 * under the bar.
 */
const MAIN_CLASS =
  'min-h-0 flex-1 overflow-y-auto pb-[var(--app-nav-h,calc(4.5rem+env(safe-area-inset-bottom)))] md:pb-0';

export function AppShell({
  children,
  perspective = 'storm',
}: {
  children: React.ReactNode;
  /**
   * Resolved server-side by the (authed) layout: 'external' for a real
   * seller-side or buyer-side user (platform_onboarding on), 'storm' for the
   * bank MD and everyone internal. The demo persona switchers stay removed
   * (2026-07-09); this prop is identity, not a toggle.
   */
  perspective?: PerspectiveId;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // T4-1 workbench top-nav shell — fail-closed flag. ON = the 56px light
  // TopNav replaces the desktop Sidebar AND the TopBar (it subsumes the
  // compliance instrument, notifications, and the deal switcher; +236px
  // content width). OFF = today's tree, byte-identical.
  const topNavEnabled = useFlag('workbench_top_nav');
  const inProject = pathname?.startsWith('/projects/') ?? false;
  const workspaceLabel =
    pathname === '/settings'
      ? 'Settings'
      : isOrganizationPath(pathname)
        ? 'Organization'
        : 'Project picker';
  // Reference fidelity (Rogo): the rail is EXPANDED by default (~264px, labels
  // visible). It stays user-toggleable and the collapsed preference persists in
  // localStorage — the effect below restores a prior collapse.
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => {
    let raf = 0;
    try {
      if (window.localStorage.getItem(COLLAPSE_KEY) === '1') {
        raf = window.requestAnimationFrame(() => setCollapsed(true));
      }
    } catch {
      // localStorage unavailable — collapse just won't persist.
    }
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  const toggle = React.useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // ignore persistence failure
      }
      return next;
    });
  }, []);

  React.useEffect(() => {
    if (!inProject || !pathname) return;
    const destination = destinationFromPathname(pathname);
    if (!destination || canAccessDestination(perspective, destination)) return;
    const match = pathname.match(/^\/projects\/([^/]+)/);
    if (!match) return;
    router.replace(`/projects/${match[1]}`);
  }, [inProject, pathname, perspective, router]);

  if (topNavEnabled) {
    // Flag ON — the workbench top-nav shell: TopNav (which carries the deal
    // switcher, nav pills, the single [data-compliance-status] ribbon,
    // notifications, and the avatar) over a full-width content column. No
    // Sidebar, no TopBar. The mobile AppNav bottom bar is unchanged.
    return (
      <div className="flex h-dvh flex-col overflow-hidden bg-[var(--surface-warm)]">
        <TopNav perspective={perspective} />
        <main className={MAIN_CLASS}>
          {children}
        </main>
        <AppNav layout="bottom-bar" perspective={perspective} className="md:hidden" />
      </div>
    );
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-[var(--surface-warm)]">
      <Sidebar
        collapsed={collapsed}
        onToggle={toggle}
        perspective={perspective}
        className="hidden md:flex"
      />

      {/* Content column — the only scroll surface. */}
      <div className="relative flex h-dvh min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar inProject={inProject} workspaceLabel={workspaceLabel} />
        {/* Compliance is the moat — always felt. The single
            [data-compliance-status] ComplianceRibbon now rides INLINE on the
            right of the TopBar (2026-07-09); the standalone strip that used to
            sit here was removed to reclaim vertical space. <main> is a
            fixed-height region (min-h-0 + overflow-hidden) so each surface
            manages its own internal scroll — the viewport never scrolls. */}
        <main className={MAIN_CLASS}>
          {children}
        </main>
      </div>

      {/* Mobile navigation (rail hidden below md). */}
      <AppNav layout="bottom-bar" perspective={perspective} className="md:hidden" />
    </div>
  );
}

export default AppShell;
