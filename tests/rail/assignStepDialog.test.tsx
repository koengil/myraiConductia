import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { AssignStepDialog } from '@/components/rail/AssignStepDialog';

/* The Assign dialog: Observers cannot own steps; an error never keeps the notification promise. */

const MEMBERS = [
  { id: 'u-storm', name: 'Storm Duncan', dealRole: 'md' },
  { id: 'u-alex', name: 'Alex Chen', dealRole: 'deal_team' },
  { id: 'u-obs', name: 'Olive Observer', dealRole: 'read_only' },
];

let patchStatus = 200;
const patches: unknown[] = [];

beforeEach(() => {
  patchStatus = 200;
  patches.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ error: 'boom' }), { status: patchStatus });
      }
      return new Response(
        JSON.stringify({ step: { assignedTo: null }, members: MEMBERS, permissions: { canAssign: true } }),
        { status: 200 },
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

describe('Observers cannot own steps', () => {
  it('shows the Observer disabled with its reason, and no PATCH is possible for them', async () => {
    const dialog = await renderDialog();
    const observer = await within(dialog).findByRole('radio', { name: /^Olive Observer/ });
    expect(observer).toBeDisabled();
    expect(within(dialog).getByText('Read only. Cannot own steps.')).toBeInTheDocument();
    expect(observer).toHaveAccessibleDescription('Read only. Cannot own steps.');
    fireEvent.click(observer);
    expect(observer).not.toBeChecked();
    expect(within(dialog).queryByRole('button', { name: /^Assign to Olive/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Remove owner' })).toBeDisabled();
    expect(patches).toHaveLength(0);

    // Other members are unchanged.
    const alex = within(dialog).getByRole('radio', { name: /^Alex Chen/ });
    expect(alex).toBeEnabled();
    fireEvent.click(alex);
    expect(within(dialog).getByRole('button', { name: 'Assign to Alex Chen' })).toBeEnabled();
  });
});

describe('an error never keeps the notification promise', () => {
  it.each([500, 403, 409])('after a %s the dialog says nothing was sent', async (status) => {
    patchStatus = status;
    const dialog = await renderDialog();
    fireEvent.click(await within(dialog).findByRole('radio', { name: /^Alex Chen/ }));
    expect(within(dialog).getByText('Alex Chen gets a notification that this step is theirs.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign to Alex Chen' }));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toBeInTheDocument());
    expect(within(dialog).getByText('Nothing was sent.')).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/gets a notification/);
  });
});
