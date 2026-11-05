import { afterEach, describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// The Promote dialog reads the router; initialOpen mounts it straight away.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { CandidateActions, disabledReason } from '@/components/discovery/CandidateActions';
import { DecisionHistory, decisionSentence } from '@/components/discovery/DecisionHistory';
import { StepSuggestion } from '@/components/discovery/StepSuggestion';
import type { CandidateDecision, CandidateItem, CandidateStation } from '@/lib/discovery/api';
import { MotionGlobalConfig } from 'framer-motion';

// Overlay exits finish at once, so a test awaits a close without running the
// real 180 ms motion. tests/overlay/dialog.test.tsx keeps the exit on real motion.
beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CANDIDATES = [
  { id: 'c-kestrel', name: 'Project Kestrel' },
  { id: 'c-harbor', name: 'Project Harbor' },
];

/** Answers the merge dialog's list read, and records each correction POST. */
function stubFetch(postStatus = 200, postBody: unknown = { correctionId: 'corr-1' }) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify(postBody), { status: postStatus }));
    }
    return Promise.resolve(new Response(JSON.stringify({ candidates: CANDIDATES }), { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ITEMS: CandidateItem[] = [
  { linkId: 'l-1', sourceItemId: 'i-1', subject: 'Harbor: bids in', sentAt: '2026-09-01T10:00:00Z', own: true },
  { linkId: 'l-2', sourceItemId: 'i-2', subject: 'Harbor: site visit', sentAt: '2026-09-05T10:00:00Z', own: true },
  { linkId: 'l-3', sourceItemId: 'i-3', subject: '', sentAt: '2026-09-07T10:00:00Z', own: false },
];

function renderActions(overrides: Partial<React.ComponentProps<typeof CandidateActions>> = {}) {
  const onChanged = vi.fn();
  render(
    <CandidateActions
      candidateId="c-harbor"
      name="Project Harbor"
      placedStepId="p4-s47"
      origin="rules"
      canAct={{ ok: true }}
      items={ITEMS}
      onChanged={onChanged}
      {...overrides}
    />,
  );
  return { onChanged };
}

const posted = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');

describe('CandidateActions', () => {
  it('offers the six actions', () => {
    renderActions();
    for (const name of ['Rename', 'Set step', 'Merge into…', 'Split…', 'Move an email…', 'Reject']) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
    expect(screen.queryByText('Needs deal-create authority')).not.toBeInTheDocument();
  });

  it('disables every action and says why when the viewer lacks deal-create authority', () => {
    renderActions({ canAct: { ok: false, reason: 'no_authority' } });
    for (const name of ['Rename', 'Set step', 'Merge into…', 'Split…', 'Move an email…', 'Reject']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByText('Needs deal-create authority')).toBeInTheDocument();
  });

  it('keeps rename, step, split and move open on a promoted candidate, and closes promote, reject and merge with the reason', () => {
    renderActions({ canResolve: { ok: false, reason: 'candidate_state' } });
    for (const name of ['Rename', 'Set step', 'Split…', 'Move an email…']) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
    for (const name of ['Merge into…', 'Reject', 'Promote to mandate']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByText('Promoted to a mandate. Promote, reject and merge no longer apply.')).toBeInTheDocument();
  });

  it('opens the Promote dialog on first render when initialOpen asks for it (a proposal row\'s Promote)', async () => {
    renderActions({ initialOpen: 'promote' });
    const dialog = screen.getByRole('dialog', { name: 'Open the mandate' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    fireEvent.keyDown(window, { key: 'Escape' });
    // The dialog leaves when its exit motion ends.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('opens no dialog without initialOpen', () => {
    renderActions();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    cleanup();
    renderActions({ initialOpen: null });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says so when the proposed deal can no longer be changed', () => {
    renderActions({ canAct: { ok: false, reason: 'candidate_state' } });
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
    expect(screen.getByText('This proposed deal can no longer be changed')).toBeInTheDocument();
    expect(disabledReason({ ok: true })).toBeNull();
  });

  it.each([
    ['Rename', 'Rename this proposed deal'],
    ['Set step', 'Set the step'],
    ['Merge into…', 'Merge Project Harbor into another deal'],
    ['Reject', 'Reject Project Harbor'],
    ['Split…', 'Split Project Harbor'],
    ['Move an email…', 'Move an email out of Project Harbor'],
  ])('opens the %s dialog, traps focus, closes on Escape and gives focus back', async (label, title) => {
    stubFetch();
    renderActions();
    const opener = screen.getByRole('button', { name: label });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole('dialog', { name: title });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Focus moved in, to a control of the dialog.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    // Tab from the last control wraps to the first, and Shift+Tab the other way.
    // Document order: jsdom returns a selector list grouped by selector.
    const controls = Array.from(
      dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea'),
    ).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const first = controls[0];
    const last = controls[controls.length - 1];
    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(window, { key: 'Escape' });
    // Focus returns as the exit starts; the dialog leaves when its exit motion ends.
    expect(document.activeElement).toBe(opener);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps Reject disabled until a reason is typed, then posts it and refreshes the page', async () => {
    const fetchMock = stubFetch();
    const { onChanged } = renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog');
    const button = within(dialog).getByRole('button', { name: 'Reject' }) as HTMLButtonElement;
    expect(button).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: '  Not a real mandate  ' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(posted(fetchMock)).toHaveLength(1);
    const [url, init] = posted(fetchMock)[0];
    expect(url).toBe('/api/v1/discovery/candidates/c-harbor/reject');
    expect(JSON.parse(String(init?.body))).toEqual({ reason: 'Not a real mandate' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('needs a reason to set a step and posts the chosen step', async () => {
    const fetchMock = stubFetch();
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Set step' }));
    const dialog = await screen.findByRole('dialog');
    const select = within(dialog).getByLabelText('Step') as HTMLSelectElement;
    expect(select.value).toBe('p4-s47');
    const option = within(select).getByRole('option', { name: /LOI Review/ });
    expect(option).toHaveTextContent('44 · LOI Review');
    fireEvent.change(select, { target: { value: 'p4-s48' } });
    const button = within(dialog).getByRole('button', { name: 'Set step' }) as HTMLButtonElement;
    expect(button).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Signed by phone' } });
    fireEvent.click(button);
    await waitFor(() => expect(posted(fetchMock)).toHaveLength(1));
    const [url, init] = posted(fetchMock)[0];
    expect(url).toBe('/api/v1/discovery/candidates/c-harbor/station');
    expect(JSON.parse(String(init?.body))).toEqual({ stepId: 'p4-s48', reason: 'Signed by phone' });
  });

  it('merges into another proposed deal of the viewer, never into itself, with a reason', async () => {
    const fetchMock = stubFetch();
    renderActions({ candidateId: 'c-harbor', name: 'Project Harbor' });
    fireEvent.click(screen.getByRole('button', { name: 'Merge into…' }));
    const dialog = await screen.findByRole('dialog');
    const select = (await within(dialog).findByLabelText('Merge into')) as HTMLSelectElement;
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Project Kestrel']);
    const button = within(dialog).getByRole('button', { name: 'Merge' }) as HTMLButtonElement;
    expect(button).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Same process' } });
    fireEvent.click(button);
    await waitFor(() => expect(posted(fetchMock)).toHaveLength(1));
    const [url, init] = posted(fetchMock)[0];
    expect(url).toBe('/api/v1/discovery/candidates/c-harbor/merge');
    expect(JSON.parse(String(init?.body))).toEqual({ survivorId: 'c-kestrel', reason: 'Same process' });
  });

  it('needs two emails to split and one to move, and says nothing more than the disabled button', () => {
    renderActions({ items: [ITEMS[0]] });
    expect(screen.getByRole('button', { name: 'Split…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move an email…' })).toBeEnabled();
    cleanup();
    renderActions({ items: [] });
    expect(screen.getByRole('button', { name: 'Split…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move an email…' })).toBeDisabled();
  });

  it('splits: needs an email, a name and a reason, never every email, and posts the chosen items', async () => {
    const fetchMock = stubFetch();
    const { onChanged } = renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Split…' }));
    const dialog = await screen.findByRole('dialog');
    const button = within(dialog).getByRole('button', { name: 'Split' }) as HTMLButtonElement;
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Different process' } });
    fireEvent.change(within(dialog).getByLabelText('Name of the new deal'), { target: { value: ' Project Harbor Annex ' } });
    expect(button).toBeDisabled(); // no email chosen yet

    const boxes = within(dialog).getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    expect(within(dialog).getByText('Harbor: bids in')).toBeInTheDocument();
    expect(within(dialog).getByText('Sep 1, 2026')).toBeInTheDocument();
    // A colleague's email carries no subject (owner-only in the database) and says whose it is.
    expect(within(dialog).getByText("From another banker's mailbox")).toBeInTheDocument();
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    expect(button).toBeEnabled();
    fireEvent.click(boxes[2]); // every email would leave nothing behind
    expect(button).toBeDisabled();
    expect(within(dialog).getByText('Leave at least one email on Project Harbor.')).toBeInTheDocument();
    fireEvent.click(boxes[2]);
    expect(button).toBeEnabled();

    fireEvent.click(button);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const [url, init] = posted(fetchMock)[0];
    expect(url).toBe('/api/v1/discovery/candidates/c-harbor/split');
    expect(JSON.parse(String(init?.body))).toEqual({
      itemIds: ['i-1', 'i-2'],
      name: 'Project Harbor Annex',
      reason: 'Different process',
    });
  });

  it('moves one email to another proposed deal of the viewer, never to itself, with a reason', async () => {
    const fetchMock = stubFetch();
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Move an email…' }));
    const dialog = await screen.findByRole('dialog');
    const target = (await within(dialog).findByLabelText('Move to')) as HTMLSelectElement;
    expect(within(target).getAllByRole('option').map((o) => o.textContent)).toEqual(['Project Kestrel']);
    const email = within(dialog).getByLabelText('Email') as HTMLSelectElement;
    expect(within(email).getAllByRole('option')).toHaveLength(3);
    expect(within(email).getAllByRole('option')[2].textContent).toBe("From another banker's mailbox · Sep 7, 2026");
    fireEvent.change(email, { target: { value: 'l-2' } });
    const button = within(dialog).getByRole('button', { name: 'Move email' }) as HTMLButtonElement;
    expect(button).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'About Kestrel' } });
    fireEvent.click(button);
    await waitFor(() => expect(posted(fetchMock)).toHaveLength(1));
    const [url, init] = posted(fetchMock)[0];
    expect(url).toBe('/api/v1/discovery/candidates/c-harbor/reassign');
    expect(JSON.parse(String(init?.body))).toEqual({ linkId: 'l-2', targetCandidateId: 'c-kestrel', reason: 'About Kestrel' });
  });

  it('renames with an optional reason, only once the name differs', async () => {
    const fetchMock = stubFetch();
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');
    const button = within(dialog).getByRole('button', { name: 'Rename' }) as HTMLButtonElement;
    expect(button).toBeDisabled(); // the name is unchanged
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' Project Harbor Two ' } });
    expect(button).toBeEnabled(); // no reason needed
    fireEvent.click(button);
    await waitFor(() => expect(posted(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(posted(fetchMock)[0][1]?.body))).toEqual({ name: 'Project Harbor Two' });
  });

  it('keeps the dialog open and shows the server message when the change is refused', async () => {
    stubFetch(403, { error: 'Needs deal-create authority' });
    const { onChanged } = renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Because' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Needs deal-create authority');
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

const decision = (over: Partial<CandidateDecision>): CandidateDecision => ({
  id: 'd1',
  candidateId: 'c-kestrel',
  action: 'rename',
  actorName: 'Storm Duncan',
  own: true,
  at: '2026-10-02T09:30:00Z',
  before: null,
  after: null,
  reason: null,
  ...over,
});

describe("CandidateActions' initialOpen 'station' and the model-origin prompt", () => {
  const PROPOSAL = {
    stepId: 'p2-s26',
    reason: 'The model placed 3 of 4 emails in Phase 2 · Preparation & Market Readiness',
    source: 'model_proposal' as const,
  };

  it("opens Set station on first render when asked to, without a click", async () => {
    stubFetch();
    renderActions({ initialOpen: 'station' });
    expect(await screen.findByRole('dialog', { name: 'Set the step' })).toBeInTheDocument();
  });

  it('opens nothing without it', () => {
    renderActions();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows no model prompt on a rules-found deal, even when handed a proposal', () => {
    renderActions({ proposal: { ...PROPOSAL, source: 'evidence' } });
    expect(screen.queryByRole('group', { name: 'Model proposal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review step' })).not.toBeInTheDocument();
  });

  it('treats an absent origin as model-origin: the station dialog does not fall back to the first station', async () => {
    stubFetch();
    renderActions({ origin: undefined, placedStepId: null, initialOpen: 'station' });
    const dialog = await screen.findByRole('dialog', { name: 'Set the step' });
    expect((within(dialog).getByLabelText('Step') as HTMLSelectElement).value).toBe('');
  });

  it('shows the prompt on a model-origin deal and opens the station dialog from it', async () => {
    stubFetch();
    renderActions({ origin: 'model_proposal', placedStepId: PROPOSAL.stepId, proposal: PROPOSAL });
    const prompt = screen.getByRole('group', { name: 'Model proposal' });
    expect(prompt).toHaveTextContent(/The model proposes Step \d{2} · /);
    expect(prompt).toHaveTextContent(PROPOSAL.reason);
    fireEvent.click(within(prompt).getByRole('button', { name: 'Review step' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set the step' });
    expect((within(dialog).getByLabelText('Step') as HTMLSelectElement).value).toBe('p2-s26');
    expect(within(dialog).getByText(PROPOSAL.reason)).toBeInTheDocument();
  });

  it('disables Review station with the reason when the viewer cannot act', () => {
    renderActions({
      origin: 'model_proposal',
      placedStepId: PROPOSAL.stepId,
      proposal: PROPOSAL,
      canAct: { ok: false, reason: 'no_authority' },
    });
    expect(screen.getByRole('button', { name: 'Review step' })).toBeDisabled();
  });
});

describe('DecisionHistory', () => {
  it('reads who, what, when, why and the value before', () => {
    const decisions: CandidateDecision[] = [
      decision({
        id: 'd1',
        action: 'set_station',
        reason: 'Signed by phone',
        before: { stepId: null, suggestedStepId: 'p4-s47' },
        after: { stepId: 'p4-s48' },
      }),
      decision({
        id: 'd2',
        action: 'rename',
        actorName: 'A colleague',
        own: false,
        at: '2026-10-03T08:00:00Z',
        before: { name: 'Project Kestrel' },
        after: { name: 'Project Osprey Two' },
      }),
      decision({ id: 'd3', action: 'reject', reason: 'Not a real mandate', at: '2026-10-04T08:00:00Z' }),
    ];
    render(<DecisionHistory decisions={decisions} candidateId="c-kestrel" />);
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent(
      'Storm Duncan set the step to 44 · LOI Review on Oct 2, 2026. Reason: Signed by phone. Before: suggested 43.',
    );
    expect(items[1]).toHaveTextContent(
      'A colleague renamed this proposed deal to Project Osprey Two on Oct 3, 2026. Before: Project Kestrel.',
    );
    expect(items[2]).toHaveTextContent('Storm Duncan rejected this proposed deal on Oct 4, 2026. Reason: Not a real mandate.');
  });

  it('names the previous override when there was one, not the suggestion', () => {
    const d = decision({
      action: 'set_station',
      reason: 'Moved up',
      before: { stepId: 'p4-s48', suggestedStepId: 'p4-s47' },
      after: { stepId: 'p5-s51' },
    });
    expect(decisionSentence(d, 'c-kestrel')).toBe(
      'Storm Duncan set the step to 47 · Signing / Announcement Prep on Oct 2, 2026. Reason: Moved up. Before: 44 · LOI Review.',
    );
  });

  it('tells a merge out of this deal from a merge into it', () => {
    const out = decision({
      candidateId: 'c-harbor',
      action: 'merge',
      reason: 'Same process',
      before: { state: 'proposed', name: 'Project Harbor' },
      after: { survivorId: 'c-kestrel', survivorName: 'Project Kestrel' },
    });
    expect(decisionSentence(out, 'c-harbor')).toBe(
      'Storm Duncan merged this proposed deal into Project Kestrel on Oct 2, 2026. Reason: Same process.',
    );
    expect(decisionSentence(out, 'c-kestrel')).toBe(
      'Storm Duncan merged Project Harbor into this proposed deal on Oct 2, 2026. Reason: Same process.',
    );
  });

  it('tells a split off this deal from a split that made it', () => {
    const split = decision({
      candidateId: 'c-kestrel',
      action: 'split',
      reason: 'Two processes',
      before: { name: 'Project Kestrel' },
      after: { newCandidateId: 'c-annex', newName: 'Project Kestrel Annex', itemCount: 2 },
    });
    expect(decisionSentence(split, 'c-kestrel')).toBe(
      'Storm Duncan split 2 emails off this proposed deal into Project Kestrel Annex on Oct 2, 2026. Reason: Two processes.',
    );
    expect(decisionSentence({ ...split, after: { ...split.after, itemCount: 1 } }, 'c-kestrel')).toContain('split 1 email off');
    expect(decisionSentence(split, 'c-annex')).toBe(
      'Storm Duncan split this proposed deal off Project Kestrel on Oct 2, 2026. Reason: Two processes.',
    );
  });

  it('tells a reassign out of this deal from a reassign into it', () => {
    const moved = decision({
      candidateId: 'c-annex',
      action: 'reassign',
      reason: 'About Kestrel',
      before: { name: 'Project Kestrel Annex', linkId: 'l-1', sourceItemId: 'i-1' },
      after: { targetCandidateId: 'c-kestrel', targetName: 'Project Kestrel' },
    });
    expect(decisionSentence(moved, 'c-annex')).toBe(
      'Storm Duncan moved an email from this proposed deal to Project Kestrel on Oct 2, 2026. Reason: About Kestrel.',
    );
    expect(decisionSentence(moved, 'c-kestrel')).toBe(
      'Storm Duncan moved an email from Project Kestrel Annex to this proposed deal on Oct 2, 2026. Reason: About Kestrel.',
    );
  });

  it('reads an accepted model proposal with how many of its emails were read, and no key or request id', () => {
    const accepted = decision({
      action: 'accept_proposal',
      after: { requestId: 'r-1', found: 3, requested: 4 },
    });
    const sentence = decisionSentence(accepted, 'c-kestrel');
    expect(sentence).toBe(
      'Storm Duncan accepted this proposed deal from a model proposal on Oct 2, 2026. 3 of 4 emails were read.',
    );
    expect(sentence).not.toMatch(/r-1|—/);
    expect(
      decisionSentence({ ...accepted, after: { requestId: 'r-1', found: 1, requested: 1 } }, 'c-kestrel'),
    ).toContain('1 of 1 email was read.');
    // A line with no usable counts still reads as a sentence, without a number.
    expect(decisionSentence({ ...accepted, after: null }, 'c-kestrel')).toBe(
      'Storm Duncan accepted this proposed deal from a model proposal on Oct 2, 2026.',
    );
  });

  it('renders nothing when no decision was made', () => {
    const { container } = render(<DecisionHistory decisions={[]} candidateId="c-kestrel" />);
    expect(container).toBeEmptyDOMElement();
  });
});

const SUGGESTED: CandidateStation = {
  stepId: 'p4-s47',
  station: 43,
  total: 61,
  title: 'Bid Review',
  lifecycle: 'live',
  reason: 'Bid Review because bids received on Sep 1, 2026 (2 emails)',
  confidence: 0.9,
  flags: ['overridden'],
  asOf: '2026-10-02T10:00:00Z',
};

describe('StepSuggestion with a step set by a person', () => {
  it('shows the MD step first and the evidence suggestion beneath it', () => {
    render(
      <StepSuggestion
        station={SUGGESTED}
        override={{ stepId: 'p4-s48', station: 44, title: 'LOI Review', reason: 'Signed by phone' }}
      />,
    );
    const card = screen.getByRole('region', { name: 'Suggested step' });
    expect(within(card).getByText('Diligence · Step 44 · LOI Review')).toBeInTheDocument();
    expect(within(card).getByText('Signed by phone')).toBeInTheDocument();
    expect(within(card).getByText('Evidence suggests Diligence · Step 43 · Bid Review')).toBeInTheDocument();
  });

  it('still says when the evidence suggests nothing', () => {
    render(
      <StepSuggestion station={null} override={{ stepId: 'p4-s48', station: 44, title: 'LOI Review', reason: null }} />,
    );
    expect(screen.getByText('Diligence · Step 44 · LOI Review')).toBeInTheDocument();
    expect(screen.getByText('No milestones extracted yet')).toBeInTheDocument();
  });
});
