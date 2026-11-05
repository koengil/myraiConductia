import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import * as React from 'react';

import TeamPage from '../src/app/(authed)/projects/[projectId]/team/page';
import { TeamRoster } from '../src/components/team/TeamRoster';
import { FlagsProvider } from '../src/lib/flags/FlagsContext';
import type { FlagMap } from '../src/lib/flags/resolveFlags';
import { clearRecipientAddition, queueRecipientAddition } from '../src/lib/team/recipientAddition';

/*
 * Canonical Team surface, flag branch (platform_onboarding).
 * OFF: today's fixture roster, invite affordance still the disabled stub.
 * ON: the live roster from GET /members, grouped by company, with the invite
 * modal reachable.
 */

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'project-summit' }),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/projects/project-summit/team',
  useSearchParams: () => new URLSearchParams(),
}));

const FLAGS_OFF: FlagMap = {
  rail_templates: false,
  template_change_review: false,
  deal_data_room_nav: false,
  gate0_api_create: false,
  platform_onboarding: false,
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
};
const FLAGS_ON: FlagMap = { ...FLAGS_OFF, platform_onboarding: true };

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

const ROSTER = {
  members: [
    {
      userId: 'u-1',
      displayName: 'Ada Bank',
      fullName: 'Ada Bankstrom',
      email: 'ada@bank.dev',
      dealRole: 'md',
      phase: 1,
      isExternal: false,
      companyId: 'bank-1',
      companyName: 'Conductia Advisory',
      companyRole: 'director',
    },
    {
      userId: 'u-2',
      displayName: null,
      fullName: 'Alex Whitfield',
      email: 'alex@seller.dev',
      dealRole: 'seller',
      phase: 0,
      isExternal: true,
      companyId: 'sell-1',
      companyName: 'Canva',
      companyRole: 'member',
    },
  ],
  parties: [{ companyId: 'sell-1', companyName: 'Canva', partyRole: 'target' }],
  bankCompanyId: 'bank-1',
};

const ME = {
  user: {
    id: 'u-1',
    email: 'ada@bank.dev',
    is_external: false,
    firm_role: null,
    company_id: 'bank-1',
    company_role: 'director',
  },
  memberships: [{ deal_id: 'atlassian', deal_role: 'md', phase: 1 }],
};

function stubFetch(me: typeof ME = ME, invitesStatus: number | 'pending' = 200) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/v1/me')) return Promise.resolve(jsonResponse(200, me));
    if (url.endsWith('/members')) return Promise.resolve(jsonResponse(200, ROSTER));
    if (url.includes('/api/v1/invites')) {
      if (invitesStatus === 'pending') return new Promise<Response>(() => {});
      return Promise.resolve(
        invitesStatus === 200
          ? jsonResponse(200, { invites: [] })
          : jsonResponse(invitesStatus, { error: 'Forbidden' }),
      );
    }
    return Promise.resolve(jsonResponse(404, { error: 'unexpected fetch' }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  clearRecipientAddition();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Team surface flag branch', () => {
  it('flag OFF renders the fixture roster with the disabled invite stub', () => {
    const fetchMock = stubFetch();
    render(
      <FlagsProvider value={FLAGS_OFF}>
        <TeamRoster />
      </FlagsProvider>,
    );

    // Fixture people render; nothing is fetched.
    expect(screen.getByText('Storm Duncan')).toBeInTheDocument();
    expect(screen.getByText('Priya Nair')).toBeInTheDocument();
    const stub = screen.getAllByRole('button', { name: /invite to deal/i })[0];
    expect(stub).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flag ON renders the live roster grouped by company and opens the invite modal', async () => {
    stubFetch();
    render(
      <FlagsProvider value={FLAGS_ON}>
        <TeamPage />
      </FlagsProvider>,
    );

    // Live members from GET /members, under their company sections.
    expect(await screen.findByText('Ada Bank')).toBeInTheDocument();
    const firm = screen.getByRole('region', { name: 'Your firm' });
    const outside = screen.getByRole('region', { name: 'Outside parties' });
    expect(within(firm).getByText('Conductia Advisory')).toBeInTheDocument();
    expect(within(firm).getByText('Ada Bank')).toBeInTheDocument();
    expect(within(outside).getByText('Canva')).toBeInTheDocument();
    expect(within(outside).getByText('Alex Whitfield')).toBeInTheDocument();
    // The fixture roster must NOT render on the live surface.
    expect(screen.queryByText('Storm Duncan')).not.toBeInTheDocument();

    // The invite affordance is a real button now; it opens the modal.
    const invite = await screen.findByRole('button', { name: /invite to deal/i });
    expect(invite).toBeEnabled();
    fireEvent.click(invite);
    expect(
      await screen.findByRole('dialog', { name: /invite to deal/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });

  it('heads the live roster "Team" once, leaving the deal name to the switcher', async () => {
    stubFetch();
    render(
      <FlagsProvider value={FLAGS_ON}>
        <TeamPage />
      </FlagsProvider>,
    );
    expect(await screen.findByText('Ada Bank')).toBeInTheDocument();
    const header = screen.getByRole('heading', { level: 1, name: 'Team' }).closest('header') as HTMLElement;
    expect(within(header).getAllByText('Team')).toHaveLength(1);
    expect(within(header).queryByText(/Project Summit/)).toBeNull();
  });

  it('says the team could not be loaded, with Try again, and never shows the server text', async () => {
    const fetchMock = stubFetch();
    const ok = fetchMock.getMockImplementation()!;
    let fail = true;
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      fail && String(input).endsWith('/members')
        ? Promise.resolve(jsonResponse(500, { error: 'boom' }))
        : ok(input),
    );
    render(
      <FlagsProvider value={FLAGS_ON}>
        <TeamPage />
      </FlagsProvider>,
    );

    expect(await screen.findByText('The team could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText(/boom/)).toBeNull();
    expect(screen.queryByText(/Request failed/)).toBeNull();

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Ada Bank')).toBeInTheDocument();
    expect(screen.queryByText('The team could not be loaded.')).toBeNull();
  });

  it('says "You are not on this deal." on a 404 members read, with no Try again', async () => {
    const fetchMock = stubFetch();
    const ok = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      String(input).endsWith('/members')
        ? Promise.resolve(jsonResponse(404, { error: 'Deal not found' }))
        : ok(input),
    );
    render(
      <FlagsProvider value={FLAGS_ON}>
        <TeamPage />
      </FlagsProvider>,
    );

    expect(await screen.findByText('You are not on this deal.')).toBeInTheDocument();
    expect(screen.queryByText('The team could not be loaded.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('keeps a 403 on the members read as a failed read with Try again (an account gate, not membership)', async () => {
    const fetchMock = stubFetch();
    const ok = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      String(input).endsWith('/members')
        ? Promise.resolve(jsonResponse(403, { error: 'mfa_required' }))
        : ok(input),
    );
    render(
      <FlagsProvider value={FLAGS_ON}>
        <TeamPage />
      </FlagsProvider>,
    );

    expect(await screen.findByText('The team could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('You are not on this deal.')).toBeNull();
  });

  it('drops the roster when a reload after success answers 404', async () => {
    const fetchMock = stubMulti();
    const ok = fetchMock.getMockImplementation()!;
    let gone = false;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PATCH') return Promise.resolve(jsonResponse(200, {}));
      if (gone && url.endsWith('/members')) return Promise.resolve(jsonResponse(404, { error: 'Deal not found' }));
      return ok(input);
    });
    render(
      <FlagsProvider value={FLAGS_ON}>
        <TeamPage />
      </FlagsProvider>,
    );
    await screen.findByText('Storm Duncan');
    fireEvent.click(personRow('Priya Rao'));
    gone = true;
    fireEvent.change(screen.getByLabelText('Access up to'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }));

    expect(await screen.findByText('You are not on this deal.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Priya Rao/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Update access' })).toBeNull();
  });

  it('hides the invite button from a bank member without manage rights (#396)', async () => {
    stubFetch(
      { user: { ...ME.user, company_role: 'member' }, memberships: [{ deal_id: 'atlassian', deal_role: 'analyst', phase: 1 }] },
      403,
    );
    render(
      <FlagsProvider value={FLAGS_ON}>
        <TeamPage />
      </FlagsProvider>,
    );

    expect(
      await screen.findByText('Invitations are sent by the deal MD or a member they delegate.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /invite to deal/i })).not.toBeInTheDocument();
  });

  it('keeps the button undecided, not refused, when the invite list fails for another reason (#396)', async () => {
    stubFetch(ME, 500);
    render(
      <FlagsProvider value={FLAGS_ON}>
        <TeamPage />
      </FlagsProvider>,
    );

    expect(await screen.findByText('Ada Bank')).toBeInTheDocument();
    expect(
      screen.queryByText('Invitations are sent by the deal MD or a member they delegate.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /invite to deal/i })).not.toBeInTheDocument();
  });

  it('does not flash the deal-manager notice while the check is pending (#396)', async () => {
    queueRecipientAddition('project-summit', 'new.person@canva.com', 'team');
    stubFetch(ME, 'pending');
    render(
      <FlagsProvider value={FLAGS_ON}>
        <TeamPage />
      </FlagsProvider>,
    );

    expect(await screen.findByText('Ada Bank')).toBeInTheDocument();
    expect(screen.queryByText(/A deal manager must add this recipient/)).not.toBeInTheDocument();
  });
});

/*
 * Team: person detail opens inline, one at a
 * time; plain labels; your firm and outside parties grouped; Team invites your
 * own firm only; who has data room access, read-only.
 */
const MULTI = {
  ...ROSTER,
  members: [
    ...ROSTER.members,
    {
      userId: 'u-3',
      displayName: 'Storm Duncan',
      fullName: 'Storm Duncan',
      email: 'storm@bank.dev',
      dealRole: 'deal_team',
      phase: 0,
      isExternal: false,
      companyId: 'bank-1',
      companyName: 'Conductia Advisory',
      companyRole: 'member',
    },
    {
      userId: 'u-4',
      displayName: 'Priya Rao',
      fullName: 'Priya Rao',
      email: 'priya@seller.dev',
      dealRole: 'seller',
      phase: 2,
      isExternal: true,
      companyId: 'sell-1',
      companyName: 'Canva',
      companyRole: 'director',
    },
  ],
};

/** The viewer holds the MD seat on this deal, so the access controls show. */
const ME_MD = { ...ME, memberships: [{ deal_id: 'project-summit', deal_role: 'md', phase: 0 }] };

function stubMulti() {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/v1/me')) return Promise.resolve(jsonResponse(200, ME_MD));
    if (url.endsWith('/members')) return Promise.resolve(jsonResponse(200, MULTI));
    if (url.includes('/api/v1/invites?')) return Promise.resolve(jsonResponse(200, { invites: [] }));
    if (url.includes('/perimeter-preview')) return Promise.resolve(jsonResponse(503, {}));
    return Promise.resolve(jsonResponse(404, { error: 'unexpected fetch' }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function personRow(name: string) {
  return screen.getByRole('button', { name: new RegExp(name) });
}

async function renderLiveTeam() {
  stubMulti();
  render(
    <FlagsProvider value={FLAGS_ON}>
      <TeamPage />
    </FlagsProvider>,
  );
  await screen.findByText('Storm Duncan');
}

describe('Team person detail opens inline', () => {
  it('opens under the row, with no side panel or dialog', async () => {
    await renderLiveTeam();
    fireEvent.click(personRow('Storm Duncan'));
    expect(personRow('Storm Duncan')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByText('Every phase')).toBeInTheDocument();
  });

  it('opening a second person closes the first in place', async () => {
    await renderLiveTeam();
    fireEvent.click(personRow('Storm Duncan'));
    fireEvent.click(personRow('Ada Bank'));
    expect(personRow('Ada Bank')).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() =>
      expect(personRow('Storm Duncan')).toHaveAttribute('aria-expanded', 'false'),
    );
    // The close control is the row itself, where the person is.
    fireEvent.click(personRow('Ada Bank'));
    expect(personRow('Ada Bank')).toHaveAttribute('aria-expanded', 'false');
  });

  it('switching person never shows the previous person access choice', async () => {
    await renderLiveTeam();
    // Alex is at Origination (0); the control starts on his current phase.
    fireEvent.click(personRow('Alex Whitfield'));
    const first = (await screen.findByLabelText('Access up to')) as HTMLSelectElement;
    expect(first.value).toBe('0');
    fireEvent.change(first, { target: { value: '4' } });
    expect(first.value).toBe('4');

    // Priya is at Marketing (2): her control shows her own phase, not Alex's 4.
    fireEvent.click(personRow('Priya Rao'));
    await waitFor(() => expect(screen.getAllByLabelText('Access up to')).toHaveLength(1));
    expect((screen.getByLabelText('Access up to') as HTMLSelectElement).value).toBe('2');
  });

  it('uses plain labels and repeats neither name nor email', async () => {
    await renderLiveTeam();
    fireEvent.click(personRow('Priya Rao'));
    const panel = await waitFor(() => {
      const el = document.querySelector('[data-disclosure-panel]');
      if (!el) throw new Error('no panel');
      return el as HTMLElement;
    });
    expect(within(panel).getByText('What they can see')).toBeInTheDocument();
    expect(within(panel).getByText('Up to Marketing')).toBeInTheDocument();
    expect(within(panel).getByText('Joined')).toBeInTheDocument();
    expect(panel.textContent).not.toMatch(/Priya Rao|priya@seller\.dev/);

    const page = screen.getByRole('region', { name: 'Team roster' });
    expect(page.textContent).not.toMatch(/Disclosure phase|perimeter|On platform|Phase \d/i);
  });

  it('lists who has data room access, read-only', async () => {
    await renderLiveTeam();
    const list = screen.getByRole('region', { name: 'Data room access' });
    expect(within(list).getByText(/Alex Whitfield/)).toBeInTheDocument();
    expect(within(list).getByText(/Priya Rao/)).toBeInTheDocument();
    expect(within(list).getByText('Up to Marketing')).toBeInTheDocument();
    // Your own firm is not on it, and nothing on it can be changed.
    expect(within(list).queryByText(/Ada Bank|Storm Duncan/)).not.toBeInTheDocument();
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
    expect(within(list).queryAllByRole('combobox')).toHaveLength(0);
  });

  it("Team's invite offers your own firm only, with no seller or buyer seat", async () => {
    await renderLiveTeam();
    fireEvent.click(await screen.findByRole('button', { name: 'Invite to deal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite to deal' });
    const company = within(dialog).getByLabelText('Company') as HTMLSelectElement;
    expect(company).toBeDisabled();
    expect(company.value).toBe('bank-1');
    expect(Array.from(company.options).map((o) => o.textContent)).toEqual(['Conductia Advisory']);
    expect(within(dialog).queryByText(/seller seat|buyer seat/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Access up to')).not.toBeInTheDocument();
  });

  it('holds the grouping until the viewer is known, so "Your firm" never flips', async () => {
    let answerMe: (response: Response) => void = () => {};
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/v1/me')) {
        return new Promise<Response>((resolve) => {
          answerMe = resolve;
        });
      }
      if (url.endsWith('/members')) return Promise.resolve(jsonResponse(200, MULTI));
      if (url.includes('/api/v1/invites?')) return Promise.resolve(jsonResponse(200, { invites: [] }));
      return Promise.resolve(jsonResponse(404, { error: 'unexpected fetch' }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <FlagsProvider value={FLAGS_ON}>
        <TeamPage />
      </FlagsProvider>,
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/members'))).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('region', { name: 'Your firm' })).toBeNull();
    expect(screen.queryByText('Storm Duncan')).toBeNull();

    answerMe(jsonResponse(200, ME_MD));
    expect(await screen.findByRole('region', { name: 'Your firm' })).toHaveTextContent('Storm Duncan');
    // Firm cards sit under the group heading: h2 group, h3 firm.
    expect(screen.getByRole('heading', { level: 2, name: 'Your firm' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Conductia Advisory' })).toBeInTheDocument();
  });
});
