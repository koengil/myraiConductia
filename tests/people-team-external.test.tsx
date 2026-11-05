import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import * as React from 'react';

import TeamPage from '../src/app/(authed)/projects/[projectId]/team/page';
import { FlagsProvider } from '../src/lib/flags/FlagsContext';
import type { FlagMap } from '../src/lib/flags/resolveFlags';
import { clearRecipientAddition } from '../src/lib/team/recipientAddition';

/*
 * Team for an outside viewer (handoff E25) and the invite button's wait
 * for the roster (handoff E31). The members API returns every seat to
 * anyone on the deal; the page shows an outside viewer only their own firm and
 * the bank's deal team, and never the "Data room access" list.
 */

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'ATLAS-2026-001' }),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/projects/ATLAS-2026-001/team',
  useSearchParams: () => new URLSearchParams(),
}));

const FLAGS_ON = {
  rail_templates: false,
  template_change_review: false,
  deal_data_room_nav: false,
  gate0_api_create: false,
  platform_onboarding: true,
  work_identity_onboarding: false,
  mail_channel: false,
  mail_jev_second_opinion: false,
  teaser_sandbox_runner: false,
  company_access_management: false,
  setup_walkthroughs: false,
  book_view: false,
  project_rail_model: false,
  deal_discovery: false,
  discovery_worker_enabled: false,
  discovery_model_proposals_demo: false,
  workbench_top_nav: false,
  skill_authoring: false,
  skill_output_revisions: false,
} satisfies FlagMap;

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

const member = (
  userId: string,
  fullName: string,
  email: string,
  isExternal: boolean,
  companyId: string | null,
  companyName: string | null,
  dealRole: string,
) => ({
  userId,
  displayName: null,
  fullName,
  email,
  dealRole,
  phase: isExternal ? 0 : 1,
  isExternal,
  companyId,
  companyName,
  companyRole: 'member',
});

/** A bank, a seller with no company (as seeded), and two buyer firms. */
const ROSTER = {
  members: [
    member('u-storm', 'Storm Duncan', 'md.intelibank@dev.com', false, 'bank-1', 'Conductia Advisory', 'md'),
    member('u-alex', 'Alex Chen', 'deal-team.intelibank@dev.com', false, 'bank-1', 'Conductia Advisory', 'analyst'),
    member('u-mike', 'Mike Cannon-Brookes', 'seller.intelibank@dev.com', true, null, null, 'seller'),
    member('u-buyer', 'Bea Buyer', 'buyer.intelibank@dev.com', true, null, null, 'buyer'),
    member('u-b1', 'Brook One', 'brook@buyer-one.dev', true, 'buy-1', 'Buyer One', 'buyer'),
    member('u-b1b', 'Blair One', 'blair@buyer-one.dev', true, 'buy-1', 'Buyer One', 'buyer'),
    member('u-b2', 'Bo Two', 'bo@buyer-two.dev', true, 'buy-2', 'Buyer Two', 'buyer'),
  ],
  parties: [
    { companyId: 'buy-1', companyName: 'Buyer One', partyRole: 'acquirer_shortlist' },
    { companyId: 'buy-2', companyName: 'Buyer Two', partyRole: 'acquirer_shortlist' },
  ],
  bankCompanyId: 'bank-1',
};

function me(id: string, isExternal: boolean, companyId: string | null, dealRole: string) {
  return {
    user: {
      id,
      email: `${id}@dev.com`,
      is_external: isExternal,
      firm_role: null,
      company_id: companyId,
      company_role: isExternal ? 'member' : 'director',
    },
    memberships: [{ deal_id: 'deal-uuid', deal_code: 'ATLAS-2026-001', deal_role: dealRole }],
  };
}

const ME_STORM = me('u-storm', false, 'bank-1', 'md');
const ME_BUYER = me('u-buyer', true, null, 'buyer');
const ME_SELLER = me('u-mike', true, null, 'seller');
const ME_BUYER_ONE = me('u-b1', true, 'buy-1', 'buyer');

function stubFetch(
  viewer: unknown,
  {
    membersStatus = 200,
    invitesStatus = 200,
    meStatus = 200,
  }: { membersStatus?: number; invitesStatus?: number; meStatus?: number | 'pending' } = {},
) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/v1/me')) {
        if (meStatus === 'pending') return new Promise<Response>(() => {});
        return Promise.resolve(
          meStatus === 200 ? jsonResponse(200, viewer) : jsonResponse(meStatus, { error: 'Server error' }),
        );
      }
      if (url.includes('recipient-affiliations')) {
        return Promise.resolve(jsonResponse(200, { affiliations: [] }));
      }
      if (url.endsWith('/members')) {
        return Promise.resolve(
          membersStatus === 200 ? jsonResponse(200, ROSTER) : jsonResponse(membersStatus, { error: 'Deal not found' }),
        );
      }
      if (url.includes('/api/v1/invites')) {
        return Promise.resolve(
          invitesStatus === 200
            ? jsonResponse(200, { invites: [] })
            : jsonResponse(invitesStatus, { error: 'Forbidden' }),
        );
      }
      return Promise.resolve(jsonResponse(403, { error: 'Forbidden' }));
    }),
  );
}

async function renderTeam() {
  render(
    <FlagsProvider value={FLAGS_ON}>
      <TeamPage />
    </FlagsProvider>,
  );
  await screen.findAllByText('Storm Duncan');
}

afterEach(() => {
  cleanup();
  clearRecipientAddition();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Team for an outside viewer', () => {
  it('shows a buyer only their own seat and the bank, never another party', async () => {
    stubFetch(ME_BUYER, { invitesStatus: 403 });
    await renderTeam();
    const page = screen.getByRole('region', { name: 'Team roster' });

    expect(page.textContent).not.toContain('Mike Cannon-Brookes');
    expect(page.textContent).not.toContain('seller.intelibank@dev.com');
    expect(page.textContent).not.toMatch(/Buyer One|Buyer Two|Brook One|Bo Two/);
    expect(screen.queryByRole('region', { name: 'Data room access' })).toBeNull();
    expect(screen.queryByText('Data room access')).toBeNull();

    const firm = screen.getByRole('region', { name: 'Your firm' });
    expect(within(firm).getByText('Bea Buyer')).toBeInTheDocument();
    const bank = screen.getByRole('region', { name: "The bank's deal team" });
    expect(within(bank).getByText('Storm Duncan')).toBeInTheDocument();
    expect(within(bank).getByText('Alex Chen')).toBeInTheDocument();
  });

  it('shows a seller no buyer row', async () => {
    stubFetch(ME_SELLER, { invitesStatus: 403 });
    await renderTeam();
    const page = screen.getByRole('region', { name: 'Team roster' });
    expect(page.textContent).not.toMatch(/Bea Buyer|buyer\.intelibank|Brook One|Bo Two|Buyer One|Buyer Two/);
    expect(within(screen.getByRole('region', { name: 'Your firm' })).getByText('Mike Cannon-Brookes')).toBeInTheDocument();
    expect(screen.queryByText('Data room access')).toBeNull();
  });

  it("shows a buyer firm's people their whole firm, and not the other bidder", async () => {
    stubFetch(ME_BUYER_ONE, { invitesStatus: 403 });
    await renderTeam();
    const firm = screen.getByRole('region', { name: 'Your firm' });
    expect(within(firm).getByText('Brook One')).toBeInTheDocument();
    expect(within(firm).getByText('Blair One')).toBeInTheDocument();
    const page = screen.getByRole('region', { name: 'Team roster' });
    expect(page.textContent).not.toMatch(/Bo Two|Buyer Two|Mike Cannon-Brookes|Bea Buyer/);
  });

  it('keeps every party and the Data room access list for the bank', async () => {
    stubFetch(ME_STORM);
    await renderTeam();
    const outside = screen.getByRole('region', { name: 'Outside parties' });
    expect(within(outside).getByText('Brook One')).toBeInTheDocument();
    expect(within(outside).getByText('Bo Two')).toBeInTheDocument();
    expect(within(outside).getByText('Mike Cannon-Brookes')).toBeInTheDocument();
    const list = screen.getByRole('region', { name: 'Data room access' });
    expect(within(list).getByText(/Mike Cannon-Brookes/)).toBeInTheDocument();
    expect(within(list).getByText(/Bea Buyer/)).toBeInTheDocument();
  });
});

describe('Invite to deal waits for the roster', () => {
  it('offers no invite when the members read is refused', async () => {
    stubFetch(ME_STORM, { membersStatus: 404 });
    render(
      <FlagsProvider value={FLAGS_ON}>
        <TeamPage />
      </FlagsProvider>,
    );
    expect(await screen.findByRole('status')).toHaveTextContent('You are not on this deal.');
    expect(screen.queryByText(/Deal not found/)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: 'Invite to deal' })).toBeNull();
  });

  it('offers the invite once the roster is in', async () => {
    stubFetch(ME_STORM);
    await renderTeam();
    expect(await screen.findByRole('button', { name: 'Invite to deal' })).toBeInTheDocument();
  });
});

describe('Team fails closed when the viewer is not known', () => {
  const OUTSIDE = /Mike Cannon-Brookes|seller\.intelibank|Bea Buyer|buyer\.intelibank|Brook One|Blair One|Bo Two|Buyer One|Buyer Two/;

  it('shows only the bank, with a retry line, when /me fails', async () => {
    stubFetch(ME_BUYER, { meStatus: 500, invitesStatus: 403 });
    await renderTeam();
    const page = screen.getByRole('region', { name: 'Team roster' });
    expect(page.textContent).not.toMatch(OUTSIDE);
    expect(screen.queryByText('Data room access')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite to deal' })).toBeNull();
    const bank = screen.getByRole('region', { name: "The bank's deal team" });
    expect(within(bank).getByText('Storm Duncan')).toBeInTheDocument();
    expect(screen.getByText("Your access could not be checked. Showing the bank's deal team.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows the roster for the viewer once Retry reaches /me', async () => {
    stubFetch(ME_BUYER, { meStatus: 500, invitesStatus: 403 });
    await renderTeam();
    stubFetch(ME_BUYER, { invitesStatus: 403 });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(within(screen.getByRole('region', { name: 'Your firm' })).getByText('Bea Buyer')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Your access could not be checked/)).toBeNull();
    expect(screen.getByRole('region', { name: 'Team roster' }).textContent).not.toMatch(/Mike Cannon-Brookes|Bo Two/);
  });

  it('shows no outside party and no Data room access while /me is pending', async () => {
    stubFetch(ME_BUYER, { meStatus: 'pending', invitesStatus: 403 });
    render(
      <FlagsProvider value={FLAGS_ON}>
        <TeamPage />
      </FlagsProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const page = screen.getByRole('region', { name: 'Team roster' });
    expect(page.textContent).not.toMatch(OUTSIDE);
    expect(screen.queryByText('Data room access')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Recipient relationship management' })).toBeNull();
  });
});
