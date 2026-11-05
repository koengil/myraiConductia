import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SessionProvider } from '@/lib/session/store';
import { MailComposer } from '@/components/mail/MailComposer';

/*
 * Closing the recipient review never drops focus on the page body.
 * Escape and Close return it to Send; Back to editing puts it in To.
 */

const recipient = {
  field: 'to',
  email: 'founder@target.com',
  boundary: 'external',
  relationship: 'counterparty',
  requiresConfirmation: true,
  reason: 'counterparty',
};

function stub() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.startsWith('/api/v1/deals/')) {
        return { ok: true, status: 200, json: async () => ({ deal: { lifecycleCategory: 'closed' } }) } as Response;
      }
      if (u.includes('/api/v1/screen')) return { ok: true, json: async () => ({ verdict: 'compliant', reasons: [] }) } as Response;
      if (u === '/api/v1/outbox') {
        return { ok: true, status: 200, json: async () => ({ recipientReviewRequired: { recipients: [recipient], token: 't' } }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openReview() {
  stub();
  render(
    <SessionProvider>
      <MailComposer screenDebounceMs={0} dealRef="ZZ-TEST-1" />
    </SessionProvider>,
  );
  await screen.findByLabelText('Email subject preview');
  fireEvent.change(screen.getByLabelText(/^to$/i), { target: { value: 'founder@target.com' } });
  fireEvent.change(screen.getByLabelText(/^subject$/i), { target: { value: 'Process update' } });
  fireEvent.input(screen.getByLabelText(/^message$/i), { target: { innerHTML: 'The room opens Monday.' } });
  const send = screen.getByRole('button', { name: /^send$/i });
  send.focus();
  fireEvent.click(send);
  // A browser drops focus from Send to the body once Send is disabled while
  // screening; jsdom keeps it there, so drop it the way a browser does.
  const sink = document.createElement('input');
  document.body.appendChild(sink);
  sink.focus();
  sink.remove();
  expect(document.activeElement).toBe(document.body);
  const dialog = await screen.findByRole('dialog', { name: 'Review email recipients' });
  return { dialog, send: () => screen.getByRole('button', { name: /^send$/i }) };
}

it('Escape returns focus to Send', async () => {
  const { dialog, send } = await openReview();

  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(send()));
});

it('Close returns focus to Send', async () => {
  const { send } = await openReview();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(send()));
});

it('Back to editing puts focus in the To field', async () => {
  await openReview();
  fireEvent.click(screen.getByRole('button', { name: 'Back to editing' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/^to$/i)));
});
