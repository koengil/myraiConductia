import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import * as React from 'react';

import {
  stashGate0Receipt,
  takeGate0Receipt,
} from '../src/lib/deals/gate0Receipt';
import { Gate0ReceiptBanner } from '../src/components/rail/Gate0ReceiptBanner';
import { setStoreOwner } from '../src/lib/session/storeOwner';

// The signed-in creator: receipts are stamped with, and only returned to, them.
beforeEach(() => setStoreOwner('user-a'));

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  setStoreOwner(null);
});

describe('gate0Receipt stash/take', () => {
  it('is a one-shot: take returns the receipt then clears it', () => {
    stashGate0Receipt('SUM-2026-014', { verdict: 'compliant', recipients: 2, at: '2026-07-16T10:00:00Z' });
    const first = takeGate0Receipt('SUM-2026-014');
    expect(first).toMatchObject({ verdict: 'compliant', recipients: 2 });
    // Cleared after the first read — a refresh does not re-show it.
    expect(takeGate0Receipt('SUM-2026-014')).toBeNull();
  });

  it('returns null for a code with no stashed receipt', () => {
    expect(takeGate0Receipt('NOPE-2026-1')).toBeNull();
  });

  it('stamps the receipt with its creator and returns it without the stamp', () => {
    stashGate0Receipt('SUM-2026-014', { verdict: 'hold', recipients: 0, at: null });
    expect(JSON.parse(window.sessionStorage.getItem('ib-gate0-receipt:SUM-2026-014')!)).toMatchObject({
      uid: 'user-a',
    });
    expect(takeGate0Receipt('SUM-2026-014')).toEqual({ verdict: 'hold', recipients: 0, at: null });
  });

  it("never returns another user's receipt, and drops it (#162)", () => {
    stashGate0Receipt('SUM-2026-014', { verdict: 'compliant', recipients: 2, at: null });
    setStoreOwner('user-b');
    expect(takeGate0Receipt('SUM-2026-014')).toBeNull();
    expect(window.sessionStorage.getItem('ib-gate0-receipt:SUM-2026-014')).toBeNull();
  });

  it('treats an unstamped legacy receipt as foreign: never returned, dropped', () => {
    window.sessionStorage.setItem(
      'ib-gate0-receipt:SUM-2026-014',
      JSON.stringify({ verdict: 'compliant', recipients: 2, at: null }),
    );
    expect(takeGate0Receipt('SUM-2026-014')).toBeNull();
    expect(window.sessionStorage.getItem('ib-gate0-receipt:SUM-2026-014')).toBeNull();
  });

  it('with no known owner: a stash persists nothing, a take returns nothing and leaves the entry', () => {
    setStoreOwner(null);
    stashGate0Receipt('SUM-2026-014', { verdict: 'compliant', recipients: 2, at: null });
    expect(window.sessionStorage.getItem('ib-gate0-receipt:SUM-2026-014')).toBeNull();

    setStoreOwner('user-a');
    stashGate0Receipt('SUM-2026-014', { verdict: 'compliant', recipients: 2, at: null });
    setStoreOwner(null);
    expect(takeGate0Receipt('SUM-2026-014')).toBeNull();
    expect(window.sessionStorage.getItem('ib-gate0-receipt:SUM-2026-014')).not.toBeNull();
    setStoreOwner('user-a');
    expect(takeGate0Receipt('SUM-2026-014')).toMatchObject({ verdict: 'compliant' });
  });
});

describe('Gate0ReceiptBanner', () => {
  it('renders the honest receipt when active and clears the stash', async () => {
    stashGate0Receipt('SUM-2026-014', { verdict: 'compliant', recipients: 1, at: '2026-07-16T10:00:00Z' });

    render(<Gate0ReceiptBanner code="SUM-2026-014" active />);

    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/Mandate opened/i)).toBeInTheDocument();
    expect(screen.getByText(/Compliant/)).toBeInTheDocument();
    expect(screen.getByText(/1 compliance recipient notified/i)).toBeInTheDocument();
    // No fabricated compliance checks.
    expect(screen.queryByText(/KYC|FINRA/)).not.toBeInTheDocument();
    // The stash was consumed (one-shot).
    expect(takeGate0Receipt('SUM-2026-014')).toBeNull();
  });

  it('Dismiss hides the receipt', async () => {
    stashGate0Receipt('SUM-2026-014', { verdict: 'compliant', recipients: 1, at: null });
    render(<Gate0ReceiptBanner code="SUM-2026-014" active />);
    expect(await screen.findByRole('status')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders nothing when not active (no ?new=1)', async () => {
    stashGate0Receipt('SUM-2026-014', { verdict: 'compliant', recipients: 1, at: null });
    const { container } = render(<Gate0ReceiptBanner code="SUM-2026-014" active={false} />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it('reports an existing-account grant separately from invitation delivery', async () => {
    stashGate0Receipt('SUM-2026-014', {
      verdict: 'compliant',
      recipients: 0,
      at: null,
      invites: [{ email: 'member@bank.dev', state: 'access-granted' }],
    });

    render(<Gate0ReceiptBanner code="SUM-2026-014" active />);

    expect(await screen.findByText(/1 existing account granted access/i)).toBeInTheDocument();
    expect(screen.queryByText(/member@bank.dev/)).not.toBeInTheDocument();
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
  });

  it('reports an existing seat without claiming that access changed', async () => {
    stashGate0Receipt('SUM-2026-014', {
      verdict: 'compliant', recipients: 0, at: null,
      invites: [{ email: 'member@bank.dev', state: 'access-existing' }],
    });
    render(<Gate0ReceiptBanner code="SUM-2026-014" active />);
    expect(await screen.findByText(/1 existing account already had access/i)).toBeInTheDocument();
    expect(screen.queryByText(/granted access/i)).not.toBeInTheDocument();
  });

  it('names its status region so a journey can scope an assertion to it', async () => {
    stashGate0Receipt('ATLAS', {
      verdict: 'compliant',
      recipients: 1,
      at: new Date().toISOString(),
      invites: [{ email: 'colleague@futureproofing.com', state: 'sent' }],
    });

    render(<Gate0ReceiptBanner code="ATLAS" active />);

    const banner = await screen.findByRole('status', { name: 'Mandate opened' });
    expect(banner).toHaveTextContent('1 invitation sent.');
  });

  it('says where a promoted mandate came from, and keeps the region name journeys locate it by', async () => {
    stashGate0Receipt('KESTR-2026-412', {
      verdict: 'compliant',
      recipients: 2,
      at: '2026-10-09T10:00:00Z',
      origin: 'discovery',
    });

    render(<Gate0ReceiptBanner code="KESTR-2026-412" active />);

    const banner = await screen.findByRole('status', { name: 'Mandate opened' });
    expect(banner).toHaveTextContent('Mandate opened from discovery');
    expect(banner).toHaveTextContent('MNPI screen: Compliant');
  });

  it('keeps the plain kicker when the receipt has no origin', async () => {
    stashGate0Receipt('SUM-2026-014', { verdict: 'compliant', recipients: 1, at: null });
    render(<Gate0ReceiptBanner code="SUM-2026-014" active />);
    const banner = await screen.findByRole('status', { name: 'Mandate opened' });
    expect(banner).not.toHaveTextContent('from discovery');
    expect(screen.getByText('Mandate opened')).toBeInTheDocument();
  });
});
