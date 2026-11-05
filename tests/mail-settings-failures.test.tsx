import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { MailSettingsSection } from '@/components/mail/MailSettingsSection';
import { ComplianceSettingsCard } from '@/components/mail/ComplianceSettingsCard';

/*
 * Settings › Mail never shows a failed read as "not set up", as no
 * access, or as nothing at all.
 */

type Health = {
  me: number;
  mailbox: number;
  complianceGet: number;
  compliancePut: number;
  firmRole: string | null;
  canEdit: boolean;
};

function stub(health: Partial<Health> = {}) {
  const h: Health = { me: 200, mailbox: 200, complianceGet: 200, compliancePut: 200, firmRole: null, canEdit: true, ...health };
  const calls: Array<{ url: string; method: string }> = [];
  const settings = { sampledFrom: 40, queuedFrom: 70, uncheckedFloor: 'sampled', sendFriction: 'one_click' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push({ url: u, method });
      const reply = (status: number, body: unknown) =>
        ({ ok: status < 300, status, json: async () => body }) as Response;
      if (u === '/api/v1/me') {
        return reply(h.me, { user: { firm_role: h.firmRole, is_external: false, email: 'storm@ignatious.com' } });
      }
      if (u === '/api/v1/mailbox') return reply(h.mailbox, { configured: false, connected: false });
      if (u === '/api/v1/discovery/mailbox-consent') {
        return reply(200, { eligible: true, consented: false, address: 'storm@ignatious.com' });
      }
      if (u.startsWith('/api/v1/compliance-settings')) {
        if (method === 'PUT') return reply(h.compliancePut, { error: 'The settings store is down' });
        return reply(h.complianceGet, { settings, isDefault: true, canEdit: h.canEdit });
      }
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  return { calls, health: h };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the mailbox card', () => {
  it('a failed mailbox read says so with Retry, never "not set up"', async () => {
    const { health } = stub({ mailbox: 500 });
    render(<MailSettingsSection />);
    expect(await screen.findByText('Your mailbox status could not be loaded. Try again.')).toBeInTheDocument();
    expect(screen.queryByText(/not set up/i)).toBeNull();
    health.mailbox = 200;
    fireEvent.click(screen.getByRole('button', { name: 'Try again loading mailbox status' }));
    expect(await screen.findByText(/not set up in Conductia yet/i)).toBeInTheDocument();
    expect(screen.queryByText('Your mailbox status could not be loaded. Try again.')).toBeNull();
  });
});

describe('the Mail settings section', () => {
  it('a failed /me says some settings could not be loaded instead of hiding the compliance card', async () => {
    const { health } = stub({ me: 500, firmRole: 'cco' });
    render(<MailSettingsSection />);
    expect(await screen.findByText('Some mail settings could not be loaded. Try again.')).toBeInTheDocument();
    health.me = 200;
    fireEvent.click(screen.getByRole('button', { name: 'Try again loading mail settings' }));
    expect(await screen.findByRole('form', { name: 'Firm compliance settings' })).toBeInTheDocument();
    expect(screen.queryByText('Some mail settings could not be loaded. Try again.')).toBeNull();
  });

  it('the CCO with the compliance settings read at 503 sees the could-not-load card', async () => {
    stub({ complianceGet: 503, firmRole: 'cco' });
    render(<MailSettingsSection />);
    expect(await screen.findByText('Compliance settings could not be loaded. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again loading compliance settings' })).toBeInTheDocument();
  });
});

describe('ComplianceSettingsCard', () => {
  it("an admin's disabled controls each point at the visible CCO-only reason (S6R5-02)", async () => {
    stub({ firmRole: 'admin', canEdit: false });
    render(<ComplianceSettingsCard />);
    await screen.findByRole('form', { name: 'Firm compliance settings' });
    const reason = "Only your firm's CCO can change these settings.";
    expect(screen.getByText(reason)).toBeVisible();
    for (const label of ['Queued from score', 'Sampled from score', 'AI check did not run', 'Before sending']) {
      const control = screen.getByLabelText(label);
      expect(control).toBeDisabled();
      expect(control).toHaveAccessibleDescription(reason);
    }
  });

  it('the CCO edits with no reason attached', async () => {
    stub({ firmRole: 'cco' });
    render(<ComplianceSettingsCard />);
    await screen.findByRole('form', { name: 'Firm compliance settings' });
    for (const label of ['Queued from score', 'Sampled from score', 'AI check did not run', 'Before sending']) {
      const control = screen.getByLabelText(label);
      expect(control).toBeEnabled();
      expect(control).not.toHaveAttribute('aria-describedby');
    }
  });

  it('a refused read (403) still renders nothing', async () => {
    stub({ complianceGet: 403 });
    const { container } = render(<ComplianceSettingsCard />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('after a failed save whose reload fails too, the card and the save error stay', async () => {
    const { health } = stub({ firmRole: 'cco', compliancePut: 500 });
    render(<ComplianceSettingsCard />);
    const form = await screen.findByRole('form', { name: 'Firm compliance settings' });
    health.complianceGet = 500;
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The settings store is down'));
    await new Promise((r) => setTimeout(r, 20));
    expect(form).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Firm compliance settings' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The settings store is down');
  });
});
