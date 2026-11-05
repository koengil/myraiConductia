import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccessNeededPanel } from '@/components/access/AccessNeededPanel';
import { ACCESS_DESTINATION } from '@/lib/constants/accessRequests';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AccessNeededPanel', () => {
  it('lets the caller request access and then shows the waiting state', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init || init.method === 'GET') {
        return new Response(JSON.stringify({ mine: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ request: { destination: 'leads', status: 'pending' } }),
        { status: 201 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AccessNeededPanel destination={ACCESS_DESTINATION.LEADS} />);
    expect(
      screen.getByText(/You need permission from an organization administrator/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'Your request is waiting for an administrator.',
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/access-requests',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
