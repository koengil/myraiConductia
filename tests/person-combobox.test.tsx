import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { PersonCombobox } from '@/components/people/PersonCombobox';

function Harness() {
  const [value, setValue] = React.useState('');
  return (
    <PersonCombobox value={value} onChange={setValue} dealId="deal-1" aria-label="Person" />
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('PersonCombobox', () => {
  it('shows suggestions and fills the value on select', async () => {
    const fetchMock = vi.fn(async (...[,]: [RequestInfo | URL, RequestInit?]) =>
      Response.json({
        people: [
          {
            id: 'deal-member:u1',
            name: 'Storm Duncan',
            email: 'storm@bank.dev',
            company: null,
            source: 'deal_member',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<Harness />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Person' }), {
      target: { value: 'stor' },
    });
    fireEvent.focus(screen.getByRole('combobox', { name: 'Person' }));

    const option = await screen.findByRole('option', { name: /Storm Duncan/i });
    fireEvent.mouseDown(option);

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Person' })).toHaveValue('Storm Duncan');
    });
  });

  it('sends the typed text in a POST body, never in the URL', async () => {
    const fetchMock = vi.fn(async (...[,]: [RequestInfo | URL, RequestInit?]) =>
      Response.json({ people: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<Harness />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Person' }), {
      target: { value: 'stor' },
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/v1/people/search');
    expect(String(url)).not.toContain('?');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ query: 'stor', dealId: 'deal-1' });
  });
});
