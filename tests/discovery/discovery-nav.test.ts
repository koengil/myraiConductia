import { describe, expect, it } from 'vitest';

import { showDiscoveryNav, type NavUser } from '@/lib/navigation/navPolicy';
import { shellNavState } from '@/lib/navigation/shellNav';

const banker: NavUser = { is_external: false, firm_role: null, company_id: 'bank', company_role: 'member' };
const external: NavUser = { ...banker, is_external: true };

describe('showDiscoveryNav', () => {
  it('shows Discovery to the bank side when deal_discovery is on', () => {
    expect(showDiscoveryNav(banker, 'storm', true)).toBe(true);
    expect(showDiscoveryNav({ ...banker, firm_role: 'cco' }, 'storm', true)).toBe(true);
  });

  it('hides it when the flag is off, for external users, outside the internal shell, and while the profile loads', () => {
    expect(showDiscoveryNav(banker, 'storm', false)).toBe(false);
    expect(showDiscoveryNav(external, 'storm', true)).toBe(false);
    expect(showDiscoveryNav(banker, 'external', true)).toBe(false);
    expect(showDiscoveryNav(null, 'storm', true)).toBe(false);
  });
});

describe('shellNavState.discoveryActive', () => {
  it('is active on /discovery and below it only', () => {
    const at = (pathname: string) => shellNavState({ pathname, navUser: banker, perspective: 'storm' });
    expect(at('/discovery').discoveryActive).toBe(true);
    expect(at('/discovery/c-1').discoveryActive).toBe(true);
    expect(at('/discovery-archive').discoveryActive).toBe(false);
    expect(at('/leads').discoveryActive).toBe(false);
    expect(at('/leads').leadsActive).toBe(true);
  });
});
