// User account status (users.status). Mirrors the status CHECK, whose source
// of truth is the migration chain:
//   20260604100000_permissions_schema.sql   — active / suspended
//   20260731120000_onboarding_invites.sql   — invited (onboarding containment)
//
// 'active'    — normal.
// 'suspended' — no access (reversible freeze, or set on company removal so a
//               company-less account cannot log in). Orthogonal to company
//               membership (users.company_id); see the company-removal cascade.
// 'invited'   — auth identity exists (created at invite-link generation) but
//               the invite is not yet accepted. Set by a server-owned update
//               in the invite create route, never by the auth trigger.
//               userIsOnboarded() keys on status !== 'invited'.

export const USER_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  INVITED: 'invited',
} as const;

export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];
