import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const useCurrentUserMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/auth/useCurrentUser', () => ({ useCurrentUser: useCurrentUserMock }));

import LeadsPageClient from '@/app/(authed)/leads/page.client';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('/leads heading', () => {
  it('renders exactly one h1 when the lead list answers 403 and shows the access panel', async () => {
    useCurrentUserMock.mockReturnValue({
      state: {
        status: 'ready',
        data: {
          user: { id: 'u1', is_external: true, firm_role: null, company_id: 'co-1', company_role: 'director' },
          company: { id: 'co-1', name: 'Client Co' },
          company_permissions: [
            { permissionKey: COMPANY_PERMISSION.LEADS_VIEW, source: { type: 'direct', id: null, name: null } },
          ],
        },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/v1/companies')) {
          return new Response(JSON.stringify({ error: 'Not permitted' }), { status: 403 });
        }
        return new Response(JSON.stringify({ mine: [] }), { status: 200 });
      }),
    );

    render(<LeadsPageClient />);
    expect(await screen.findByText(/You need permission/)).toBeInTheDocument();
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Leads' })).toBeInTheDocument();
  });
});
