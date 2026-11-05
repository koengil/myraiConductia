import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { AppShell } from '@/components/shell/AppShell';

const flags = vi.hoisted(() => ({ topNav: false }));
vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) => (key === 'workbench_top_nav' ? flags.topNav : false),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('@/components/organisms/navigation', () => ({
  Sidebar: () => null,
  TopBar: () => null,
  TopNav: () => null,
}));
vi.mock('@/components/shell/AppNav', () => ({ AppNav: () => <nav aria-label="Primary navigation" /> }));

afterEach(() => {
  cleanup();
  flags.topNav = false;
});

/**
 * The phone bottom bar is fixed over the viewport foot: the one scroll surface
 * reserves its height below md, so the last rows of a long page scroll clear.
 * jsdom has no layout, so this pins the padding classes only; the 390px e2e
 * journey (e2e/journeys/s5-phone-nav-badge.spec.ts) checks the bar in a browser.
 */
describe('AppShell bottom bar room', () => {
  for (const topNav of [false, true]) {
    it(`pins the main padding classes (bar height below md, none from md) with workbench_top_nav ${topNav ? 'on' : 'off'}`, () => {
      flags.topNav = topNav;
      render(
        <AppShell>
          <p>page</p>
        </AppShell>,
      );
      const main = screen.getByRole('main');
      expect(main.className).toContain('pb-[var(--app-nav-h,');
      expect(main.className).toContain('md:pb-0');
    });
  }
});
