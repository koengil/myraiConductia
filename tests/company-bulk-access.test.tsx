import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BulkAccessDialog } from '@/components/company/BulkAccessDialog';
import type { CompanyMemberAccess } from '@/components/company/companyAccessUi';
import {
  ACCESS_CONCURRENCY,
  BULK_ACCESS_COPY,
  bulkSummary,
  mapWithAccessLimit,
  setAccessForMembers,
} from '@/lib/company/bulkAccess';
import { groupByRole } from '@/lib/company/rosterGroups';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function accessFor(userId: string, version: number, direct: string[] = []): CompanyMemberAccess {
  return {
    company_id: 'c1',
    user_id: userId,
    version,
    assigned_roles: [],
    direct_permissions: direct as CompanyMemberAccess['direct_permissions'],
    effective_permissions: [],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('mapWithAccessLimit', () => {
  it('keeps at most ACCESS_CONCURRENCY in flight and returns results in input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 30 }, (_, i) => i);
    const out = await mapWithAccessLimit(items, async (i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, (i % 3) + 1));
      inFlight -= 1;
      return i * 2;
    });
    expect(ACCESS_CONCURRENCY).toBe(4);
    expect(peak).toBe(ACCESS_CONCURRENCY);
    expect(out).toEqual(items.map((i) => i * 2));
  });
});

describe('groupByRole', () => {
  it('orders firm roles, then directors, then custom roles, then members last', () => {
    const groups = groupByRole(
      [
        { n: 'a', r: 'Member' },
        { n: 'b', r: 'Director' },
        { n: 'c', r: 'Compliance' },
        { n: 'd', r: 'Administrator' },
        { n: 'e', r: 'Member' },
        { n: 'f', r: 'Chief Compliance Officer' },
      ],
      (item) => item.r,
    );
    expect(groups.map((group) => group.label)).toEqual([
      'Administrator',
      'Chief Compliance Officer',
      'Director',
      'Compliance',
      'Member',
    ]);
    expect(groups.at(-1)?.members.map((item) => item.n)).toEqual(['a', 'e']);
  });
});

describe('setAccessForMembers (client fan-out over the one-person PATCH)', () => {
  it('writes each person with their own version and reports every result, including a partial failure', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method !== 'PATCH') {
        // The reload after a stale write.
        return json({ access: accessFor('u3', 8) });
      }
      const body = JSON.parse(String(init.body));
      if (input.endsWith('/u2/access')) {
        expect(body.expectedVersion).toBe(1);
        return json({ access: accessFor('u2', 2, body.directPermissions) });
      }
      if (input.endsWith('/u3/access')) {
        return json({ error: 'Employee access changed concurrently. Reload and retry.' }, 409);
      }
      if (input.endsWith('/u4/access')) return json({ error: 'Forbidden' }, 403);
      return json({ error: 'Protected company administrators have immutable access' }, 409);
    });

    const results = await setAccessForMembers(
      'c1',
      [
        { userId: 'u2', name: 'Alex', version: 1 },
        { userId: 'u3', name: 'Ren', version: 5 },
        { userId: 'u4', name: 'Kai', version: 0 },
        { userId: 'u5', name: 'Dee', version: 0 },
      ],
      { roleIds: [], directPermissions: [COMPANY_PERMISSION.LEADS_VIEW] },
      fetchMock,
    );

    expect(results.map((result) => [result.userId, result.status])).toEqual([
      ['u2', 'updated'],
      ['u3', 'stale'],
      ['u4', 'failed'],
      ['u5', 'failed'],
    ]);
    expect(results[1]).toMatchObject({ status: 'stale', access: { version: 8 } });
    expect(results[2]).toMatchObject({ message: BULK_ACCESS_COPY.forbidden });
    expect(results[3]).toMatchObject({ message: BULK_ACCESS_COPY.protected });
    // Every write goes to the existing per-person route; no bulk route exists.
    for (const [url] of fetchMock.mock.calls) {
      expect(url).toMatch(/^\/api\/v1\/companies\/c1\/members\/u\d\/access$/);
    }
    expect(bulkSummary(results)).toBe('Access set for 1 of 4 people.');
  });

  it('turns a network error into that person\'s result without stopping the rest', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(json({ access: accessFor('u3', 1) }));
    const results = await setAccessForMembers(
      'c1',
      [
        { userId: 'u2', name: 'Alex', version: 0 },
        { userId: 'u3', name: 'Ren', version: 0 },
      ],
      { roleIds: [], directPermissions: [] },
      fetchMock,
    );
    expect(results[0]).toMatchObject({ status: 'failed', message: BULK_ACCESS_COPY.network });
    expect(results[1].status).toBe('updated');
  });
});

describe('BulkAccessDialog', () => {
  const people = [
    { id: 'u2', name: 'Alex Reyes', access: accessFor('u2', 1, [COMPANY_PERMISSION.LEADS_VIEW]) },
    { id: 'u3', name: 'Ren Ito', access: accessFor('u3', 4, [COMPANY_PERMISSION.LEADS_VIEW, COMPANY_PERMISSION.LEADS_CREATE]) },
  ];
  const permissions = [
    { key: COMPANY_PERMISSION.LEADS_VIEW, label: 'View Leads', description: '', category: 'leads', sortOrder: 1 },
    { key: COMPANY_PERMISSION.LEADS_CREATE, label: 'Create leads', description: '', category: 'leads', sortOrder: 2 },
  ];

  it('starts from what everyone shares, reports each person, and retries a stale one from the reloaded version', async () => {
    let renConflict = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method !== 'PATCH') return json({ access: accessFor('u3', 7) });
      const body = JSON.parse(String(init.body));
      if (url.endsWith('/u3/access') && renConflict) {
        renConflict = false;
        return json({ error: 'Employee access changed concurrently. Reload and retry.' }, 409);
      }
      return json({ access: accessFor(url.includes('/u2/') ? 'u2' : 'u3', body.expectedVersion + 1) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onAccessChange = vi.fn();
    const onFinished = vi.fn();

    render(
      <BulkAccessDialog
        open
        onClose={vi.fn()}
        onFinished={onFinished}
        companyId="c1"
        people={people}
        roles={[]}
        permissions={permissions}
        viewerPermissionKeys={new Set(Object.values(COMPANY_PERMISSION))}
        onAccessChange={onAccessChange}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Set access for 2 people' });
    expect(within(dialog).getByRole('checkbox', { name: /View Leads/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /Create leads/ })).not.toBeChecked();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Set access for 2 people' }));
    expect(await within(dialog).findByText('Access set for 1 of 2 people.')).toBeInTheDocument();
    expect(within(dialog).getByText(BULK_ACCESS_COPY.stale)).toBeInTheDocument();

    const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patches()[0][1]?.body))).toEqual({
      expectedVersion: 1,
      roleIds: [],
      directPermissions: [COMPANY_PERMISSION.LEADS_VIEW],
    });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again for 1' }));
    expect(await within(dialog).findByText('Access set for all 2 people.')).toBeInTheDocument();
    const retry = patches().at(-1)!;
    expect(String(retry[0])).toBe('/api/v1/companies/c1/members/u3/access');
    expect(JSON.parse(String(retry[1]?.body)).expectedVersion).toBe(7);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(onFinished).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onAccessChange).toHaveBeenCalled());
  });
});
