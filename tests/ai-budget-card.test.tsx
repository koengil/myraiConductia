import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AiBudgetCard } from '@/components/audit/AiBudgetCard';

/* The AI Costs page's budget card (D83): the limit for every reader, the form for a CCO or admin. */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch(get: { status: number; body?: unknown }, put?: { status: number; body: unknown }) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const reply = init?.method === 'PUT' && put ? put : get;
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('AiBudgetCard', () => {
  it('shows a director the limit without the form', async () => {
    stubFetch({ status: 200, body: { monthlyLimitUsd: 250, canEdit: false } });
    render(<AiBudgetCard />);
    expect(await screen.findByText('$250.00')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save budget' })).toBeNull();
  });

  it('lets the CCO set a budget', async () => {
    const fetchMock = stubFetch(
      { status: 200, body: { monthlyLimitUsd: null, canEdit: true } },
      { status: 200, body: { monthlyLimitUsd: 300, canEdit: true } },
    );
    render(<AiBudgetCard />);
    expect(await screen.findByText('No budget set')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Limit in USD'), { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    expect(await screen.findByText('$300.00')).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ monthlyLimitUsd: 300 });
  });

  it('keeps Save disabled until the limit is a positive number', async () => {
    stubFetch({ status: 200, body: { monthlyLimitUsd: null, canEdit: true } });
    render(<AiBudgetCard />);
    const save = await screen.findByRole('button', { name: 'Save budget' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Limit in USD'), { target: { value: '0' } });
    expect(save).toBeDisabled();
  });

  it('lets the CCO remove a budget', async () => {
    const fetchMock = stubFetch(
      { status: 200, body: { monthlyLimitUsd: 250, canEdit: true } },
      { status: 200, body: { monthlyLimitUsd: null, canEdit: true } },
    );
    render(<AiBudgetCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove budget' }));
    expect(await screen.findByText('No budget set')).toBeInTheDocument();
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body))).toEqual({ monthlyLimitUsd: null });
  });

  it('shows the error when saving fails', async () => {
    stubFetch(
      { status: 200, body: { monthlyLimitUsd: null, canEdit: true } },
      { status: 400, body: { error: 'monthlyLimitUsd must be above 0 and at most 1000000' } },
    );
    render(<AiBudgetCard />);
    fireEvent.change(await screen.findByLabelText('Limit in USD'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('monthlyLimitUsd must be above 0');
  });

  it('re-reads the stored limit when a save fails after writing it', async () => {
    let stored: number | null = 100;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        stored = 300; // written, then the audit row failed
        return { ok: false, status: 500, json: async () => ({ error: 'Saved but audit write failed: x' }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ monthlyLimitUsd: stored, canEdit: true }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AiBudgetCard />);
    fireEvent.change(await screen.findByLabelText('Limit in USD'), { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Saved but audit write failed');
    expect(await screen.findByText('$300.00')).toBeInTheDocument();
  });

  it('renders nothing when the caller is refused', async () => {
    const fetchMock = stubFetch({ status: 403, body: { error: 'Forbidden' } });
    const { container } = render(<AiBudgetCard />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
