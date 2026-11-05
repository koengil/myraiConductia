import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SkillBuilderDialog, type InitialPlacement } from '@/components/rail/SkillBuilderDialog';
import {
  defaultPlacement,
  placementBefore,
  placementSummary,
} from '@/components/rail/SkillBuilderPlacementFields';
import type { SkillAuthoringClient } from '@/lib/skillAuthoring/client';
import type { Placement } from '@/lib/skillAuthoring/types';
import { baseDraft, fakeClient, openResult, rail } from '../helpers/skillBuilderDialogFixtures';
import { publicationClientStub } from '../helpers/publicationClientStub';

afterEach(() => {
  cleanup();
});

async function open(
  client: SkillAuthoringClient,
  initialPlacement?: InitialPlacement,
  publicationClient = publicationClientStub(),
) {
  const onClose = vi.fn();
  render(
    <SkillBuilderDialog
      open
      dealId="deal-1"
      rail={rail}
      onClose={onClose}
      client={client}
      publicationClient={publicationClient}
      initialPlacement={initialPlacement}
    />,
  );
  await screen.findByRole('dialog');
  await waitFor(() => expect(client.open).toHaveBeenCalled());
  return { onClose };
}

/** Lets a debounced draft save (500 ms) fire if anything scheduled one. */
const pastDebounce = () => new Promise((resolve) => setTimeout(resolve, 700));

const AFTER_STEP_1: Placement = { kind: 'after', phaseIndex: 0, afterStepId: 'step-1' };
const AFTER_STEP_2: Placement = { kind: 'after', phaseIndex: 0, afterStepId: 'step-2' };

describe('where a new step goes', () => {
  it('defaults to after the deal current step, or after the step the MD added from', () => {
    expect(defaultPlacement(rail)).toEqual(AFTER_STEP_1);
    expect(defaultPlacement(rail, 'step-2')).toEqual(AFTER_STEP_2);
    expect(defaultPlacement({ ...rail, currentStepId: null })).toEqual({
      kind: 'phase_start',
      phaseIndex: 0,
    });
  });

  it('saves "Before" as the spot the API knows: after the step before, or the phase start', () => {
    expect(placementBefore(rail, 0, 'step-2')).toEqual(AFTER_STEP_1);
    expect(placementBefore(rail, 0, 'step-1')).toEqual({ kind: 'phase_start', phaseIndex: 0 });
  });

  it('reads as one line that names the step or the phase by name', () => {
    expect(placementSummary(rail, AFTER_STEP_1)).toBe('Adds after: cat-1');
    expect(placementSummary(rail, AFTER_STEP_1, 'step-2')).toBe('Adds before: cat-2');
    expect(placementSummary(rail, { kind: 'phase_end', phaseIndex: 1 })).toBe('Adds at the end of Diligence');
  });

  it('opens with the step name first and the default spot as one line, the selects only after Change', async () => {
    const client = fakeClient();
    await open(client, { placement: AFTER_STEP_1, explicit: false });

    await waitFor(() =>
      expect(screen.getByTestId('placement-summary')).toHaveTextContent('Adds after: cat-1'),
    );
    expect(screen.queryByLabelText('Phase')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Position')).not.toBeInTheDocument();
    // Opening shows the spot but saves nothing.
    await pastDebounce();
    expect(client.patch).not.toHaveBeenCalled();

    // The step name is the first field in the dialog.
    const fields = screen.getAllByRole('textbox');
    expect(fields[0]).toHaveAccessibleName('Step name');

    fireEvent.click(screen.getByRole('button', { name: 'Change where this step goes' }));
    const phase = screen.getByLabelText('Phase') as HTMLSelectElement;
    expect(Array.from(phase.options).map((o) => o.textContent)).toEqual(['Origination', 'Diligence']);
    const position = screen.getByLabelText('Position') as HTMLSelectElement;
    expect(Array.from(position.options).map((o) => o.textContent)).toEqual([
      'Start of phase',
      'End of phase',
      'Before: cat-1',
      'After: cat-1',
      'Before: cat-2',
      'After: cat-2',
    ]);
  });

  it('places "Before" a step and keeps reading it as before', async () => {
    const client = fakeClient();
    await open(client, { placement: AFTER_STEP_2, explicit: false });
    await waitFor(() =>
      expect(screen.getByTestId('placement-summary')).toHaveTextContent('Adds after: cat-2'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change where this step goes' }));
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: 'before:step-2' } });

    expect(screen.getByLabelText('Position')).toHaveValue('before:step-2');
    await waitFor(() =>
      expect(client.patch).toHaveBeenLastCalledWith(
        'deal-1',
        'draft-1',
        expect.objectContaining({ placement: AFTER_STEP_1 }),
      ),
    );
  });

  it('saves the spot with the first edit, in the same draft save as the name', async () => {
    const client = fakeClient();
    await open(client, { placement: AFTER_STEP_2, explicit: false });
    await waitFor(() =>
      expect(screen.getByTestId('placement-summary')).toHaveTextContent('Adds after: cat-2'),
    );
    fireEvent.change(screen.getByLabelText('Step name'), { target: { value: 'Buyer memo' } });
    await waitFor(() => expect(client.patch).toHaveBeenCalledTimes(1));
    expect(client.patch).toHaveBeenCalledWith(
      'deal-1',
      'draft-1',
      expect.objectContaining({ name: 'Buyer memo', placement: AFTER_STEP_2 }),
    );
  });

  it('opening and closing without an edit leaves the draft untouched', async () => {
    const client = fakeClient();
    const { onClose } = await open(client, { placement: AFTER_STEP_1, explicit: true });
    await waitFor(() =>
      expect(screen.getByTestId('placement-summary')).toHaveTextContent('Adds after: cat-1'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await pastDebounce();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("keeps a resumed draft's own spot unless the MD added from a step, and saves neither on open", async () => {
    const saved = baseDraft({ placement: AFTER_STEP_2 });
    const kept = fakeClient({ open: vi.fn(async () => openResult(saved)) });
    await open(kept, { placement: AFTER_STEP_1, explicit: false });
    await waitFor(() =>
      expect(screen.getByTestId('placement-summary')).toHaveTextContent('Adds after: cat-2'),
    );
    await pastDebounce();
    expect(kept.patch).not.toHaveBeenCalled();
    cleanup();

    const moved = fakeClient({ open: vi.fn(async () => openResult(saved)) });
    await open(moved, { placement: AFTER_STEP_1, explicit: true });
    await waitFor(() =>
      expect(screen.getByTestId('placement-summary')).toHaveTextContent('Adds after: cat-1'),
    );
    await pastDebounce();
    expect(moved.patch).not.toHaveBeenCalled();
  });

  it('"Save skill and add step" saves the shown spot before it publishes', async () => {
    const ready = baseDraft({
      name: 'Buyer memo',
      candidate: {
        id: 'cand-1',
        digest: 'sha256:abc',
        schemaVersion: 1,
        name: 'Buyer memo',
        purpose: 'Draft the memo',
        expectedInput: 'Notes',
        expectedOutput: 'A memo',
        inputs: [],
      },
    });
    const order: string[] = [];
    const client = fakeClient({
      open: vi.fn(async () => openResult(ready)),
      patch: vi.fn(async (_deal, _draft, command) => {
        order.push('patch');
        return baseDraft({ ...ready, ...command, editRevision: 2 });
      }),
    });
    const publicationClient = publicationClientStub();
    vi.mocked(publicationClient.publish).mockImplementation(async () => {
      order.push('publish');
      throw new Error('stop here');
    });
    await open(client, { placement: AFTER_STEP_1, explicit: false }, publicationClient);
    const save = await screen.findByRole('button', { name: 'Save skill and add step' });
    await waitFor(() => expect(save).toBeEnabled());
    expect(client.patch).not.toHaveBeenCalled();

    fireEvent.click(save);
    await waitFor(() => expect(order).toEqual(['patch', 'publish']));
    expect(client.patch).toHaveBeenCalledWith(
      'deal-1',
      'draft-1',
      expect.objectContaining({ placement: AFTER_STEP_1 }),
    );
  });
});
