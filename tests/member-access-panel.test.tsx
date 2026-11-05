import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_CHOICE_COPY } from '@/components/company/AccessChoiceFields';
import { MEMBER_ACCESS_COPY, MemberAccessPanel } from '@/components/company/MemberAccessPanel';
import type { CompanyMemberAccess } from '@/components/company/companyAccessUi';
import { BULK_ACCESS_COPY } from '@/lib/company/bulkAccess';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';

const permissions = [
  {
    key: COMPANY_PERMISSION.INVITES_SEND,
    label: 'Send invitations',
    description: 'Invite employees.',
    category: 'company',
    sortOrder: 1,
  },
  {
    key: COMPANY_PERMISSION.ROLES_MANAGE,
    label: 'Manage roles',
    description: 'Compose roles.',
    category: 'company',
    sortOrder: 2,
  },
];

const recruiter = {
  id: 'r1',
  name: 'Recruiter',
  description: null,
  version: 1,
  permissionKeys: [COMPANY_PERMISSION.INVITES_SEND],
  assignmentCount: 1,
  createdAt: '',
  updatedAt: '',
};

const access: CompanyMemberAccess = {
  company_id: 'c1',
  user_id: 'u2',
  version: 3,
  assigned_roles: [
    { id: 'r1', name: 'Recruiter', version: 1, permission_keys: [COMPANY_PERMISSION.INVITES_SEND] },
  ],
  direct_permissions: [COMPANY_PERMISSION.ROLES_MANAGE],
  effective_permissions: [
    { permissionKey: COMPANY_PERMISSION.INVITES_SEND, source: { type: 'role', id: 'r1', name: 'Recruiter' } },
    { permissionKey: COMPANY_PERMISSION.ROLES_MANAGE, source: { type: 'direct', id: null, name: null } },
  ],
};

const ALL = new Set(Object.values(COMPANY_PERMISSION));

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

type PanelProps = React.ComponentProps<typeof MemberAccessPanel>;

/** Owns `editing` like the roster does, so Edit / Cancel / Save round-trip. */
function Harness(props: Partial<PanelProps> & { startEditing?: boolean }) {
  const { startEditing = false, ...rest } = props;
  const [editing, setEditing] = React.useState(startEditing);
  return (
    <MemberAccessPanel
      companyId="c1"
      member={{ id: 'u2', companyRole: 'member' }}
      initialAccess={access}
      roles={[recruiter]}
      permissions={permissions}
      viewerPermissionKeys={ALL}
      canAssign
      editing={editing}
      onEditingChange={setEditing}
      onAccessChange={vi.fn()}
      {...rest}
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('member access panel (inline, Settings › Organization)', () => {
  it('opens read-only: what they can do and where it comes from, no controls but Edit access', () => {
    render(<Harness />);

    expect(screen.getByText(MEMBER_ACCESS_COPY.explainer)).toBeInTheDocument();
    expect(screen.getByText('Send invitations')).toBeInTheDocument();
    expect(screen.getByText('From Recruiter')).toBeInTheDocument();
    expect(screen.getByText('Given on its own')).toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Save access' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit access' })).toBeInTheDocument();
  });

  it('edits only after Edit access, then sends an exact versioned set and returns to read-only', async () => {
    const nextAccess = { ...access, version: 4, direct_permissions: [] };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('PATCH');
      return json({ access: nextAccess });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit access' }));
    expect(screen.getByRole('checkbox', { name: /Recruiter/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save access' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Manage roles/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      expectedVersion: 3,
      roleIds: ['r1'],
      directPermissions: [],
    });
    expect(await screen.findByRole('status')).toHaveTextContent(MEMBER_ACCESS_COPY.saved);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('Cancel drops the edits and goes back to read-only', () => {
    const onDirtyChange = vi.fn();
    render(<Harness onDirtyChange={onDirtyChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit access' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Manage roles/ }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByText('Manage roles')).toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('reloads the latest access after a stale write and stays in edit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: 'Employee access changed concurrently. Reload and retry.' }, 409))
      .mockResolvedValueOnce(json({ access: { ...access, version: 9 } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness startEditing />);

    fireEvent.click(screen.getByRole('checkbox', { name: /Manage roles/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    expect(await screen.findByText(MEMBER_ACCESS_COPY.stale)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/companies/c1/members/u2/access');
    expect(screen.getByRole('checkbox', { name: /Manage roles/ })).toBeChecked();
  });

  it.each([
    [403, 'Forbidden', BULK_ACCESS_COPY.forbidden],
    [409, 'Protected company administrators have immutable access', BULK_ACCESS_COPY.protected],
    [404, 'Company member not found', BULK_ACCESS_COPY.gone],
    [500, 'Access replace failed (XX000)', MEMBER_ACCESS_COPY.saveFailed],
  ])('says a %i failed save in plain words, never the server text', async (status, serverText, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: serverText }, status)));
    render(<Harness startEditing />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Manage roles/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.queryByText(serverText)).not.toBeInTheDocument();
  });

  it('shows what the viewer cannot give, with the reason, and asks for it to be taken away before saving', () => {
    render(<Harness startEditing viewerPermissionKeys={new Set([COMPANY_PERMISSION.INVITES_SEND])} />);

    const manage = screen.getByRole('checkbox', { name: /Manage roles/ });
    expect(manage).toBeEnabled();
    expect(screen.getByText(ACCESS_CHOICE_COPY.permissionOutside)).toBeInTheDocument();
    expect(screen.getByText(MEMBER_ACCESS_COPY.outsideEnvelope)).toBeInTheDocument();
    fireEvent.click(manage);
    expect(manage).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save access' })).toBeEnabled();
  });

  it('shows a director as locked with the reason, never as editable', () => {
    render(<Harness member={{ id: 'me', companyRole: 'director' }} startEditing />);

    expect(screen.getByText(MEMBER_ACCESS_COPY.lockedDirector)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit access' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save access' })).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  // The CCO's access is fixed because the CCO is a director: the reason under
  // their row says so, never a rule about other people.
  it('says why a fixed person is fixed: a director (the CCO among them) or the firm administrator', () => {
    render(<Harness member={{ id: 'cco', companyRole: 'director' }} />);
    expect(screen.getByText('As a director, they have every permission. Their access is fixed.')).toBeInTheDocument();
    expect(screen.queryByText(/Directors and firm administrators/)).toBeNull();
    cleanup();

    const root: CompanyMemberAccess = {
      ...access,
      assigned_roles: [],
      direct_permissions: [],
      effective_permissions: [
        { permissionKey: COMPANY_PERMISSION.INVITES_SEND, source: { type: 'root', id: null, name: null } },
      ],
    };
    render(<Harness member={{ id: 'admin', companyRole: null }} initialAccess={root} />);
    expect(
      screen.getByText('As a firm administrator, they have every permission. Their access is fixed.'),
    ).toBeInTheDocument();
  });

  it('tells a viewer who cannot assign access why they cannot change it', () => {
    render(<Harness canAssign={false} />);
    expect(screen.getByText(MEMBER_ACCESS_COPY.lockedNoAuthority)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit access' })).toBeNull();
  });

  it('loads access when no snapshot is available', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ access }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness initialAccess={undefined} canAssign={false} />);

    expect(screen.getByText('Loading access.')).toBeInTheDocument();
    expect(await screen.findByText('Send invitations')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/companies/c1/members/u2/access');
  });

  it('fails closed when access cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'Access lookup failed.' }, 503)));
    render(<Harness initialAccess={undefined} />);

    expect(await screen.findByText('Access lookup failed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit access' })).toBeNull();
  });

  it('uses fixed human labels when the permission catalogue is unavailable', () => {
    render(<Harness permissions={[]} canAssign={false} />);
    expect(screen.getByText('Send company invitations')).toBeInTheDocument();
    expect(screen.queryByText(COMPANY_PERMISSION.INVITES_SEND)).toBeNull();
  });

  it('asks Keep editing or Discard when the roster tries to move away with unsaved edits', () => {
    const onKeepEditing = vi.fn();
    const onDiscard = vi.fn();
    render(<Harness startEditing discardPrompt onKeepEditing={onKeepEditing} onDiscard={onDiscard} />);

    expect(screen.getByRole('alert')).toHaveTextContent(MEMBER_ACCESS_COPY.unsaved);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(onKeepEditing).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('never says "Company permissions do not grant" or "Protected company authority"', () => {
    const { container } = render(<Harness member={{ id: 'me', companyRole: 'director' }} />);
    expect(container.textContent).not.toMatch(/Company permissions do not grant|Protected company authority/);
  });
});
