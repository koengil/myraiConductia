import { describe, it, expect } from 'vitest';

import { resolveDealStepStructureCapability } from '@/lib/api/v1/access';
import { DEAL_ROLE } from '@/lib/constants/roles';

type FakeUsersRow = {
  is_external?: boolean;
  firm_role?: string | null;
  tenant_id?: string;
  company_id?: string | null;
};

function makeStructureAdmin(opts: {
  userRow: FakeUsersRow;
  membershipRow?: { deal_role?: string | null } | null;
  permissionGranted?: boolean;
}) {
  return {
    from: (table: string) => {
      if (table === 'users') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: opts.userRow, error: null }),
            }),
          }),
        };
      }
      if (table === 'deal_memberships') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: opts.membershipRow ?? null, error: null }),
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    rpc: async () => ({ data: opts.permissionGranted ?? false, error: null }),
  };
}

describe('resolveDealStepStructureCapability', () => {
  it('denies a company member lacking company:deals:steps:structure', async () => {
    const admin = makeStructureAdmin({
      userRow: {
        is_external: false,
        firm_role: null,
        tenant_id: 'tenant-1',
        company_id: 'company-1',
      },
      membershipRow: { deal_role: 'analyst' },
      permissionGranted: false,
    });

    const result = await resolveDealStepStructureCapability(admin as never, 'user-1');

    expect(result).toBe(false);
  });

  it('grants a company member holding company:deals:steps:structure', async () => {
    const admin = makeStructureAdmin({
      userRow: {
        is_external: false,
        firm_role: null,
        tenant_id: 'tenant-1',
        company_id: 'company-1',
      },
      membershipRow: { deal_role: 'analyst' },
      permissionGranted: true,
    });

    const result = await resolveDealStepStructureCapability(admin as never, 'user-1');

    expect(result).toBe(true);
  });

  it('denies a deal MD lacking company:deals:steps:structure', async () => {
    const admin = makeStructureAdmin({
      userRow: {
        is_external: false,
        firm_role: null,
        tenant_id: 'tenant-1',
        company_id: 'company-1',
      },
      membershipRow: { deal_role: DEAL_ROLE.MD },
      permissionGranted: false,
    });

    const result = await resolveDealStepStructureCapability(admin as never, 'user-1');

    expect(result).toBe(false);
  });

  it('denies an external caller regardless of company permission', async () => {
    const admin = makeStructureAdmin({
      userRow: { is_external: true, firm_role: null, tenant_id: 'tenant-1', company_id: 'company-1' },
      membershipRow: { deal_role: 'seller' },
      permissionGranted: true,
    });

    const result = await resolveDealStepStructureCapability(admin as never, 'user-1');

    expect(result).toBe(false);
  });
});
