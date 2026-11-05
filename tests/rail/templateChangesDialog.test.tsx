import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { TemplateChangesDialog } from '@/components/rail/TemplateChangesDialog';
import type { ProjectRail, ProjectRailStep } from '@/lib/rail/projectRail';
import type { TemplateChangeSet } from '@/lib/railTemplates/changeReview';

import { TEMPLATE_CHANGE_SET, decided } from './templateChangeSetFixture';

function step(stepId: string, title: string, phaseIndex: number, displayOrder: number): ProjectRailStep {
  return {
    id: `uuid-${stepId}`,
    stepId,
    origin: 'custom',
    phaseIndex,
    displayOrder,
    seq: null,
    status: 'pending',
    definition: { title, description: '' },
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
  };
}

const RAIL: ProjectRail = {
  currentStepId: null,
  canEditStructure: true,
  canSaveTemplate: false,
  phases: [
    { index: 4, name: 'Diligence, LOI & Definitive Docs', dealStatus: 'active' },
    { index: 5, name: 'Signing, Closing & Post-Close', dealStatus: 'active' },
  ],
  steps: [
    step('p4-s50', 'Definitive Agreement Support', 4, 50),
    step('p5-s51', 'Signing / Announcement Prep', 5, 51),
    step('p5-s53', 'LinkedIn Post', 5, 53),
  ],
};

function renderDialog(
  changeSet: TemplateChangeSet = TEMPLATE_CHANGE_SET,
  { canDecide = true, busy = false, error = null as string | null } = {},
) {
  const handlers = { onDecide: vi.fn(), onReopen: vi.fn(), onClose: vi.fn() };
  render(
    <TemplateChangesDialog
      changeSet={changeSet}
      rail={RAIL}
      canDecide={canDecide}
      busy={busy}
      error={error}
      {...handlers}
    />,
  );
  return handlers;
}

describe('TemplateChangesDialog', () => {
  it('names the template, the revision step and its author', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Standard sell-side · v3 → v4' });
    expect(dialog).toHaveTextContent('Saved Sep 30, 2026 by Storm Duncan');
    expect(dialog.textContent).not.toContain('—');
  });

  it('places additions and removals in their own sections with position lines', () => {
    renderDialog();
    const added = screen.getByRole('region', { name: 'Added to the template' });
    expect(added).toHaveTextContent('Diligence, LOI & Definitive Docs · After Definitive Agreement Support');
    expect(added).toHaveTextContent('Signing, Closing & Post-Close · Start of phase');
    expect(added).toHaveTextContent('Independent fairness opinion from a qualified adviser before board approval.');
    const removed = screen.getByRole('region', { name: 'Removed from the template' });
    expect(removed).toHaveTextContent('LinkedIn Post');
    expect(removed).toHaveTextContent('Signing, Closing & Post-Close · On your rail today');
  });

  it('sends each of the four decisions', () => {
    const { onDecide } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Add Fairness opinion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard Sanctions re-screen before signing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove LinkedIn Post' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep LinkedIn Post' }));
    expect(onDecide.mock.calls).toEqual([
      ['added:custom-fairness', 'accepted'],
      ['added:custom-sanctions', 'discarded'],
      ['removed:p5-s53', 'accepted'],
      ['removed:p5-s53', 'discarded'],
    ]);
  });

  it('offers no undo on an accepted change and reopens a discarded or kept one', () => {
    const { onReopen } = renderDialog(
      decided(TEMPLATE_CHANGE_SET, {
        'added:custom-fairness': 'accepted',
        'added:custom-sanctions': 'discarded',
        'removed:p5-s53': 'discarded',
      }),
    );
    const added = screen.getByRole('region', { name: 'Added to the template' });
    expect(within(added).getByText('Added')).toBeInTheDocument();
    expect(within(added).getByText('Discarded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo Fairness opinion' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Removed from the template' })).getByText('Kept')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo Sanctions re-screen before signing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo LinkedIn Post' }));
    expect(onReopen.mock.calls).toEqual([['added:custom-sanctions'], ['removed:p5-s53']]);
  });

  it('labels an accepted removal as off the rail', () => {
    renderDialog(decided(TEMPLATE_CHANGE_SET, { 'removed:p5-s53': 'accepted' }));
    const removed = screen.getByRole('region', { name: 'Removed from the template' });
    expect(within(removed).getByText('Removed')).toBeInTheDocument();
    expect(removed).toHaveTextContent('Signing, Closing & Post-Close · Off your rail');
    expect(screen.queryByRole('button', { name: 'Undo LinkedIn Post' })).not.toBeInTheDocument();
  });

  it('holds every decision while one is being saved', () => {
    const { onDecide } = renderDialog(TEMPLATE_CHANGE_SET, { busy: true });
    const add = screen.getByRole('button', { name: 'Add Fairness opinion' });
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.queryByText('Only the deal team can change this rail.')).not.toBeInTheDocument();
  });

  it('states why a decision did not go through', () => {
    renderDialog(TEMPLATE_CHANGE_SET, { error: 'The decision could not be saved. Try again.' });
    expect(screen.getByRole('alert')).toHaveTextContent('The decision could not be saved. Try again.');
  });

  it('disables decisions for a reader without structural authority', () => {
    const { onDecide } = renderDialog(TEMPLATE_CHANGE_SET, { canDecide: false });
    expect(screen.getByText('Only the deal team can change this rail.')).toBeInTheDocument();
    const add = screen.getByRole('button', { name: 'Add Fairness opinion' });
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('closes from the close button and from Escape', () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('states that nothing changes until the team decides', () => {
    renderDialog();
    expect(
      screen.getByText(
        'Nothing changes on your rail until you decide. Discarded changes are not offered again unless you undo them.',
      ),
    ).toBeInTheDocument();
  });
});
