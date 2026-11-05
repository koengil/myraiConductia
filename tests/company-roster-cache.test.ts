import { afterEach, describe, expect, it } from 'vitest';

import {
  getCompanyRosterSnapshot,
  invalidateCompanyRoster,
  setCompanyRosterSnapshot,
} from '@/lib/company/companyRosterCache';

const snapshot = {
  viewer: {
    id: 'me',
    firm_role: null,
    company_id: 'c1',
    company_role: 'director',
    is_external: false,
    can_invite: false,
  },
  members: [
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
  ],
  invites: [],
  viewerPermissions: [],
  rolesData: { permissions: [], roles: [], viewerPermissions: [] },
  memberAccess: {},
};

afterEach(() => {
  invalidateCompanyRoster();
});

describe('company roster cache', () => {
  it('keeps a per-company snapshot so the roster can render without a refetch', () => {
    expect(getCompanyRosterSnapshot('c1', false)).toBeNull();
    setCompanyRosterSnapshot('c1', false, snapshot);
    expect(getCompanyRosterSnapshot('c1', false)?.members[0]?.full_name).toBe('Storm Duncan');
    expect(getCompanyRosterSnapshot('c1', true)).toBeNull();
    expect(getCompanyRosterSnapshot('c2', false)).toBeNull();
  });

  it('can drop one company or the whole cache', () => {
    setCompanyRosterSnapshot('c1', false, snapshot);
    setCompanyRosterSnapshot('c2', false, snapshot);
    invalidateCompanyRoster('c1', false);
    expect(getCompanyRosterSnapshot('c1', false)).toBeNull();
    expect(getCompanyRosterSnapshot('c2', false)).not.toBeNull();
    invalidateCompanyRoster();
    expect(getCompanyRosterSnapshot('c2', false)).toBeNull();
  });
});
