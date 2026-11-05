import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { EvidenceSuggestionMarker, type MarkerStep } from '@/components/rail/EvidenceSuggestionMarker';
import type { EvidenceSuggestion } from '@/lib/deals/evidenceSuggestion';

const SUGGESTION: EvidenceSuggestion = {
  assessmentId: '3f0c1f0e-5a4b-4f57-9d8e-0c1f2a3b4c5d',
  stepId: 'p5-s51',
  reason: 'Signing / Announcement Prep because signing on 26 Oct 2026 (1 email)',
  evidenceCount: 1,
  asOf: '2026-10-28T10:00:00Z',
  dismissed: false,
  flags: [],
};

/** A small rail: step numbers come from this order, the move sends the step's seq. */
const STEPS: MarkerStep[] = [
  { stepId: 'p4-s46', seq: 46, title: 'Process Letter', removed: false },
  { stepId: 'p4-s47', seq: 47, title: 'Bid Review', removed: false },
  { stepId: 'p4-s48', seq: 48, title: 'LOI Review', removed: false },
  { stepId: 'p5-s51', seq: 51, title: 'Signing / Announcement Prep', removed: false },
];

type Fetch = ReturnType<typeof vi.fn>;
let fetchMock: Fetch;
let suggestion: EvidenceSuggestion | null;
let origin: 'model_proposal' | 'rules';
let patchStatus = 200;

beforeEach(() => {
  suggestion = SUGGESTION;
  origin = 'rules';
  patchStatus = 200;
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      return Promise.resolve(new Response(JSON.stringify(patchStatus === 200 ? { deal: {} } : { error: 'Only the deal MD can move the rail backwards' }), { status: patchStatus }));
    }
    if (init?.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ correctionId: 'c-1' }), { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify({ suggestion, origin }), { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderMarker = (props: Partial<React.ComponentProps<typeof EvidenceSuggestionMarker>> = {}) => {
  const onMoved = vi.fn();
  const view = render(
    <EvidenceSuggestionMarker dealCode="KESTR-2026-412" steps={STEPS} currentStepId="p4-s48" canDismiss onMoved={onMoved} {...props} />,
  );
  return { onMoved, ...view };
};
const calls = (method: string) => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method);
/** The read has been made and its answer rendered, so an absence assertion after it is not vacuous. */
const settled = async () => {
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('EvidenceSuggestionMarker', () => {
  it('reads the suggestion for this deal code and shows the step, the title and the reason', async () => {
    renderMarker();
    const marker = await screen.findByRole('status', { name: 'Evidence suggestion' });
    expect(marker).toHaveTextContent('Evidence suggests Step 04 · Signing / Announcement Prep');
    expect(marker).toHaveTextContent(SUGGESTION.reason);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/discovery/suggestions?deal=KESTR-2026-412');
  });

  it('is hidden when the suggested step is the one the cursor is on', async () => {
    renderMarker({ currentStepId: 'p5-s51' });
    await settled();
    expect(screen.queryByRole('status', { name: 'Evidence suggestion' })).not.toBeInTheDocument();
  });

  it('is hidden once that assessment was dismissed', async () => {
    suggestion = { ...SUGGESTION, dismissed: true };
    renderMarker();
    await settled();
    expect(screen.queryByRole('status', { name: 'Evidence suggestion' })).not.toBeInTheDocument();
  });

  it('is hidden when the suggested step was removed from this rail', async () => {
    renderMarker({ steps: STEPS.map((s) => (s.stepId === 'p5-s51' ? { ...s, removed: true } : s)) });
    await settled();
    expect(screen.queryByRole('status', { name: 'Evidence suggestion' })).not.toBeInTheDocument();
  });

  it('is hidden when the step is not on this rail at all, and when the engine flagged station_removed', async () => {
    renderMarker({ steps: STEPS.filter((s) => s.stepId !== 'p5-s51') });
    await settled();
    expect(screen.queryByRole('status', { name: 'Evidence suggestion' })).not.toBeInTheDocument();
    cleanup();
    suggestion = { ...SUGGESTION, flags: ['station_removed'] };
    renderMarker();
    await settled();
    expect(screen.queryByRole('status', { name: 'Evidence suggestion' })).not.toBeInTheDocument();
  });

  it('is hidden when the read answers nothing or fails', async () => {
    suggestion = null;
    renderMarker();
    await settled();
    expect(screen.queryByRole('status', { name: 'Evidence suggestion' })).not.toBeInTheDocument();
    cleanup();
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 500 })));
    renderMarker();
    await settled();
    expect(screen.queryByRole('status', { name: 'Evidence suggestion' })).not.toBeInTheDocument();
  });

  it("numbers the step from this rail's own order: a removed step renumbers it", async () => {
    renderMarker({ steps: STEPS.map((s) => (s.stepId === 'p4-s47' ? { ...s, removed: true } : s)) });
    const marker = await screen.findByRole('status', { name: 'Evidence suggestion' });
    expect(marker).toHaveTextContent('Evidence suggests Step 03 · Signing / Announcement Prep');
    expect(screen.getByRole('button', { name: 'Move rail to step 03' })).toBeInTheDocument();
  });

  it('moves the rail through the progress route with the step seq (51), never the step number', async () => {
    const { onMoved } = renderMarker();
    fireEvent.click(await screen.findByRole('button', { name: 'Move rail to step 04' }));
    await waitFor(() => expect(onMoved).toHaveBeenCalledTimes(1));
    expect(calls('PATCH')).toHaveLength(1);
    const [url, init] = calls('PATCH')[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/deals/KESTR-2026-412/progress');
    expect(JSON.parse(init.body as string)).toEqual({ currentStepSeq: 51 });
  });

  it('says so when the rail could not be moved, and does not report a move', async () => {
    patchStatus = 403;
    const { onMoved } = renderMarker();
    fireEvent.click(await screen.findByRole('button', { name: 'Move rail to step 04' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only the deal MD can move the rail backwards');
    expect(onMoved).not.toHaveBeenCalled();
  });

  it('offers dismissal only to the MD', async () => {
    renderMarker({ canDismiss: false });
    await screen.findByRole('status', { name: 'Evidence suggestion' });
    expect(screen.queryByRole('button', { name: 'Dismiss with reason' })).not.toBeInTheDocument();
    cleanup();
    renderMarker({ canDismiss: true });
    expect(await screen.findByRole('button', { name: 'Dismiss with reason' })).toBeInTheDocument();
  });

  it('dismisses with a required reason, then hides the marker and posts nothing else', async () => {
    renderMarker();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss with reason' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss this suggestion' });
    const submit = within(dialog).getByRole('button', { name: 'Dismiss' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: '  Signing slipped to November  ' } });
    expect(submit).toBeEnabled();

    suggestion = { ...SUGGESTION, dismissed: true }; // what the next read says after the dismissal
    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls('POST')).toHaveLength(1);
    const [url, init] = calls('POST')[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/discovery/suggestions/dismiss');
    expect(JSON.parse(init.body as string)).toEqual({
      dealCode: 'KESTR-2026-412',
      assessmentId: SUGGESTION.assessmentId,
      reason: 'Signing slipped to November',
    });
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Evidence suggestion' })).not.toBeInTheDocument());
    expect(calls('PATCH')).toHaveLength(0);
  });

  it('keeps the dialog and shows the message when the server refuses the dismissal', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? Promise.resolve(new Response(JSON.stringify({ error: 'Only the deal MD can dismiss this suggestion' }), { status: 403 }))
        : Promise.resolve(new Response(JSON.stringify({ suggestion }), { status: 200 })),
    );
    renderMarker();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss with reason' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Not the MD' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Only the deal MD can dismiss this suggestion');
    expect(screen.getByRole('status', { name: 'Evidence suggestion' })).toBeInTheDocument();
  });
  describe('origin', () => {
    it('offers Move with one click on a deal the rules found', async () => {
      origin = 'rules';
      const { onMoved } = renderMarker();
      fireEvent.click(await screen.findByRole('button', { name: 'Move rail to step 04' }));
      await waitFor(() => expect(onMoved).toHaveBeenCalledTimes(1));
      expect(calls('PATCH')).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Dismiss with reason' })).toBeInTheDocument();
    });

    it('has no Move on a model-origin deal; the suggestion, its reason and Dismiss stay', async () => {
      origin = 'model_proposal';
      renderMarker();
      const marker = await screen.findByRole('status', { name: 'Evidence suggestion' });
      expect(marker).toHaveTextContent('Evidence suggests Step 04 · Signing / Announcement Prep');
      expect(marker).toHaveTextContent(SUGGESTION.reason);
      expect(screen.queryByRole('button', { name: /Move rail to step/ })).not.toBeInTheDocument();
      expect(within(marker).getByRole('button', { name: 'Dismiss with reason' })).toBeInTheDocument();
      expect(calls('PATCH')).toHaveLength(0);
    });

    it('still dismisses with a reason on a model-origin deal', async () => {
      origin = 'model_proposal';
      renderMarker();
      fireEvent.click(await screen.findByRole('button', { name: 'Dismiss with reason' }));
      const dialog = await screen.findByRole('dialog', { name: 'Dismiss this suggestion' });
      fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Signing slipped' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
      await waitFor(() => expect(calls('POST')).toHaveLength(1));
      expect(calls('PATCH')).toHaveLength(0);
    });

    it('shows a model-origin deal\'s suggestion with no actions at all to someone who cannot dismiss', async () => {
      origin = 'model_proposal';
      renderMarker({ canDismiss: false });
      const marker = await screen.findByRole('status', { name: 'Evidence suggestion' });
      expect(within(marker).queryByRole('button')).not.toBeInTheDocument();
    });

    /** Answers the read with this exact body (the mock's default always carries an origin), and the rest as usual. */
    const answerWith = (body: unknown, status = 200) =>
      fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify(init?.method ? { correctionId: 'c-1' } : body), { status: init?.method ? 200 : status }),
        ),
      );

    it('fails closed: a response with no origin shows the suggestion and Dismiss but no Move', async () => {
      answerWith({ suggestion });
      renderMarker();
      const marker = await screen.findByRole('status', { name: 'Evidence suggestion' });
      expect(marker).toHaveTextContent(SUGGESTION.reason);
      expect(screen.queryByRole('button', { name: /Move rail to step/ })).not.toBeInTheDocument();
      expect(within(marker).getByRole('button', { name: 'Dismiss with reason' })).toBeInTheDocument();
    });

    it.each([['unknown'], ['Rules'], [''], [null], [42]])('fails closed: an origin of %j shows no Move', async (value) => {
      answerWith({ suggestion, origin: value });
      renderMarker();
      await screen.findByRole('status', { name: 'Evidence suggestion' });
      expect(screen.queryByRole('button', { name: /Move rail to step/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Dismiss with reason' })).toBeInTheDocument();
    });

    it('fails closed: a failed fetch shows no Move (nor any marker)', async () => {
      fetchMock.mockImplementation(() => Promise.reject(new Error('network down')));
      renderMarker();
      await settled();
      expect(screen.queryByRole('button', { name: /Move rail to step/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('status', { name: 'Evidence suggestion' })).not.toBeInTheDocument();
    });

    it('fails closed: a 500 shows no Move even when the body carries a suggestion and rules', async () => {
      answerWith({ suggestion, origin: 'rules' }, 500);
      renderMarker();
      await settled();
      expect(screen.queryByRole('button', { name: /Move rail to step/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('status', { name: 'Evidence suggestion' })).not.toBeInTheDocument();
    });

    it('offers Move only for an explicit rules', async () => {
      answerWith({ suggestion, origin: 'rules' });
      renderMarker();
      expect(await screen.findByRole('button', { name: 'Move rail to step 04' })).toBeInTheDocument();
    });

    it('asks again after a reload and follows the origin the server then reports', async () => {
      origin = 'model_proposal';
      const { rerender } = renderMarker();
      await screen.findByRole('status', { name: 'Evidence suggestion' });
      expect(screen.queryByRole('button', { name: /Move rail to step/ })).not.toBeInTheDocument();
      origin = 'rules';
      rerender(
        <EvidenceSuggestionMarker dealCode="OTHER-2026-001" steps={STEPS} currentStepId="p4-s48" canDismiss onMoved={vi.fn()} />,
      );
      expect(await screen.findByRole('button', { name: 'Move rail to step 04' })).toBeInTheDocument();
    });
  });
});
