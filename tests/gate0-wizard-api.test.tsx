import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import * as React from 'react';

import { Gate0Wizard } from '../src/components/wizard/Gate0Wizard';
import { invalidateLeadCatalog } from '../src/lib/leads/leadCatalog';
import { FlagsProvider } from '../src/lib/flags/FlagsContext';
import { SessionProvider, useSession } from '../src/lib/session/store';
import type { FlagMap } from '../src/lib/flags/resolveFlags';
import { getAllDeals } from '../src/lib/rail/deals';
import { firstStepAfterGate0 } from '../src/lib/rail/dealRail';
import { setStoreOwner } from '../src/lib/session/storeOwner';

/** Surfaces the shell compliance status so tests can assert the ribbon dispatch. */
function RibbonProbe() {
  const { state } = useSession();
  return <span data-testid="ribbon">{state.complianceStatus}</span>;
}

/*
 * Gate 0 wizard — flag-ON path (G10). With gate0_api_create enabled, complete()
 * POSTs to /api/v1/deals and routes to the returned deal CODE, and surfaces a
 * decisive error for each failure class. The fixture localStorage path must NOT
 * run when the flag is on.
 */

const pushSpy = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushSpy,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/projects',
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

const FLAGS_ON: FlagMap = {
  rail_templates: false,
  template_change_review: false,
  deal_data_room_nav: false,
  gate0_api_create: true,
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

function renderWizardFlagOn(flags: FlagMap = FLAGS_ON) {
  return render(
    <SessionProvider>
      <FlagsProvider value={flags}>
        <Gate0Wizard />
        <RibbonProbe />
      </FlagsProvider>
    </SessionProvider>,
  );
}

const NOTIFY_RECIPIENTS = [
  { id: 'cco-1', name: 'Pat Rivera', role: 'Chief Compliance Officer' },
];

function isNotifyRecipientsUrl(url: string): boolean {
  return url.includes('/notify-recipients');
}

/** Fixture leads the mocked GET /api/v1/companies?type=client returns. */
const LEAD_OPTIONS = [
  { id: 'canva-co', name: 'Canva', type: 'client' },
  { id: 'figma-co', name: 'Figma', type: 'client' },
  { id: 'notion-co', name: 'Notion', type: 'client' },
];

/** Mock themed code-name proposals (POST /api/v1/codenames/suggest). */
const MOCK_CODENAME_THEMES = {
  themes: [
    {
      id: 'birds',
      label: 'Birds',
      suggestions: [
        'Project Falcon',
        'Project Osprey',
        'Project Kestrel',
        'Project Heron',
        'Project Raven',
      ],
    },
    {
      id: 'football',
      label: 'Football',
      suggestions: [
        'Project Gunners',
        'Project Rovers',
        'Project Wanderers',
        'Project Rangers',
        'Project Albion',
      ],
    },
    {
      id: 'movies',
      label: 'Movies',
      suggestions: [
        'Project Meridian',
        'Project Vertex',
        'Project Halcyon',
        'Project Cascade',
        'Project Orion',
      ],
    },
  ],
  source: 'fallback',
};

function maybeCodenameSuggest(url: string): Response | null {
  if (url.includes('/api/v1/codenames/suggest')) {
    return jsonResponse(200, MOCK_CODENAME_THEMES);
  }
  return null;
}

/** Select a lead from the typeahead (types the name, clicks the matching option). */
async function selectLead(name: string) {
  fireEvent.change(screen.getByLabelText(/^lead$/i), { target: { value: name } });
  fireEvent.click(await screen.findByRole('option', { name }));
}

/** Select a lead and wait for the prefetched code-name themes. */
async function fillCodenameStep(target: string, codename = 'Project Meridian') {
  const leadInput = screen.getByLabelText(/^lead$/i);
  await waitFor(() => {
    fireEvent.change(leadInput, { target: { value: target } });
    expect(screen.getByRole('option', { name: target })).toBeInTheDocument();
  });
  fireEvent.click(screen.getByRole('option', { name: target }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText(/^code name$/i), { target: { value: codename } });
}

/** Local calendar date as YYYY-MM-DD — must mirror the wizard's localDateIso
 *  (NOT toISOString, which is UTC and drifts a day in non-UTC CI timezones). */
function localDateIso(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Fill the conflicts attestation sub-step (approver + confirmation; the date
 *  defaults to today). */
function fillConflicts(approver = 'Avery Lindqvist') {
  fireEvent.change(screen.getByLabelText(/approved by/i), {
    target: { value: approver },
  });
  fireEvent.click(screen.getByLabelText(/confirm the conflicts approval/i));
}

/** Drive the five sub-steps to the final "Create the mandate" button. */
async function walkToCreate(target = 'Canva', codename = 'Project Meridian') {
  renderWizardFlagOn();
  await act(async () => {});
  await fillCodenameStep(target, codename);
  fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → conflicts
  fillConflicts();
  fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → team
  fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → notify
  fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → entry
}

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

/**
 * URL-aware fetch stub. The wizard now also calls /me (useCurrentUser) and, when
 * a bank is resolvable, the roster + roles endpoints. /me returns 401 here so
 * useCurrentUser stays in error (no signed-in company → no roster fetch), which
 * keeps these tests focused on the create call to POST /api/v1/deals.
 */
function stubFetch(dealsResponse: Response | (() => Promise<never>)) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const codename = maybeCodenameSuggest(url);
    if (codename) return Promise.resolve(codename);
    if (url.endsWith('/api/v1/me')) return Promise.resolve(jsonResponse(401, { error: 'x' }));
    if (isNotifyRecipientsUrl(url)) {
      return Promise.resolve(jsonResponse(200, { recipients: NOTIFY_RECIPIENTS }));
    }
    if (url.includes('/members')) return Promise.resolve(jsonResponse(200, { members: [] }));
    if (url.endsWith('/api/v1/roles')) return Promise.resolve(jsonResponse(200, { roles: [] }));
    if (url.includes('/api/v1/companies')) {
      return Promise.resolve(jsonResponse(200, { companies: LEAD_OPTIONS }));
    }
    if (url.endsWith('/api/v1/deals')) {
      return typeof dealsResponse === 'function'
        ? dealsResponse()
        : Promise.resolve(dealsResponse);
    }
    return Promise.resolve(jsonResponse(200, {}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function mockFetchOnce(status: number, body: unknown) {
  return stubFetch(jsonResponse(status, body));
}

/** The single POST /api/v1/deals call, for payload assertions. */
function dealsCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] | undefined {
  const call = fetchMock.mock.calls.find(
    (c) => String((c as unknown[])[0]).endsWith('/api/v1/deals'),
  );
  return call as unknown as [string, RequestInit] | undefined;
}

beforeEach(() => {
  pushSpy.mockClear();
  window.localStorage.clear();
  invalidateLeadCatalog();
  // The signed-in creator, as the shell's auth listener knows them: the Gate 0
  // receipt is stamped with, and only handed back to, this user (#162).
  setStoreOwner('user-md');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setStoreOwner(null);
});

describe('Gate0Wizard — flag on (API create)', () => {
  it('guides the MD to the Leads page when no leads are registered yet', async () => {
    // /companies returns no leads; before typing anything, the code-name step
    // shows a decisive empty state pointing at /leads (not a silent blank).
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const codename = maybeCodenameSuggest(url);
        if (codename) return Promise.resolve(codename);
        if (url.endsWith('/api/v1/me')) return Promise.resolve(jsonResponse(401, { error: 'x' }));
        if (url.includes('/api/v1/companies'))
          return Promise.resolve(jsonResponse(200, { companies: [] }));
        return Promise.resolve(jsonResponse(200, {}));
      }),
    );
    renderWizardFlagOn();
    await act(async () => {});
    expect(
      await screen.findByText(/no leads registered yet\. add one on the leads page/i),
    ).toBeInTheDocument();
  });

  it('POSTs the Gate 0 payload and routes to the returned deal code', async () => {
    const fetchMock = mockFetchOnce(201, { deal: { code: 'MERID-2026-123' } });
    await walkToCreate('Canva', 'Project Meridian');

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));

    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith('/projects/MERID-2026-123/rail?new=1'),
    );

    const call = dealsCall(fetchMock);
    expect(call).toBeDefined();
    const [, init] = call!;
    expect(init.method).toBe('POST');
    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(payload).toMatchObject({
      codename: 'Project Meridian',
      targetCompanyId: 'canva-co',
      // Defaults to the first MVP-rail step (the pre-project New Business
      // Development steps are not offered as an entry point).
      entryStepSeq: firstStepAfterGate0()!.seq,
      conflictsAttestation: {
        approvedBy: 'Avery Lindqvist',
        approvedOn: localDateIso(),
      },
    });
    expect(payload.codenameTheme).toBeTruthy();
    // Members is an array (empty here — no roster interaction in this test).
    expect(Array.isArray(payload.members)).toBe(true);

    // COMPLIANCE: the fixture localStorage path did NOT run (no local deal).
    expect(getAllDeals().find((d) => d.id === 'project-meridian')).toBeUndefined();

    // No screening in the response → the ribbon goes green (clear) on success.
    await waitFor(() => expect(screen.getByTestId('ribbon')).toHaveTextContent('clear'));
  });

  it('posts the step the MD chose as entryStepSeq', async () => {
    const fetchMock = mockFetchOnce(201, { deal: { code: 'MERID-2026-124' } });
    await walkToCreate('Canva', 'Project Meridian');

    const select = screen.getByRole('combobox', { name: 'Starting step' });
    expect(select).toBeEnabled();
    expect(select).toHaveValue(String(firstStepAfterGate0()!.seq));
    fireEvent.change(select, { target: { value: '48' } });
    expect(screen.getByRole('option', { name: '44 · LOI Review' })).toHaveValue('48');

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));
    await waitFor(() => expect(pushSpy).toHaveBeenCalled());

    const payload = JSON.parse(dealsCall(fetchMock)![1].body as string) as Record<string, unknown>;
    expect(payload.entryStepSeq).toBe(48);
  });

  it('signals completion (closes the dialog) after a successful create', async () => {
    // Regression: the success path navigated but never closed the modal, so the
    // dialog — mounted in the persistent shell — stayed stuck on "Creating…".
    const onComplete = vi.fn();
    mockFetchOnce(201, { deal: { code: 'MERID-2026-123' } });
    render(
      <SessionProvider>
        <FlagsProvider value={FLAGS_ON}>
          <Gate0Wizard onComplete={onComplete} />
        </FlagsProvider>
      </SessionProvider>,
    );
    await act(async () => {});
    await fillCodenameStep('Canva', 'Project Meridian');
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → conflicts
    fillConflicts();
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → team
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → notify
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → entry

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));

    await waitFor(() => expect(pushSpy).toHaveBeenCalled());
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('drives the shell ribbon from the returned screening verdict', async () => {
    stubFetch(jsonResponse(201, { deal: { code: 'MERID-2026-7' }, screening: { verdict: 'hold' } }));
    await walkToCreate('Canva', 'Project Meridian');

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));

    await waitFor(() => expect(pushSpy).toHaveBeenCalled());
    // 'hold' verdict → ribbon reflects a hold, not a fabricated pass.
    expect(screen.getByTestId('ribbon')).toHaveTextContent('hold');
  });

  it.each([
    [422, /must not contain the target name/i],
    [409, /already in use on a live deal/i],
    [400, /details are incomplete/i],
    [503, /unavailable right now/i],
    [500, /something went wrong/i],
  ])('surfaces a decisive error on %i and does not navigate', async (status, matcher) => {
    mockFetchOnce(status, { error: 'x' });
    await walkToCreate('Figma', 'Project Vertex');

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(matcher);
    expect(pushSpy).not.toHaveBeenCalled();
    // Retryable: the button is enabled again.
    expect(screen.getByRole('button', { name: 'Create the mandate' })).toBeEnabled();
  });

  it('surfaces a network error when the request rejects', async () => {
    stubFetch(() => Promise.reject(new Error('offline')));
    await walkToCreate('Notion', 'Project Atlas');

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/network error/i);
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

describe('Gate0Wizard — flag on, real roster (G11)', () => {
  /** URL-aware stub with an authenticated MD, a bank roster, and roles. */
  function stubWithRoster() {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const codename = maybeCodenameSuggest(url);
      if (codename) return Promise.resolve(codename);
      if (url.endsWith('/api/v1/me')) {
        return Promise.resolve(
          jsonResponse(200, {
            user: {
              id: 'md-1',
              email: 'md@bank.dev',
              full_name: 'Storm Duncan',
              display_name: 'Storm Duncan',
              firm_role: null,
              department: 'ib',
              is_external: false,
              status: 'active',
              company_id: 'bank-1',
            },
            memberships: [],
            mandate: null,
          }),
        );
      }
      if (isNotifyRecipientsUrl(url)) {
        return Promise.resolve(jsonResponse(200, { recipients: NOTIFY_RECIPIENTS }));
      }
      if (url.includes('/api/v1/companies') && !url.includes('/members')) {
        return Promise.resolve(jsonResponse(200, { companies: LEAD_OPTIONS }));
      }
      if (url.includes('/companies/bank-1/members')) {
        return Promise.resolve(
          jsonResponse(200, {
            members: [
              {
                id: 'jw-1',
                full_name: 'James Watt',
                display_name: 'James Watt',
                email: 'james@bank.dev',
                department: 'ib',
                firm_role: null,
                company_role: 'member',
                preferred_deal_role: 'legal',
              },
              {
                id: 'cco-1',
                full_name: 'Pat Rivera',
                display_name: 'Pat Rivera',
                email: 'cco@bank.dev',
                department: 'compliance',
                firm_role: 'cco',
                company_role: 'director',
                preferred_deal_role: null,
              },
            ],
          }),
        );
      }
      if (url.endsWith('/api/v1/roles')) {
        return Promise.resolve(
          jsonResponse(200, {
            roles: [
              { slug: 'md', permissions: ['deal:full'] },
              { slug: 'deal_team', permissions: ['deal:read'] },
            ],
          }),
        );
      }
      if (url.endsWith('/api/v1/deals')) {
        return Promise.resolve(jsonResponse(201, { deal: { code: 'MERID-2026-9' } }));
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('renders the real roster, locks the creator as MD, and sends selected members', async () => {
    const fetchMock = stubWithRoster();
    renderWizardFlagOn();
    await act(async () => {});
    await fillCodenameStep('Canva', 'Project Meridian');
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → conflicts
    fillConflicts();
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → team

    // The creator is the locked MD seat; the colleague is opt-in.
    expect(
      await screen.findByLabelText('Storm Duncan · Managing Director'),
    ).toBeDisabled();
    const colleague = await screen.findByLabelText('James Watt');
    expect(colleague).not.toBeChecked();
    fireEvent.click(colleague);
    expect(colleague).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → notify
    expect(await screen.findByText('Pat Rivera')).toBeInTheDocument();
    expect(screen.getByText('Chief Compliance Officer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → entry
    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));

    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith('/projects/MERID-2026-9/rail?new=1'),
    );

    const call = dealsCall(fetchMock);
    const payload = JSON.parse((call![1].body as string)) as {
      members: Array<{ userId: string; dealRole: string }>;
    };
    // The creator is NOT in members (seated as MD server-side); the colleague is,
    // defaulting to deal_team.
    expect(payload.members).toEqual([{ userId: 'jw-1', dealRole: 'deal_team' }]);
  });

  it('the team step speaks plainly: no permission slugs, department names spaced from the name', async () => {
    stubWithRoster();
    renderWizardFlagOn();
    await act(async () => {});
    await fillCodenameStep('Canva', 'Project Meridian');
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → conflicts
    fillConflicts();
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → team
    fireEvent.click(await screen.findByLabelText('James Watt'));

    expect(screen.getByText('Runs the deal and signs off.')).toBeInTheDocument();
    expect(screen.getByText('Works the deal day to day.')).toBeInTheDocument();
    expect(screen.getByText('Investment banking')).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    for (const slug of ['deal:full', 'deal:read', 'acquirer:full', 'scoring:edit', 'team:manage', 'compliance:verdicts']) {
      expect(text, slug).not.toContain(slug);
    }
    expect(text).not.toMatch(/(Storm Duncan|James Watt)(ib|legal)/);
    expect(text).not.toMatch(/James Watt\s*ib\b/);
  });

  it('says so on notify when no one is assigned to receive new-mandate notices', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const codename = maybeCodenameSuggest(url);
        if (codename) return Promise.resolve(codename);
        if (url.endsWith('/api/v1/me')) {
          return Promise.resolve(
            jsonResponse(200, {
              user: {
                id: 'md-1',
                email: 'md@bank.dev',
                full_name: 'Storm Duncan',
                display_name: 'Storm Duncan',
                firm_role: null,
                department: 'ib',
                is_external: false,
                status: 'active',
                company_id: 'bank-1',
              },
              memberships: [],
              mandate: null,
            }),
          );
        }
        if (isNotifyRecipientsUrl(url)) {
          return Promise.resolve(jsonResponse(200, { recipients: [] }));
        }
        if (url.includes('/api/v1/companies') && !url.includes('/members')) {
          return Promise.resolve(jsonResponse(200, { companies: LEAD_OPTIONS }));
        }
        if (url.includes('/companies/bank-1/members')) {
          return Promise.resolve(
            jsonResponse(200, {
              members: [
                {
                  id: 'jw-1',
                  full_name: 'James Watt',
                  display_name: 'James Watt',
                  email: 'james@bank.dev',
                  department: 'ib',
                  firm_role: null,
                  company_role: 'member',
                  preferred_deal_role: 'legal',
                },
              ],
            }),
          );
        }
        if (url.endsWith('/api/v1/roles')) {
          return Promise.resolve(jsonResponse(200, { roles: [] }));
        }
        return Promise.resolve(jsonResponse(200, {}));
      }),
    );
    renderWizardFlagOn();
    await act(async () => {});
    await fillCodenameStep('Canva', 'Project Meridian');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fillConflicts();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(
      await screen.findByText('No one is assigned to receive new-mandate notices'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The mandate cannot be created until someone will receive this notice/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Pat Rivera')).toBeNull();
    // Blocked here, beside the reason, not at a bare disabled Create on Entry.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: 'Notify Compliance' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create the mandate' })).toBeNull();
  });

  it('offers the loaded roster as approver suggestions and still accepts a free-typed name', async () => {
    stubWithRoster();
    renderWizardFlagOn();
    await act(async () => {});
    await fillCodenameStep('Canva', 'Project Meridian');
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → conflicts

    // "Approved by" is a custom combobox: focusing opens the roster suggestions.
    const approver = screen.getByLabelText(/approved by/i) as HTMLInputElement;
    expect(approver).toHaveAttribute('role', 'combobox');
    fireEvent.focus(approver);
    const option = await screen.findByRole('option', { name: 'James Watt' });

    // Selecting a suggestion fills the input.
    fireEvent.mouseDown(option);
    expect(approver.value).toBe('James Watt');

    // The approver may be a senior partner who is not on the roster: free text holds.
    fireEvent.change(approver, { target: { value: 'Dana Rios' } });
    expect(approver.value).toBe('Dana Rios');
  });

  it('prefills a colleague role from the preference only when onboarding is enabled', async () => {
    stubWithRoster();
    renderWizardFlagOn({ ...FLAGS_ON, platform_onboarding: true });
    await act(async () => {});
    await fillCodenameStep('Canva', 'Project Meridian');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fillConflicts();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    fireEvent.click(await screen.findByLabelText('James Watt'));
    const role = screen.getByLabelText('Deal role for James Watt') as HTMLSelectElement;
    expect(role.value).toBe('legal');
    expect([...role.options].map((option) => option.value)).toEqual([
      'deal_team',
      'legal',
      'read_only',
    ]);
  });

  it('shows a distinct error (not the empty-state) when the roster fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const codename = maybeCodenameSuggest(url);
        if (codename) return Promise.resolve(codename);
        if (url.endsWith('/api/v1/me')) {
          return Promise.resolve(
            jsonResponse(200, {
              user: {
                id: 'md-1',
                email: 'md@bank.dev',
                full_name: 'Storm Duncan',
                display_name: 'Storm Duncan',
                firm_role: null,
                department: 'ib',
                is_external: false,
                status: 'active',
                company_id: 'bank-1',
              },
              memberships: [],
              mandate: null,
            }),
          );
        }
        if (isNotifyRecipientsUrl(url)) {
          return Promise.resolve(jsonResponse(200, { recipients: NOTIFY_RECIPIENTS }));
        }
        if (url.includes('/members')) return Promise.resolve(jsonResponse(500, { error: 'boom' }));
        if (url.endsWith('/api/v1/roles')) return Promise.resolve(jsonResponse(200, { roles: [] }));
        if (url.includes('/api/v1/companies')) {
          return Promise.resolve(jsonResponse(200, { companies: LEAD_OPTIONS }));
        }
        return Promise.resolve(jsonResponse(200, {}));
      }),
    );

    renderWizardFlagOn();
    await act(async () => {});
    await fillCodenameStep('Canva', 'Project Meridian');
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → conflicts
    fillConflicts();
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → team

    // A failed roster load surfaces a decisive error, never the "no colleagues" copy.
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load your colleagues/i);
    expect(screen.queryByText(/no eligible colleagues/i)).not.toBeInTheDocument();
  });
});

describe('Gate0Wizard — invite by email (platform_onboarding)', () => {
  /** URL-aware stub: authenticated MD at bank-1, empty roster, a create that
   *  returns the deal id, and a working POST /api/v1/invites. */
  function stubWithInvites() {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const codename = maybeCodenameSuggest(url);
      if (codename) return Promise.resolve(codename);
      if (url.endsWith('/api/v1/me')) {
        return Promise.resolve(
          jsonResponse(200, {
            user: {
              id: 'md-1',
              email: 'md@bank.dev',
              full_name: 'Storm Duncan',
              display_name: 'Storm Duncan',
              firm_role: null,
              department: 'ib',
              is_external: false,
              status: 'active',
              company_id: 'bank-1',
            },
            memberships: [],
            mandate: null,
          }),
        );
      }
      if (isNotifyRecipientsUrl(url)) {
        return Promise.resolve(jsonResponse(200, { recipients: NOTIFY_RECIPIENTS }));
      }
      if (url.includes('/members')) return Promise.resolve(jsonResponse(200, { members: [] }));
      if (url.endsWith('/api/v1/roles')) return Promise.resolve(jsonResponse(200, { roles: [] }));
      if (url.includes('/api/v1/companies')) {
        return Promise.resolve(jsonResponse(200, { companies: LEAD_OPTIONS }));
      }
      if (url.endsWith('/api/v1/deals')) {
        return Promise.resolve(
          jsonResponse(201, { deal: { id: 'deal-uuid-1', code: 'MERID-2026-9' } }),
        );
      }
      if (url.endsWith('/api/v1/invites/preflight') && init?.method === 'POST') {
        const request = JSON.parse(init.body as string) as { email: string };
        return Promise.resolve(
          jsonResponse(200, {
            normalizedEmail: request.email.trim().toLowerCase(),
            classification: 'match',
            confirmationRequired: false,
          }),
        );
      }
      if (url.endsWith('/api/v1/invites') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(201, { invite: { id: 'inv-1', deliveryStatus: 'sent' } }),
        );
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function renderWizard(flags: FlagMap) {
    return render(
      <SessionProvider>
        <FlagsProvider value={flags}>
          <Gate0Wizard />
        </FlagsProvider>
      </SessionProvider>,
    );
  }

  async function walkToTeam() {
    await act(async () => {});
    await fillCodenameStep('Canva', 'Project Meridian');
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → conflicts
    fillConflicts();
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → team
  }

  it('flag off: no affordance and the original copy holds', async () => {
    stubWithInvites();
    renderWizard(FLAGS_ON); // platform_onboarding: false
    await walkToTeam();

    expect(screen.getByText(/invite by email comes later/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add invitation' })).not.toBeInTheDocument();
  });

  it('flag on: queues chips (rejecting duplicates inline), fires the invites after create, and stashes their delivery on the receipt', async () => {
    const fetchMock = stubWithInvites();
    renderWizard({ ...FLAGS_ON, platform_onboarding: true });
    await walkToTeam();

    // The copy acknowledges queued invites send at create; the old copy is gone.
    expect(screen.getByText(/invitations send when the mandate is created/i)).toBeInTheDocument();
    expect(screen.queryByText(/invite by email comes later/i)).not.toBeInTheDocument();

    // Queue one colleague; a duplicate (case-insensitive) is rejected inline.
    const email = screen.getByLabelText(/^email$/i);
    fireEvent.change(email, { target: { value: 'Nina@bank.dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check and add invitation' }));
    expect(await screen.findByText('nina@bank.dev')).toBeInTheDocument();
    fireEvent.change(email, { target: { value: 'nina@BANK.dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check and add invitation' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/already queued/i));

    // A queued chip can be removed before create; re-queue it after.
    fireEvent.click(screen.getByRole('button', { name: 'Remove the invitation for nina@bank.dev' }));
    expect(screen.queryByText('nina@bank.dev')).not.toBeInTheDocument();
    fireEvent.change(email, { target: { value: 'nina@bank.dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check and add invitation' }));
    await screen.findByText('nina@bank.dev');

    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → notify
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → entry
    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));

    // Close-on-success (#112) still holds; the invite fired before the close.
    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith('/projects/MERID-2026-9/rail?new=1'),
    );
    const inviteCall = fetchMock.mock.calls.find(
      (c) => String((c as unknown[])[0]).endsWith('/api/v1/invites'),
    ) as unknown as [string, RequestInit] | undefined;
    expect(inviteCall).toBeDefined();
    expect(JSON.parse(inviteCall![1].body as string)).toEqual({
      email: 'nina@bank.dev',
      companyId: 'bank-1',
      companyRole: 'member',
      dealId: 'deal-uuid-1',
      dealRole: 'deal_team',
    });

    // The delivery outcome rides the Gate 0 receipt for the rail landing.
    const stashed = window.sessionStorage.getItem('ib-gate0-receipt:MERID-2026-9');
    expect(stashed).toBeTruthy();
    expect(JSON.parse(stashed!).uid).toBe('user-md');
    expect(JSON.parse(stashed!).invites).toEqual([
      { email: 'nina@bank.dev', state: 'sent' },
    ]);
  });
  // D8.6: the second invitation surface. Gate 0 composes invitations before the
  // deal exists, so the lookup runs with no deal context and the preview is
  // seat-only. What matters here is that the card appears on this surface and
  // that a failing lookup cannot block or bypass the queue's own gate.
  it('flag on: the lookup card appears for a plausible address on the Team step', async () => {
    const inner = stubWithInvites();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (String(url).includes('/invites/lookup')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                normalizedEmail: 'nina@bank.dev',
                domain: 'bank.dev',
                companyMatch: { companyId: 'bank-1', companyName: 'Advisory Bank' },
                proposedCompany: null,
                warnings: [],
                recommendation: {
                  dealRole: 'deal_team',
                  companyRole: 'member',
                  phase: 0,
                  reasons: { dealRole: 'bank_internal_seat', phase: 'phase_not_applicable_internal' },
                },
              }),
          } as Response);
        }
        return (inner as unknown as typeof fetch)(url, init);
      }),
    );

    renderWizard({ ...FLAGS_ON, platform_onboarding: true });
    await walkToTeam();

    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'nina@bank.dev' } });

    const card = await screen.findByTestId('smart-lookup-card');
    await waitFor(() => expect(card.getAttribute('data-status')).toBe('ready'));
    expect(screen.getByText(/Advisory Bank/)).toBeInTheDocument();
  });

  it('flag on: a failing lookup degrades neutrally and still lets the invitation queue', async () => {
    const inner = stubWithInvites();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (String(url).includes('/invites/lookup')) {
          return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) } as Response);
        }
        return (inner as unknown as typeof fetch)(url, init);
      }),
    );

    renderWizard({ ...FLAGS_ON, platform_onboarding: true });
    await walkToTeam();

    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'nina@bank.dev' } });
    await waitFor(() =>
      expect(screen.getByTestId('smart-lookup-card').getAttribute('data-status')).toBe('unavailable'),
    );

    // The queue is unaffected: the inviter can still add the invitation, and the
    // wizard's own confirmation path is what governs it.
    fireEvent.click(screen.getByRole('button', { name: 'Check and add invitation' }));
    expect(await screen.findByText('nina@bank.dev')).toBeInTheDocument();
  });
});

describe('Gate0Wizard — saved rails (rail_templates)', () => {
  const RAIL_FLAGS: FlagMap = {
    ...FLAGS_ON,
    rail_templates: true,
    project_rail_model: true,
  };

  const SAVED_RAIL = {
    id: '33333333-3333-4333-8333-333333333333',
    revisionId: '44444444-4444-4444-8444-444444444444',
    name: 'Technology sell-side',
    description: 'Standard technology process.',
    stepCount: 3,
    skillCount: 1,
    updatedAt: '2026-09-20T12:00:00.000Z',
  };

  const SAVED_RAIL_PREVIEW = {
    ...SAVED_RAIL,
    steps: [{ title: 'Mandate kickoff', phaseIndex: 1, displayOrder: 1 }],
  };

  const REQUEST_ID = '77777777-7777-4777-8777-777777777777';
  const CREATION_KEY = 'rail-template-create:md-1';

  const MD_ME = {
    user: {
      id: 'md-1',
      email: 'md@bank.dev',
      full_name: 'Storm Duncan',
      display_name: 'Storm Duncan',
      firm_role: null,
      department: 'ib',
      is_external: false,
      status: 'active',
      company_id: 'bank-1',
    },
    memberships: [],
    mandate: null,
  };

  const FROZEN_INPUT = {
    tenantId: 'tenant-1',
    actorId: 'md-1',
    bankId: 'bank-1',
    codename: 'Project Meridian',
    targetName: null,
    targetCompanyId: 'canva-co',
    codenameTheme: 'Movies',
    members: [],
    screening: { verdict: 'compliant', reasons: [] },
    conflicts: { approvedBy: 'Avery Lindqvist', approvedOn: '2026-09-20' },
  };

  const RESUME_RECEIPT = {
    deal: { id: 'deal-1', code: 'MERID-2026-9' },
    memberships: [],
    notified: [{ userId: 'cco-1', at: '2026-09-21T10:00:00.000Z' }],
    screening: { verdict: 'hold', reasons: ['Flagged'] },
  };

  type RailStub = {
    deals?: Response[];
    me?: Response | 'pending';
    list?: Response;
    read?: Response;
    resume?: Response;
  };

  function stubSavedRails(options: RailStub = {}) {
    const dealsQueue = [
      ...(options.deals ?? [
        jsonResponse(201, { deal: { id: 'deal-1', code: 'MERID-2026-9' } }),
      ]),
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const codename = maybeCodenameSuggest(url);
      if (codename) return Promise.resolve(codename);
      if (url.endsWith('/api/v1/me')) {
        if (options.me === 'pending') return new Promise<Response>(() => {});
        return Promise.resolve(options.me ?? jsonResponse(200, MD_ME));
      }
      if (url.includes('/api/v1/deals/template-creations/')) {
        return Promise.resolve(
          method === 'POST'
            ? (options.resume ?? jsonResponse(404, { error: 'gone' }))
            : (options.read ?? jsonResponse(404, { error: 'gone' })),
        );
      }
      if (url.startsWith('/api/v1/rail-templates?')) {
        return Promise.resolve(
          options.list ?? jsonResponse(200, { templates: [SAVED_RAIL] }),
        );
      }
      if (url.startsWith('/api/v1/rail-templates/')) {
        return Promise.resolve(jsonResponse(200, SAVED_RAIL_PREVIEW));
      }
      if (isNotifyRecipientsUrl(url)) {
        return Promise.resolve(jsonResponse(200, { recipients: NOTIFY_RECIPIENTS }));
      }
      if (url.includes('/members')) return Promise.resolve(jsonResponse(200, { members: [] }));
      if (url.endsWith('/api/v1/roles')) return Promise.resolve(jsonResponse(200, { roles: [] }));
      if (url.includes('/api/v1/companies')) {
        return Promise.resolve(jsonResponse(200, { companies: LEAD_OPTIONS }));
      }
      if (url.endsWith('/api/v1/deals') && method === 'POST') {
        return Promise.resolve(
          dealsQueue.shift() ?? jsonResponse(500, { error: 'no queued create' }),
        );
      }
      if (url.endsWith('/api/v1/invites/preflight') && method === 'POST') {
        return Promise.resolve(
          jsonResponse(200, { classification: 'match', confirmationRequired: false }),
        );
      }
      if (url.endsWith('/api/v1/invites') && method === 'POST') {
        return Promise.resolve(
          jsonResponse(201, { invite: { id: 'inv-1', deliveryStatus: 'sent' } }),
        );
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const railSelect = () => screen.getByRole('combobox', { name: 'Rail' });

  async function chooseSavedRail() {
    await screen.findByRole('option', { name: SAVED_RAIL.name });
    fireEvent.change(railSelect(), { target: { value: SAVED_RAIL.id } });
    await screen.findByRole('list', { name: 'Saved rail steps' });
  }

  async function walkToCreate(flags: FlagMap, choose: boolean) {
    renderWizardFlagOn(flags);
    await act(async () => {});
    await fillCodenameStep('Canva', 'Project Meridian');
    if (choose) await chooseSavedRail();
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → conflicts
    fillConflicts();
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → team
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → notify
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → entry
  }

  function createPayload(fetchMock: ReturnType<typeof vi.fn>) {
    const call = dealsCall(fetchMock);
    expect(call).toBeDefined();
    return JSON.parse(call![1].body as string) as Record<string, unknown>;
  }

  function createPayloads(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls
      .filter((c) => String((c as unknown[])[0]).endsWith('/api/v1/deals'))
      .map((c) => JSON.parse(((c as unknown[])[1] as RequestInit).body as string));
  }

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('offers no rail choice when saved rails are off', async () => {
    const fetchMock = stubSavedRails();
    renderWizardFlagOn(FLAGS_ON);
    await act(async () => {});
    await fillCodenameStep('Canva', 'Project Meridian');

    expect(screen.queryByRole('combobox', { name: 'Rail' })).toBeNull();
    expect(
      fetchMock.mock.calls.filter((c) =>
        String((c as unknown[])[0]).includes('/api/v1/rail-templates'),
      ),
    ).toHaveLength(0);
  });

  it('sends the chosen saved rail under one request id and keeps the id for recovery', async () => {
    const fetchMock = stubSavedRails();
    await walkToCreate(RAIL_FLAGS, true);

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));
    await waitFor(() => expect(pushSpy).toHaveBeenCalled());

    const payload = createPayload(fetchMock);
    expect(payload.railTemplate).toEqual({
      templateId: SAVED_RAIL.id,
      revisionId: SAVED_RAIL.revisionId,
    });
    expect(payload.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(window.sessionStorage.getItem(CREATION_KEY)).toBeNull();
  });

  it('disables the entry step for a saved rail and sends the default seq', async () => {
    const fetchMock = stubSavedRails();
    await walkToCreate(RAIL_FLAGS, true);

    expect(screen.getByRole('combobox', { name: 'Starting step' })).toBeDisabled();
    expect(screen.getByText('A saved rail opens at its first step.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));
    await waitFor(() => expect(pushSpy).toHaveBeenCalled());

    expect(createPayload(fetchMock).entryStepSeq).toBe(firstStepAfterGate0()!.seq);
  });

  it('refuses to submit a saved rail before the actor is confirmed', async () => {
    const fetchMock = stubSavedRails({ me: 'pending' });
    await walkToCreate(RAIL_FLAGS, true);

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Conductia has not confirmed your identity yet. Try again in a moment.',
    );
    expect(dealsCall(fetchMock)).toBeUndefined();
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('returns the MD to the rail choice when the saved rail changed since the preview', async () => {
    const fetchMock = stubSavedRails({
      deals: [
        jsonResponse(409, {
          error: 'That saved rail changed while you were working.',
          code: 'stale_template',
          retryable: false,
        }),
      ],
    });
    await walkToCreate(RAIL_FLAGS, true);

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This saved rail changed. Review the updated rail and try again.',
    );
    expect(pushSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(railSelect()).toHaveValue('standard'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter((c) =>
          String((c as unknown[])[0]).startsWith('/api/v1/rail-templates?'),
        ).length,
      ).toBeGreaterThan(1),
    );
    expect(window.sessionStorage.getItem(CREATION_KEY)).toBeNull();
  });

  it('releases the request when the code name is already on a live deal', async () => {
    const fetchMock = stubSavedRails({
      deals: [
        jsonResponse(409, {
          error: 'That code name is already in use on a live deal. Pick another.',
          code: 'codename_taken',
          retryable: false,
        }),
        jsonResponse(201, { deal: { id: 'deal-1', code: 'MERID-2026-9' } }),
      ],
    });
    await walkToCreate(RAIL_FLAGS, true);

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That code name is already in use on a live deal. Pick another.',
    );
    expect(pushSpy).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(CREATION_KEY)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));

    await waitFor(() => expect(pushSpy).toHaveBeenCalled());
    const requestIds = fetchMock.mock.calls
      .filter((c) => String((c as unknown[])[0]).endsWith('/api/v1/deals'))
      .map(
        (c) =>
          JSON.parse(String(((c as unknown[])[1] as RequestInit).body)).requestId,
      );
    expect(requestIds).toHaveLength(2);
    expect(requestIds[1]).not.toBe(requestIds[0]);
  });

  it('retries a retryable failure under the same request id and revision', async () => {
    const fetchMock = stubSavedRails({
      deals: [
        jsonResponse(503, {
          error: 'Skill retention did not complete, so nothing changed.',
          code: 'provider_unavailable',
          retryable: true,
        }),
        jsonResponse(201, { deal: { id: 'deal-1', code: 'MERID-2026-9' } }),
      ],
    });
    await walkToCreate(RAIL_FLAGS, true);

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Skill retention did not complete, so nothing changed.',
    );
    expect(window.sessionStorage.getItem(CREATION_KEY)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));
    await waitFor(() => expect(pushSpy).toHaveBeenCalled());

    const payloads = createPayloads(fetchMock) as Array<Record<string, unknown>>;
    expect(payloads).toHaveLength(2);
    expect(payloads[1].requestId).toBe(payloads[0].requestId);
    expect(payloads[1].railTemplate).toEqual(payloads[0].railTemplate);
  });

  it('abandons a pending command explicitly before a new one is started', async () => {
    const fetchMock = stubSavedRails({
      deals: [
        jsonResponse(503, { error: 'down', code: 'provider_unavailable', retryable: true }),
        jsonResponse(201, { deal: { id: 'deal-1', code: 'MERID-2026-9' } }),
      ],
    });
    await walkToCreate(RAIL_FLAGS, true);

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));
    await screen.findByRole('alert');
    const first = (createPayloads(fetchMock)[0] as Record<string, unknown>).requestId;

    fireEvent.click(screen.getByRole('button', { name: 'Abandon and start over' }));
    expect(window.sessionStorage.getItem(CREATION_KEY)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));
    await waitFor(() => expect(pushSpy).toHaveBeenCalled());
    const payloads = createPayloads(fetchMock) as Array<Record<string, unknown>>;
    expect(payloads[1].requestId).not.toBe(first);
  });

  it('keeps a request id the server says is already admitted', async () => {
    const fetchMock = stubSavedRails({
      deals: [
        jsonResponse(503, {
          error: 'Skill retention did not complete, so nothing changed.',
          code: 'provider_unavailable',
          retryable: true,
        }),
        jsonResponse(409, {
          error: 'That save was already started with different details.',
          code: 'idempotency_conflict',
          retryable: false,
        }),
      ],
      read: jsonResponse(200, {
        selection: { templateId: SAVED_RAIL.id, revisionId: SAVED_RAIL.revisionId },
        input: FROZEN_INPUT,
        state: 'preparing',
      }),
    });
    await walkToCreate(RAIL_FLAGS, true);

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));
    await screen.findByRole('alert');
    const admitted = window.sessionStorage.getItem(CREATION_KEY);
    expect(admitted).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));

    expect(
      await screen.findByRole('button', { name: 'Resume the mandate' }),
    ).toBeEnabled();
    expect(window.sessionStorage.getItem(CREATION_KEY)).toBe(admitted);
    const payloads = createPayloads(fetchMock) as Array<Record<string, unknown>>;
    expect(payloads).toHaveLength(2);
    expect(payloads[1].requestId).toBe(admitted);
  });

  it('keeps the command when a skill on the saved rail is unavailable', async () => {
    const fetchMock = stubSavedRails({
      deals: [
        jsonResponse(409, {
          error: 'Skills are not enabled here, so this rail was not used.',
          code: 'skill_unavailable',
          retryable: false,
        }),
        jsonResponse(409, {
          error: 'Skills are not enabled here, so this rail was not used.',
          code: 'skill_unavailable',
          retryable: false,
        }),
      ],
    });
    await walkToCreate(RAIL_FLAGS, true);

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Skills are not enabled here, so this rail was not used.',
    );
    const admitted = window.sessionStorage.getItem(CREATION_KEY);
    expect(admitted).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));
    await waitFor(() => expect(createPayloads(fetchMock)).toHaveLength(2));

    const payloads = createPayloads(fetchMock) as Array<Record<string, unknown>>;
    expect(payloads[1].requestId).toBe(admitted);
    expect(window.sessionStorage.getItem(CREATION_KEY)).toBe(admitted);
  });

  it('resumes a creation interrupted by a reload and stashes the real receipt', async () => {
    window.sessionStorage.setItem(CREATION_KEY, REQUEST_ID);
    const fetchMock = stubSavedRails({
      read: jsonResponse(200, {
        selection: { templateId: SAVED_RAIL.id, revisionId: SAVED_RAIL.revisionId },
        input: FROZEN_INPUT,
        state: 'preparing',
      }),
      resume: jsonResponse(200, RESUME_RECEIPT),
    });
    renderWizardFlagOn(RAIL_FLAGS);

    const resume = await screen.findByRole('button', { name: 'Resume the mandate' });
    expect(screen.getByText(/Project Meridian/)).toBeInTheDocument();
    expect(
      screen.getByText(
        'Queued invitations were not restored. Invite anyone remaining from Team once the mandate opens.',
      ),
    ).toBeVisible();

    expect(
      screen.getByText(`Saved rail ${SAVED_RAIL.name}.`),
    ).toBeVisible();

    fireEvent.click(resume);

    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith('/projects/MERID-2026-9/rail?new=1'),
    );
    expect(dealsCall(fetchMock)).toBeUndefined();
    expect(screen.getByTestId('ribbon')).toHaveTextContent('hold');
    const stashed = window.sessionStorage.getItem('ib-gate0-receipt:MERID-2026-9');
    expect(JSON.parse(stashed!)).toMatchObject({
      verdict: 'hold',
      recipients: 1,
      at: '2026-09-21T10:00:00.000Z',
    });
    expect(window.sessionStorage.getItem(CREATION_KEY)).toBeNull();
  });

  it('replays a ready receipt without creating a second mandate', async () => {
    window.sessionStorage.setItem(CREATION_KEY, REQUEST_ID);
    const fetchMock = stubSavedRails({
      read: jsonResponse(200, {
        selection: { templateId: SAVED_RAIL.id, revisionId: SAVED_RAIL.revisionId },
        input: FROZEN_INPUT,
        state: 'ready',
      }),
      resume: jsonResponse(200, RESUME_RECEIPT),
    });
    renderWizardFlagOn(RAIL_FLAGS);

    fireEvent.click(await screen.findByRole('button', { name: 'Resume the mandate' }));

    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith('/projects/MERID-2026-9/rail?new=1'),
    );
    expect(dealsCall(fetchMock)).toBeUndefined();
    expect(
      fetchMock.mock.calls.filter(
        (c) =>
          String((c as unknown[])[0]).includes('/template-creations/') &&
          ((c as unknown[])[1] as RequestInit | undefined)?.method === 'POST',
      ),
    ).toHaveLength(1);
  });

  it('keeps the command when a resume fails for a reason other than it being gone', async () => {
    window.sessionStorage.setItem(CREATION_KEY, REQUEST_ID);
    stubSavedRails({
      read: jsonResponse(200, {
        selection: { templateId: SAVED_RAIL.id, revisionId: SAVED_RAIL.revisionId },
        input: FROZEN_INPUT,
        state: 'preparing',
      }),
      resume: jsonResponse(401, { error: 'Unauthorized' }),
    });
    renderWizardFlagOn(RAIL_FLAGS);

    fireEvent.click(await screen.findByRole('button', { name: 'Resume the mandate' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(CREATION_KEY)).toBe(REQUEST_ID);
    expect(
      screen.getByRole('button', { name: 'Resume the mandate' }),
    ).toBeEnabled();
  });

  it('releases a resumed command whose code name was taken in the meantime', async () => {
    window.sessionStorage.setItem(CREATION_KEY, REQUEST_ID);
    stubSavedRails({
      read: jsonResponse(200, {
        selection: { templateId: SAVED_RAIL.id, revisionId: SAVED_RAIL.revisionId },
        input: FROZEN_INPUT,
        state: 'preparing',
      }),
      resume: jsonResponse(409, {
        error: 'That code name is already in use on a live deal. Pick another.',
        code: 'codename_taken',
        retryable: false,
      }),
    });
    renderWizardFlagOn(RAIL_FLAGS);

    fireEvent.click(await screen.findByRole('button', { name: 'Resume the mandate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That code name is already in use on a live deal. Pick another.',
    );
    expect(window.sessionStorage.getItem(CREATION_KEY)).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Resume the mandate' }),
    ).not.toBeInTheDocument();
  });

  it('creates under the stored request id when the recovery read did not complete', async () => {
    window.sessionStorage.setItem(CREATION_KEY, REQUEST_ID);
    const fetchMock = stubSavedRails({
      read: jsonResponse(502, { error: 'bad gateway' }),
    });
    await walkToCreate(RAIL_FLAGS, true);

    expect(window.sessionStorage.getItem(CREATION_KEY)).toBe(REQUEST_ID);
    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));
    await waitFor(() => expect(pushSpy).toHaveBeenCalled());

    expect(createPayload(fetchMock).requestId).toBe(REQUEST_ID);
  });

  it('will not resume a command it cannot read, and does not forget it either', async () => {
    window.sessionStorage.setItem(CREATION_KEY, REQUEST_ID);
    stubSavedRails({
      read: jsonResponse(200, {
        selection: { templateId: SAVED_RAIL.id, revisionId: SAVED_RAIL.revisionId },
        input: { ...FROZEN_INPUT, codename: undefined },
        state: 'preparing',
      }),
    });
    renderWizardFlagOn(RAIL_FLAGS);
    await act(async () => {});

    await screen.findByRole('combobox', { name: 'Rail' });
    expect(screen.queryByRole('button', { name: 'Resume the mandate' })).toBeNull();
    expect(window.sessionStorage.getItem(CREATION_KEY)).toBe(REQUEST_ID);
  });

  it('abandons a recovered command and returns the wizard to the MD', async () => {
    window.sessionStorage.setItem(CREATION_KEY, REQUEST_ID);
    const fetchMock = stubSavedRails({
      read: jsonResponse(200, {
        selection: { templateId: SAVED_RAIL.id, revisionId: SAVED_RAIL.revisionId },
        input: FROZEN_INPUT,
        state: 'preparing',
      }),
    });
    renderWizardFlagOn(RAIL_FLAGS);

    fireEvent.click(await screen.findByRole('button', { name: 'Abandon and start over' }));

    expect(window.sessionStorage.getItem(CREATION_KEY)).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Rail' })).toHaveValue('standard');
    expect(
      fetchMock.mock.calls.filter(
        (c) =>
          String((c as unknown[])[0]).includes('/template-creations/') &&
          ((c as unknown[])[1] as RequestInit | undefined)?.method === 'POST',
      ),
    ).toHaveLength(0);
  });

  it('forgets a command the server no longer holds', async () => {
    window.sessionStorage.setItem(CREATION_KEY, REQUEST_ID);
    stubSavedRails({
      read: jsonResponse(404, { error: 'That mandate is no longer pending.' }),
    });
    renderWizardFlagOn(RAIL_FLAGS);
    await act(async () => {});

    await waitFor(() =>
      expect(window.sessionStorage.getItem(CREATION_KEY)).toBeNull(),
    );
    expect(screen.queryByRole('button', { name: 'Resume the mandate' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Rail' })).toBeInTheDocument();
  });

  it('keeps the invitation sequence around a saved rail create', async () => {
    const fetchMock = stubSavedRails();
    renderWizardFlagOn({ ...RAIL_FLAGS, platform_onboarding: true });
    await act(async () => {});
    await fillCodenameStep('Canva', 'Project Meridian');
    await chooseSavedRail();
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → conflicts
    fillConflicts();
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → team

    fireEvent.change(screen.getByLabelText(/^email$/i), {
      target: { value: 'nina@bank.dev' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check and add invitation' }));
    await screen.findByText('nina@bank.dev');

    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → notify
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // → entry
    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));
    await waitFor(() => expect(pushSpy).toHaveBeenCalled());

    const order = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
    const createAt = order.indexOf('/api/v1/deals');
    const inviteAt = order.indexOf('/api/v1/invites');
    expect(
      order
        .slice(0, createAt)
        .filter((url) => url === '/api/v1/invites/preflight'),
    ).toHaveLength(2);
    expect(createAt).toBeLessThan(inviteAt);
    const inviteCall = fetchMock.mock.calls.find(
      (c) => String((c as unknown[])[0]) === '/api/v1/invites',
    ) as unknown as [string, RequestInit];
    expect(JSON.parse(inviteCall[1].body as string)).toMatchObject({
      dealId: 'deal-1',
      email: 'nina@bank.dev',
    });
    const payload = createPayload(fetchMock);
    expect(Object.keys(payload).sort()).toEqual(
      [
        'codename',
        'codenameTheme',
        'conflictsAttestation',
        'entryStepSeq',
        'members',
        'railTemplate',
        'requestId',
        'targetCompanyId',
      ].sort(),
    );
  });
});
