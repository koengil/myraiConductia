import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
import { SETTINGS_SECTIONS, resolveSettingsSection, settingsHref } from '../src/lib/settings/sections';
import { badgeHref, destinationFor } from '../src/lib/notifications/navBadges';
import { NOTIFICATION_EVENTS } from '../src/lib/constants/notifications';
import { LOCAL_PREF_DEFAULTS, getLocalPref, setLocalPref } from '../src/lib/prefs/localPrefs';
import SettingsPage from '../src/app/(authed)/settings/page';
import type { AppNotification } from '../src/lib/notifications/useNotifications';

function n(id: string, event_type: string, extra: Partial<AppNotification> = {}): AppNotification {
  return { id, deal_id: 'd1', event_type, payload: {}, read_at: null, created_at: '2026-10-22T00:00:00Z', ...extra };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('settings sections', () => {
  it('registers the five sections', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual(['profile', 'organization', 'mail', 'rails', 'notifications']);
  });
  it('resolves deep links and falls back to profile', () => {
    expect(resolveSettingsSection('organization').id).toBe('organization');
    expect(resolveSettingsSection(['mail', 'rails']).id).toBe('mail');
    expect(resolveSettingsSection('nope').id).toBe('profile');
    expect(resolveSettingsSection(undefined).id).toBe('profile');
    expect(settingsHref('rails')).toBe('/settings?section=rails');
  });
  it('renders the list and the active section', async () => {
    render(await SettingsPage({ searchParams: Promise.resolve({ section: 'notifications' }) }));
    expect(screen.getByRole('link', { name: 'Notifications' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { level: 2, name: 'Notifications' })).toBeTruthy();
    expect(screen.getByText(/Notification preferences do not exist yet/)).toBeTruthy();
    expect(screen.getByText(/bell and in the badges/)).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('nav badges', () => {
  it('every known event type is either mapped or knowingly unbadged', () => {
    const unbadged = NOTIFICATION_EVENTS.filter((e) => destinationFor(e) === null);
    // team_mailbox_refused opens /discovery from the bell, which has no nav badge slot.
    expect(unbadged.sort()).toEqual(['deal_created', 'expense_approved', 'team_mailbox_refused']);
  });
  it('maps compliance_hold to mail and nda/phase events to team', () => {
    expect(destinationFor('compliance_hold')).toBe('mail');
    expect(destinationFor('nda_pending')).toBe('team');
    expect(destinationFor('nda_signed')).toBe('team');
    expect(destinationFor('phase_promoted')).toBe('team');
  });
  it('sends permission requests and their answers to Settings › Organization, never Team', () => {
    for (const e of ['access_requested', 'access_approved', 'access_denied']) {
      expect(destinationFor(e)).toBe('settings');
    }
    expect(badgeHref(n('a', 'access_requested', { deal_id: null }))).toBe(
      '/settings?section=organization&tab=requests',
    );
    expect(badgeHref(n('b', 'access_approved', { deal_id: null }))).toBe(
      '/settings?section=organization',
    );
  });
  it('badgeHref rejects unsafe payload hrefs', () => {
    for (const href of ['//evil.example', '/\\evil', '/\t/evil', 'https://evil.example']) {
      expect(badgeHref(n('x', 'step_assigned', { payload: { href } }))).toBe('/projects/d1/rail');
    }
    expect(badgeHref(n('x', 'step_assigned', { payload: { href: '/projects/X/mail?y=1' } }))).toBe('/projects/X/mail?y=1');
  });
  it('badgeHref prefers payload href, then deal destinations, then settings sections', () => {
    expect(badgeHref(n('1', 'mail_queued_for_review', { payload: { href: '/projects/d1/mail?folder=held' } }))).toBe('/projects/d1/mail?folder=held');
    expect(badgeHref(n('1', 'mail_queued_for_review'))).toBe('/projects/d1/mail');
    expect(badgeHref(n('2', 'member_added'))).toBe('/projects/d1/team');
    expect(badgeHref(n('3', 'step_assigned'))).toBe('/projects/d1/rail');
    expect(badgeHref(n('3', 'step_assigned', { deal_id: null }))).toBe('/projects');
    expect(badgeHref(n('4', 'mailbox_connected', { deal_id: null }))).toBe('/settings?section=mail');
    expect(badgeHref(n('5', 'work_identity_replaced', { deal_id: null }))).toBe('/settings?section=profile');
    expect(badgeHref(n('6', 'step_assigned', { payload: { href: 'https://evil.example' } }))).toBe('/projects/d1/rail');
  });
});

describe('local prefs', () => {
  beforeEach(() => window.localStorage.clear());
  it('returns defaults, round-trips, and rejects bad stored values', () => {
    expect(getLocalPref('railEditPrompt')).toBe(LOCAL_PREF_DEFAULTS.railEditPrompt);
    expect(setLocalPref('railEditPrompt', 'never')).toBe(true);
    expect(getLocalPref('railEditPrompt')).toBe('never');
    window.localStorage.setItem('conductia.homeView', 'garbage');
    expect(getLocalPref('homeView')).toBe(LOCAL_PREF_DEFAULTS.homeView);
  });
  it('uses the existing homeView key and BankHome values', () => {
    expect(setLocalPref('homeView', 'book')).toBe(true);
    expect(window.localStorage.getItem('conductia.homeView')).toBe('book');
    expect(setLocalPref('railViewFilter', 'has_activity')).toBe(true);
  });
  it('survives a throwing localStorage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(getLocalPref('railViewFilter')).toBe('all');
    expect(setLocalPref('railViewFilter', 'mine')).toBe(false);
  });
  it('is SSR-safe without window', () => {
    vi.stubGlobal('window', undefined);
    expect(getLocalPref('homeView')).toBe('console');
    expect(setLocalPref('homeView', 'book')).toBe(false);
    vi.unstubAllGlobals();
  });
});
