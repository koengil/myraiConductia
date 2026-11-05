import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getCompanyEffectivePermissionsChecked,
  hasCompanyPermission,
  hasCompanyPermissionChecked,
} from '@/lib/api/v1/companyAccess';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';

function mockAdmin(data: unknown, error: unknown = null) {
  return {
    rpc: vi.fn().mockResolvedValue({ data, error }),
  } as unknown as SupabaseClient;
}

describe('getCompanyEffectivePermissionsChecked', () => {
  it('returns typed, source-aware permissions from the authoritative RPC', async () => {
    const admin = mockAdmin([
      {
        permission_key: COMPANY_PERMISSION.DIRECTORY_VIEW_ALL,
        source_type: 'role',
        source_id: 'role-1',
        source_name: 'HR Manager',
      },
      {
        permission_key: COMPANY_PERMISSION.INVITES_SEND,
        source_type: 'direct',
        source_id: null,
        source_name: null,
      },
      {
        permission_key: COMPANY_PERMISSION.ROLES_MANAGE,
        source_type: 'root',
        source_id: null,
        source_name: 'Company director',
      },
    ]);

    await expect(
      getCompanyEffectivePermissionsChecked(admin, 'user-1', 'company-1'),
    ).resolves.toEqual([
      {
        permissionKey: COMPANY_PERMISSION.DIRECTORY_VIEW_ALL,
        source: { type: 'role', id: 'role-1', name: 'HR Manager' },
      },
      {
        permissionKey: COMPANY_PERMISSION.INVITES_SEND,
        source: { type: 'direct', id: null, name: null },
      },
      {
        permissionKey: COMPANY_PERMISSION.ROLES_MANAGE,
        source: { type: 'root', id: null, name: 'Company director' },
      },
    ]);
    expect(admin.rpc).toHaveBeenCalledWith('app_company_effective_permissions', {
      p_user_id: 'user-1',
      p_company_id: 'company-1',
    });
  });

  it('returns an empty permission set as a readable denial', async () => {
    await expect(
      getCompanyEffectivePermissionsChecked(mockAdmin([]), 'user-1', 'company-1'),
    ).resolves.toEqual([]);
  });

  it('returns unreadable for an RPC error or malformed result', async () => {
    await expect(
      getCompanyEffectivePermissionsChecked(
        mockAdmin(null, { message: 'failed' }),
        'user-1',
        'company-1',
      ),
    ).resolves.toBe('unreadable');
    await expect(
      getCompanyEffectivePermissionsChecked(
        mockAdmin([
          {
            permission_key: 'company:unknown',
            source_type: 'role',
            source_id: 'role-1',
            source_name: 'Unknown',
          },
        ]),
        'user-1',
        'company-1',
      ),
    ).resolves.toBe('unreadable');
    await expect(
      getCompanyEffectivePermissionsChecked(mockAdmin(null), 'user-1', 'company-1'),
    ).resolves.toBe('unreadable');
  });
});

describe('hasCompanyPermission', () => {
  it('returns the readable allow and denial decisions from the RPC', async () => {
    const allowed = mockAdmin(true);
    await expect(
      hasCompanyPermissionChecked(
        allowed,
        'user-1',
        'company-1',
        COMPANY_PERMISSION.ACCESS_ASSIGN,
      ),
    ).resolves.toBe(true);
    expect(allowed.rpc).toHaveBeenCalledWith('app_has_company_permission', {
      p_user_id: 'user-1',
      p_company_id: 'company-1',
      p_permission_key: COMPANY_PERMISSION.ACCESS_ASSIGN,
    });

    await expect(
      hasCompanyPermissionChecked(
        mockAdmin(false),
        'user-1',
        'company-1',
        COMPANY_PERMISSION.ACCESS_ASSIGN,
      ),
    ).resolves.toBe(false);
  });

  it('reports RPC errors and malformed decisions as unreadable', async () => {
    await expect(
      hasCompanyPermissionChecked(
        mockAdmin(null, { message: 'failed' }),
        'user-1',
        'company-1',
        COMPANY_PERMISSION.ACCESS_ASSIGN,
      ),
    ).resolves.toBe('unreadable');
    await expect(
      hasCompanyPermissionChecked(
        mockAdmin(null),
        'user-1',
        'company-1',
        COMPANY_PERMISSION.ACCESS_ASSIGN,
      ),
    ).resolves.toBe('unreadable');
  });

  it('fails closed in the enforcement wrapper', async () => {
    await expect(
      hasCompanyPermission(
        mockAdmin(null, { message: 'failed' }),
        'user-1',
        'company-1',
        COMPANY_PERMISSION.ACCESS_ASSIGN,
      ),
    ).resolves.toBe(false);
  });
});
