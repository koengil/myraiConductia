import { request as playwrightRequest } from '@playwright/test';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import { COMPANY_ROLE } from '@/lib/constants/roles';
import { EMPLOYEE_EMAIL, seededStorageState } from '../auth/session';
import { Evidence } from '../support/evidence';
import { expect, test } from '../support/fixtures';
import { newCollectedContext } from '../support/cspViolations';
import { watchNavigations } from '../support/navigationWatch';
import { denyAccessRequest } from '../steps/denyAccessRequest';
import { leadCreateStaysLockedAfterDenial } from '../steps/leadCreateStaysLockedAfterDenial';
import { requestLeadCreateAccess } from '../steps/requestLeadCreateAccess';
import type { JourneyContext, JourneyState, Step } from '../steps/types';

/**
 * The other decision on the same row as access-propagation.spec.ts's approve:
 * an employee asks for Create leads and the director denies it. Case 7 in the
 * bug bash names both Approve and Deny as buttons on the request row, but only
 * walks Approve — this proves Deny actually withholds the permission and
 * tells the requester, rather than just removing the row from the inbox.
 */
const JOURNEY: Step[] = [
  requestLeadCreateAccess,
  denyAccessRequest,
  leadCreateStaysLockedAfterDenial,
];

test('a denied access request withholds the permission and tells the requester', async ({
  page,
  evidence,
  runId,
  since,
  browser,
  baseURL,
}, testInfo) => {
  // Hermetic-only: the journey rewrites a seeded employee's company access, and
  // a deployed environment's employees are somebody's real permissions.
  test.skip(
    testInfo.project.name === 'live',
    "the journey rewrites a seeded employee's company access",
  );

  const employeeState = await seededStorageState(EMPLOYEE_EMAIL, baseURL);
  const employeeContext = await newCollectedContext(browser, { baseURL, storageState: employeeState });
  const employeePage = await employeeContext.newPage();
  const employeeApi = await playwrightRequest.newContext({ baseURL, storageState: employeeState });

  const employeeEvidence = new Evidence(employeeApi);
  const state: JourneyState = {};
  const ctx: JourneyContext = {
    page,
    evidence,
    employeePage,
    employeeEvidence,
    employeeNav: watchNavigations(employeePage),
    runId,
    since,
    state,
  };

  let baseline: { roleIds: string[]; directPermissions: string[] } | null = null;

  try {
    const director = await evidence.me();
    expect(director.user.company_id, 'the director belongs to no company').toBeTruthy();
    state.companyId = director.user.company_id as string;

    const employeeProfile = await employeeEvidence.me();
    state.employeeUserId = employeeProfile.user.id;
    state.employeeEmail = employeeProfile.user.email;

    const { members } = await evidence.listCompanyMembers(state.companyId);
    const member = members.find((row) => row.id === state.employeeUserId);
    expect(member, `${EMPLOYEE_EMAIL} is not on the director's company roster`).toBeTruthy();
    expect(member?.company_role, 'the subject of a denial must not be a director').not.toBe(
      COMPANY_ROLE.DIRECTOR,
    );
    state.employeeName = member?.display_name || member?.full_name;

    const { access } = await evidence.getMemberAccess(state.companyId, state.employeeUserId);
    expect(
      access.effective_permissions.some((permission) => permission.source.type === 'root'),
      'the subject holds protected company authority, which no director can decide on',
    ).toBe(false);
    baseline = {
      roleIds: access.assigned_roles.map((role) => role.id),
      directPermissions: access.direct_permissions,
    };

    const seeded = await evidence.replaceMemberAccess(state.companyId, state.employeeUserId, {
      expectedVersion: access.version,
      roleIds: baseline.roleIds,
      directPermissions: [COMPANY_PERMISSION.LEADS_VIEW],
    });
    expect(seeded.direct_permissions).toEqual([COMPANY_PERMISSION.LEADS_VIEW]);

    for (const step of JOURNEY) {
      await test.step(`${step.name} · act`, () => step.act(ctx));
      await test.step(`${step.name} · assertUi`, () => step.assertUi(ctx));
      await test.step(`${step.name} · verify`, () => step.verify(ctx));
    }
  } finally {
    if (baseline && state.companyId && state.employeeUserId) {
      const { access } = await evidence.getMemberAccess(state.companyId, state.employeeUserId);
      await evidence.replaceMemberAccess(state.companyId, state.employeeUserId, {
        expectedVersion: access.version,
        roleIds: baseline.roleIds,
        directPermissions: baseline.directPermissions,
      });
    }
    await employeeApi.dispose();
    await employeeContext.close();
  }
});
