import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { DataroomPendingBanner } from '../src/components/rail/DataroomPendingBanner';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn(async () => responses.shift() ?? json(500, {}));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe('DataroomPendingBanner (PL-27)', () => {
  it('shows nothing while the data room is ready', async () => {
    const fetchMock = stubFetch(json(200, { status: 'ready' }));
    render(<DataroomPendingBanner dealCode="FALCO-2026-123" />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await settle();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows nothing when the status cannot be read', async () => {
    const fetchMock = stubFetch(json(500, { error: 'down' }));
    render(<DataroomPendingBanner dealCode="FALCO-2026-123" />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await settle();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the pending state, and a successful retry reports the data room ready', async () => {
    const fetchMock = stubFetch(json(200, { status: 'pending' }), json(200, { status: 'ready' }));
    render(<DataroomPendingBanner dealCode="FALCO-2026-123" />);

    const banner = await screen.findByRole('status', { name: 'Data room pending' });
    expect(banner).toHaveTextContent('Uploads to its data rooms fail until setup completes.');

    fireEvent.click(screen.getByRole('button', { name: 'Retry setup' }));

    expect(await screen.findByRole('status', { name: 'Data room ready' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v1/deals/FALCO-2026-123/dataroom',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps the retry available when the setup fails again', async () => {
    stubFetch(json(200, { status: 'pending' }), json(502, { status: 'pending' }));
    render(<DataroomPendingBanner dealCode="FALCO-2026-123" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Retry setup' }));

    expect(await screen.findByText(/Setup did not complete/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry setup' })).toBeEnabled();
  });

  it('sends one retry for a double click', async () => {
    let finish: (r: Response) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { status: 'pending' }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)));
    vi.stubGlobal('fetch', fetchMock);
    render(<DataroomPendingBanner dealCode="FALCO-2026-123" />);

    const button = await screen.findByRole('button', { name: 'Retry setup' });
    act(() => {
      button.click();
      button.click();
    });
    expect(await screen.findByRole('button', { name: 'Retrying setup' })).toBeDisabled();
    finish(json(200, { status: 'ready' }));

    await screen.findByRole('status', { name: 'Data room ready' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
