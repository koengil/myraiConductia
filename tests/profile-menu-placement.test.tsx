import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ProfileMenu } from '@/components/profile/ProfileMenu';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: () => ({ auth: { signOut: vi.fn() } }),
}));

const GAP = 8;
const PANEL = { width: 280, height: 232 };
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function resolvePanelBox(
  panelClasses: string[],
  trigger: Box,
  viewport: { width: number; height: number },
): Box {
  const opensBelow = panelClasses.some((c) => c.startsWith('top-'));
  const opensAbove = panelClasses.some((c) => c.startsWith('bottom-'));
  const alignedRight = panelClasses.includes('right-0');
  const alignedLeft = panelClasses.includes('left-0');

  if (opensBelow === opensAbove || alignedRight === alignedLeft) {
    throw new Error(`Ambiguous anchor: ${panelClasses.join(' ')}`);
  }

  const width = Math.min(PANEL.width, viewport.width - 24);
  return {
    x: alignedRight ? trigger.x + trigger.width - width : trigger.x,
    y: opensBelow
      ? trigger.y + trigger.height + GAP
      : trigger.y - GAP - PANEL.height,
    width,
    height: PANEL.height,
  };
}

function topNavTrigger(viewportWidth: number): Box {
  return { x: viewportWidth - 52, y: 10, width: 36, height: 36 };
}

function railTrigger(viewportHeight: number): Box {
  return { x: 16, y: viewportHeight - 88, width: 36, height: 36 };
}

function openPanel(placement?: 'below-end' | 'above-start') {
  render(
    <ProfileMenu
      name="Storm Duncan"
      roleLabel="Administrator"
      initials="SD"
      placement={placement}
      compact
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /open profile menu/ }));
  return screen.getByRole('dialog', { name: 'Profile' });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('ProfileMenu placement', () => {
  it.each(VIEWPORTS)(
    'keeps the panel inside a $width x $height viewport from a top-nav trigger',
    ({ width, height }) => {
      const panel = openPanel();
      const box = resolvePanelBox(Array.from(panel.classList), topNavTrigger(width), {
        width,
        height,
      });

      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
    },
  );

  it.each(VIEWPORTS)(
    'keeps the panel inside a $width x $height viewport from a rail-foot trigger',
    ({ width, height }) => {
      const panel = openPanel('above-start');
      const box = resolvePanelBox(Array.from(panel.classList), railTrigger(height), {
        width,
        height,
      });

      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
    },
  );

  it('reaches Settings and sign-out from the default top-nav placement', () => {
    openPanel();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('link', { name: 'Profile' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: /Storm Duncan.+Administrator/ })).toBeInTheDocument();
    expect(screen.queryByText('Active mandate')).not.toBeInTheDocument();
  });
});
