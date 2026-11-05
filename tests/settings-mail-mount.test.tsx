import * as React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { mailSection } from '@/lib/settings/sections/mail';
import { NOTIFICATIONS_COPY, notificationsSection } from '@/lib/settings/sections/notifications';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import type { FlagMap } from '@/lib/flags/resolveFlags';
import { CONNECT_GMAIL_HREF } from '@/components/discovery/ConnectGmailBanner';

/** Settings › Mail mounts the Mail section, and the Gmail banner links to its Deal discovery card. */

const withFlag = (ui: React.ReactNode) => (
  <FlagsProvider value={{ deal_discovery: true } as FlagMap}>{ui}</FlagsProvider>
);

function stub(firmRole: string | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u === '/api/v1/me') {
        return { ok: true, json: async () => ({ user: { firm_role: firmRole, is_external: false, email: 'a@bank.test' } }) } as Response;
      }
      if (u === '/api/v1/discovery/mailbox-consent') {
        return { ok: true, json: async () => ({ eligible: true, consented: false, address: 'a@bank.test' }) } as Response;
      }
      if (u === '/api/v1/mailbox') return { ok: true, json: async () => ({ configured: false, connected: false }) } as Response;
      if (u.startsWith('/api/v1/compliance-settings')) {
        return { ok: true, json: async () => ({ settings: { sampledFrom: 40, queuedFrom: 70, uncheckedFloor: 'sampled', sendFriction: 'one_click' }, isDefault: true, canEdit: true }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('renders the mailbox cards for a member, with the anchor the Gmail banner links to', async () => {
  stub(null);
  const { container } = render(withFlag(mailSection.render()));
  expect(await screen.findByRole('heading', { name: 'Signature' })).toBeInTheDocument();
  const anchor = CONNECT_GMAIL_HREF.split('#')[1];
  expect(CONNECT_GMAIL_HREF.startsWith('/settings?section=mail#')).toBe(true);
  await waitFor(() => expect(container.querySelector(`#${anchor}`)).not.toBeNull());
  expect(screen.queryByText(/compliance/i)).toBeNull();
});

it('adds the firm compliance settings for an admin', async () => {
  stub('admin');
  render(withFlag(mailSection.render()));
  expect(await screen.findByText(/compliance/i)).toBeInTheDocument();
});

it('Settings > Notifications states plainly that preferences do not exist yet', () => {
  render(<>{notificationsSection.render()}</>);
  expect(screen.getByText(NOTIFICATIONS_COPY)).toBeInTheDocument();
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
});
