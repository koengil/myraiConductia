import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const useCurrentUserMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/auth/useCurrentUser', () => ({
  useCurrentUser: useCurrentUserMock,
}));
vi.mock('@/components/leads/LeadList', () => ({
  LeadList: ({ canCreate }: { canCreate?: boolean }) => (
    <div>
      Lead catalog
      <span>{canCreate ? 'can-create' : 'cannot-create'}</span>
    </div>
  ),
}));
vi.mock('@/components/leads/PeopleList', () => ({
  PeopleList: () => <div>People catalog</div>,
}));
vi.mock('@/components/leads/CrmNetworkPreview', () => ({
  CrmNetworkPreview: () => <div>Network catalog</div>,
}));

import LeadsPageClient from '@/app/(authed)/leads/page.client';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ mine: [] }), { status: 200 })),
  );
});

describe('leads page access gate', () => {
  it('shows a spinner until the signed-in user is known', () => {
    useCurrentUserMock.mockReturnValue({ state: { status: 'loading' } });
    render(<LeadsPageClient />);
    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(screen.queryByText('Lead catalog')).toBeNull();
    expect(screen.queryByText(/You need permission/)).toBeNull();
  });

  it('shows the request panel without mounting the catalog when View Leads is missing', () => {
    useCurrentUserMock.mockReturnValue({
      state: {
        status: 'ready',
        data: {
          user: {
            id: 'u1',
            is_external: false,
            firm_role: null,
            company_id: 'co-1',
            company_role: 'member',
          },
          company: { id: 'co-1', name: 'Conductia' },
          company_permissions: [
            {
              permissionKey: COMPANY_PERMISSION.ACCESS_ASSIGN,
              source: { type: 'direct', id: null, name: null },
            },
          ],
        },
      },
    });
    render(<LeadsPageClient />);
    expect(screen.getByText(/You need permission from an organization administrator/)).toBeInTheDocument();
    expect(screen.queryByText('Lead catalog')).toBeNull();
    expect(screen.queryByText('Loading')).toBeNull();
  });

  it('renders the catalog once the caller is allowed', () => {
    useCurrentUserMock.mockReturnValue({
      state: {
        status: 'ready',
        data: {
          user: {
            id: 'u1',
            is_external: false,
            firm_role: null,
            company_id: 'co-1',
            company_role: 'member',
          },
          company: { id: 'co-1', name: 'Conductia' },
          company_permissions: [
            {
              permissionKey: COMPANY_PERMISSION.LEADS_VIEW,
              source: { type: 'direct', id: null, name: null },
            },
          ],
        },
      },
    });
    render(<LeadsPageClient />);
    expect(screen.getByText('Lead catalog')).toBeInTheDocument();
    expect(screen.getByText('cannot-create')).toBeInTheDocument();
    expect(screen.queryByText(/You need permission/)).toBeNull();
    // The page has exactly one h1.
    const h1s = document.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Leads' })).toBeInTheDocument();
  });

  it('lets a caller with Create leads open the registration form', () => {
    useCurrentUserMock.mockReturnValue({
      state: {
        status: 'ready',
        data: {
          user: {
            id: 'u1',
            is_external: false,
            firm_role: null,
            company_id: 'co-1',
            company_role: 'member',
          },
          company: { id: 'co-1', name: 'Conductia' },
          company_permissions: [
            {
              permissionKey: COMPANY_PERMISSION.LEADS_VIEW,
              source: { type: 'direct', id: null, name: null },
            },
            {
              permissionKey: COMPANY_PERMISSION.LEADS_CREATE,
              source: { type: 'direct', id: null, name: null },
            },
          ],
        },
      },
    });
    render(<LeadsPageClient />);
    expect(screen.getByText('Lead catalog')).toBeInTheDocument();
    expect(screen.getByText('can-create')).toBeInTheDocument();
  });
});
