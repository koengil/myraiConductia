import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import { PROMOTED_REASON } from '@/components/discovery/CandidateActions';
import { ACCEPT_FAILURE_COPY } from '@/components/discovery/ProposalActions';
import {
  dismissedLabel,
  emailsLabel,
  ModelProposals,
  originCaption,
  phaseLabel,
  POLL_LIMIT,
  POLL_MS,
  STILL_READING,
} from '@/components/discovery/ModelProposals';
import {
  ACCEPT_FAILURE_CODES,
  groupProposals,
  type ModelProposalAccept,
  type ModelProposalGroup,
  type ModelProposalRow,
} from '@/lib/discovery/propose/group';
import { messageKey } from '@/lib/discovery/propose/key';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY, type FlagKey } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';

const flagsWith = (demo: boolean) =>
  Object.fromEntries(
    (Object.keys(FLAG_REGISTRY) as FlagKey[]).map((key) => [
      key,
      key === 'deal_discovery' || (demo && key === 'discovery_model_proposals_demo'),
    ]),
  ) as FlagMap;

const CANDIDATE = '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071';
const OPERATION = '6f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f';

const row = ({ id, ...over }: Partial<ModelProposalRow> & { id: string }): ModelProposalRow => ({
  message_key: messageKey(id),
  outcome: 'deal',
  deal_key: 'm:project-heron',
  deal_name: 'Project Heron',
  candidate_id: null,
  phase: 'phase-2',
  sent_at: '2026-03-02T10:00:00Z',
  party_domains: ['harbourline.example'],
  ...over,
});

// Real grouping over rows, so the section is tested on what the route sends: both deals on the viewer's own mailbox.
const PROPOSALS: ModelProposalGroup[] = groupProposals(
  [
    row({ id: '<a@x>' }),
    row({ id: '<b@x>', phase: 'phase-3', sent_at: '2026-03-09T10:00:00Z', party_domains: ['northgate.example'] }),
    row({
      id: '<c@x>',
      deal_key: `c:${CANDIDATE}`,
      deal_name: 'Project Kestrel',
      candidate_id: CANDIDATE,
      phase: 'phase-4',
      sent_at: '2026-02-01T10:00:00Z',
      party_domains: [],
    }),
  ],
  new Set(),
  new Set(['m:project-heron', `c:${CANDIDATE}`]),
);

function stubFetch(response: Promise<Response> | Response) {
  const fetchMock = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Let the fetch, its json() and the state update settle. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const ok = (proposals: unknown, dismissedCount?: number) =>
  new Response(JSON.stringify(dismissedCount === undefined ? { proposals } : { proposals, dismissedCount }), {
    status: 200,
  });

function renderSection(demo = true) {
  return render(
    <FlagsProvider value={flagsWith(demo)}>
      <ModelProposals />
    </FlagsProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

const rowOf = (key: string) =>
  screen
    .getAllByRole('listitem')
    .find((li) => li.getAttribute('data-deal-key') === key)!;

describe('ModelProposals', () => {
  it('renders nothing and fetches nothing while the demo flag is off', () => {
    const fetchMock = stubFetch(ok(PROPOSALS));
    const { container } = renderSection(false);
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders nothing while loading, on a 404 and when there are no proposals', async () => {
    let resolve!: (value: Response) => void;
    const fetchMock = stubFetch(new Promise<Response>((r) => (resolve = r)));
    const loading = renderSection();
    expect(loading.container).toBeEmptyDOMElement();
    resolve(ok([]));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/discovery/model-proposals', expect.anything()));
    await settle();
    expect(loading.container).toBeEmptyDOMElement();
    loading.unmount();

    stubFetch(new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }));
    const notFound = renderSection();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await settle();
    expect(notFound.container).toBeEmptyDOMElement();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows one row per proposed deal, with the Proposed badge, phase, emails, dates and parties', async () => {
    stubFetch(ok(PROPOSALS));
    renderSection();

    const section = await screen.findByRole('region', { name: 'Proposed from mail by a model' });
    expect(within(section).getByText('Proposed from mail by a model · demo')).toBeInTheDocument();
    const rows = within(section).getAllByRole('listitem').filter((li) => li.hasAttribute('data-deal-key'));
    expect(rows.map((li) => li.getAttribute('data-deal-key'))).toEqual(['m:project-heron', `c:${CANDIDATE}`]);

    const heron = rows[0];
    expect(within(heron).getByRole('heading', { name: 'Project Heron' })).toBeInTheDocument();
    expect(within(heron).getByText('Proposed')).toBeInTheDocument();
    expect(within(heron).getByText('Phase 3 · Marketing & First-Round Bids')).toBeInTheDocument();
    expect(within(heron).getByText('From 2 emails')).toBeInTheDocument();
    expect(within(heron).getByText('Mar 2, 2026 to Mar 9, 2026')).toBeInTheDocument();
    expect(within(heron).getByRole('list', { name: 'Parties' })).toHaveTextContent('harbourline.example');
    expect(within(heron).getByRole('list', { name: 'Parties' })).toHaveTextContent('northgate.example');
    // A model-only deal has no rules-found page to link to.
    expect(within(heron).queryByRole('link')).not.toBeInTheDocument();
  });

  it('links a deal the rules also found to its candidate page', async () => {
    stubFetch(ok(PROPOSALS));
    renderSection();
    const link = await screen.findByRole('link', { name: 'Project Kestrel' });
    expect(link).toHaveAttribute('href', `/discovery/${CANDIDATE}`);
    const kestrel = link.closest('li')!;
    expect(within(kestrel).getByText('Phase 4 · Diligence, LOI & Definitive Docs')).toBeInTheDocument();
    expect(within(kestrel).getByText('No outside party identified')).toBeInTheDocument();
    expect(kestrel).toHaveTextContent('From 1 email, on a deal the codename rules also found');
  });

  it('reads as a proposal: ink outline, no violet, no status fill, no em dash', async () => {
    stubFetch(ok(PROPOSALS));
    const { container } = renderSection();
    const section = await screen.findByRole('region', { name: 'Proposed from mail by a model' });
    expect(section.className).toContain('border-[var(--accent)]');
    expect(section.className).toContain('shadow-[var(--elev-1)]');
    const html = container.innerHTML;
    expect(html).not.toMatch(/--ai\b|--ai-|violet|#5e5ce6/i);
    expect(html).not.toMatch(/--(positive|negative|hold)/);
    expect(container.textContent).not.toContain('—');
    // The row actions share CandidateActions' outlined button: no ink or red fill on the row itself.
    for (const button of within(section).getAllByRole('button')) {
      expect(button.className).toContain('border-[var(--stroke)]');
      expect(button.className).not.toMatch(/bg-\[var\(--(accent|negative)/);
    }
  });

  it('offers Promote and Dismiss on a deal the rules also found, and Accept and Dismiss on a model-only deal', async () => {
    stubFetch(ok(PROPOSALS));
    renderSection();
    await screen.findByRole('region', { name: 'Proposed from mail by a model' });

    const heron = rowOf('m:project-heron');
    expect(within(heron).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Accept as proposed deal',
      'Dismiss',
    ]);
    // Accept is for a model-only deal: the rules-found row has Promote instead.
    expect(within(rowOf(`c:${CANDIDATE}`)).queryByRole('button', { name: /Accept/ })).not.toBeInTheDocument();

    const kestrel = rowOf(`c:${CANDIDATE}`);
    expect(within(kestrel).getAllByRole('button').map((b) => b.textContent)).toEqual(['Promote to mandate', 'Dismiss']);
    expect(within(kestrel).getByRole('button', { name: 'Promote to mandate' })).toBeEnabled();
    expect(within(kestrel).queryByText(PROMOTED_REASON)).not.toBeInTheDocument();
  });

  it('words a c: row by its origin: a deal the model made on accept is not "also found" by the rules (G-02b)', async () => {
    const accepted = PROPOSALS.map((p) => (p.candidateId ? { ...p, origin: 'model_proposal' as const } : p));
    stubFetch(ok(accepted));
    renderSection();
    await screen.findByRole('region', { name: 'Proposed from mail by a model' });
    const kestrel = rowOf(`c:${CANDIDATE}`);
    expect(kestrel).toHaveTextContent('From 1 email, on a deal accepted from a model proposal');
    expect(kestrel).not.toHaveTextContent('codename rules also found');
    expect(kestrel.textContent).not.toContain('\u2014');
    // Promote still applies: the candidate page starts the dialog unpicked for a model-origin deal.
    fireEvent.click(within(kestrel).getByRole('button', { name: 'Promote to mandate' }));
    expect(push).toHaveBeenCalledWith(`/discovery/${CANDIDATE}?promote=1`);
  });

  it('keeps the rules caption for a rules-found c: row, and none for an m: row', async () => {
    stubFetch(ok(PROPOSALS));
    renderSection();
    await screen.findByRole('region', { name: 'Proposed from mail by a model' });
    expect(rowOf(`c:${CANDIDATE}`)).toHaveTextContent('From 1 email, on a deal the codename rules also found');
    expect(rowOf('m:project-heron')).toHaveTextContent('From 2 emails');
    expect(rowOf('m:project-heron')).not.toHaveTextContent(/also found|accepted from/);
    expect(originCaption('rules')).toBe(', on a deal the codename rules also found');
    expect(originCaption('model_proposal')).toBe(', on a deal accepted from a model proposal');
    expect(originCaption(null)).toBe('');
  });

  it('words nothing about the origin of a c: row whose origin is not known, and never claims the rules found it', async () => {
    stubFetch(ok(PROPOSALS.map((p) => (p.candidateId ? { ...p, origin: null } : p))));
    renderSection();
    await screen.findByRole('region', { name: 'Proposed from mail by a model' });
    const kestrel = rowOf(`c:${CANDIDATE}`);
    expect(kestrel).toHaveTextContent('From 1 email');
    expect(kestrel).not.toHaveTextContent(/also found|accepted from/);
  });

  it('offers no action on a group the viewer may not act on, such as one with team-inbox rows (TH1-3)', async () => {
    stubFetch(ok(PROPOSALS.map((p) => ({ ...p, actionable: false }))));
    renderSection();
    await screen.findByRole('region', { name: 'Proposed from mail by a model' });
    for (const key of ['m:project-heron', `c:${CANDIDATE}`]) {
      expect(within(rowOf(key)).queryAllByRole('button')).toEqual([]);
    }
    // The rows themselves still show.
    expect(within(rowOf(`c:${CANDIDATE}`)).getByText('Project Kestrel')).toBeInTheDocument();
  });

  it('opens the candidate with its Promote dialog: Promote navigates, it writes nothing', async () => {
    const fetchMock = stubFetch(ok(PROPOSALS));
    renderSection();
    await screen.findByRole('region', { name: 'Proposed from mail by a model' });
    fireEvent.click(within(rowOf(`c:${CANDIDATE}`)).getByRole('button', { name: 'Promote to mandate' }));
    expect(push).toHaveBeenCalledWith(`/discovery/${CANDIDATE}?promote=1`);
    // The list read only: no POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('disables Promote with the reason when the candidate is already a mandate', async () => {
    stubFetch(ok(PROPOSALS.map((p) => (p.candidateId ? { ...p, promoted: true } : p))));
    renderSection();
    await screen.findByRole('region', { name: 'Proposed from mail by a model' });
    const kestrel = rowOf(`c:${CANDIDATE}`);
    const promote = within(kestrel).getByRole('button', { name: 'Promote to mandate' });
    expect(promote).toBeDisabled();
    expect(promote).toHaveAttribute('title', PROMOTED_REASON);
    expect(within(kestrel).getByText(PROMOTED_REASON)).toBeInTheDocument();
    // Dismiss stays open: a dismissal never touches the candidate.
    expect(within(kestrel).getByRole('button', { name: 'Dismiss' })).toBeEnabled();
    fireEvent.click(promote);
    expect(push).not.toHaveBeenCalled();
  });

  it('shows the dismissed count as a quiet caption, and nothing when none was dismissed', async () => {
    stubFetch(ok(PROPOSALS, 2));
    const first = renderSection();
    const section = await screen.findByRole('region', { name: 'Proposed from mail by a model' });
    const caption = within(section).getByText('2 dismissed');
    expect(caption.className).toContain('font-mono');
    expect(caption.className).toContain('text-[var(--ink-tertiary)]');
    first.unmount();

    stubFetch(ok(PROPOSALS, 0));
    renderSection();
    const again = await screen.findByRole('region', { name: 'Proposed from mail by a model' });
    expect(within(again).queryByText(/dismissed$/)).not.toBeInTheDocument();
  });

  it('keeps the card with its count once every proposal was dismissed', async () => {
    stubFetch(ok([], 1));
    renderSection();
    const section = await screen.findByRole('region', { name: 'Proposed from mail by a model' });
    expect(within(section).getByText('1 dismissed')).toBeInTheDocument();
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
  });

  it('dismisses after the confirm and refetches the list, which then carries the count', async () => {
    let reads = 0;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ dismissed: 1, operationId: OPERATION }), { status: 200 }));
      }
      reads += 1;
      return Promise.resolve(reads === 1 ? ok(PROPOSALS) : ok(PROPOSALS.filter((p) => p.dealKey !== 'm:project-heron'), 1));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderSection();
    await screen.findByRole('region', { name: 'Proposed from mail by a model' });

    fireEvent.click(within(rowOf('m:project-heron')).getByRole('button', { name: 'Dismiss' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss Project Heron' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss proposal' }));

    expect(await screen.findByText('1 dismissed')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The content-free reference the owner quotes to ask for a restore (D10).
    expect(screen.getByRole('status')).toHaveTextContent(`Dismissed. Restore reference ${OPERATION}`);
    expect(screen.queryByRole('heading', { name: 'Project Heron' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Project Kestrel' })).toBeInTheDocument();
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe('/api/v1/discovery/model-proposals/dismiss');
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ dealKey: 'm:project-heron' });
    expect(reads).toBe(2);
  });

  it('says so when the route fails', async () => {
    stubFetch(new Response(JSON.stringify({ error: 'x' }), { status: 500 }));
    renderSection();
    expect(await screen.findByRole('alert')).toHaveTextContent('Model proposals could not be loaded. Try again shortly.');
  });
});

const HERON = PROPOSALS.find((p) => p.dealKey === 'm:project-heron')!;
const withHeron = (accept: ModelProposalAccept | null): ModelProposalGroup[] =>
  PROPOSALS.map((p) => (p === HERON ? { ...p, accept } : p));
const PENDING: ModelProposalAccept = { state: 'pending', requested: 2 };

describe('ModelProposals: accept', () => {
  it('shows a pending accept as a status line with no buttons', async () => {
    stubFetch(ok(withHeron(PENDING)));
    renderSection();
    await screen.findByRole('region', { name: 'Proposed from mail by a model' });
    const heron = rowOf('m:project-heron');
    expect(within(heron).getByRole('status')).toHaveTextContent('Reading 2 emails again');
    expect(within(heron).queryAllByRole('button')).toEqual([]);
    // The rules-found row is not affected.
    expect(within(rowOf(`c:${CANDIDATE}`)).getAllByRole('button')).toHaveLength(2);
  });

  it('reads one email in the singular', async () => {
    stubFetch(ok(withHeron({ state: 'pending', requested: 1 })));
    renderSection();
    expect(await screen.findByRole('status')).toHaveTextContent('Reading 1 email again');
  });

  it.each(ACCEPT_FAILURE_CODES)('shows the fixed sentence for a failed accept (%s) and Dismiss', async (code) => {
    stubFetch(ok(withHeron({ state: 'failed', code })));
    renderSection();
    await screen.findByRole('region', { name: 'Proposed from mail by a model' });
    const heron = rowOf('m:project-heron');
    expect(within(heron).getByText(ACCEPT_FAILURE_COPY[code])).toBeInTheDocument();
    expect(within(heron).queryByRole('status')).not.toBeInTheDocument();
    const labels = within(heron).getAllByRole('button').map((b) => b.textContent);
    // "Accept again" only for `error`: the other codes would fail the same way.
    expect(labels).toEqual(code === 'error' ? ['Accept again', 'Dismiss'] : ['Dismiss']);
  });

  it('keeps the failure copy fixed, free of em dashes', () => {
    expect(ACCEPT_FAILURE_COPY).toEqual({
      none_readable: 'None of these emails can be read now.',
      source_unavailable: 'The mailbox is not readable now.',
      candidate_closed: 'This proposed deal was rejected.',
      error: 'Could not accept the proposal. Try again shortly.',
    });
    for (const text of Object.values(ACCEPT_FAILURE_COPY)) expect(text).not.toContain('\u2014');
  });

  it('gives a group the viewer may not act on no Accept and no state, whatever it carries (R11)', async () => {
    const team = PROPOSALS.map((p) => ({ ...p, actionable: false, accept: p === HERON ? PENDING : p.accept }));
    stubFetch(ok(team));
    renderSection();
    await screen.findByRole('region', { name: 'Proposed from mail by a model' });
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('has no Accept on an m: group that carries no proposed station', async () => {
    stubFetch(ok(PROPOSALS.map((p) => (p === HERON ? { ...p, proposed: null } : p))));
    renderSection();
    await screen.findByRole('region', { name: 'Proposed from mail by a model' });
    expect(within(rowOf('m:project-heron')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Dismiss']);
  });

  it('accepts after the confirm and reads the list again, which then shows the pending row', async () => {
    let reads = 0;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ operationId: OPERATION, requestCount: 1 }), { status: 202 }));
      }
      reads += 1;
      return Promise.resolve(ok(reads === 1 ? PROPOSALS : withHeron(PENDING)));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderSection();
    await screen.findByRole('region', { name: 'Proposed from mail by a model' });

    fireEvent.click(within(rowOf('m:project-heron')).getByRole('button', { name: 'Accept as proposed deal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Accept Project Heron as a proposed deal' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept and read 2 emails' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Reading 2 emails again');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe('/api/v1/discovery/model-proposals/accept');
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({
      dealKey: 'm:project-heron',
      proposedStepId: HERON.proposed!.stepId,
    });
    expect(reads).toBe(2);
  });
});

describe('ModelProposals: reading again while an accept is pending', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A response that settles on microtasks alone, so fake timers never stall a body read. */
  const instant = (proposals: ModelProposalGroup[]) =>
    ({ ok: true, status: 200, json: async () => ({ proposals }) }) as unknown as Response;

  /** Reads answered in order; the last answer repeats. Timers are fake, so settle by advancing them. */
  function stubReads(...answers: ModelProposalGroup[][]) {
    let reads = 0;
    const fetchMock = vi.fn(() => {
      const answer = answers[Math.min(reads, answers.length - 1)];
      reads += 1;
      return Promise.resolve(instant(answer));
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

  it('reads again on a timer while some group is pending, and stops once none is', async () => {
    vi.useFakeTimers();
    const fetchMock = stubReads(withHeron(PENDING), withHeron(PENDING), PROPOSALS);
    renderSection();
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Reading 2 emails again');

    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toBeInTheDocument();
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await advance(POLL_MS * 5);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not read again when nothing is pending', async () => {
    vi.useFakeTimers();
    const fetchMock = stubReads(PROPOSALS);
    renderSection();
    await advance(0);
    await advance(POLL_MS * 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is bounded: it stops after POLL_LIMIT reads even if the accept is still pending', async () => {
    vi.useFakeTimers();
    const fetchMock = stubReads(withHeron(PENDING));
    renderSection();
    await advance(0);
    // One interval per act, so each tick renders and reads (one long act would batch every tick into one read).
    for (let i = 0; i < POLL_LIMIT + 10; i += 1) await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1 + POLL_LIMIT);
  });

  it('says "Still reading. Refresh later." once the limit is reached with a group still pending, and not before', async () => {
    vi.useFakeTimers();
    stubReads(withHeron(PENDING));
    renderSection();
    await advance(0);
    const section = screen.getByRole('region', { name: 'Proposed from mail by a model' });
    for (let i = 0; i < POLL_LIMIT; i += 1) await advance(POLL_MS);
    // The last read has happened; the timer has not yet found the limit.
    expect(within(section).queryByText(STILL_READING)).not.toBeInTheDocument();
    await advance(POLL_MS);
    const note = within(section).getByText('Still reading. Refresh later.');
    expect(note).toHaveAttribute('role', 'status');
    expect(note.textContent).not.toContain('—');
    // The pending row still says what it is doing.
    expect(within(rowOf('m:project-heron')).getByRole('status')).toHaveTextContent('Reading 2 emails again');
  });

  it('does not say it when nothing was left pending', async () => {
    vi.useFakeTimers();
    stubReads(withHeron(PENDING), PROPOSALS);
    renderSection();
    await advance(0);
    for (let i = 0; i < POLL_LIMIT + 2; i += 1) await advance(POLL_MS);
    expect(screen.queryByText(STILL_READING)).not.toBeInTheDocument();
  });

  it('stops on unmount', async () => {
    vi.useFakeTimers();
    const fetchMock = stubReads(withHeron(PENDING));
    const view = renderSection();
    await advance(0);
    view.unmount();
    await advance(POLL_MS * 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the list on screen when a later read fails', async () => {
    vi.useFakeTimers();
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        reads += 1;
        return reads === 1 ? Promise.resolve(instant(withHeron(PENDING))) : Promise.reject(new Error('network'));
      }),
    );
    renderSection();
    await advance(0);
    await advance(POLL_MS);
    expect(reads).toBe(2);
    expect(screen.getByRole('status')).toHaveTextContent('Reading 2 emails again');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('labels', () => {
  it('counts emails and names the phase from the rail', () => {
    expect(dismissedLabel(1)).toBe('1 dismissed');
    expect(dismissedLabel(3)).toBe('3 dismissed');
    expect(emailsLabel(1)).toBe('From 1 email');
    expect(emailsLabel(3)).toBe('From 3 emails');
    expect(phaseLabel({ id: 'phase-1', name: 'Origination, Qualification & Mandate' })).toBe(
      'Phase 1 · Origination, Qualification & Mandate',
    );
  });
});
