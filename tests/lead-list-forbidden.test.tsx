import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { LeadList } from '@/components/leads/LeadList';

/*
 * A director revokes View Leads while a member has /leads open. The next
 * list read answers 403; the page must turn into the access request panel
 * rather than a generic "could not load" error (Rob's Aug 31 demo find).
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LeadList when the permission was revoked under the session', () => {
  it('shows the access request panel on a 403 instead of an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/v1/companies?type=')) {
          return new Response(JSON.stringify({ error: 'Not permitted' }), { status: 403 });
        }
        if (url === '/api/v1/access-requests') {
          return new Response(JSON.stringify({ mine: [] }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    render(<LeadList />);

    expect(await screen.findByText(/You need permission/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeInTheDocument();
    expect(screen.queryByText(/Could not load leads/)).toBeNull();
    expect(screen.queryByLabelText('Registered leads')).toBeNull();
  });
});
