import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

/*
 * Settings lists only the sections that apply. Organization is for the
 * bank side and for outside parties in a company; Mail is bank side only. A
 * deep link to a section that does not apply opens Profile.
 */

const navUser = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/navigation/serverNav', () => ({ getNavUser: async () => navUser.current }));
const replace = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
// The Profile section's own UI needs a router and a session; this test is about the list.
vi.mock('@/lib/settings/sections/profile', () => ({
  profileSection: { id: 'profile', label: 'Profile', render: () => <p>Profile fields</p> },
}));

import SettingsPage from '../src/app/(authed)/settings/page';
import { resolveSettingsSection, settingsSectionsFor } from '../src/lib/settings/sections';
import type { NavUser } from '../src/lib/navigation/navPolicy';

const bank: NavUser = { is_external: false, firm_role: null, company_id: 'bank', company_role: 'director' };
const seller: NavUser = { is_external: true, firm_role: null, company_id: null, company_role: null };
const clientDirector: NavUser = { is_external: true, firm_role: null, company_id: 'client', company_role: 'director' };

afterEach(() => {
  cleanup();
  replace.mockClear();
  window.history.replaceState(null, '', '/');
  navUser.current = null;
});

describe('settings sections by viewer', () => {
  it('gives the bank every section', () => {
    expect(settingsSectionsFor(bank).map((s) => s.id)).toEqual(['profile', 'organization', 'mail', 'rails', 'notifications']);
  });

  it('gives a seller or buyer with no company Profile and Notifications only', () => {
    const ids = settingsSectionsFor(seller).map((s) => s.id);
    expect(ids).toEqual(['profile', 'notifications']);
    expect(resolveSettingsSection('organization', settingsSectionsFor(seller)).id).toBe('profile');
    expect(resolveSettingsSection('mail', settingsSectionsFor(seller)).id).toBe('profile');
    expect(resolveSettingsSection('rails', settingsSectionsFor(seller)).id).toBe('profile');
  });

  it("keeps Organization, not Mail, for an outside company's director", () => {
    expect(settingsSectionsFor(clientDirector).map((s) => s.id)).toEqual(['profile', 'organization', 'notifications']);
  });

  it('lists every section while the viewer is unknown', () => {
    expect(settingsSectionsFor(null)).toHaveLength(5);
  });

  it('renders the seller exactly Profile and Notifications, and Profile for ?section=rails', async () => {
    navUser.current = seller;
    render(await SettingsPage({ searchParams: Promise.resolve({ section: 'rails' }) }));
    const list = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(list).getAllByRole('link').map((a) => a.textContent)).toEqual(['Profile', 'Notifications']);
    expect(screen.getByRole('heading', { level: 2, name: 'Profile' })).toBeInTheDocument();
  });

  it('moves an old #deal-discovery link to Mail for the bank, once, and never for a seller (no loop)', async () => {
    window.history.replaceState(null, '', '/settings?section=profile#deal-discovery');
    navUser.current = seller;
    render(await SettingsPage({ searchParams: Promise.resolve({ section: 'profile' }) }));
    expect(replace).not.toHaveBeenCalled();
    cleanup();

    navUser.current = bank;
    render(await SettingsPage({ searchParams: Promise.resolve({ section: 'profile' }) }));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/settings?section=mail#deal-discovery');
  });
});
