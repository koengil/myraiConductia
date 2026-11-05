import { describe, expect, it } from 'vitest';

import { resolveCrmScope, crmScopeHeadline, crmScopeDescription } from '@/lib/leads/crmScope';
import { navUserFromProfile } from '@/lib/navigation/navPolicy';

describe('resolveCrmScope', () => {
  it('scopes customer org users to their company catalog', () => {
    const navUser = navUserFromProfile({
      is_external: true,
      firm_role: null,
      company_id: 'tokmail-co',
      company_role: 'director',
    });
    const scope = resolveCrmScope(navUser, 'Tokmail');
    expect(scope.tenantWide).toBe(false);
    expect(scope.orgName).toBe('Tokmail');
    expect(crmScopeHeadline(scope)).toBe('Tokmail CRM');
    expect(crmScopeDescription(scope)).toContain('Tokmail');
  });

  it('marks bank internal users as tenant-wide', () => {
    const navUser = navUserFromProfile({
      is_external: false,
      firm_role: 'md',
      company_id: 'bank-co',
      company_role: null,
    });
    const scope = resolveCrmScope(navUser, 'Conductia Bank');
    expect(scope.tenantWide).toBe(true);
    expect(crmScopeHeadline(scope)).toBe('Firm CRM');
  });
});
