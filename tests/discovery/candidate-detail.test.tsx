import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// The URL the view was opened with: a proposal row's Promote lands here with ?promote=1.
const nav = vi.hoisted(() => ({ search: '', replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.push }),
  usePathname: () => '/discovery/c-kestrel',
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import { CandidateDetailView } from '@/components/discovery/CandidateDetailView';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY, type FlagKey } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';
import type { CandidateDetail } from '@/lib/discovery/api';
import { proposalReason, proposedStepFor } from '@/lib/discovery/propose/station';

const flags = Object.fromEntries(
  (Object.keys(FLAG_REGISTRY) as FlagKey[]).map((key) => [key, key === 'deal_discovery']),
) as FlagMap;

const QUOTE = 'The letter of intent for Project Kestrel was signed on 18 September 2026.';
const BEFORE = 'Team, good news. ';
const AFTER = ' Next: diligence.';

const KESTREL: CandidateDetail = {
  id: 'c-kestrel',
  name: 'Project Kestrel',
  codename: 'Project Kestrel',
  parties: [{ name: 'Northwind Robotics', domain: 'northwind-robotics.example' }],
  firstSeenAt: '2026-05-05T09:00:00Z',
  lastSeenAt: '2026-09-18T17:00:00Z',
  evidenceCount: 2,
  ownEvidenceCount: 1,
  state: 'proposed',
  station: {
    stepId: 'p4-s48',
    station: 44,
    total: 61,
    title: 'LOI Review',
    lifecycle: 'live',
    reason: 'LOI Review because LOI signed on Sep 18, 2026 (3 emails)',
    confidence: 0.9,
    flags: [],
    asOf: '2026-09-30T10:01:00Z',
  },
  milestones: [
    { id: 'm1', type: 'bids_received', label: 'Bids received', occurredAt: '2026-08-28', sourceItemId: 'i-colleague', own: false, team: false },
    { id: 'm2', type: 'loi_signed', label: 'LOI signed', occurredAt: '2026-09-18', sourceItemId: 'i-own', own: true, team: false },
  ],
  evidence: [
    {
      sourceItemId: 'i-own',
      subject: 'Project Kestrel: LOI signed',
      sentAt: '2026-09-18T15:00:00Z',
      own: true,
      team: false,
      excerpt: { text: `${BEFORE}${QUOTE}${AFTER}`, highlight: [BEFORE.length, BEFORE.length + QUOTE.length] },
    },
    { sourceItemId: 'i-colleague', subject: 'Secret colleague subject', sentAt: '2026-09-18T16:00:00Z', own: false, team: false, excerpt: null },
  ],
  items: [],
  decisions: [],
  override: null,
  canAct: { ok: true },
  canResolve: { ok: true },
  mergedInto: null,
  origin: 'rules',
  modelProposal: null,
};

function stubFetch(response: Promise<Response> | Response) {
  const fetchMock = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const ok = (candidate: CandidateDetail) => new Response(JSON.stringify({ candidate }), { status: 200 });

function renderView() {
  return render(
    <FlagsProvider value={flags}>
      <CandidateDetailView candidateId="c-kestrel" />
    </FlagsProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  nav.search = '';
  nav.replace.mockReset();
  nav.push.mockReset();
});

describe('CandidateDetailView', () => {
  it('shows a loading state, then the deal', async () => {
    let resolve!: (value: Response) => void;
    stubFetch(new Promise<Response>((r) => (resolve = r)));
    renderView();
    expect(screen.getByRole('status')).toHaveTextContent('Loading proposed deal');
    resolve(ok(KESTREL));
    expect(await screen.findByRole('heading', { level: 1, name: 'Project Kestrel' })).toBeInTheDocument();
  });

  it('says it is refreshing while the reload after a correction is in flight, then clears it', async () => {
    let finishReload!: (value: Response) => void;
    let reads = 0;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ correctionId: 'corr-1' }), { status: 200 }));
      reads += 1;
      return reads === 1 ? Promise.resolve(ok(KESTREL)) : new Promise<Response>((resolve) => (finishReload = resolve));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderView();
    const article = (await screen.findByRole('heading', { level: 1, name: 'Project Kestrel' })).closest('article')!;
    expect(article).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByText('Refreshing')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Not a real mandate' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(article).toHaveAttribute('aria-busy', 'true'));
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing');
    // The page it already holds stays on screen meanwhile.
    expect(screen.getByRole('heading', { level: 1, name: 'Project Kestrel' })).toBeInTheDocument();

    // The view marks itself busy before it issues the reload: resolve it only once it is in flight (#638).
    await waitFor(() => expect(reads).toBe(2));
    finishReload(ok({ ...KESTREL, name: 'Project Kestrel (rejected)', state: 'rejected' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Project Kestrel (rejected)' })).toBeInTheDocument();
    expect(article).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByText('Refreshing')).not.toBeInTheDocument();
  });

  it('reads the detail once from the candidate route', async () => {
    const fetchMock = stubFetch(ok(KESTREL));
    renderView();
    await screen.findByRole('heading', { level: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/discovery/candidates/c-kestrel', expect.anything());
  });

  it('shows the step line and the reason, with a closed badge only when closed', async () => {
    stubFetch(ok(KESTREL));
    renderView();
    const card = await screen.findByRole('region', { name: 'Suggested step' });
    expect(within(card).getByText('Diligence · Step 44 · LOI Review')).toBeInTheDocument();
    expect(within(card).getByText('LOI Review because LOI signed on Sep 18, 2026 (3 emails)')).toBeInTheDocument();
    expect(within(card).queryByText('Closed')).not.toBeInTheDocument();
  });

  it('badges a closed deal', async () => {
    stubFetch(ok({ ...KESTREL, station: { ...KESTREL.station!, stepId: 'p5-s57', station: 53, title: 'Closing Checklist', lifecycle: 'closed' } }));
    renderView();
    const card = await screen.findByRole('region', { name: 'Suggested step' });
    expect(within(card).getByText('Signing · Step 53 · Closing Checklist')).toBeInTheDocument();
    expect(within(card).getByText('Closed')).toBeInTheDocument();
  });

  it('lists the milestones with dates and whose mailbox each came from', async () => {
    stubFetch(ok(KESTREL));
    renderView();
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Bids received')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Aug 28, 2026')).toBeInTheDocument();
    expect(within(rows[0]).getByText("Another banker's mailbox")).toBeInTheDocument();
    expect(within(rows[1]).getByText('Sep 18, 2026')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Your mailbox')).toBeInTheDocument();
  });

  it('labels mail the viewer reads as a team inbox member "Team inbox", not as their own mailbox (#173 G-07)', async () => {
    const teamMail: CandidateDetail = {
      ...KESTREL,
      milestones: [KESTREL.milestones[0], { ...KESTREL.milestones[1], team: true }],
      evidence: [{ ...KESTREL.evidence[0], team: true }, KESTREL.evidence[1]],
    };
    stubFetch(ok(teamMail));
    const { container } = renderView();
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[1]).getByText('Team inbox')).toBeInTheDocument();
    expect(within(table).queryByText('Your mailbox')).not.toBeInTheDocument();
    expect(within(rows[0]).getByText("Another banker's mailbox")).toBeInTheDocument();
    const evidence = screen.getByRole('region', { name: 'Evidence' });
    expect(within(evidence).getByText('Team inbox')).toBeInTheDocument();
    // The member still reads the cited sentence of team mail they may read.
    expect(evidence.querySelector('mark')).toHaveTextContent(QUOTE);
    expect(container.textContent).not.toContain('\u2014');
  });

  it('marks the cited span in the viewer\'s own excerpt', async () => {
    stubFetch(ok(KESTREL));
    renderView();
    const evidence = await screen.findByRole('region', { name: 'Evidence' });
    const mark = evidence.querySelector('mark');
    expect(mark).toHaveTextContent(QUOTE);
    expect(mark!.parentElement).toHaveTextContent(`${BEFORE}${QUOTE}${AFTER}`);
    expect(within(evidence).getByText('Project Kestrel: LOI signed')).toBeInTheDocument();
  });

  it('shows a colleague\'s mail as metadata only, never its subject or text', async () => {
    stubFetch(ok(KESTREL));
    renderView();
    const evidence = await screen.findByRole('region', { name: 'Evidence' });
    expect(within(evidence).getByText("From another banker's mailbox · metadata only")).toBeInTheDocument();
    expect(within(evidence).getAllByText('Sep 18, 2026').length).toBeGreaterThan(0);
    expect(screen.queryByText('Secret colleague subject')).not.toBeInTheDocument();
    expect(evidence.querySelectorAll('mark')).toHaveLength(1);
  });

  it('says so when no milestone has been extracted yet', async () => {
    stubFetch(ok({ ...KESTREL, station: null, milestones: [], evidence: [] }));
    renderView();
    expect(await screen.findByText('No milestones extracted yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Evidence' })).not.toBeInTheDocument();
  });

  it('shows an error when the route fails', async () => {
    stubFetch(new Response(JSON.stringify({ error: 'x' }), { status: 500 }));
    renderView();
    expect(await screen.findByRole('alert')).toHaveTextContent('The proposed deal could not be loaded. Try again shortly.');
  });

  it('says the deal is not available on a 404, which is also what an invisible deal answers', async () => {
    stubFetch(new Response(JSON.stringify({ error: 'Proposed deal not found' }), { status: 404 }));
    renderView();
    expect(await screen.findByRole('alert')).toHaveTextContent('This proposed deal is not available to you.');
  });

  it('offers the corrections, disabled with the reason when the viewer may not act', async () => {
    stubFetch(ok({ ...KESTREL, canAct: { ok: false, reason: 'no_authority' } }));
    renderView();
    const actions = await screen.findByRole('region', { name: 'Actions' });
    expect(within(actions).getByRole('button', { name: 'Reject' })).toBeDisabled();
    expect(within(actions).getByText('Needs deal-create authority')).toBeInTheDocument();
  });

  it('shows the MD\'s step first, and the decision history beneath the evidence', async () => {
    stubFetch(
      ok({
        ...KESTREL,
        override: { stepId: 'p5-s51', station: 47, title: 'Signing / Announcement Prep', reason: 'Signed by phone' },
        decisions: [
          {
            id: 'd1',
            candidateId: 'c-kestrel',
            action: 'set_station',
            actorName: 'Storm Duncan',
            own: true,
            at: '2026-10-02T09:00:00Z',
            before: { stepId: null, suggestedStepId: 'p4-s48' },
            after: { stepId: 'p5-s51' },
            reason: 'Signed by phone',
          },
        ],
      }),
    );
    renderView();
    const card = await screen.findByRole('region', { name: 'Suggested step' });
    expect(within(card).getByText('Signing · Step 47 · Signing / Announcement Prep')).toBeInTheDocument();
    expect(within(card).getByText('Evidence suggests Diligence · Step 44 · LOI Review')).toBeInTheDocument();
    const history = screen.getByRole('region', { name: 'Decision history' });
    expect(history).toHaveTextContent(
      'Storm Duncan set the step to 47 · Signing / Announcement Prep on Oct 2, 2026. Reason: Signed by phone. Before: suggested 44.',
    );
  });

  it('says a merged deal was merged, with a link to the survivor', async () => {
    stubFetch(ok({ ...KESTREL, state: 'merged_into', mergedInto: { id: 'c-survivor', name: 'Project Kestrel Prime' } }));
    renderView();
    const link = await screen.findByRole('link', { name: 'Project Kestrel Prime' });
    expect(link).toHaveAttribute('href', '/discovery/c-survivor');
    expect(link.closest('p')).toHaveTextContent('Merged into Project Kestrel Prime');
  });

  describe('?promote=1 from a proposal row', () => {
    const PROMOTE_DIALOG = 'Open the mandate';

    it('opens the Promote dialog once the deal loads, and drops the param from the URL', async () => {
      nav.search = 'promote=1';
      stubFetch(ok(KESTREL));
      renderView();
      expect(await screen.findByRole('dialog', { name: PROMOTE_DIALOG })).toBeInTheDocument();
      expect(nav.replace).toHaveBeenCalledTimes(1);
      expect(nav.replace).toHaveBeenCalledWith('/discovery/c-kestrel', { scroll: false });
    });

    it('keeps any other query the page carries when it drops the param', async () => {
      nav.search = 'promote=1&from=proposals';
      stubFetch(ok(KESTREL));
      renderView();
      await screen.findByRole('dialog', { name: PROMOTE_DIALOG });
      expect(nav.replace).toHaveBeenCalledWith('/discovery/c-kestrel?from=proposals', { scroll: false });
    });

    it('opens nothing when the viewer may not act, and shows the usual reason instead', async () => {
      nav.search = 'promote=1';
      stubFetch(ok({ ...KESTREL, canAct: { ok: false, reason: 'no_authority' } }));
      renderView();
      const actions = await screen.findByRole('region', { name: 'Actions' });
      expect(within(actions).getByText('Needs deal-create authority')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(nav.replace).toHaveBeenCalledTimes(1);
    });

    it('opens nothing when the proposal can no longer end, for example once it is a mandate', async () => {
      nav.search = 'promote=1';
      stubFetch(ok({ ...KESTREL, state: 'confirmed', canResolve: { ok: false, reason: 'candidate_state' } }));
      renderView();
      const actions = await screen.findByRole('region', { name: 'Actions' });
      expect(within(actions).getByRole('button', { name: 'Promote to mandate' })).toBeDisabled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('opens nothing and leaves the URL alone without the param', async () => {
      stubFetch(ok(KESTREL));
      renderView();
      await screen.findByRole('region', { name: 'Actions' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(nav.replace).not.toHaveBeenCalled();
    });
  });

  describe('?station=1', () => {
    const STATION_DIALOG = 'Set the step';

    it('opens Set station once the deal loads, and drops only that param', async () => {
      nav.search = 'station=1&from=proposals';
      stubFetch(ok(KESTREL));
      renderView();
      expect(await screen.findByRole('dialog', { name: STATION_DIALOG })).toBeInTheDocument();
      expect(nav.replace).toHaveBeenCalledTimes(1);
      expect(nav.replace).toHaveBeenCalledWith('/discovery/c-kestrel?from=proposals', { scroll: false });
    });

    it('opens nothing when the viewer may not act', async () => {
      nav.search = 'station=1';
      stubFetch(ok({ ...KESTREL, canAct: { ok: false, reason: 'no_authority' } }));
      renderView();
      const actions = await screen.findByRole('region', { name: 'Actions' });
      expect(within(actions).getByText('Needs deal-create authority')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(nav.replace).toHaveBeenCalledTimes(1);
    });

    it('opens Set station on a promoted deal, which still allows it', async () => {
      nav.search = 'station=1';
      stubFetch(ok({ ...KESTREL, state: 'confirmed', canResolve: { ok: false, reason: 'candidate_state' } }));
      renderView();
      expect(await screen.findByRole('dialog', { name: STATION_DIALOG })).toBeInTheDocument();
    });

    it('lets Promote win when both params are present and promote is open', async () => {
      nav.search = 'promote=1&station=1';
      stubFetch(ok(KESTREL));
      renderView();
      expect(await screen.findByRole('dialog', { name: 'Open the mandate' })).toBeInTheDocument();
      expect(nav.replace).toHaveBeenCalledWith('/discovery/c-kestrel', { scroll: false });
    });
  });

  describe('a model-origin deal (G-02b, R10)', () => {
    const STEP = proposedStepFor('phase-2');
    const PROPOSAL = { requestId: 'r-1', stepId: STEP, phase: 'phase-2' as const, placed: 3, of: 4 };
    const FALCON: CandidateDetail = {
      ...KESTREL,
      id: 'c-falcon',
      name: 'Falcon',
      station: null,
      origin: 'model_proposal',
      modelProposal: PROPOSAL,
    };

    it('says what the model proposes and that no station is set, with a way to review it', async () => {
      stubFetch(ok(FALCON));
      renderView();
      const prompt = await screen.findByRole('group', { name: 'Model proposal' });
      expect(prompt).toHaveTextContent(/^The model proposes Step \d{2} · .+/);
      expect(prompt).toHaveTextContent(proposalReason(PROPOSAL));
      expect(prompt).toHaveTextContent('No step is set.');
      expect(within(prompt).getByRole('button', { name: 'Review step' })).toBeEnabled();
    });

    it('opens Set station on Review station with the proposal, its reason and the confirmation preselected', async () => {
      stubFetch(ok(FALCON));
      renderView();
      fireEvent.click(await screen.findByRole('button', { name: 'Review step' }));
      const dialog = await screen.findByRole('dialog', { name: 'Set the step' });
      expect(within(dialog).getByText('Proposed')).toBeInTheDocument();
      expect(within(dialog).getByText(proposalReason(PROPOSAL))).toBeInTheDocument();
      expect((within(dialog).getByLabelText('Step') as HTMLSelectElement).value).toBe(STEP);
      expect((within(dialog).getByLabelText('Reason') as HTMLTextAreaElement).value).toBe('Confirmed the proposed step');
    });

    it('opens that same review from ?station=1', async () => {
      nav.search = 'station=1';
      stubFetch(ok(FALCON));
      renderView();
      const dialog = await screen.findByRole('dialog', { name: 'Set the step' });
      expect(within(dialog).getByText(proposalReason(PROPOSAL))).toBeInTheDocument();
    });

    it('starts Promote unpicked, never at the proposed station', async () => {
      nav.search = 'promote=1';
      stubFetch(ok(FALCON));
      renderView();
      const dialog = await screen.findByRole('dialog', { name: 'Open the mandate' });
      expect((within(dialog).getByLabelText('Starting step') as HTMLSelectElement).value).toBe('');
    });

    it('drops the prompt once the MD has set a station, and Promote then starts at that station', async () => {
      nav.search = 'promote=1';
      stubFetch(
        ok({ ...FALCON, override: { stepId: 'p4-s48', station: 44, title: 'LOI Review', reason: 'Signed by phone' } }),
      );
      renderView();
      const dialog = await screen.findByRole('dialog', { name: 'Open the mandate' });
      expect((within(dialog).getByLabelText('Starting step') as HTMLSelectElement).value).toBe('48');
      expect(screen.queryByRole('group', { name: 'Model proposal' })).not.toBeInTheDocument();
    });

    it('shows no prompt to a viewer who is not the mailbox owner, and Set station asks them to choose', async () => {
      stubFetch(ok({ ...FALCON, station: null, modelProposal: null }));
      renderView();
      await screen.findByRole('region', { name: 'Actions' });
      expect(screen.queryByRole('group', { name: 'Model proposal' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Set step' }));
      const dialog = await screen.findByRole('dialog', { name: 'Set the step' });
      expect((within(dialog).getByLabelText('Step') as HTMLSelectElement).value).toBe('');
      expect(within(dialog).getByRole('button', { name: 'Set step' })).toBeDisabled();
    });

    it('names an evidence suggestion in Set station, but never starts Promote at it', async () => {
      stubFetch(ok({ ...FALCON, modelProposal: null, station: KESTREL.station }));
      renderView();
      await screen.findByRole('region', { name: 'Actions' });
      expect(screen.queryByRole('group', { name: 'Model proposal' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Set step' }));
      const dialog = await screen.findByRole('dialog', { name: 'Set the step' });
      expect(within(dialog).getByText('Proposed')).toBeInTheDocument();
      expect(within(dialog).getByText(KESTREL.station!.reason)).toBeInTheDocument();
      expect((within(dialog).getByLabelText('Step') as HTMLSelectElement).value).toBe('p4-s48');
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.click(screen.getByRole('button', { name: 'Promote to mandate' }));
      const promote = await screen.findByRole('dialog', { name: 'Open the mandate' });
      expect((within(promote).getByLabelText('Starting step') as HTMLSelectElement).value).toBe('');
    });

    it('disables Review station with the reason when the viewer cannot act', async () => {
      stubFetch(ok({ ...FALCON, canAct: { ok: false, reason: 'no_authority' } }));
      renderView();
      expect(await screen.findByRole('button', { name: 'Review step' })).toBeDisabled();
    });

    it('does not change a rules-found deal: no prompt, and the evidence station is where Set station starts', async () => {
      stubFetch(ok(KESTREL));
      renderView();
      await screen.findByRole('region', { name: 'Actions' });
      expect(screen.queryByRole('group', { name: 'Model proposal' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Set step' }));
      const dialog = await screen.findByRole('dialog', { name: 'Set the step' });
      expect(within(dialog).queryByText('Proposed')).not.toBeInTheDocument();
      expect((within(dialog).getByLabelText('Step') as HTMLSelectElement).value).toBe('p4-s48');
    });

    it('keeps visible copy free of em dashes', async () => {
      stubFetch(ok(FALCON));
      const { container } = renderView();
      await screen.findByRole('group', { name: 'Model proposal' });
      expect(container.textContent).not.toContain('—');
    });
  });

  it('keeps visible copy free of em dashes', async () => {
    stubFetch(ok(KESTREL));
    const { container } = renderView();
    await screen.findByRole('heading', { level: 1 });
    expect(container.textContent).not.toContain('—');
  });
});
