import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

import { DontAskAgainConfirmation } from '@/components/rail/RailEditPrompt';
import { RailsSettings } from '@/components/settings/RailsSettings';

/*
 * "Don't ask again" never confirms a choice this browser refused to
 * keep. The rail flow itself (prompt returns after the next move) is covered
 * in tests/rail/railRcPreviews.test.tsx.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('Don\'t ask again when storage refuses', () => {
  it('the confirmation says Conductia will ask again, with no Settings link', () => {
    render(<DontAskAgainConfirmation shownAt={Date.now()} notKept onDone={() => {}} />);
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent('This browser is not keeping settings, so Conductia will ask again.');
    expect(screen.queryByRole('link', { name: 'Settings › Rails' })).not.toBeInTheDocument();
  });

  it('the stored case still points at Settings › Rails', () => {
    render(<DontAskAgainConfirmation shownAt={Date.now()} onDone={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('You can change this in Settings › Rails.');
  });

  it('Settings › Rails shows the not-kept alert when storage throws', async () => {
    render(<RailsSettings />);
    const toggle = await screen.findByRole('checkbox', { name: 'Ask before changing the rail' });
    await waitFor(() => expect(toggle).toBeEnabled());
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    act(() => {
      fireEvent.click(toggle);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('This browser is not keeping settings');
  });

  it('Settings › Rails says moves are a Preview and asks only for adds and removes', async () => {
    render(<RailsSettings />);
    await screen.findByRole('checkbox', { name: 'Ask before changing the rail' });
    expect(
      screen.getByText(/When you add or remove a step, Conductia asks first, because the change applies to everyone on the deal\./),
    ).toBeInTheDocument();
    expect(screen.getByText('Moving a step is a Preview kept in this browser.')).toBeInTheDocument();
    expect(screen.queryByText(/add, remove or move/)).not.toBeInTheDocument();
  });
});
