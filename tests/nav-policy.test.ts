import { describe, expect, it } from 'vitest';
import {
  canAddDealMembers,
  canCreateLead,
  homeHref,
  isExternalCompanyDirector,
  isOrganizationAdministrator,
  isOrganizationPath,
  ORGANIZATION_HREF,
  ORGANIZATION_SETTINGS_HREF,
  showCommandCenterNav,
  showDataRoomNav,
  showDealSelector,
  canAccessLeads,
  showLeadsNav,
  showNewDealNav,
  showRailTemplatesNav,
  showAiCostsNav,
  AI_COSTS_HREF,
  type NavUser,
} from '@/lib/navigation/navPolicy';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import { COMPANY_ROLE, FIRM_ROLE } from '@/lib/constants/roles';
import { organizationSettingsHref } from '@/lib/settings/href';

const externalDirector: NavUser = {
  is_external: true,
  firm_role: null,
  company_id: 'co-playboot',
  company_role: COMPANY_ROLE.DIRECTOR,
};

const externalMember: NavUser = {
  is_external: true,
  firm_role: null,
  company_id: 'co-playboot',
  company_role: COMPANY_ROLE.MEMBER,
};

const bankMd: NavUser = {
  is_external: false,
  firm_role: null,
  company_id: null,
  company_role: null,
};

const internalCompanyDirector: NavUser = {
  is_external: false,
  firm_role: null,
  company_id: 'co-bank',
  company_role: COMPANY_ROLE.DIRECTOR,
};

describe('navPolicy — external company director', () => {
  it('is classified as a company director', () => {
    expect(isExternalCompanyDirector(externalDirector)).toBe(true);
  });

  it('lands on Settings › Organization', () => {
    expect(homeHref(externalDirector)).toBe(ORGANIZATION_SETTINGS_HREF);
    expect(ORGANIZATION_SETTINGS_HREF).toBe(organizationSettingsHref());
    expect(showDealSelector(externalDirector, 'external')).toBe(true);
  });

  it('hides bank operations nav except conductor center and leads', () => {
    // The create RPC never grants external users a company permission, so the
    // entry point stays hidden rather than leading to a 403 (PR #138 review).
    expect(showNewDealNav(externalDirector)).toBe(false);
    expect(showCommandCenterNav(externalDirector)).toBe(true);
    expect(showLeadsNav(externalDirector)).toBe(true);
    expect(canCreateLead(externalDirector)).toBe(true);
    expect(isOrganizationAdministrator(externalDirector)).toBe(true);
  });
});

describe('navPolicy — external company employee', () => {
  it('sees command center and leads by default when permissions are unset', () => {
    expect(showCommandCenterNav(externalMember)).toBe(true);
    expect(showLeadsNav(externalMember)).toBe(true);
    expect(canAccessLeads(externalMember)).toBe(true);
    expect(showNewDealNav(externalMember)).toBe(false);
    expect(canAddDealMembers(externalMember)).toBe(false);
  });

  it('gates nav from effective company permissions when present', () => {
    const keys = new Set([
      COMPANY_PERMISSION.LEADS_VIEW,
      COMPANY_PERMISSION.LEADS_CREATE,
      COMPANY_PERMISSION.DEALS_CREATE,
      COMPANY_PERMISSION.DEALS_ADD_MEMBERS,
    ]);
    const permitted: NavUser = { ...externalMember, companyPermissionKeys: keys };

    expect(showLeadsNav(permitted)).toBe(true);
    expect(canAccessLeads(permitted)).toBe(true);
    expect(canCreateLead(permitted)).toBe(true);
    // Client companies never receive company:deals:create (20260902120000) and
    // the create RPC refuses external actors, so the key alone never shows it.
    expect(showNewDealNav(permitted)).toBe(false);
    expect(canAddDealMembers(permitted)).toBe(true);
    expect(showLeadsNav({ ...externalMember, companyPermissionKeys: new Set() })).toBe(true);
    expect(canAccessLeads({ ...externalMember, companyPermissionKeys: new Set() })).toBe(false);
    expect(canCreateLead({ ...externalMember, companyPermissionKeys: new Set() })).toBe(false);
  });
});

describe('navPolicy — bank-side users', () => {
  it('does not treat bank members as organization administrators', () => {
    expect(isOrganizationAdministrator(bankMd)).toBe(false);
  });

  it('keeps bank operations nav for the MD', () => {
    expect(showNewDealNav(bankMd)).toBe(true);
    expect(showCommandCenterNav(bankMd)).toBe(true);
    expect(showLeadsNav(bankMd)).toBe(true);
    expect(canAccessLeads(bankMd)).toBe(true);
    expect(homeHref(bankMd)).toBe('/projects');
  });

  it('requires View Leads for bank-side company members once permissions are loaded', () => {
    const seated: NavUser = {
      is_external: false,
      firm_role: null,
      company_id: 'co-bank',
      company_role: COMPANY_ROLE.MEMBER,
      companyPermissionKeys: new Set([COMPANY_PERMISSION.ACCESS_ASSIGN]),
    };
    expect(canAccessLeads(seated)).toBe(false);
    expect(
      canAccessLeads({
        ...seated,
        companyPermissionKeys: new Set([COMPANY_PERMISSION.LEADS_VIEW]),
      }),
    ).toBe(true);
  });

  it('requires Create leads once company permissions are loaded', () => {
    const seated: NavUser = {
      is_external: false,
      firm_role: null,
      company_id: 'co-bank',
      company_role: COMPANY_ROLE.MEMBER,
      companyPermissionKeys: new Set([COMPANY_PERMISSION.LEADS_VIEW]),
    };
    expect(canCreateLead(seated)).toBe(false);
    expect(
      canCreateLead({
        ...seated,
        companyPermissionKeys: new Set([
          COMPANY_PERMISSION.LEADS_VIEW,
          COMPANY_PERMISSION.LEADS_CREATE,
        ]),
      }),
    ).toBe(true);
    expect(canCreateLead(bankMd)).toBe(true);
  });

  it('gates New deal on Create deals once company permissions are loaded (Finding 14)', () => {
    const seated: NavUser = {
      is_external: false,
      firm_role: null,
      company_id: 'co-bank',
      company_role: COMPANY_ROLE.MEMBER,
      companyPermissionKeys: new Set([COMPANY_PERMISSION.LEADS_VIEW]),
    };
    expect(showNewDealNav(seated)).toBe(false);
    expect(
      showNewDealNav({
        ...seated,
        companyPermissionKeys: new Set([COMPANY_PERMISSION.DEALS_CREATE]),
      }),
    ).toBe(true);
    // Directors are access roots: their effective set carries every key.
    expect(
      showNewDealNav({
        ...internalCompanyDirector,
        companyPermissionKeys: new Set(Object.values(COMPANY_PERMISSION)),
      }),
    ).toBe(true);
    // Firm admins and the CCO keep the entry point regardless of company keys,
    // matching the short-circuit in src/lib/api/v1/access.ts and the RPC.
    expect(showNewDealNav({ ...seated, firm_role: FIRM_ROLE.ADMIN })).toBe(true);
    expect(showNewDealNav({ ...seated, firm_role: FIRM_ROLE.CCO })).toBe(true);
    // Before permissions load, bank-side users still see it (server decides).
    expect(showNewDealNav(bankMd)).toBe(true);
  });

  it('treats internal company directors as organization administrators', () => {
    expect(isOrganizationAdministrator(internalCompanyDirector)).toBe(true);
    expect(homeHref(internalCompanyDirector)).toBe('/projects');
  });

  it('keeps sidebar destinations visible before the profile is ready', () => {
    expect(showCommandCenterNav(null)).toBe(true);
    expect(showLeadsNav(null)).toBe(true);
    expect(showRailTemplatesNav(null)).toBe(false);
  });

  it('shows Rails configuration only for the template permission', () => {
    const seated: NavUser = {
      ...bankMd,
      company_id: 'co-bank',
      companyPermissionKeys: new Set(),
    };
    expect(showRailTemplatesNav(seated)).toBe(false);
    expect(
      showRailTemplatesNav({
        ...seated,
        companyPermissionKeys: new Set([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]),
      }),
    ).toBe(true);
    expect(
      showRailTemplatesNav({
        ...seated,
        companyPermissionKeys: new Set([COMPANY_PERMISSION.DEAL_STEPS_STRUCTURE]),
      }),
    ).toBe(false);
  });

  it('recognises the old organization URLs (they redirect into Settings)', () => {
    expect(isOrganizationPath(ORGANIZATION_HREF)).toBe(true);
    expect(isOrganizationPath('/companies/co-playboot/members')).toBe(true);
    expect(isOrganizationPath('/companies/co-playboot/roles')).toBe(true);
    expect(isOrganizationPath('/projects')).toBe(false);
  });

  it('allows firm admins full bank nav', () => {
    const admin: NavUser = { ...bankMd, firm_role: FIRM_ROLE.ADMIN };
    expect(showLeadsNav(admin)).toBe(true);
    expect(isOrganizationAdministrator(admin)).toBe(true);
  });
});

describe('navPolicy — AI costs', () => {
  it('shows the firm AI costs page to the roles that get the full spend breakdown', () => {
    expect(AI_COSTS_HREF).toBe('/ai-costs');
    expect(showAiCostsNav({ ...bankMd, firm_role: FIRM_ROLE.ADMIN })).toBe(true);
    expect(showAiCostsNav({ ...bankMd, firm_role: FIRM_ROLE.CCO })).toBe(true);
    expect(showAiCostsNav(internalCompanyDirector)).toBe(true);
  });

  it('follows the research and trading wall of the ai-spend route for directors, not overseers', () => {
    expect(showAiCostsNav({ ...internalCompanyDirector, department: 'research' })).toBe(false);
    expect(showAiCostsNav({ ...internalCompanyDirector, department: 'trading' })).toBe(false);
    expect(showAiCostsNav({ ...bankMd, firm_role: FIRM_ROLE.CCO, department: 'research' })).toBe(true);
  });

  it('hides it from other bankers, external users, and a profile still loading', () => {
    expect(showAiCostsNav(bankMd)).toBe(false);
    expect(showAiCostsNav(externalDirector)).toBe(false);
    expect(showAiCostsNav(externalMember)).toBe(false);
    expect(showAiCostsNav(null)).toBe(false);
  });
});

describe('navPolicy — Data Room row (deal_data_room_nav)', () => {
  it('hides the row from internal users while the flag is off', () => {
    expect(showDataRoomNav(false, 'storm')).toBe(false);
  });

  it('shows the row to internal users once the flag is on', () => {
    expect(showDataRoomNav(true, 'storm')).toBe(true);
  });

  it('keeps the row for external seats with the flag off', () => {
    expect(showDataRoomNav(false, 'external')).toBe(true);
    expect(showDataRoomNav(true, 'external')).toBe(true);
  });
});
