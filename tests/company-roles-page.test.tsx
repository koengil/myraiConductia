import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/flags/FlagsContext', () => ({ useFlag: vi.fn(() => true) }));

import { CompanyRolesWorkspace } from '@/components/company/CompanyRolesWorkspace';
import { useFlag } from '@/lib/flags/FlagsContext';

const CompanyRolesPage = () => <CompanyRolesWorkspace companyId="c1" />;

const permissionDefinitions = [
  {
    key: 'company:invites:send',
    label: 'Send invitations',
    description: 'Invite employees.',
    category: 'company',
    sortOrder: 1,
  },
  {
    key: 'company:roles:manage',
    label: 'Manage roles',
    description: 'Create and update roles.',
    category: 'company',
    sortOrder: 2,
  },
];

const existingRole = {
  id: 'r1',
  name: 'Recruiter',
  description: 'Sends invitations.',
  version: 2,
  permissionKeys: ['company:invites:send'],
  assignmentCount: 0,
  createdAt: '2026-08-14T00:00:00Z',
  updatedAt: '2026-08-14T00:00:00Z',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rolesBody(viewerPermissionKeys = ['company:roles:manage']) {
  return {
    permissions: permissionDefinitions,
    roles: [existingRole],
    viewerPermissions: viewerPermissionKeys.map((permissionKey) => ({
      permissionKey,
      source: { type: 'direct', id: null, name: null },
    })),
  };
}

beforeEach(() => {
  vi.mocked(useFlag).mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('company roles page', () => {
  it('renders the flag-off closed panel without making requests', () => {
    vi.mocked(useFlag).mockReturnValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<CompanyRolesPage />);

    expect(screen.getByText('Company access management is not available.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders load failures as alerts', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/v1/me') {
        return json({ user: { firm_role: null, company_id: 'c1', company_role: 'director' } });
      }
      return json({ error: 'Roles service unavailable.' }, 503);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CompanyRolesPage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Roles service unavailable.');
    expect(alert).toHaveClass('text-[var(--negative)]');
  });

  it('creates a role with fixed permissions and enforces the viewer grant envelope', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/me') {
        return json({
          user: { firm_role: null, company_id: 'c1', company_role: 'member' },
          company_permissions: [],
        });
      }
      if (url.endsWith('/roles') && init?.method === 'POST') return json({ role: existingRole }, 201);
      if (url.endsWith('/roles')) return json(rolesBody());
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompanyRolesPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create role' }));
    const invitations = screen.getByRole('checkbox', { name: /Send invitations/ });
    expect(invitations).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'Role manager' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Manage roles/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save role' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/companies/c1/roles',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            name: 'Role manager',
            description: null,
            permissionKeys: ['company:roles:manage'],
          }),
        }),
      ),
    );
    expect(await screen.findByText('Role created.')).toBeInTheDocument();
  });

  it('reloads after a stale role edit', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/me') {
        return json({ user: { firm_role: null, company_id: 'c1', company_role: 'member' } });
      }
      if (url.endsWith('/roles/r1') && init?.method === 'PATCH') return json({ error: 'stale' }, 409);
      if (url.endsWith('/roles')) return json(rolesBody(['company:roles:manage', 'company:invites:send']));
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompanyRolesPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'Hiring lead' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save role' }));

    expect(
      await screen.findByText('This role changed while you were editing. The latest roles have been reloaded.'),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/companies/c1/roles/r1',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('archives an unassigned role with its expected version', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/me') {
        return json({ user: { firm_role: 'admin', company_id: null, company_role: null } });
      }
      if (url.includes('/roles/r1?expectedVersion=2') && init?.method === 'DELETE') {
        return json({ archived: true });
      }
      if (url.endsWith('/roles')) return json(rolesBody(Object.values({
        directory: 'company:directory:view_all',
        invite: 'company:invites:send',
        roles: 'company:roles:manage',
        access: 'company:access:assign',
      })));
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompanyRolesPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/companies/c1/roles/r1?expectedVersion=2',
        { method: 'DELETE' },
      ),
    );
  });

  it('reports the assignment count returned by an archive conflict', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/me') {
        return json({ user: { firm_role: 'admin', company_id: null, company_role: null } });
      }
      if (url.includes('/roles/r1?expectedVersion=2') && init?.method === 'DELETE') {
        return json({ error: 'Assigned roles cannot be archived', assignmentCount: 3 }, 409);
      }
      if (url.endsWith('/roles')) {
        return json(
          rolesBody([
            'company:directory:view_all',
            'company:invites:send',
            'company:roles:manage',
            'company:access:assign',
          ]),
        );
      }
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompanyRolesPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'This role is assigned to 3 members and cannot be archived.',
    );
  });

  it('keeps role readers without roles-manage authority read only', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/me') {
        return json({ user: { firm_role: null, company_id: 'c1', company_role: 'member' } });
      }
      if (url === '/api/v1/access-requests') return json({ mine: [], inbox: [] });
      return json(rolesBody(['company:access:assign']));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompanyRolesPage />);

    expect(await screen.findByText('Recruiter')).toBeInTheDocument();
    // Every listed role is active, so a constant "active" chip says nothing.
    expect(within(screen.getByRole('region', { name: 'Company roles' })).queryByText('active')).toBeNull();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeInTheDocument();
    expect(
      screen.getByText(/You need permission from an organization administrator to use Roles/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create role' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('lets a locked member request roles-manage without loading the catalogue', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/me') {
        return json({ user: { firm_role: null, company_id: 'c1', company_role: 'member' } });
      }
      if (url === '/api/v1/access-requests') return json({ mine: [], inbox: [] });
      return json({ error: 'Not permitted to view company roles' }, 403);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompanyRolesPage />);

    expect(
      await screen.findByText(/You need permission from an organization administrator to use Roles/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeInTheDocument();
    expect(screen.queryByText('Recruiter')).toBeNull();
  });
});
