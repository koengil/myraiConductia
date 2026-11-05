import { describe, expect, it } from 'vitest';

import { COMPANY_ROLE, FIRM_ROLE } from '../src/lib/constants/roles';
import {
  FIXTURE_GATE0_NOTIFY_RECIPIENTS,
  MISSING_CCO_LABEL,
  MISSING_CCO_NOTICE,
  NOTIFY_APPROVED_WHAT,
  complianceOfficersFromRoster,
  gate0NotifyRoleLabel,
  notifyApprovedWhat,
  notifyRecipientsLabel,
} from '../src/lib/rail/gate0';

describe('Gate 0 notify recipients', () => {
  it('names the seeded CCO rather than the role title', () => {
    expect(FIXTURE_GATE0_NOTIFY_RECIPIENTS).toEqual([
      { name: 'Pat Rivera', role: 'Chief Compliance Officer' },
    ]);
    expect(notifyRecipientsLabel(FIXTURE_GATE0_NOTIFY_RECIPIENTS)).toBe('Pat Rivera');
  });

  it('says so when nobody was notified', () => {
    expect(notifyRecipientsLabel([])).toBe(MISSING_CCO_LABEL);
    expect(notifyApprovedWhat([])).toBe(MISSING_CCO_NOTICE);
    expect(notifyApprovedWhat(FIXTURE_GATE0_NOTIFY_RECIPIENTS)).toBe(NOTIFY_APPROVED_WHAT);
  });

  it('picks tenant CCOs off the bank roster by name', () => {
    expect(
      complianceOfficersFromRoster([
        {
          id: 'jw',
          firm_role: null,
          display_name: 'James Watt',
          full_name: 'James Watt',
        },
        {
          id: 'cco',
          firm_role: FIRM_ROLE.CCO,
          display_name: 'Pat Rivera',
          full_name: 'Patricia Rivera',
        },
      ]),
    ).toEqual([
      { id: 'cco', name: 'Pat Rivera', role: 'Chief Compliance Officer' },
    ]);
    expect(complianceOfficersFromRoster([])).toEqual([]);
  });

  it('labels CCO, admin, director, and granted staff distinctly', () => {
    expect(gate0NotifyRoleLabel({ firm_role: FIRM_ROLE.CCO })).toBe(
      'Chief Compliance Officer',
    );
    expect(gate0NotifyRoleLabel({ firm_role: FIRM_ROLE.ADMIN })).toBe(
      'Administrator',
    );
    expect(gate0NotifyRoleLabel({ company_role: COMPANY_ROLE.DIRECTOR })).toBe(
      'Director',
    );
    expect(gate0NotifyRoleLabel({ company_role: COMPANY_ROLE.MEMBER })).toBe(
      'Compliance',
    );
  });
});
