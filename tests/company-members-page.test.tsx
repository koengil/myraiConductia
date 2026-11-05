import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigationState = vi.hoisted(() => ({ search: '' }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navigationState.search),
}));
vi.mock('@/lib/flags/FlagsContext', () => ({ useFlag: vi.fn(() => true) }));

import { CompanyMembersView, isFixedAccessMember } from '@/components/company/CompanyMembersWorkspace';
import { invalidateCompanyRoster } from '@/lib/company/companyRosterCache';
import { useFlag } from '@/lib/flags/FlagsContext';

const CompanyMembersPage = () => <CompanyMembersView companyId="c1" />;

/** Radix menus open on Enter or pointerdown, not a bare click. */
function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole('button', { name }), { key: 'Enter' });
}

const director = {
  id: 'me',
  firm_role: null,
  company_id: 'c1',
  company_role: 'director',
  is_external: false,
  can_invite: false,
};

const initialMembers = [
  {
    id: 'me',
    full_name: 'Storm Duncan',
    display_name: null,
    email: 'storm@bank.dev',
    department: 'ib',
    firm_role: null,
    company_role: 'director',
    can_invite: false,
    preferred_deal_role: null,
    is_walled: false,
  },
  {
    id: 'u2',
    full_name: 'Alex Reyes',
    display_name: null,
    email: 'alex@bank.dev',
    department: 'ib',
    firm_role: null,
    company_role: 'member',
    can_invite: false,
    preferred_deal_role: 'legal',
    is_walled: false,
  },
  {
    id: 'u3',
    full_name: 'Ren Ito',
    display_name: null,
    email: 'ren@bank.dev',
    department: 'research',
    firm_role: null,
    company_role: 'member',
    can_invite: false,
    preferred_deal_role: null,
    is_walled: true,
  },
];

function stubFetch() {
  let members = initialMembers.map((member) => ({ ...member }));
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const response = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url === '/api/v1/me') return response({ user: director });
    if (url === '/api/v1/access-requests') return response({ mine: [], inbox: [] });
    if (url.includes('/members?includeWalled=true')) return response({ members });
    if (url.includes('/api/v1/invites?')) return response({ invites: [] });
    if (url.endsWith('/members/u2') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as { preferredDealRole: string | null };
      members = members.map((member) =>
        member.id === 'u2'
          ? { ...member, preferred_deal_role: body.preferredDealRole }
          : member,
      );
      return response({ member: members.find((member) => member.id === 'u2') });
    }
    return response({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  invalidateCompanyRoster();
  navigationState.search = '';
  vi.mocked(useFlag).mockImplementation((key) => key === 'platform_onboarding');
});

afterEach(() => {
  invalidateCompanyRoster();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('company members page', () => {
  it('shows the leads spinner while the roster loads', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    render(<CompanyMembersPage />);
    expect(screen.getByText('Loading members…')).toBeInTheDocument();
  });

  it('shows the cached roster immediately when returning to the page', async () => {
    stubFetch();
    const first = render(<CompanyMembersPage />);
    await screen.findByText('Alex Reyes');
    first.unmount();

    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    render(<CompanyMembersPage />);
    expect(screen.getByText('Alex Reyes')).toBeInTheDocument();
    expect(screen.queryByText('Loading members…')).toBeNull();
  });

  it('opens the invite modal from the + button', async () => {
    stubFetch();
    render(<CompanyMembersPage />);
    await screen.findByText('Alex Reyes');

    expect(screen.queryByRole('dialog', { name: 'Invite a member' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Invite a member' }));
    expect(screen.getByRole('dialog', { name: 'Invite a member' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Invite a member' })).toBeInTheDocument();
  });

  it('requests walled rows and hides deal-role and director promotion controls', async () => {
    const fetchMock = stubFetch();
    render(<CompanyMembersPage />);

    await screen.findByText('Ren Ito');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/companies/c1/members?includeWalled=true',
    );
    expect(screen.queryByLabelText('Preferred role for Ren Ito')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make director' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Actions for Alex Reyes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions for Ren Ito' })).toBeInTheDocument();
  });

  it('preserves the legacy invite delegation controls when Phase B is disabled', async () => {
    const fetchMock = stubFetch();
    render(<CompanyMembersPage />);

    await screen.findByText('Alex Reyes');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/companies/c1/members?includeWalled=true',
    );
    openMenu('Actions for Alex Reyes');
    expect(await screen.findByRole('menuitem', { name: 'Allow invites' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Roles & permissions' })).toBeNull();
  });

  it('never exposes preferred deal-role selectors on the roster', async () => {
    stubFetch();
    render(<CompanyMembersPage />);
    await screen.findByText('Alex Reyes');

    expect(screen.queryByLabelText('Preferred role for Alex Reyes')).toBeNull();
    expect(screen.queryByLabelText('Preferred role for Ren Ito')).toBeNull();
  });

  it('filters the roster by name or email', async () => {
    stubFetch();
    render(<CompanyMembersPage />);
    await screen.findByText('Alex Reyes');

    fireEvent.change(screen.getByLabelText('Search members'), {
      target: { value: 'ren@' },
    });
    expect(screen.queryByText('Alex Reyes')).toBeNull();
    expect(screen.getByText('Ren Ito')).toBeInTheDocument();
  });

  it('hides preferred-role controls when platform onboarding is disabled', async () => {
    vi.mocked(useFlag).mockReturnValue(false);
    stubFetch();
    render(<CompanyMembersPage />);
    await screen.findByText('Alex Reyes');

    expect(screen.queryByLabelText('Preferred role for Alex Reyes')).toBeNull();
  });

  it('uses effective invite authority and does not request walled rows for an invite delegate', async () => {
    vi.mocked(useFlag).mockImplementation((key) => key === 'company_access_management');
    const response = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/me') {
        return response({
          user: { ...director, company_role: 'member' },
          company_permissions: [
            {
              permissionKey: 'company:invites:send',
              source: { type: 'direct', id: null, name: null },
            },
          ],
        });
      }
      if (url === '/api/v1/companies/c1/members') return response({ members: initialMembers });
      if (url.includes('/api/v1/invites?')) return response({ invites: [] });
      if (url.endsWith('/members/me/access')) return response({ access: undefined });
      return response({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CompanyMembersPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Invite a member' }));
    expect(await screen.findByRole('heading', { name: 'Invite a member' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/companies/c1/members');
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/v1/companies/c1/members?includeWalled=true',
    );
    expect(screen.queryByRole('button', { name: 'Allow invites' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make director' })).toBeNull();
    // A delegate opens only their own row, read-only; nobody else's row opens.
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Storm Duncan/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /^Alex Reyes/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /^Select / })).toBeNull();
  });

  it('renders a simple Name / Email / Role roster for an external company director', async () => {
    vi.mocked(useFlag).mockReturnValue(true);
    const response = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const roles = [
      {
        id: 'role-employee',
        name: 'Employee',
        description: null,
        version: 1,
        permissionKeys: [],
        assignmentCount: 0,
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:00:00.000Z',
      },
      {
        id: 'role-md',
        name: 'MD',
        description: null,
        version: 1,
        permissionKeys: ['company:invites:send'],
        assignmentCount: 0,
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:00:00.000Z',
      },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/me') {
        return response({
          user: {
            id: 'ext-dir',
            firm_role: null,
            company_id: 'c1',
            company_role: 'director',
            is_external: true,
            can_invite: false,
          },
          company_permissions: [],
        });
      }
      if (url === '/api/v1/companies/c1/members?includeWalled=true') {
        return response({
          members: [
            {
              id: 'ext-dir',
              full_name: 'Rob.dll',
              display_name: null,
              email: 'admin@playboot.com',
              department: null,
              firm_role: null,
              company_role: 'director',
              can_invite: false,
              preferred_deal_role: null,
              is_walled: false,
            },
            {
              id: 'emp-1',
              full_name: 'Jane Doe',
              display_name: null,
              email: 'jane@playboot.com',
              department: null,
              firm_role: null,
              company_role: 'member',
              can_invite: false,
              preferred_deal_role: null,
              is_walled: false,
            },
          ],
        });
      }
      if (url === '/api/v1/companies/c1/roles') {
        return response({ permissions: [], roles, viewerPermissions: [] });
      }
      if (url.endsWith('/members/emp-1/access')) {
        return response({
          access: {
            company_id: 'c1',
            user_id: 'emp-1',
            version: 0,
            assigned_roles: [],
            direct_permissions: [],
            effective_permissions: [],
          },
        });
      }
      if (url.includes('/api/v1/invites?')) return response({ invites: [] });
      return response({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CompanyMembersPage />);

    expect(await screen.findByText('Rob.dll')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Roles' })).toBeInTheDocument();
    // One meaning for Administrator: their own director reads "Director".
    expect(screen.getByRole('heading', { name: /^Director/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Employee/ })).toBeInTheDocument();
    expect(screen.queryByText('Administrator')).toBeNull();
    // The role picker is not on the row: opening the row is read-only, and
    // "Change role" is the explicit step.
    expect(screen.queryByLabelText('Role for Jane Doe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Jane Doe/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Change role' }));
    expect(screen.getByLabelText('Role for Jane Doe')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/companies/c1/roles');

    // Their invite offers only what the server grants an outside director.
    fireEvent.click(screen.getByRole('button', { name: 'Invite an employee' }));
    const invite = screen.getByRole('dialog', { name: 'Invite an employee' });
    expect(within(invite).queryByRole('combobox', { name: 'Company role' })).toBeNull();
    expect(within(invite).queryByText('Administrator')).toBeNull();
    expect(within(invite).queryByText('Director')).toBeNull();
    expect(within(invite).getByText(/To add another director, ask the bank running your deal/)).toBeInTheDocument();
  });

  it('uses the target-company grant envelope for a firm administrator', async () => {
    vi.mocked(useFlag).mockImplementation((key) => key === 'company_access_management');
    const response = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const allPermissionKeys = [
      'company:directory:view_all',
      'company:invites:send',
      'company:roles:manage',
      'company:access:assign',
    ];
    const permissions = allPermissionKeys.map((key, index) => ({
      key,
      label:
        key === 'company:invites:send'
          ? 'Send company invitations'
          : `Permission ${index + 1}`,
      description: 'Company authority.',
      category: 'company',
      sortOrder: index,
    }));
    const accessFor = (userId: string) => ({
      company_id: 'c1',
      user_id: userId,
      version: 1,
      assigned_roles: [],
      direct_permissions: [],
      effective_permissions: [],
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/me') {
        return response({
          user: {
            ...director,
            firm_role: 'admin',
            company_id: null,
            company_role: null,
          },
          company_permissions: [],
        });
      }
      if (url === '/api/v1/companies/c1/members?includeWalled=true') {
        return response({ members: initialMembers });
      }
      if (url === '/api/v1/companies/c1/roles') {
        return response({
          permissions,
          roles: [],
          viewerPermissions: allPermissionKeys.map((permissionKey) => ({
            permissionKey,
            source: { type: 'root', id: null, name: 'Firm administrator' },
          })),
        });
      }
      if (url.includes('/api/v1/invites?')) return response({ invites: [] });
      const accessMatch = /\/members\/([^/]+)\/access$/.exec(url);
      if (accessMatch) return response({ access: accessFor(accessMatch[1]) });
      return response({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CompanyMembersPage />);

    await screen.findByText('Alex Reyes');
    openMenu('Actions for Alex Reyes');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit access' }));
    const invitePermission = await screen.findByRole('checkbox', {
      name: /Send company invitations/,
    });
    expect(invitePermission).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save access' })).toBeDisabled();
    fireEvent.click(invitePermission);
    expect(screen.getByRole('button', { name: 'Save access' })).toBeEnabled();
  });

  it('lets a locked member open their own permissions', async () => {
    vi.mocked(useFlag).mockImplementation((key) => key === 'company_access_management');
    const response = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/me') {
        return response({
          user: { ...director, company_role: 'member' },
          company_permissions: [],
        });
      }
      if (url === '/api/v1/access-requests') return response({ mine: [], inbox: [] });
      if (url === '/api/v1/companies/c1/members') return response({ members: [] });
      if (url.includes('/api/v1/invites?')) return response({ invites: [] });
      if (url.endsWith('/members/me/access')) {
        return response({
          access: {
            company_id: 'c1',
            user_id: 'me',
            version: 1,
            assigned_roles: [],
            direct_permissions: [],
            effective_permissions: [
              {
                permissionKey: 'company:leads:create',
                source: { type: 'direct', id: null, name: null },
              },
            ],
          },
        });
      }
      return response({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CompanyMembersPage />);

    expect(await screen.findByRole('button', { name: 'Request access' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Your permissions' }));
    expect(await screen.findByText('Create leads')).toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Edit access' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save access' })).toBeNull();
  });

  it('uses roster tabs and keeps invite next to the filter', async () => {
    vi.mocked(useFlag).mockReturnValue(true);
    const response = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/me') return response({ user: director, company_permissions: [] });
        if (url.includes('/members?includeWalled=true')) return response({ members: initialMembers });
        if (url.includes('/api/v1/invites?')) return response({ invites: [] });
        if (url === '/api/v1/companies/c1/roles') {
          return response({ permissions: [], roles: [], viewerPermissions: [] });
        }
        if (url === '/api/v1/access-requests') return response({ mine: [], inbox: [] });
        const accessMatch = /\/members\/([^/]+)\/access$/.exec(url);
        if (accessMatch) {
          return response({
            access: {
              company_id: 'c1',
              user_id: accessMatch[1],
              version: 0,
              assigned_roles: [],
              direct_permissions: [],
              effective_permissions: [],
            },
          });
        }
        return response({});
      }),
    );

    render(<CompanyMembersPage />);
    await screen.findByText('Alex Reyes');

    expect(screen.queryByText(/^Company$/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Members' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Roster' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Permission requests' })).toHaveAttribute(
      'href',
      '/companies/c1/members?tab=requests',
    );
    expect(screen.getByRole('link', { name: 'Roles' })).toHaveAttribute(
      'href',
      '/companies/c1/roles',
    );
    expect(screen.getByLabelText('Search members')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite a member' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Access requests' })).toBeNull();
  });

  it('shows the permission-request inbox on the requests tab', async () => {
    navigationState.search = 'tab=requests';
    vi.mocked(useFlag).mockReturnValue(true);
    const response = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/me') return response({ user: director, company_permissions: [] });
        if (url.includes('/members?includeWalled=true')) return response({ members: initialMembers });
        if (url.includes('/api/v1/invites?')) return response({ invites: [] });
        if (url === '/api/v1/companies/c1/roles') {
          return response({ permissions: [], roles: [], viewerPermissions: [] });
        }
        if (url === '/api/v1/access-requests') return response({ mine: [], inbox: [] });
        return response({});
      }),
    );

    render(<CompanyMembersPage />);

    expect(await screen.findByRole('link', { name: 'Permission requests' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByText('No pending permission requests.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Search members')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite a member' })).toBeNull();
  });

  it('lets a member request assign-access and mandate notices from the requests tab', async () => {
    navigationState.search = 'tab=requests';
    vi.mocked(useFlag).mockImplementation((key) => key === 'company_access_management');
    const response = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/me') {
          return response({ user: { ...director, company_role: 'member' }, company_permissions: [] });
        }
        if (url === '/api/v1/companies/c1/members') return response({ members: [] });
        if (url.includes('/api/v1/invites?')) return response({ invites: [] });
        if (url === '/api/v1/access-requests') return response({ mine: [], inbox: [] });
        if (url.endsWith('/members/me/access')) {
          return response({
            access: {
              company_id: 'c1',
              user_id: 'me',
              version: 0,
              assigned_roles: [],
              direct_permissions: [],
              effective_permissions: [],
            },
          });
        }
        return response({});
      }),
    );

    render(<CompanyMembersPage />);

    expect(await screen.findByRole('heading', { name: 'Assign employee access' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Receive new-mandate notices' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Request access' })).toHaveLength(2);
    expect(screen.queryByText('No pending permission requests.')).toBeNull();
  });

  it('groups by role, filters by role, and sets the same access for several people at once', async () => {
    vi.mocked(useFlag).mockImplementation((key) => key === 'company_access_management');
    const response = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const viewerPermissions = [
      { permissionKey: 'company:access:assign', source: { type: 'root', id: null, name: 'Company director' } },
      { permissionKey: 'company:leads:view', source: { type: 'root', id: null, name: 'Company director' } },
    ];
    const permissions = [
      { key: 'company:leads:view', label: 'View Leads', description: '', category: 'leads', sortOrder: 1 },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/me') return response({ user: director, company_permissions: [] });
      if (url.includes('/members?includeWalled=true')) return response({ members: initialMembers });
      if (url.includes('/api/v1/invites?')) return response({ invites: [] });
      if (url === '/api/v1/companies/c1/roles') {
        return response({ permissions, roles: [], viewerPermissions });
      }
      const accessMatch = /\/members\/([^/]+)\/access$/.exec(url);
      if (accessMatch && init?.method === 'PATCH') {
        if (accessMatch[1] === 'u3') {
          return response({ error: 'Employee access changed concurrently. Reload and retry.' }, 409);
        }
        const body = JSON.parse(String(init.body));
        return response({
          access: {
            company_id: 'c1',
            user_id: accessMatch[1],
            version: body.expectedVersion + 1,
            assigned_roles: [],
            direct_permissions: body.directPermissions,
            effective_permissions: [],
          },
        });
      }
      if (accessMatch) {
        return response({
          access: {
            company_id: 'c1',
            user_id: accessMatch[1],
            version: accessMatch[1] === 'u2' ? 2 : 5,
            assigned_roles: [],
            direct_permissions: [],
            effective_permissions: accessMatch[1] === 'me' ? viewerPermissions : [],
          },
        });
      }
      return response({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CompanyMembersPage />);
    await screen.findByText('Alex Reyes');

    // Grouped by role, directors first.
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings[0]).toMatch(/^Director/);
    expect(headings[1]).toMatch(/^Member/);
    expect(screen.getByRole('group', { name: /^Director/ })).toHaveTextContent('Storm Duncan');

    // The role filter narrows the rows.
    fireEvent.change(screen.getByLabelText('Filter by role'), { target: { value: 'Director' } });
    expect(screen.queryByText('Alex Reyes')).toBeNull();
    fireEvent.change(screen.getByLabelText('Filter by role'), { target: { value: '' } });

    // A director cannot be selected: their access is fixed, and the row says why.
    expect(screen.queryByRole('checkbox', { name: 'Select Storm Duncan' })).toBeNull();
    expect(screen.getByText('Storm Duncan: As a director, they have every permission. Their access is fixed.')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Set access' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alex Reyes' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ren Ito' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set access' }));

    const dialog = await screen.findByRole('dialog', { name: 'Set access for 2 people' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /View Leads/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set access for 2 people' }));

    expect(await within(dialog).findByText('Access set for 1 of 2 people.')).toBeInTheDocument();
    expect(within(dialog).getByText('Alex Reyes').closest('li')).toHaveAttribute('data-result', 'updated');
    expect(within(dialog).getByText('Ren Ito').closest('li')).toHaveAttribute('data-result', 'stale');

    const patches = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(patches.map(([url]) => String(url)).sort()).toEqual([
      '/api/v1/companies/c1/members/u2/access',
      '/api/v1/companies/c1/members/u3/access',
    ]);
    const alex = patches.find(([url]) => String(url).includes('/u2/'))!;
    expect(JSON.parse(String(alex[1]?.body))).toEqual({
      expectedVersion: 2,
      roleIds: [],
      directPermissions: ['company:leads:view'],
    });
  });

  it('opening a row is read-only; editing needs Edit access, and unsaved edits ask before switching rows', async () => {
    vi.mocked(useFlag).mockImplementation((key) => key === 'company_access_management');
    const response = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    const viewerPermissions = [
      { permissionKey: 'company:access:assign', source: { type: 'root', id: null, name: 'Company director' } },
      { permissionKey: 'company:leads:view', source: { type: 'root', id: null, name: 'Company director' } },
    ];
    const permissions = [
      { key: 'company:leads:view', label: 'View Leads', description: '', category: 'leads', sortOrder: 1 },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/me') return response({ user: director, company_permissions: [] });
        if (url.includes('/members?includeWalled=true')) return response({ members: initialMembers });
        if (url.includes('/api/v1/invites?')) return response({ invites: [] });
        if (url === '/api/v1/companies/c1/roles') return response({ permissions, roles: [], viewerPermissions });
        const accessMatch = /\/members\/([^/]+)\/access$/.exec(url);
        if (accessMatch) {
          return response({
            access: {
              company_id: 'c1',
              user_id: accessMatch[1],
              version: 1,
              assigned_roles: [],
              direct_permissions: [],
              effective_permissions: accessMatch[1] === 'me' ? viewerPermissions : [],
            },
          });
        }
        return response({});
      }),
    );

    render(<CompanyMembersPage />);
    const alexRow = await screen.findByRole('button', { name: /^Alex Reyes/ });
    fireEvent.click(alexRow);
    expect(alexRow).toHaveAttribute('aria-expanded', 'true');
    // Read-only, and the name and email are not repeated under the row.
    expect(await screen.findByRole('button', { name: 'Edit access' })).toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox', { name: /View Leads/ })).toHaveLength(0);
    expect(screen.getAllByText('Alex Reyes')).toHaveLength(1);
    expect(screen.getAllByText(/alex@bank\.dev/)).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Edit access' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /View Leads/ }));

    // Switching to another row with unsaved edits asks first.
    fireEvent.click(screen.getByRole('button', { name: /^Ren Ito/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('You have unsaved access changes.');
    expect(alexRow).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByRole('button', { name: /^Ren Ito/ })).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(alexRow).toHaveAttribute('aria-expanded', 'false'));
  });

  it('labels a firm administrator "Administrator" and a company director "Director", never the other way', async () => {
    const members = [
      { ...initialMembers[0], id: 'adm', full_name: 'Avery Admin', firm_role: 'admin', company_role: 'member' },
      ...initialMembers,
    ];
    const response = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/me') return response({ user: director });
        if (url.includes('/members?includeWalled=true')) return response({ members });
        if (url.includes('/api/v1/invites?')) return response({ invites: [] });
        return response({});
      }),
    );
    render(<CompanyMembersPage />);
    await screen.findByText('Avery Admin');
    expect(screen.getByRole('group', { name: /^Administrator/ })).toHaveTextContent('Avery Admin');
    expect(screen.getByRole('group', { name: /^Administrator/ })).not.toHaveTextContent('Storm Duncan');
    expect(screen.getByRole('group', { name: /^Director/ })).toHaveTextContent('Storm Duncan');
  });

  it('a director\'s invite offers Member and Director only, and says how CCO and Administrator are assigned', async () => {
    stubFetch();
    render(<CompanyMembersPage />);
    await screen.findByText('Alex Reyes');
    fireEvent.click(screen.getByRole('button', { name: 'Invite a member' }));
    const dialog = screen.getByRole('dialog', { name: 'Invite a member' });
    const role = within(dialog).getByRole('combobox', { name: 'Company role' });
    expect(within(role).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Member',
      'Director',
    ]);
    expect(
      within(dialog).getByText(
        'Chief Compliance Officer and Administrator are set by Conductia when your firm is set up, not by invitation. To change one, contact Conductia.',
      ),
    ).toBeInTheDocument();
  });

  it('asks before removing a member, and Cancel sends nothing (#250)', async () => {
    const fetchMock = stubFetch();
    render(<CompanyMembersPage />);
    await screen.findByText('Alex Reyes');
    openMenu('Actions for Alex Reyes');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));

    const deletes = () =>
      fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
    const confirm = await screen.findByRole('dialog', { name: 'Remove Alex Reyes' });
    expect(deletes()).toHaveLength(0);

    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove Alex Reyes' })).toBeNull());
    expect(deletes()).toHaveLength(0);

    openMenu('Actions for Alex Reyes');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Remove Alex Reyes' })).getByRole('button', {
        name: 'Remove',
      }),
    );
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(String(deletes()[0][0])).toBe('/api/v1/companies/c1/members/u2');
  });

  it('shows a retry instead of an empty roster when the roster fails to load (#250)', async () => {
    const fetchMock = stubFetch();
    const ok = fetchMock.getMockImplementation()!;
    let fail = true;
    fetchMock.mockImplementation(async (input, init) =>
      fail && String(input).includes('/members?includeWalled=true')
        ? new Response('{}', { status: 500 })
        : ok(input, init),
    );
    render(<CompanyMembersPage />);
    expect(await screen.findByText('The roster could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('Alex Reyes')).toBeNull();
    // A failed read is not an empty roster: no empty line under the error.
    expect(screen.queryByText(/No members yet/)).toBeNull();

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Alex Reyes')).toBeInTheDocument();
  });

  it('an outside director changes a person\'s role only through Change role and Save role', async () => {
    vi.mocked(useFlag).mockReturnValue(true);
    const response = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    const roles = [
      {
        id: 'role-md',
        name: 'MD',
        description: null,
        version: 1,
        permissionKeys: [],
        assignmentCount: 0,
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:00:00.000Z',
      },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/me') {
        return response({
          user: { id: 'ext-dir', firm_role: null, company_id: 'c1', company_role: 'director', is_external: true, can_invite: false },
          company_permissions: [],
        });
      }
      if (url === '/api/v1/companies/c1/members?includeWalled=true') {
        return response({
          members: [
            { ...initialMembers[1], id: 'emp-1', full_name: 'Jane Doe', email: 'jane@playboot.com', department: null },
          ],
        });
      }
      if (url === '/api/v1/companies/c1/roles') return response({ permissions: [], roles, viewerPermissions: [] });
      if (url.endsWith('/members/emp-1/access') && init?.method === 'PATCH') {
        return response({ access: { user_id: 'emp-1', version: 1 } });
      }
      if (url.endsWith('/members/emp-1/access')) {
        return response({
          access: { company_id: 'c1', user_id: 'emp-1', version: 0, assigned_roles: [], direct_permissions: [], effective_permissions: [] },
        });
      }
      if (url.includes('/api/v1/invites?')) return response({ invites: [] });
      return response({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CompanyMembersPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Jane Doe/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Change role' }));
    const select = screen.getByLabelText('Role for Jane Doe') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'role-md' } });
    const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(patches()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Save role' }));

    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(String(patches()[0][1]?.body))).toEqual({
      expectedVersion: 0,
      roleIds: ['role-md'],
      directPermissions: [],
    });
  });

  it('reads each person\'s access with at most four requests at once, however long the roster', async () => {
    vi.mocked(useFlag).mockImplementation((key) => key === 'company_access_management');
    const response = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...initialMembers[1],
      id: `m${i}`,
      full_name: `Person ${i}`,
      email: `p${i}@bank.dev`,
    }));
    const viewerPermissions = [
      { permissionKey: 'company:access:assign', source: { type: 'root', id: null, name: 'Company director' } },
    ];
    let inFlight = 0;
    let peak = 0;
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/me') return response({ user: director, company_permissions: [] });
        if (url.includes('/members?includeWalled=true')) return response({ members: [initialMembers[0], ...many] });
        if (url.includes('/api/v1/invites?')) return response({ invites: [] });
        if (url === '/api/v1/companies/c1/roles') return response({ permissions: [], roles: [], viewerPermissions });
        const accessMatch = /\/members\/([^/]+)\/access$/.exec(url);
        if (accessMatch) {
          inFlight += 1;
          reads += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 2));
          inFlight -= 1;
          return response({
            access: {
              company_id: 'c1',
              user_id: accessMatch[1],
              version: 1,
              assigned_roles: [],
              direct_permissions: [],
              effective_permissions: [],
            },
          });
        }
        return response({});
      }),
    );
    render(<CompanyMembersPage />);
    expect(await screen.findByRole('button', { name: /^Person 39/ }, { timeout: 3000 })).toBeInTheDocument();
    expect(reads).toBe(41);
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe('roster row edits and filters', () => {
  const response = (data: unknown) =>
    new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  const viewerPermissions = [
    { permissionKey: 'company:access:assign', source: { type: 'root', id: null, name: 'Company director' } },
    { permissionKey: 'company:leads:view', source: { type: 'root', id: null, name: 'Company director' } },
  ];
  const permissions = [
    { key: 'company:leads:view', label: 'View Leads', description: '', category: 'leads', sortOrder: 1 },
  ];

  /** The access-managed roster (bank side), with reads of each person's access. */
  function stubAccessRoster() {
    vi.mocked(useFlag).mockImplementation((key) => key === 'company_access_management');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/me') return response({ user: director, company_permissions: [] });
        if (url.includes('/members?includeWalled=true')) return response({ members: initialMembers });
        if (url.includes('/api/v1/invites?')) return response({ invites: [] });
        if (url === '/api/v1/companies/c1/roles') return response({ permissions, roles: [], viewerPermissions });
        const accessMatch = /\/members\/([^/]+)\/access$/.exec(url);
        if (accessMatch) {
          return response({
            access: {
              company_id: 'c1',
              user_id: accessMatch[1],
              version: 1,
              assigned_roles: [],
              direct_permissions: [],
              effective_permissions: accessMatch[1] === 'me' ? viewerPermissions : [],
            },
          });
        }
        return response({});
      }),
    );
  }

  /** Open Alex's row in edit mode and change something, so it has unsaved edits. */
  async function dirtyAlex() {
    const alexRow = await screen.findByRole('button', { name: /^Alex Reyes/ });
    fireEvent.click(alexRow);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit access' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /View Leads/ }));
    return alexRow;
  }

  it('"Edit access" from another row survives the Discard prompt', async () => {
    stubAccessRoster();
    render(<CompanyMembersPage />);
    const alexRow = await dirtyAlex();

    openMenu('Actions for Ren Ito');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit access' }));
    expect(screen.getByRole('alert')).toHaveTextContent('You have unsaved access changes.');
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));

    expect(screen.getByRole('button', { name: /^Ren Ito/ })).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(alexRow).toHaveAttribute('aria-expanded', 'false'));
    // Ren's row opened straight into edit mode: the checkboxes are there.
    expect(await screen.findByRole('checkbox', { name: /View Leads/ })).toBeInTheDocument();
  });

  it('Set access closes an open row first', async () => {
    stubAccessRoster();
    render(<CompanyMembersPage />);
    const alexRow = await screen.findByRole('button', { name: /^Alex Reyes/ });
    fireEvent.click(alexRow);
    expect(alexRow).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ren Ito' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set access' }));
    expect(await screen.findByRole('dialog', { name: 'Set access for 1 person' })).toBeInTheDocument();
    await waitFor(() => expect(alexRow).toHaveAttribute('aria-expanded', 'false'));
  });

  it('with unsaved edits, Set access asks, and Discard goes straight on into Set access', async () => {
    stubAccessRoster();
    render(<CompanyMembersPage />);
    const alexRow = await dirtyAlex();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ren Ito' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set access' }));
    expect(screen.getByRole('alert')).toHaveTextContent('You have unsaved access changes.');
    expect(screen.queryByRole('dialog', { name: /^Set access for/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    // One press: the dialog opens without pressing Set access again.
    expect(await screen.findByRole('dialog', { name: 'Set access for 1 person' })).toBeInTheDocument();
    await waitFor(() => expect(alexRow).toHaveAttribute('aria-expanded', 'false'));
  });

  it('a role filter whose group is gone stops filtering; the empty state is neutral', async () => {
    let members = [initialMembers[0], initialMembers[1]];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/v1/me') return response({ user: director });
        if (url === '/api/v1/access-requests') return response({ mine: [], inbox: [] });
        if (url.includes('/members?includeWalled=true')) return response({ members });
        if (url.includes('/api/v1/invites?')) return response({ invites: [] });
        if (url.endsWith('/members/u2') && init?.method === 'DELETE') {
          members = members.filter((m) => m.id !== 'u2');
          return response({ removed: { userId: 'u2' } });
        }
        return response({});
      }),
    );
    render(<CompanyMembersPage />);
    await screen.findByText('Alex Reyes');

    fireEvent.change(screen.getByLabelText('Search members'), { target: { value: 'nobody' } });
    expect(screen.getByText('No members match.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search members'), { target: { value: '' } });

    fireEvent.change(screen.getByLabelText('Filter by role'), { target: { value: 'Member' } });
    expect(screen.queryByText('Storm Duncan')).toBeNull();

    openMenu('Actions for Alex Reyes');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Remove Alex Reyes' })).getByRole('button', { name: 'Remove' }),
    );

    // Only Directors are left: the filter control is gone, and so is its filter.
    await waitFor(() => expect(screen.queryByText('Alex Reyes')).toBeNull());
    expect(screen.queryByLabelText('Filter by role')).toBeNull();
    expect(screen.getByText(/Storm Duncan/)).toBeInTheDocument();
    expect(screen.queryByText('No members match.')).toBeNull();
  });
});

describe('whose access is fixed (matches app_company_is_access_root)', () => {
  const none = {};
  it('locks every director of a managed company, bank or outside client, and firm administrators', () => {
    expect(isFixedAccessMember({ id: 'd', company_role: 'director', firm_role: null }, none)).toBe(true);
    expect(isFixedAccessMember({ id: 'a', company_role: 'member', firm_role: 'admin' }, none)).toBe(true);
  });

  it('leaves members editable unless the server reports a root grant for them', () => {
    expect(isFixedAccessMember({ id: 'm', company_role: 'member', firm_role: null }, none)).toBe(false);
    expect(isFixedAccessMember({ id: 'c', company_role: 'member', firm_role: 'cco' }, none)).toBe(false);
    const rooted = {
      m: {
        company_id: 'c1',
        user_id: 'm',
        version: 1,
        assigned_roles: [],
        direct_permissions: [],
        effective_permissions: [
          { permissionKey: 'company:leads:view', source: { type: 'root', id: null, name: 'Company director' } },
        ],
      },
    } as unknown as Parameters<typeof isFixedAccessMember>[1];
    expect(isFixedAccessMember({ id: 'm', company_role: 'member', firm_role: null }, rooted)).toBe(true);
  });
});
