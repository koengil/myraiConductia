import { describe, expect, it } from 'vitest';
import {
  initialsFor,
  roleLabelFor,
  type CurrentMandate,
  type CurrentUserProfile,
} from '@/lib/auth/useCurrentUser';
import { COMPANY_ROLE, DEAL_ROLE, FIRM_ROLE } from '@/lib/constants/roles';

function profile(overrides: Partial<CurrentUserProfile> = {}): CurrentUserProfile {
  return {
    id: 'u1',
    email: 'storm.duncan@bank.com',
    full_name: 'Storm Duncan',
    display_name: null,
    firm_role: null,
    department: null,
    is_external: false,
    status: 'active',
    company_id: null,
    company_role: null,
    can_invite: false,
    ...overrides,
  };
}

function mandate(overrides: Partial<CurrentMandate> = {}): CurrentMandate {
  return {
    dealId: 'd1',
    code: 'ATLAS-2026-001',
    codename: 'Project Atlas',
    status: 'intake',
    dealRole: DEAL_ROLE.MD,
    targetName: 'Atlassian',
    ...overrides,
  };
}

describe('roleLabelFor', () => {
  it('prefers the firm-role label when present', () => {
    expect(
      roleLabelFor(
        profile({ firm_role: FIRM_ROLE.ADMIN, company_role: COMPANY_ROLE.MEMBER }),
        mandate(),
      ),
    ).toBe('Administrator');
    expect(roleLabelFor(profile({ firm_role: FIRM_ROLE.CCO }), mandate())).toBe(
      'Chief Compliance Officer',
    );
  });

  it('uses the company role instead of a deal-seat title', () => {
    expect(
      roleLabelFor(profile({ company_role: COMPANY_ROLE.MEMBER }), mandate()),
    ).toBe('Member');
    expect(roleLabelFor(profile({ company_role: COMPANY_ROLE.DIRECTOR }), null)).toBe(
      'Director',
    );
  });

  it('defaults to Member with no firm-role or company role', () => {
    expect(roleLabelFor(profile(), mandate())).toBe('Member');
  });
});

describe('initialsFor', () => {
  it('uses first + last initial for a multi-word name', () => {
    expect(initialsFor(profile({ full_name: 'Storm Duncan' }))).toBe('SD');
  });

  it('prefers display_name over full_name', () => {
    expect(
      initialsFor(profile({ display_name: 'Alex Chen', full_name: 'Alexander Chen' })),
    ).toBe('AC');
  });

  it('falls back to the first two characters of a single token', () => {
    expect(initialsFor(profile({ display_name: 'Admin', full_name: 'Admin' }))).toBe('AD');
  });
});
