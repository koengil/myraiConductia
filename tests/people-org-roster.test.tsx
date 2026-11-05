import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/flags/FlagsContext', () => ({ useFlag: vi.fn(() => true) }));

import { CompanyMembersView } from '@/components/company/CompanyMembersWorkspace';
import { invalidateCompanyRoster } from '@/lib/company/companyRosterCache';
import { useFlag } from '@/lib/flags/FlagsContext';

/*
 * Settings › Organization roster: who may remove a protected person
 * (handoff E27), the role save that reports a failed reload honestly,
 * the own row's reserved menu column, and a selection that a filter
 * hides.
 */

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const person = (id: string, fullName: string, firmRole: string | null, companyRole: string) => ({
  id,
  full_name: fullName,
  display_name: null,
  email: `${id}@bank.dev`,
  department: 'ib',
  firm_role: firmRole,
  company_role: companyRole,
  can_invite: false,
  preferred_deal_role: null,
  is_walled: false,
});

const MEMBERS = [
  person('admin', 'Admin', 'admin', 'member'),
  person('pat', 'Pat Rivera', 'cco', 'member'),
  person('morgan', 'Morgan Vale', null, 'director'),
  person('storm', 'Storm Duncan', null, 'director'),
  person('alex', 'Alex Chen', null, 'member'),
  person('jordan', 'Jordan Blake', null, 'member'),
];

const ROOT = [
  { permissionKey: 'company:access:assign', source: { type: 'root', id: null, name: 'Company director' } },
];

function viewerUser(id: string) {
  const self = MEMBERS.find((m) => m.id === id)!;
  return {
    id,
    firm_role: self.firm_role,
    company_id: 'c1',
    company_role: self.company_role,
    is_external: false,
    can_invite: false,
  };
}

function stubBankRoster(viewerId: string) {
  vi.mocked(useFlag).mockImplementation((key) => key === 'company_access_management');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/me') return json({ user: viewerUser(viewerId), company_permissions: ROOT });
      if (url.includes('/members?includeWalled=true')) return json({ members: MEMBERS });
      if (url.includes('/api/v1/invites?')) return json({ invites: [] });
      if (url === '/api/v1/access-requests') return json({ mine: [], inbox: [] });
      if (url === '/api/v1/companies/c1/roles') return json({ permissions: [], roles: [], viewerPermissions: ROOT });
      const access = /\/members\/([^/]+)\/access$/.exec(url);
      if (access) {
        const fixed = ['admin', 'pat', 'morgan', 'storm'].includes(access[1]);
        return json({
          access: {
            company_id: 'c1',
            user_id: access[1],
            version: 1,
            assigned_roles: [],
            direct_permissions: [],
            effective_permissions: fixed ? ROOT : [],
          },
        });
      }
      return json({});
    }),
  );
}

/** Radix menus open on Enter, not a bare click. */
async function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole('button', { name: `Actions for ${name}` }), { key: 'Enter' });
  return screen.findByRole('menu');
}

const REASON = 'Only a firm administrator can remove a director, a compliance officer or an administrator.';

beforeEach(() => {
  invalidateCompanyRoster();
});

afterEach(() => {
  invalidateCompanyRoster();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Remove on protected people', () => {
  it.each(['Admin', 'Pat Rivera', 'Morgan Vale'])(
    'a director sees no enabled Remove on %s, and the reason',
    async (name) => {
      stubBankRoster('storm');
      render(<CompanyMembersView companyId="c1" inSettings />);
      await screen.findByText('Alex Chen');
      const menu = await openMenu(name);
      const remove = within(menu).getByRole('menuitem', { name: 'Remove' });
      expect(remove).toHaveAttribute('aria-disabled', 'true');
      expect(within(menu).getByText(REASON)).toBeInTheDocument();
    },
  );

  it('a director keeps Remove on a member row', async () => {
    stubBankRoster('storm');
    render(<CompanyMembersView companyId="c1" inSettings />);
    await screen.findByText('Alex Chen');
    const menu = await openMenu('Alex Chen');
    const remove = within(menu).getByRole('menuitem', { name: 'Remove' });
    expect(remove).not.toHaveAttribute('aria-disabled');
    expect(within(menu).queryByText(REASON)).toBeNull();
  });

  it.each(['Pat Rivera', 'Morgan Vale', 'Storm Duncan'])(
    'the firm administrator is offered Remove on %s',
    async (name) => {
      stubBankRoster('admin');
      render(<CompanyMembersView companyId="c1" inSettings />);
      await screen.findByText('Alex Chen');
      const menu = await openMenu(name);
      expect(within(menu).getByRole('menuitem', { name: 'Remove' })).not.toHaveAttribute('aria-disabled');
      expect(within(menu).queryByText(REASON)).toBeNull();
    },
  );
});

describe('the own row keeps the menu column', () => {
  it('renders a placeholder cell the width of the menu on the own row', async () => {
    stubBankRoster('storm');
    const { container } = render(<CompanyMembersView companyId="c1" inSettings />);
    await screen.findByText('Alex Chen');
    const own = container.querySelector('li[data-member="storm"]')!;
    expect(within(own as HTMLElement).queryByRole('button', { name: /^Actions for/ })).toBeNull();
    const cell = own.querySelector('[data-menu-placeholder]');
    expect(cell).not.toBeNull();
    expect(cell!.className).toContain('w-[34px]');
  });

  it("keeps it on an outside director's own row beside their people's Change role menus", async () => {
    vi.mocked(useFlag).mockReturnValue(true);
    const roles = [{ id: 'role-md', name: 'MD', description: null, version: 1, permissionKeys: [], assignmentCount: 0, createdAt: '', updatedAt: '' }];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/me') {
          return json({ user: { id: 'ext-dir', firm_role: null, company_id: 'c1', company_role: 'director', is_external: true, can_invite: false }, company_permissions: [] });
        }
        if (url.includes('/members?includeWalled=true')) {
          return json({ members: [person('ext-dir', 'Rob Dill', null, 'director'), person('emp-1', 'Jane Doe', null, 'member')] });
        }
        if (url === '/api/v1/companies/c1/roles') return json({ permissions: [], roles, viewerPermissions: [] });
        if (url.endsWith('/members/emp-1/access')) {
          return json({ access: { company_id: 'c1', user_id: 'emp-1', version: 0, assigned_roles: [], direct_permissions: [], effective_permissions: [] } });
        }
        if (url.includes('/api/v1/invites?')) return json({ invites: [] });
        return json({});
      }),
    );
    const { container } = render(<CompanyMembersView companyId="c1" inSettings />);
    await screen.findByText('Jane Doe');
    expect(screen.getByRole('button', { name: 'Actions for Jane Doe' })).toBeInTheDocument();
    expect(container.querySelector('li[data-member="ext-dir"] [data-menu-placeholder]')).not.toBeNull();
  });
});

describe('a filter that hides a selected person drops them', () => {
  it('tick Alex, search zzz: the selection bar is gone, and stays gone', async () => {
    stubBankRoster('storm');
    render(<CompanyMembersView companyId="c1" inSettings />);
    await screen.findByText('Alex Chen');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alex Chen' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search members'), { target: { value: 'zzz' } });
    expect(screen.getByText('No members match.')).toBeInTheDocument();
    expect(screen.queryByText('1 selected')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set access' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Search members'), { target: { value: '' } });
    expect(screen.queryByText('1 selected')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Select Alex Chen' })).not.toBeChecked();
  });

  it('keeps people the filter still shows', async () => {
    stubBankRoster('storm');
    render(<CompanyMembersView companyId="c1" inSettings />);
    await screen.findByText('Alex Chen');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alex Chen' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Jordan Blake' }));
    fireEvent.change(screen.getByLabelText('Search members'), { target: { value: 'alex' } });
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Alex Chen' })).toBeChecked();
  });
});

describe('a saved role with a failed reload', () => {
  it('closes the editor and says the roster could not be loaded, not that the role was not changed', async () => {
    vi.mocked(useFlag).mockReturnValue(true);
    const roles = [{ id: 'role-md', name: 'MD', description: null, version: 1, permissionKeys: [], assignmentCount: 0, createdAt: '', updatedAt: '' }];
    let meCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/me') {
        meCalls += 1;
        if (meCalls > 1) return json({ error: 'Server error' }, 500);
        return json({ user: { id: 'ext-dir', firm_role: null, company_id: 'c1', company_role: 'director', is_external: true, can_invite: false }, company_permissions: [] });
      }
      if (url.includes('/members?includeWalled=true')) {
        return json({ members: [person('ext-dir', 'Rob Dill', null, 'director'), person('emp-1', 'Jane Doe', null, 'member')] });
      }
      if (url === '/api/v1/companies/c1/roles') return json({ permissions: [], roles, viewerPermissions: [] });
      if (url.endsWith('/members/emp-1/access') && init?.method === 'PATCH') {
        return json({ access: { user_id: 'emp-1', version: 1 } });
      }
      if (url.endsWith('/members/emp-1/access')) {
        return json({ access: { company_id: 'c1', user_id: 'emp-1', version: 0, assigned_roles: [], direct_permissions: [], effective_permissions: [] } });
      }
      if (url.includes('/api/v1/invites?')) return json({ invites: [] });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CompanyMembersView companyId="c1" inSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /^Jane Doe/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Change role' }));
    fireEvent.change(screen.getByLabelText('Role for Jane Doe'), { target: { value: 'role-md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save role' }));

    expect(await screen.findByText('The roster could not be loaded.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText('Role for Jane Doe')).toBeNull());
    expect(screen.queryByText('The role was not changed.')).toBeNull();
  });
});
