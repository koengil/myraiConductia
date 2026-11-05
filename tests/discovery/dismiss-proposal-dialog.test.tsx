import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { DismissProposalDialog } from '@/components/discovery/DismissProposalDialog';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const M_KEY = 'm:project-heron';
const C_KEY = 'c:3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071';
const OPERATION = '6f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f';

/** Answers every dismiss POST with `status` and `body`; `hold` keeps the answer pending until released. */
function stubFetch(status = 200, body: unknown = { dismissed: 1 }) {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let hold = false;
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => {
    if (hold) await held;
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    holdAnswers: () => {
      hold = true;
    },
    release: () => release(),
  };
}

function renderDialog(dealKey = M_KEY, name = 'Project Heron') {
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(<DismissProposalDialog dealKey={dealKey} name={name} onClose={onClose} onDone={onDone} />);
  return { onClose, onDone };
}

describe('DismissProposalDialog', () => {
  it('is a modal that names the deal, traps focus and closes on Escape', async () => {
    stubFetch();
    const { onClose } = renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Dismiss Project Heron' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('Model proposal')).toBeInTheDocument();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled)'));
    const first = controls[0];
    const last = controls[controls.length - 1];
    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has no reason field, and a kit footer: left-aligned, the primary first', () => {
    stubFetch();
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    const buttons = within(dialog).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Dismiss proposal', 'Cancel']);
    const footer = buttons[0].parentElement!;
    expect(footer.className).toContain('justify-start');
    expect(footer.className).not.toContain('justify-end');
    // Ink, never red: dismissing archives.
    expect(buttons[0].className).toContain('bg-[var(--accent)]');
    expect(dialog.innerHTML).not.toMatch(/--ai\b|--ai-|violet|#5e5ce6/i);
    expect(dialog.innerHTML).not.toMatch(/bg-\[var\(--negative/);
  });

  it('says the proposal stays on record, in copy free of em dashes and of the key', () => {
    stubFetch();
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('The proposal stays on record and leaves your list.');
    expect(dialog).toHaveTextContent('The codename rules still find deals in this mail.');
    expect(dialog.textContent).not.toContain('—');
    expect(dialog.textContent).not.toContain(M_KEY);
    cleanup();

    renderDialog(C_KEY, 'Project Kestrel');
    expect(screen.getByRole('dialog', { name: 'Dismiss Project Kestrel' })).toHaveTextContent(
      'The proposed deal the codename rules found stays as it is.',
    );
  });

  it('cancels without posting', () => {
    const { fetchMock } = stubFetch();
    const { onClose, onDone } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts exactly the deal key, then hands back the restore reference to refresh the list', async () => {
    const { fetchMock } = stubFetch(200, { dismissed: 1, operationId: OPERATION });
    const { onDone, onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss proposal' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(OPERATION));
    expect(onClose).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/discovery/model-proposals/dismiss');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ dealKey: M_KEY });
  });

  it('treats a repeat (0 dismissed) like any other success', async () => {
    stubFetch(200, { dismissed: 0, operationId: null });
    const { onDone } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss proposal' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(null));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refreshes on a 404 too: the proposal is no longer there to dismiss', async () => {
    stubFetch(404, { error: 'Proposal not found' });
    const { onDone } = renderDialog(C_KEY, 'Project Kestrel');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss proposal' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(null));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('stays open with the server text on a 500, and the button works again', async () => {
    stubFetch(500, { error: 'Could not dismiss the proposal' });
    const { onDone } = renderDialog();
    const button = screen.getByRole('button', { name: 'Dismiss proposal' });
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not dismiss the proposal');
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it('says so in fixed text when the request fails without a message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network'))),
    );
    const { onDone } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss proposal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The proposal could not be dismissed. Try again shortly.');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('posts once on a double click', async () => {
    const stub = stubFetch(200, { dismissed: 1 });
    stub.holdAnswers();
    const { onDone } = renderDialog();
    const button = screen.getByRole('button', { name: 'Dismiss proposal' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    stub.release();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(stub.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cannot be closed while the dismissal is in flight: not by Escape, the backdrop or Cancel', async () => {
    const stub = stubFetch(200, { dismissed: 1, operationId: OPERATION });
    stub.holdAnswers();
    const { onClose, onDone } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss proposal' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(dialog.parentElement!);
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeDisabled();
    fireEvent.click(cancel);
    expect(onClose).not.toHaveBeenCalled();
    stub.release();
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(OPERATION));
    // Settled, it closes again.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
