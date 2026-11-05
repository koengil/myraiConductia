import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/v1/companyAccess', () => ({
  hasCompanyPermission: vi.fn(async () => false),
}));

import { hasCompanyPermission } from '@/lib/api/v1/companyAccess';
import { listApproverIds } from '@/lib/api/v1/accessRequests';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import { COMPANY_ROLE } from '@/lib/constants/roles';
import type { SupabaseClient } from '@supabase/supabase-js';

function usersAdmin(rows: unknown[]): SupabaseClient {
  const builder: Record<string, unknown> = {};
  const next = () => builder;
  builder.select = next;
  builder.eq = next;
  builder.then = (onFulfilled: (v: { data: unknown; error: null }) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(onFulfilled);
  return { from: () => builder } as unknown as SupabaseClient;
}

describe('listApproverIds', () => {
  it('includes seated directors and people who can assign access', async () => {
    vi.mocked(hasCompanyPermission).mockImplementation(async (_admin, userId) => userId === 'u-assign');
    const admin = usersAdmin([
      { id: 'u-director', company_role: COMPANY_ROLE.DIRECTOR, firm_role: null },
      { id: 'u-assign', company_role: 'member', firm_role: null },
      { id: 'u-member', company_role: 'member', firm_role: null },
    ]);

    await expect(listApproverIds(admin, 'co-1')).resolves.toEqual(['u-director', 'u-assign']);
    expect(hasCompanyPermission).toHaveBeenCalledWith(
      admin,
      'u-assign',
      'co-1',
      COMPANY_PERMISSION.ACCESS_ASSIGN,
    );
  });
});
