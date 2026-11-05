import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { AiSpendPanel, formatUsd } from '@/components/audit/AiSpendPanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  ({ ok: status < 300, status, json: async () => body }) as unknown as Response;

describe('AiSpendPanel', () => {
  it('shows the total and the three cuts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(200, {
          summary: {
            totalCostUsd: 0.4131,
            calls: 3,
            unpricedCalls: 0,
            byDeal: [],
            byPerson: [{ key: 'u', label: 'Marcelo Gumiero', calls: 3, pricedCalls: 3, costUsd: 0.4131, inputTokens: 0, outputTokens: 0 }],
            byTask: [{ key: 'p1-s9', label: 'p1-s9', calls: 1, pricedCalls: 1, costUsd: 0.41, inputTokens: 0, outputTokens: 0 }],
            byModel: [{ key: 'unknown', label: 'Model not reported', calls: 1, pricedCalls: 1, costUsd: 0.41, inputTokens: 0, outputTokens: 0 }],
          },
        }),
      ),
    );
    render(<AiSpendPanel dealId="ZZTES-2026-586" />);
    await screen.findByText(`${formatUsd(0.4131)} across 3 API calls`);
    expect(screen.getByRole('table', { name: 'By person' })).toHaveTextContent('Marcelo Gumiero');
    expect(screen.getByRole('table', { name: 'By model' })).toHaveTextContent('Model not reported');
  });

  it('says so when the deal has no AI spend, and hides on a refused read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { summary: { totalCostUsd: 0, calls: 0, unpricedCalls: 0, byDeal: [], byPerson: [], byTask: [], byModel: [] } })));
    const { unmount } = render(<AiSpendPanel dealId="d-1" />);
    await screen.findByText('No AI spend on this deal yet');
    unmount();

    // The route's answer for a fixture deal or a deal the viewer is not on.
    vi.stubGlobal('fetch', vi.fn(async () => json(404, { error: 'Deal not found' })));
    render(<AiSpendPanel dealId="project-summit" />);
    await waitFor(() => expect(screen.queryByText(/AI spend/)).toBeNull());
  });

  it('keeps the panel on a failed read, with a plain line and Try again', async () => {
    const empty = { summary: { totalCostUsd: 0, calls: 0, unpricedCalls: 0, byDeal: [], byPerson: [], byTask: [], byModel: [] } };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(500, { error: 'private server details' }))
      .mockResolvedValueOnce(json(200, empty));
    vi.stubGlobal('fetch', fetcher);
    render(<AiSpendPanel dealId="d-1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('AI spend could not be loaded.');
    expect(screen.getByRole('region', { name: 'AI spend' })).toBeInTheDocument();
    expect(screen.queryByText('private server details')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('No AI spend on this deal yet');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

const firmSummary = {
  totalCostUsd: 12, calls: 3, unpricedCalls: 1,
  byDeal: [{ key: 'none', label: 'Outside a deal', calls: 3, pricedCalls: 2, costUsd: 12, inputTokens: 0, outputTokens: 0 }],
  byPerson: [], byTask: [], byModel: [],
};
describe('firm-wide AI spend', () => {
  it('requests tenant scope and includes costs outside a deal', async () => {
    const fetcher = vi.fn(async () => json(200, { summary: firmSummary }));
    vi.stubGlobal('fetch', fetcher);
    render(<AiSpendPanel />);
    await screen.findByText('$12.00 across 3 API calls · 1 unpriced');
    expect(fetcher).toHaveBeenCalledWith('/api/v1/ai-spend', expect.objectContaining({ credentials: 'include' }));
    expect(screen.getByRole('table', { name: 'By deal' })).toHaveTextContent('Outside a deal');
    // Lance, Oct 5: "API calls", so a count is not read as phone or video calls.
    expect(within(screen.getByRole('table', { name: 'By deal' })).getByRole('columnheader', { name: 'API calls' })).toBeInTheDocument();
    expect(screen.getByText('Firm AI spend')).toBeInTheDocument();
  });
  it('identifies a truncated window instead of a lifetime total', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { summary: firmSummary, window: { truncated: true, limit: 2000 } })));
    render(<AiSpendPanel />);
    await screen.findByText('$12.00 across the latest 2000 API calls · 1 unpriced');
  });
  it('does not render denied data, even if the 403 response has a body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(403, { summary: firmSummary })));
    render(<AiSpendPanel />);
    await waitFor(() => expect(screen.queryByText('Firm AI spend')).toBeNull());
    expect(screen.queryByText('Outside a deal')).toBeNull();
  });
  it('distinguishes empty records from an unavailable service', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { summary: { ...firmSummary, calls: 0, totalCostUsd: 0, unpricedCalls: 0, byDeal: [] } })));
    const { unmount } = render(<AiSpendPanel />);
    await screen.findByText('No AI spend recorded for the firm yet');
    unmount();
    vi.stubGlobal('fetch', vi.fn(async () => json(500, { error: 'private server details' })));
    render(<AiSpendPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('AI spend could not be loaded.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('private server details')).toBeNull();
  });
  it('does not carry firm totals into a pending deal request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(200, { summary: firmSummary })).mockImplementationOnce(() => new Promise(() => {})));
    const { rerender } = render(<AiSpendPanel />);
    await screen.findByText('$12.00 across 3 API calls · 1 unpriced');
    rerender(<AiSpendPanel dealId="other-deal" />);
    expect(screen.queryByText('$12.00 across 3 API calls · 1 unpriced')).toBeNull();
    expect(screen.getByText('Loading AI spend…')).toBeInTheDocument();
  });
});

it('names no uncaptured cost on the firm panel (bench chat since #193, twin chat since PR #427)', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(200, { detail: 'full', summary: { totalCostUsd: 0.5, calls: 1, unpricedCalls: 0, byDeal: [], byPerson: [], byTask: [], byModel: [] } })));
  render(<AiSpendPanel />);
  const note = await screen.findByText('Recorded usage across the firm, including work outside a deal.');
  expect(note).not.toHaveTextContent(/not yet recorded|Skill-bench/);
});
