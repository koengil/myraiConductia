import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecipientBoundaryWarning } from '@/components/mail/RecipientBoundaryWarning';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function policy(domains: string[] = ['bank.example']) {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ verifiedDomains: domains }) });
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
it('updates immediately when the last external recipient is added or removed', async () => {
  const fetcher = policy();
  const view = render(<RecipientBoundaryWarning recipients={['a@bank.example']} />);
  await waitFor(() => expect(screen.queryByText(/unverified/i)).not.toBeInTheDocument());
  expect(screen.queryByText('External recipient')).not.toBeInTheDocument();
  view.rerender(<RecipientBoundaryWarning recipients={['a@bank.example', 'b@outside.test']} />);
  expect(screen.getByText('External recipient')).toBeInTheDocument();
  view.rerender(<RecipientBoundaryWarning recipients={['a@bank.example']} />);
  expect(screen.queryByText('External recipient')).not.toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledOnce();
});
it('distinguishes an unconfigured firm from proven external recipients', async () => {
  policy([]); render(<RecipientBoundaryWarning recipients={['a@outside.test']} />);
  await screen.findByText(/No verified domains/i);
  expect(screen.queryByText('External recipient')).not.toBeInTheDocument();
});
it('keeps empty drafts quiet and makes failed lookup retryable', async () => {
  const fetcher = policy(); fetcher.mockRejectedValueOnce(new Error('offline'));
  const view = render(<RecipientBoundaryWarning recipients={[]} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  view.rerender(<RecipientBoundaryWarning recipients={['a@outside.test']} />);
  fireEvent.click(await screen.findByRole('button', {name:/try again/i}));
  await screen.findByText('External recipient');
});
it('does not present unresolved policy as internal', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  render(<RecipientBoundaryWarning recipients={['a@bank.example']} />);
  expect(screen.getByText('Could not tell if recipients are outside the firm')).toBeInTheDocument();
});

it('classifies current recipients when a delayed policy response arrives', async () => {
  let resolve!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise((done) => { resolve = done; })));
  const view = render(<RecipientBoundaryWarning recipients={['a@bank.example']} />);
  view.rerender(<RecipientBoundaryWarning recipients={['b@outside.test']} />);
  resolve({ok:true, json: async () => ({verifiedDomains:['bank.example']})});
  await screen.findByText('External recipient');
});

it('aborts policy lookup when the composer unmounts', () => {
  const fetcher = vi.fn(() => new Promise(() => {}));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<RecipientBoundaryWarning recipients={['a@bank.example']} />);
  const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
