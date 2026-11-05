import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { AppNotification } from '@/lib/notifications/useNotifications';

/*
 * The bell opens a deal by its code, the same way the nav badges do. A
 * stored link whose deal segment is a UUID is rewritten to the code; the
 * stored link is kept only when there is no code. The stored data itself is
 * handoff E33.
 */

const feed = vi.hoisted(() => ({ items: [] as AppNotification[] }));
vi.mock('@/lib/notifications/useNotifications', () => ({
  useNotifications: () => ({
    items: feed.items,
    unreadCount: feed.items.length,
    ready: true,
    markRead: vi.fn(),
    reload: vi.fn(),
  }),
}));
vi.mock('@/lib/access/useAccessInbox', () => ({
  useAccessInbox: () => ({ items: [], busyId: null, error: null, decide: vi.fn(), match: () => null, reload: vi.fn() }),
}));

import { NotificationsBell } from '@/components/notifications/NotificationsBell';

const UUID = '8a642fdf-1b2c-4d5e-8f90-123456789abc';

function hold(payload: AppNotification['payload']): AppNotification {
  return {
    id: 'h1',
    deal_id: UUID,
    event_type: 'compliance_hold',
    payload,
    read_at: null,
    created_at: '2026-10-22T00:00:00Z',
  };
}

function openBell() {
  render(<NotificationsBell />);
  fireEvent.click(screen.getByRole('button', { name: /^Notifications/ }));
}

afterEach(() => {
  cleanup();
  feed.items = [];
});

describe('bell links use the deal code', () => {
  it('rewrites a stored UUID link to the code', () => {
    feed.items = [hold({ code: 'SUMMIT-2026-003', href: `/projects/${UUID}/mail?folder=held` })];
    openBell();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/projects/SUMMIT-2026-003/mail?folder=held');
  });

  it('keeps the stored link when no code resolves', () => {
    feed.items = [hold({ href: `/projects/${UUID}/mail?folder=held` })];
    openBell();
    expect(screen.getByRole('link')).toHaveAttribute('href', `/projects/${UUID}/mail?folder=held`);
  });
});

describe('bell row titles', () => {
  it('wrap to two lines instead of truncating to one', () => {
    feed.items = [hold({ code: 'SUMMIT-2026-003', href: `/projects/${UUID}/mail?folder=held` })];
    openBell();
    const title = screen.getByRole('link');
    expect(title.className).toContain('line-clamp-2');
    expect(title.className).not.toContain('truncate');
  });
});
