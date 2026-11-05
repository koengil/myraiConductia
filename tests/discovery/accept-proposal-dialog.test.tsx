import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { AcceptProposalDialog } from '@/components/discovery/AcceptProposalDialog';
import type { ModelProposalProposed } from '@/lib/discovery/propose/group';
import { proposedStepFor } from '@/lib/discovery/propose/station';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const M_KEY = 'm:project-heron';
const PROPOSED: ModelProposalProposed = { stepId: proposedStepFor('phase-2'), phase: 'phase-2', placed: 3, of: 4 };
const ACCEPT = 'Accept and read 4 emails';

/** Answers every accept POST with `status` and `body`; `hold` keeps the answer pending until released. */
function stubFetch(status = 202, body: unknown = { operationId: 'op', requestCount: 1 }) {
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

function renderDialog(proposed: ModelProposalProposed = PROPOSED) {
  const onClose = vi.fn();
  const onDone = vi.fn();
  const onStale = vi.fn();
  render(
    <AcceptProposalDialog
      dealKey={M_KEY}
      name="Project Heron"
      proposed={proposed}
      onClose={onClose}
      onDone={onDone}
      onStale={onStale}
    />,
  );
  return { onClose, onDone, onStale };
}

describe('AcceptProposalDialog', () => {
  it('is a modal that names the deal, traps focus and closes on Escape', async () => {
    stubFetch();
    const { onClose } = renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Accept Project Heron as a proposed deal' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled)'));
    const first = controls[0];
    const last = controls[controls.length - 1];
    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says what will happen, shows the proposed station with its reason, and that none is set until confirmed', () => {
    stubFetch();
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(
      'The 4 emails are read again through the mailbox guard and the exclusion policy. Those still admitted become this deal\'s evidence.',
    );
    expect(dialog).toHaveTextContent('Proposed step');
    expect(dialog.textContent).toMatch(/\d{2} · \S/);
    expect(dialog).toHaveTextContent('The model placed 3 of 4 emails in Phase 2');
    expect(dialog).toHaveTextContent('No step is set until you confirm it on the deal.');
  });

  it('has a kit footer: left-aligned, the primary first, with the email count in its label', () => {
    stubFetch();
    renderDialog();
    const dialog = screen.getByRole('dialog');
    const buttons = within(dialog).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([ACCEPT, 'Cancel']);
    const footer = buttons[0].parentElement!;
    expect(footer.className).toContain('justify-start');
    expect(footer.className).not.toContain('justify-end');
  });

  it('uses ink only: no violet, no status fill, no red button', () => {
    stubFetch();
    renderDialog();
    const dialog = screen.getByRole('dialog');
    const [primary] = within(dialog).getAllByRole('button');
    expect(primary.className).toContain('bg-[var(--accent)]');
    expect(dialog.innerHTML).not.toMatch(/--ai\b|--ai-|violet|#5e5ce6/i);
    expect(dialog.innerHTML).not.toMatch(/--(positive|negative|hold)(?!-deep)/);
    expect(dialog.innerHTML).not.toMatch(/bg-\[var\(--negative/);
  });

  it('reads in the singular for one email, and has no em dash or key anywhere', () => {
    stubFetch();
    renderDialog({ ...PROPOSED, placed: 1, of: 1 });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('The 1 email is read again');
    expect(screen.getByRole('button', { name: 'Accept and read 1 email' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('The model placed 1 of 1 email in Phase 2');
    expect(dialog.textContent).not.toContain('—');
    expect(dialog.textContent).not.toContain(M_KEY);
  });

  it('cancels without posting', () => {
    const { fetchMock } = stubFetch();
    const { onClose, onDone } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts exactly the key and the proposed step, once, then hands over to refresh the list', async () => {
    const { fetchMock } = stubFetch();
    const { onDone, onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: ACCEPT }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/discovery/model-proposals/accept');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ dealKey: M_KEY, proposedStepId: PROPOSED.stepId });
  });

  it('posts once on a double click', async () => {
    const stub = stubFetch();
    stub.holdAnswers();
    const { onDone } = renderDialog();
    const button = screen.getByRole('button', { name: ACCEPT });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    stub.release();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(stub.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cannot be closed while the request is in flight: not by Escape, the backdrop or Cancel', async () => {
    const stub = stubFetch();
    stub.holdAnswers();
    const { onClose, onDone } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: ACCEPT }));
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(dialog.parentElement!);
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeDisabled();
    fireEvent.click(cancel);
    expect(onClose).not.toHaveBeenCalled();
    stub.release();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('refreshes on a 404 too: the proposal is no longer there to accept', async () => {
    stubFetch(404, { error: 'Proposal not found' });
    const { onDone } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: ACCEPT }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('stays open on a plain 409 (the lock timed out) with the server text, and the button works again', async () => {
    stubFetch(409, { error: 'Try again in a moment' });
    const { onDone, onStale } = renderDialog();
    const button = screen.getByRole('button', { name: ACCEPT });
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in a moment');
    expect(onDone).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
    expect(button).toBeEnabled();
  });

  it('treats a 409 candidate_closed as final: the text stays, the primary is off, the list refreshes', async () => {
    stubFetch(409, { error: 'This proposal can no longer be accepted', code: 'candidate_closed' });
    const { onDone, onStale, onClose } = renderDialog();
    const button = screen.getByRole('button', { name: ACCEPT });
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('This proposal can no longer be accepted');
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('treats a 409 proposal_changed as final too: the fixed text, the primary off, the list refreshes', async () => {
    stubFetch(409, { code: 'proposal_changed', error: 'This proposal changed. Review it again.' });
    const { onDone, onStale, onClose } = renderDialog();
    const button = screen.getByRole('button', { name: ACCEPT });
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('This proposal changed. Review it again.');
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says so in fixed text when the request fails without a message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network'))),
    );
    const { onDone } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: ACCEPT }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The proposal could not be accepted. Try again shortly.');
    expect(onDone).not.toHaveBeenCalled();
  });
});
