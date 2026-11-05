import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DealInvite } from '@/components/team/DealInvite';
import { InviteModal } from '@/components/team/InviteModal';
import { canOpenInvite, type Viewer } from '@/lib/team/inviteAccess';
import type { LiveRoster } from '@/lib/team/roster';

/**
 * The reusable invite: "Invite to deal" brings colleagues at your firm;
 * "Give data room access" brings an outside party on the existing external
 * seat, through the same POST /api/v1/invites. No permission change: the
 * button shows only where the server already serves the invite list.
 */

const ROSTER: LiveRoster = {
  bankCompanyId: 'bank-1',
  members: [
    {
      userId: 'md-1',
      displayName: 'Storm Duncan',
      fullName: 'Storm Duncan',
      email: 'md@bank.dev',
      dealRole: 'md',
      phase: 0,
      isExternal: false,
      companyId: 'bank-1',
      companyName: 'Advisory Bank',
      companyRole: 'director',
    },
  ],
  parties: [
    { companyId: 'seller-1', companyName: 'Target Co', partyRole: 'target' },
    { companyId: 'buyer-1', companyName: 'Vista Equity Partners', partyRole: 'acquirer_shortlist' },
  ],
};

const MD: Viewer = {
  id: 'md-1',
  isExternal: false,
  firmRole: null,
  companyId: 'bank-1',
  companyRole: 'director',
  isDealMd: true,
};

const ME = {
  user: {
    id: 'md-1',
    is_external: false,
    firm_role: null,
    company_id: 'bank-1',
    company_role: 'director',
  },
  memberships: [{ deal_id: 'PROJECT-X', deal_role: 'md', deal_code: 'PROJECT-X' }],
};

const json = (status: number, body: unknown) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);

function stub(invitesStatus = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/v1/me')) return json(200, ME);
      if (url.endsWith('/members')) return json(200, ROSTER);
      if (url.includes('/api/v1/invites?')) return json(invitesStatus, { invites: [] });
      return json(503, {});
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('the data room invite', () => {
  it('offers outside parties only, with the seat, role and phase it always had', () => {
    stub();
    render(
      <InviteModal
        dealId="PROJECT-X"
        roster={ROSTER}
        viewer={MD}
        scope="data-room"
        onClose={() => {}}
        onCreated={() => {}}
        onResend={() => Promise.resolve({ ok: false })}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Give data room access' });
    const company = within(dialog).getByLabelText('Company') as HTMLSelectElement;
    expect(company).toBeEnabled();
    expect(Array.from(company.options).map((o) => o.textContent)).toEqual([
      'Select a company',
      'Target Co',
      'Vista Equity Partners',
    ]);

    fireEvent.change(company, { target: { value: 'buyer-1' } });
    expect(within(dialog).getByText(/take the buyer seat on this deal/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Role')).toBeInTheDocument();
    const phase = within(dialog).getByLabelText('Access up to') as HTMLSelectElement;
    expect(Array.from(phase.options).map((o) => o.textContent)).toEqual([
      'Origination',
      'Preparation',
      'Marketing',
      'Diligence',
      'Signing',
    ]);
  });
});

describe('the Invite to deal dialog', () => {
  it('names the reason the Company select is fixed to your firm', () => {
    stub();
    render(
      <InviteModal
        dealId="PROJECT-X"
        roster={ROSTER}
        viewer={MD}
        scope="internal"
        onClose={() => {}}
        onCreated={() => {}}
        onResend={() => Promise.resolve({ ok: false })}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Invite to deal' });
    const company = within(dialog).getByLabelText('Company') as HTMLSelectElement;
    expect(company).toBeDisabled();
    expect(company).toHaveAccessibleDescription('Colleagues at your firm join this deal.');
    const reason = within(dialog).getByText('Colleagues at your firm join this deal.');
    expect(company.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('leaves a choosable Company select undescribed', () => {
    stub();
    render(
      <InviteModal
        dealId="PROJECT-X"
        roster={ROSTER}
        viewer={MD}
        scope="data-room"
        onClose={() => {}}
        onCreated={() => {}}
        onResend={() => Promise.resolve({ ok: false })}
      />,
    );
    const company = screen.getByLabelText('Company') as HTMLSelectElement;
    expect(company).toBeEnabled();
    expect(company).not.toHaveAttribute('aria-describedby');
  });
});

describe('DealInvite', () => {
  it('shows "Give data room access" to a viewer the invite list is served to, and opens the form', async () => {
    stub();
    render(<DealInvite dealId="PROJECT-X" mode="data-room" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Give data room access' }));
    expect(await screen.findByRole('dialog', { name: 'Give data room access' })).toBeInTheDocument();
  });

  it('opens in recipient mode for a Mail handoff: prefills the email and shows Deal relationship', async () => {
    stub();
    render(<DealInvite dealId="PROJECT-X" mode="data-room" recipientEmail="out@outside.test" />);
    const dialog = await screen.findByRole('dialog', { name: 'Give data room access' });
    expect(within(dialog).getByLabelText('Email')).toHaveValue('out@outside.test');
    const company = within(dialog).getByLabelText('Company') as HTMLSelectElement;
    expect(Array.from(company.options).map((o) => o.textContent)).toEqual(['Select a company', 'Target Co', 'Vista Equity Partners']);
    fireEvent.change(company, { target: { value: 'buyer-1' } });
    expect(within(dialog).getByLabelText('Deal relationship')).toBeInTheDocument();
  });

  it('shows "Invite to deal" for the internal mode', async () => {
    stub();
    render(<DealInvite dealId="PROJECT-X" mode="internal" />);
    expect(await screen.findByRole('button', { name: 'Invite to deal' })).toBeInTheDocument();
  });

  it('renders nothing where the server refuses the invite list', async () => {
    stub(403);
    render(<DealInvite dealId="PROJECT-X" mode="data-room" />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('canOpenInvite', () => {
  it('keeps outside parties to their own firm', () => {
    const director: Viewer = {
      ...MD,
      isExternal: true,
      companyId: 'seller-1',
      companyRole: 'director',
      isDealMd: false,
    };
    expect(canOpenInvite(director, null, 'internal')).toBe(true);
    expect(canOpenInvite(director, null, 'data-room')).toBe(false);
  });

  it('waits for the invite list answer for bank users', () => {
    expect(canOpenInvite(MD, null, 'data-room')).toBe(false);
    expect(canOpenInvite(MD, false, 'data-room')).toBe(false);
    expect(canOpenInvite(MD, true, 'data-room')).toBe(true);
    expect(canOpenInvite(null, true, 'internal')).toBe(false);
  });
});
