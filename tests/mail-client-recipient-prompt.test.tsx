import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

/*
 * A later send never wipes the post-send recipient prompt. New
 * additions merge into the prompt, deduped by email.
 */

vi.mock('next/navigation', () => ({ useParams: () => ({ projectId: 'ZZ-A' }) }));
// The deal is in the viewer's list (S6R4-02): Mail renders for it.
vi.mock('@/lib/deals/useDeals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deals/useDeals')>();
  const deals = [
    { id: 'ZZ-A', code: 'ZZ-A', codename: 'Project A' },
    { id: 'ZZ-B', code: 'ZZ-B', codename: 'Project B' },
  ];
  return {
    ...actual,
    useDeals: () => ({ state: { status: 'ready', deals }, deals, loading: false, error: false, reload: () => {} }),
  };
});
vi.mock('@/components/mail/MailComposer', () => ({
  MailComposer: ({ onSent }: { onSent: (status: string, recipients: unknown[]) => void }) => (
    <>
      <button onClick={() => onSent('sent', [{ email: 'first@outside.test', boundary: 'external', reason: 'not_on_deal' }])}>
        ZZ TEST send new outsider
      </button>
      <button onClick={() => onSent('sent', [])}>ZZ TEST send known</button>
      <button onClick={() => onSent('sent', [{ email: 'FIRST@outside.test', boundary: 'external', reason: 'not_on_deal' }, { email: 'second@outside.test', boundary: 'external', reason: 'not_on_deal' }])}>
        ZZ TEST send overlap
      </button>
    </>
  ),
}));

import { SessionProvider } from '@/lib/session/store';
import { MailClient } from '@/components/mail/MailClient';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stub() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [], user: { firm_role: null } }) }),
  );
}

function sendWith(label: string) {
  fireEvent.click(screen.getByRole('button', { name: /new message/i }));
  fireEvent.click(screen.getByRole('button', { name: label }));
}

it('keeps the first send\'s prompt after a later send with no new outside address', async () => {
  stub();
  render(<SessionProvider><MailClient /></SessionProvider>);
  sendWith('ZZ TEST send new outsider');
  expect(await screen.findByRole('link', { name: 'Give first@outside.test data room access' })).toBeInTheDocument();
  sendWith('ZZ TEST send known');
  expect(screen.getByRole('link', { name: 'Give first@outside.test data room access' })).toBeInTheDocument();
  expect(screen.getByText('Email sent. Add the recipient to this deal.')).toBeInTheDocument();
});

it('merges new additions into the prompt, deduped by email', async () => {
  stub();
  render(<SessionProvider><MailClient /></SessionProvider>);
  sendWith('ZZ TEST send new outsider');
  await screen.findByRole('link', { name: 'Give first@outside.test data room access' });
  sendWith('ZZ TEST send overlap');
  expect(screen.getAllByRole('link', { name: /Give first@outside\.test data room access/i })).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'Give second@outside.test data room access' })).toBeInTheDocument();
  expect(screen.getByText('Email sent. Add the recipients to this deal.')).toBeInTheDocument();
});

it('Not now clears the prompt', async () => {
  stub();
  render(<SessionProvider><MailClient /></SessionProvider>);
  sendWith('ZZ TEST send new outsider');
  fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
  expect(screen.queryByRole('link', { name: /first@outside\.test/ })).toBeNull();
});
