import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { AssignStepDialog } from '@/components/rail/AssignStepDialog';
import { MoveStepDialog } from '@/components/rail/MoveStepDialog';
import type { ProjectRailStep } from '@/lib/rail/projectRail';

/*
 * "Move step" and "Assign to {name}" are disabled at the current choice; a
 * short visible reason says why, and the button names it (S6-24).
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function described(button: HTMLElement): string {
  const ids = (button.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
}

function customStep(id: string, title: string): ProjectRailStep {
  return {
    id,
    stepId: `custom:${id}`,
    origin: 'custom',
    phaseIndex: 2,
    displayOrder: 1,
    seq: null,
    status: 'pending',
    definition: { title, description: '' },
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
  };
}

describe('Move step at its current place', () => {
  const steps = [customStep('a', 'Buyer list'), customStep('b', 'Teaser review'), customStep('c', 'NDA')];

  it('says this is already its place, until another position is chosen', async () => {
    render(
      <MoveStepDialog
        target={{ step: steps[1], phaseName: 'Preparation', phaseSteps: steps, numberOf: () => '02' }}
        onClose={() => {}}
        onMove={() => {}}
      />,
    );
    const dialog = await screen.findByRole('dialog');
    const move = within(dialog).getByRole('button', { name: 'Move step' });
    expect(move).toBeDisabled();
    expect(within(dialog).getByText('This is already its place.')).toBeInTheDocument();
    expect(described(move)).toBe('This is already its place.');

    fireEvent.click(within(dialog).getByRole('radio', { name: /^First in Preparation/ }));
    expect(move).toBeEnabled();
    expect(move).not.toHaveAttribute('aria-describedby');
    expect(within(dialog).queryByText('This is already its place.')).not.toBeInTheDocument();
  });
});

describe('Assign at the current owner', () => {
  function stubOwner(assignedTo: string | null) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              step: { assignedTo },
              members: [
                { id: 'u-storm', name: 'Storm Duncan', dealRole: 'md' },
                { id: 'u-alex', name: 'Alex Chen', dealRole: 'deal_team' },
              ],
              permissions: { canAssign: true },
            }),
            { status: 200 },
          ),
      ),
    );
  }

  function renderDialog() {
    render(
      <AssignStepDialog
        dealId="D-1"
        step={{ stepId: 'p2-s30', title: 'Buyer long list' }}
        currentUserId="u-storm"
        onClose={() => {}}
        onAssigned={() => {}}
      />,
    );
    return screen.findByRole('dialog', { name: 'Buyer long list' });
  }

  it('says the step is already assigned to that person', async () => {
    stubOwner('u-alex');
    const dialog = await renderDialog();
    await within(dialog).findByRole('radio', { name: /^Alex Chen/ });
    const assign = within(dialog).getByRole('button', { name: 'Assign to Alex Chen' });
    expect(assign).toBeDisabled();
    expect(within(dialog).getByText('Already assigned to Alex Chen.')).toBeInTheDocument();
    expect(described(assign)).toBe('Already assigned to Alex Chen.');

    fireEvent.click(within(dialog).getByRole('radio', { name: /^Storm Duncan/ }));
    const toMe = within(dialog).getByRole('button', { name: 'Assign to Storm Duncan' });
    expect(toMe).toBeEnabled();
    expect(toMe).not.toHaveAttribute('aria-describedby');
  });

  it('says an unowned step is already unassigned', async () => {
    stubOwner(null);
    const dialog = await renderDialog();
    await within(dialog).findByRole('radio', { name: /^Alex Chen/ });
    const remove = within(dialog).getByRole('button', { name: 'Remove owner' });
    expect(remove).toBeDisabled();
    expect(described(remove)).toBe('Already unassigned.');
  });

  it('says nothing about an owner the deal team no longer lists', async () => {
    stubOwner('u-gone');
    const dialog = await renderDialog();
    await within(dialog).findByRole('radio', { name: /^Alex Chen/ });
    expect(within(dialog).queryByText('Already unassigned.')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/^Already assigned to/)).not.toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Assign' });
    expect(confirm).toBeDisabled();
    expect(confirm).not.toHaveAttribute('aria-describedby');
  });
});
