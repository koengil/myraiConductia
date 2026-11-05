import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BulkAccessDialog } from '@/components/company/BulkAccessDialog';
import type { CompanyMemberAccess } from '@/components/company/companyAccessUi';
import { BULK_ACCESS_COPY, setAccessForMembers } from '@/lib/company/bulkAccess';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';

/*
 * A stale write whose reload fails is not "latest access is loaded",
 * and is not retried with the old version; a person whose access could not be
 * read is flagged and left out of the write.
 */

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function accessFor(userId: string, version: number): CompanyMemberAccess {
  return { company_id: 'c1', user_id: userId, version, assigned_roles: [], direct_permissions: [], effective_permissions: [] };
}

const STALE = { error: 'Employee access changed concurrently. Reload and retry.' };
const STALE_UNREAD =
  'Changed by someone else. Their latest access could not be loaded. Close and reopen Set access.';
const UNREAD = 'Their current access could not be read.';

const permissions = [
  { key: COMPANY_PERMISSION.LEADS_VIEW, label: 'View Leads', description: '', category: 'leads', sortOrder: 1 },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('setAccessForMembers: a stale write whose reload fails', () => {
  it('returns a distinct result, not a loaded copy', async () => {
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) =>
      init?.method === 'PATCH' ? json(STALE, 409) : json({ error: 'Server error' }, 500),
    );
    const [result] = await setAccessForMembers('c1', [{ userId: 'u2', name: 'Alex', version: 1 }], { roleIds: [], directPermissions: [] }, fetchMock);
    expect(result.status).toBe('stale_unread');
    expect(BULK_ACCESS_COPY.staleUnread).toBe(STALE_UNREAD);
  });
});

describe('BulkAccessDialog', () => {
  it('says the latest access could not be loaded, and never retries that row with the old version', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method !== 'PATCH') return json({ error: 'Server error' }, 500);
      if (url.includes('/u3/')) return json(STALE, 409);
      if (url.includes('/u4/')) return json({ error: 'Forbidden' }, 403);
      return json({ access: accessFor('u2', 2) });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <BulkAccessDialog
        open
        onClose={vi.fn()}
        companyId="c1"
        people={[
          { id: 'u2', name: 'Alex Reyes', access: accessFor('u2', 1) },
          { id: 'u3', name: 'Ren Ito', access: accessFor('u3', 4) },
          { id: 'u4', name: 'Kai Lee', access: accessFor('u4', 0) },
        ]}
        roles={[]}
        permissions={permissions}
        viewerPermissionKeys={new Set(Object.values(COMPANY_PERMISSION))}
        onAccessChange={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Set access for 3 people' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set access for 3 people' }));
    expect(await within(dialog).findByText('Access set for 1 of 3 people.')).toBeInTheDocument();

    const ren = within(dialog).getByText('Ren Ito').closest('li')!;
    expect(ren).toHaveTextContent(STALE_UNREAD);
    expect(ren).not.toHaveTextContent(BULK_ACCESS_COPY.stale);

    // Only Kai (refused, retryable) counts; Ren needs the dialog reopened.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again for 1' }));
    await within(dialog).findByText('Access set for 1 of 3 people.');
    const renPatches = fetchMock.mock.calls.filter(
      ([url, init]) => init?.method === 'PATCH' && String(url).includes('/u3/'),
    );
    expect(renPatches).toHaveLength(1);
  });

  it('flags a person whose access could not be read and leaves them out of the write', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      json({ access: accessFor('u2', 2) }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <BulkAccessDialog
        open
        onClose={vi.fn()}
        companyId="c1"
        people={[
          { id: 'u2', name: 'Alex Reyes', access: accessFor('u2', 1) },
          { id: 'u3', name: 'Ren Ito' },
        ]}
        roles={[]}
        permissions={permissions}
        viewerPermissionKeys={new Set(Object.values(COMPANY_PERMISSION))}
        onAccessChange={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Set access for 2 people' });
    const flag = within(dialog).getByText(UNREAD);
    expect(flag.closest('li')).toHaveTextContent('Ren Ito');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set access for 1 person' }));
    await within(dialog).findByText('Access set for 1 person.');
    const patched = fetchMock.mock.calls.map(([url]) => String(url));
    expect(patched).toEqual(['/api/v1/companies/c1/members/u2/access']);
  });

  it('offers no write when nobody selected could be read', () => {
    render(
      <BulkAccessDialog
        open
        onClose={vi.fn()}
        companyId="c1"
        people={[{ id: 'u3', name: 'Ren Ito' }]}
        roles={[]}
        permissions={permissions}
        viewerPermissionKeys={new Set(Object.values(COMPANY_PERMISSION))}
        onAccessChange={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Set access for 1 person' });
    expect(within(dialog).getByRole('button', { name: 'Set access for 0 people' })).toBeDisabled();
  });
});
