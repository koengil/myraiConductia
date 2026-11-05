import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { CONFIRMED_PROPOSAL_REASON, SetStepDialog } from '@/components/discovery/SetStepDialog';
import { proposalReason, proposedStepFor } from '@/lib/discovery/propose/station';
import { MVP_DEAL_RAIL, stepDisplayNumber } from '@/lib/rail/dealRail';

const MODEL_STEP = proposedStepFor('phase-2');
const MODEL_REASON = proposalReason({ placed: 3, of: 4, phase: 'phase-2' });
const stationLabel = (stepId: string) => {
  const step = MVP_DEAL_RAIL.flatMap((p) => p.steps).find((s) => s.id === stepId)!;
  return `${String(stepDisplayNumber(stepId, MVP_DEAL_RAIL)).padStart(2, '0')} · ${step.title}`;
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ correctionId: 'corr-1' }), { status: 200 })));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDialog(props: Partial<React.ComponentProps<typeof SetStepDialog>> = {}) {
  const onDone = vi.fn();
  render(
    <SetStepDialog
      candidateId="c-falcon"
      currentStepId={MODEL_STEP}
      origin="model_proposal"
      proposal={{ stepId: MODEL_STEP, reason: MODEL_REASON, source: 'model_proposal' }}
      onClose={vi.fn()}
      onDone={onDone}
      {...props}
    />,
  );
  const dialog = screen.getByRole('dialog', { name: 'Set the step' });
  return { onDone, dialog, select: within(dialog).getByLabelText('Step') as HTMLSelectElement };
}

describe('SetStepDialog on a model proposal', () => {
  it('shows what is proposed and why, and starts on the proposed station', () => {
    const { dialog, select } = renderDialog();
    expect(within(dialog).getByText('Proposed')).toBeInTheDocument();
    expect(within(dialog).getByText(stationLabel(MODEL_STEP), { selector: 'p' })).toBeInTheDocument();
    expect(within(dialog).getByText(MODEL_REASON)).toBeInTheDocument();
    expect(select.value).toBe(MODEL_STEP);
  });

  it('starts the reason as a confirmation the MD can edit, so submitting is the confirmation', async () => {
    const { dialog, onDone } = renderDialog();
    const reason = within(dialog).getByLabelText('Reason') as HTMLTextAreaElement;
    expect(reason.value).toBe(CONFIRMED_PROPOSAL_REASON);
    expect(CONFIRMED_PROPOSAL_REASON).toBe('Confirmed the proposed step');
    const submit = within(dialog).getByRole('button', { name: 'Set step' });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/discovery/candidates/c-falcon/station');
    expect(JSON.parse(init.body as string)).toEqual({ stepId: MODEL_STEP, reason: CONFIRMED_PROPOSAL_REASON });
  });

  it('lets the MD choose another station and write their own reason', async () => {
    const { dialog, select, onDone } = renderDialog();
    fireEvent.change(select, { target: { value: 'p4-s48' } });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Signed by phone' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set step' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ stepId: 'p4-s48', reason: 'Signed by phone' });
  });

  it('shows an evidence suggestion the same way, with its own reason', () => {
    const { dialog } = renderDialog({
      currentStepId: 'p4-s48',
      proposal: { stepId: 'p4-s48', reason: 'LOI Review because LOI signed on Sep 18, 2026 (3 emails)', source: 'evidence' },
    });
    expect(within(dialog).getByText('Proposed')).toBeInTheDocument();
    expect(within(dialog).getByText('LOI Review because LOI signed on Sep 18, 2026 (3 emails)')).toBeInTheDocument();
    expect((within(dialog).getByLabelText('Reason') as HTMLTextAreaElement).value).toBe(CONFIRMED_PROPOSAL_REASON);
  });

  it('keeps its copy free of em dashes', () => {
    const { dialog } = renderDialog();
    expect(dialog.textContent).not.toContain('—');
  });

  describe('the default reason belongs to the proposed station only', () => {
    const OTHER_STEP = 'p4-s48';
    const reasonBox = (dialog: HTMLElement) => within(dialog).getByLabelText('Reason') as HTMLTextAreaElement;
    const submitted = () => {
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      return JSON.parse(init.body as string) as { stepId: string; reason: string };
    };

    it('clears the untouched default when a different station is picked, so the submit needs the MD\'s own reason', async () => {
      const { dialog, select, onDone } = renderDialog();
      fireEvent.change(select, { target: { value: OTHER_STEP } });
      expect(reasonBox(dialog).value).toBe('');
      const submit = within(dialog).getByRole('button', { name: 'Set step' });
      expect(submit).toBeDisabled();
      fireEvent.click(submit);
      expect(fetchMock).not.toHaveBeenCalled();

      fireEvent.change(reasonBox(dialog), { target: { value: 'Signed by phone' } });
      fireEvent.click(submit);
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      expect(submitted()).toEqual({ stepId: OTHER_STEP, reason: 'Signed by phone' });
      expect(submitted().reason).not.toBe(CONFIRMED_PROPOSAL_REASON);
    });

    it('never sends the confirmation as the reason for a different station', () => {
      const { dialog, select } = renderDialog();
      fireEvent.change(select, { target: { value: OTHER_STEP } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Set step' }));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps a reason the MD edited when the station changes, both ways', async () => {
      const { dialog, select, onDone } = renderDialog();
      fireEvent.change(reasonBox(dialog), { target: { value: 'Told by the client' } });
      fireEvent.change(select, { target: { value: OTHER_STEP } });
      expect(reasonBox(dialog).value).toBe('Told by the client');
      fireEvent.change(select, { target: { value: MODEL_STEP } });
      expect(reasonBox(dialog).value).toBe('Told by the client');
      fireEvent.change(select, { target: { value: OTHER_STEP } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Set step' }));
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      expect(submitted()).toEqual({ stepId: OTHER_STEP, reason: 'Told by the client' });
    });

    it('keeps a reason the MD deliberately cleared cleared, even on the proposed station', () => {
      const { dialog, select } = renderDialog();
      fireEvent.change(reasonBox(dialog), { target: { value: '' } });
      fireEvent.change(select, { target: { value: OTHER_STEP } });
      fireEvent.change(select, { target: { value: MODEL_STEP } });
      expect(reasonBox(dialog).value).toBe('');
    });

    it('brings the default back when the MD switches back to the proposed station with the reason untouched', () => {
      const { dialog, select } = renderDialog();
      fireEvent.change(select, { target: { value: OTHER_STEP } });
      expect(reasonBox(dialog).value).toBe('');
      fireEvent.change(select, { target: { value: MODEL_STEP } });
      expect(reasonBox(dialog).value).toBe(CONFIRMED_PROPOSAL_REASON);
    });

    it('sends the default reason when the MD submits the proposed station without editing', async () => {
      const { dialog, onDone } = renderDialog();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Set step' }));
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(submitted()).toEqual({ stepId: MODEL_STEP, reason: CONFIRMED_PROPOSAL_REASON });
    });

    it('sends the default reason after a round trip to another station and back', async () => {
      const { dialog, select, onDone } = renderDialog();
      fireEvent.change(select, { target: { value: OTHER_STEP } });
      fireEvent.change(select, { target: { value: MODEL_STEP } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Set step' }));
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(submitted()).toEqual({ stepId: MODEL_STEP, reason: CONFIRMED_PROPOSAL_REASON });
    });

    it('points the station select and the reason box at the Proposed block', () => {
      const { dialog, select } = renderDialog();
      const describedBy = select.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const block = document.getElementById(describedBy as string);
      expect(block).not.toBeNull();
      expect(block).toHaveTextContent('Proposed');
      expect(block).toHaveTextContent(MODEL_REASON);
      expect(reasonBox(dialog).getAttribute('aria-describedby')).toBe(describedBy);
      expect(dialog.contains(block)).toBe(true);
    });

    it('describes nothing when there is no proposal block to point at', () => {
      const { dialog, select } = renderDialog({ currentStepId: 'p4-s47', proposal: null });
      expect(select).not.toHaveAttribute('aria-describedby');
      expect(reasonBox(dialog)).not.toHaveAttribute('aria-describedby');
    });
  });
});

describe('SetStepDialog on a model-origin deal with nothing proposed', () => {
  it('has no first-station fallback: it asks the MD to choose and cannot submit until they do', async () => {
    const { dialog, select, onDone } = renderDialog({ currentStepId: null, proposal: null });
    expect(select.value).toBe('');
    expect(within(select).getByRole('option', { name: 'Choose a step' })).toBeInTheDocument();
    expect(within(dialog).queryByText('Proposed')).not.toBeInTheDocument();

    const submit = within(dialog).getByRole('button', { name: 'Set step' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Told by the client' } });
    expect(submit).toBeDisabled();

    fireEvent.change(select, { target: { value: 'p4-s47' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ stepId: 'p4-s47', reason: 'Told by the client' });
  });

  it('starts at the MD\'s own station, with no proposal block and an empty reason', () => {
    const { dialog, select } = renderDialog({ currentStepId: 'p4-s48', proposal: null });
    expect(select.value).toBe('p4-s48');
    expect(within(dialog).queryByText('Proposed')).not.toBeInTheDocument();
    expect((within(dialog).getByLabelText('Reason') as HTMLTextAreaElement).value).toBe('');
  });

  it('starts unpicked when the step it was given is not on the rail', () => {
    const { select } = renderDialog({ currentStepId: 'p9-s999', proposal: null });
    expect(select.value).toBe('');
  });
});

describe('SetStepDialog on a rules-found deal (unchanged)', () => {
  it('starts at the given station with no proposal block and an empty reason', () => {
    const { dialog, select } = renderDialog({ origin: 'rules', currentStepId: 'p4-s47', proposal: null });
    expect(select.value).toBe('p4-s47');
    expect(within(dialog).queryByText('Proposed')).not.toBeInTheDocument();
    expect((within(dialog).getByLabelText('Reason') as HTMLTextAreaElement).value).toBe('');
  });

  it('still falls back to the first station when none is given', () => {
    const { select } = renderDialog({ origin: 'rules', currentStepId: null, proposal: null });
    expect(select.value).not.toBe('');
    expect(within(select).queryByRole('option', { name: 'Choose a step' })).not.toBeInTheDocument();
  });
});

describe('SetStepDialog with no origin given (fails closed as model-origin)', () => {
  it('does not fall back to the first station: it asks the MD to choose', () => {
    const { select } = renderDialog({ origin: undefined, currentStepId: null, proposal: null });
    expect(select.value).toBe('');
    expect(within(select).getByRole('option', { name: 'Choose a step' })).toBeInTheDocument();
  });
});
